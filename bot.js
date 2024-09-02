const TelegramBot = require('node-telegram-bot-api');
const puppeteer = require('puppeteer');
const { ChatOpenAI } = require("@langchain/openai");
const { PromptTemplate } = require("@langchain/core/prompts");
const { loadSummarizationChain } = require("langchain/chains");
const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");
const { Document } = require("langchain/document");
const cron = require('node-cron');
require("dotenv").config();

// Telegram Bot Token
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

// OpenAI Configuration
const llm = new ChatOpenAI({
  modelName: "gpt-4o-mini",
  temperature: 0,
});

// Text splitter for summarization
const textSplitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 200 });

// Summarization prompt
const stuffPrompt = PromptTemplate.fromTemplate(
    "Summarize the following article in a concise manner. Focus on the main subject, key facts, and important details. Format the summary as follows:\n\n" +
    "1. Main Subject: [One sentence describing the primary focus of the article]\n" +
    "2. Key Facts:\n" +
    "   - [3-4 bullet points with the most important information]\n" +
    "3. Context: [1-2 sentences providing relevant background or industry context]\n" +
    "4. Implications: [1 sentence on potential impact or future outlook]\n\n" +
    "Keep the entire summary under 100 words.\n\n" +
    "Article Text:\n```{text}```\n" +
    "CONCISE SUMMARY:"
);

// Global variables to store user states and subscribed users
const userStates = {};
const subscribedUsers = new Set();

// Bot command handlers
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const message = "Welcome to the TechCrunch Scraper Bot! Click 'Get News' to start or use /subscribe to receive automatic updates.";
  const opts = {
    reply_markup: JSON.stringify({
      keyboard: [['Get News']],
      resize_keyboard: true,
      one_time_keyboard: false
    })
  };
  bot.sendMessage(chatId, message, opts);
});

bot.onText(/\/subscribe/, (msg) => {
  const chatId = msg.chat.id;
  subscribedUsers.add(chatId);
  bot.sendMessage(chatId, "You've been subscribed to receive automatic updates every 4 hours.");
});

bot.onText(/\/unsubscribe/, (msg) => {
  const chatId = msg.chat.id;
  subscribedUsers.delete(chatId);
  bot.sendMessage(chatId, "You've been unsubscribed from automatic updates.");
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  if (msg.text === 'Get News') {
    const opts = {
      reply_markup: JSON.stringify({
        inline_keyboard: [
          [{ text: 'Artificial Intelligence', callback_data: 'ai' }],
          [{ text: 'Startups', callback_data: 'startups' }]
        ]
      })
    };
    bot.sendMessage(chatId, 'Choose a category:', opts);
  }
});

bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  if (data === 'ai' || data === 'startups') {
    userStates[chatId] = {
      category: data,
      currentPage: data === 'ai' ? 1 : 2,
    };
    await fetchAndSendArticleTitles(chatId);
  } else if (data.startsWith('article_')) {
    const articleIndex = parseInt(data.split('_')[1]);
    await fetchAndSummarizeArticle(chatId, articleIndex);
  } else if (data.startsWith('page_')) {
    userStates[chatId].currentPage = parseInt(data.split('_')[1]);
    await fetchAndSendArticleTitles(chatId);
  }
});

async function fetchAndSendArticleTitles(chatId) {
  const state = userStates[chatId];
  const category = state.category === 'ai' ? 'artificial-intelligence' : 'startups';
  const url = `https://techcrunch.com/category/${category}/page/${state.currentPage}/`;

  try {
    const articles = await scrapeTechCrunchArticles(url);
    const inlineKeyboard = [];

    for (let i = 0; i < Math.min(10, articles.length); i++) {
      const article = articles[i];
      const title = article.title.length > 30 
        ? article.title.substring(0, 30) + '...\n' + article.title.substring(30)
        : article.title;
      inlineKeyboard.push([{ text: title, callback_data: `article_${i}` }]);
    }

    const paginationButtons = [];
    for (let i = 0; i < 5; i++) {
      const pageNum = state.currentPage + i;
      paginationButtons.push({ text: pageNum.toString(), callback_data: `page_${pageNum}` });
    }
    inlineKeyboard.push(paginationButtons);

    const opts = {
      reply_markup: JSON.stringify({
        inline_keyboard: inlineKeyboard
      })
    };

    bot.sendMessage(chatId, `Articles from page ${state.currentPage}:`, opts);
  } catch (error) {
    bot.sendMessage(chatId, `Error fetching articles: ${error.message}`);
  }
}

async function fetchAndSummarizeArticle(chatId, articleIndex) {
  const state = userStates[chatId];
  const category = state.category === 'ai' ? 'artificial-intelligence' : 'startups';
  const url = `https://techcrunch.com/category/${category}/page/${state.currentPage}/`;

  try {
    const articles = await scrapeTechCrunchArticles(url);
    const article = articles[articleIndex];
    const summary = await summarizeArticle(article);
    const message = `Title: ${article.title}\nLink: ${article.link}\n\nSummary:\n${summary}`;
    bot.sendMessage(chatId, message);
  } catch (error) {
    bot.sendMessage(chatId, `Error summarizing article: ${error.message}`);
  }
}

async function scrapeTechCrunchArticles(url) {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

  const articles = await page.evaluate(() => {
    const articleElements = document.querySelectorAll('h2.wp-block-post-title');
    return Array.from(articleElements).map(el => {
      const linkElement = el.querySelector('a');
      return {
        title: linkElement.innerText.trim(),
        link: linkElement.href
      };
    });
  });

  await browser.close();
  return articles;
}

async function summarizeArticle(article) {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(article.link, { waitUntil: 'networkidle2', timeout: 60000 });

  const content = await page.evaluate(() => {
    const contentElement = document.querySelector('.entry-content.wp-block-post-content');
    if (!contentElement) return '';
    const paragraphs = contentElement.querySelectorAll('p');
    return Array.from(paragraphs).map(p => p.textContent.trim()).join('\n\n');
  });

  await browser.close();

  if (!content || content.length === 0) {
    return "No content available for summarization.";
  }

  const document = new Document({ pageContent: content, metadata: { source: article.link, title: article.title } });
  const splits = await textSplitter.splitDocuments([document]);

  const stuffChain = loadSummarizationChain(llm, { type: "stuff", prompt: stuffPrompt });
  const stuffOutput = await stuffChain.call({ input_documents: splits });

  return stuffOutput.text;
}

async function fetchAndSummarizeLatestNews() {
  const categories = ['artificial-intelligence', 'startups'];
  
  for (const category of categories) {
    const url = `https://techcrunch.com/category/${category}/`;
    try {
      const articles = await scrapeTechCrunchArticles(url);
      if (articles.length > 0) {
        const latestArticle = articles[0];
        const summary = await summarizeArticle(latestArticle);
        const message = `Latest ${category === 'artificial-intelligence' ? 'AI' : 'Startups'} News:\n\nTitle: ${latestArticle.title}\nLink: ${latestArticle.link}\n\nSummary:\n${summary}`;
        
        for (const chatId of subscribedUsers) {
          bot.sendMessage(chatId, message);
        }
      }
    } catch (error) {
      console.error(`Error fetching latest ${category} news:`, error);
    }
  }
}

// Schedule the auto-fetch task to run every 4 hours
cron.schedule('0 */4 * * *', () => {
  console.log('Running auto-fetch task...');
  fetchAndSummarizeLatestNews();
});

console.log('Bot is running...');