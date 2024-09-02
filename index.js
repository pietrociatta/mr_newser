const puppeteer = require('puppeteer');
const { ChatOpenAI } = require("@langchain/openai");
const { PromptTemplate } = require("@langchain/core/prompts");
const { loadSummarizationChain } = require("langchain/chains");
const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");
const { Document } = require("langchain/document");
require("dotenv").config();

// Configuration
const START_PAGE = parseInt(process.env.START_PAGE || '2', 10);
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '1', 10);
const ARTICLES_PER_PAGE = parseInt(process.env.ARTICLES_PER_PAGE || '1', 10);

const llm = new ChatOpenAI({
  modelName: "gpt-4o-mini",
  temperature: 0,
});

async function scrapeArticles(page, numArticles) {
    console.log(`Starting to scrape up to ${numArticles} articles from the current page...`);
    const pageTitle = await page.title();
    console.log(`Current page title: ${pageTitle}`);

    return await page.evaluate((numArticles) => {
        const articleTitles = document.querySelectorAll('h2.wp-block-post-title');
        console.log(`Found ${articleTitles.length} articles on this page.`);
        const results = [];
        for (let i = 0; i < Math.min(numArticles, articleTitles.length); i++) {
            const titleElement = articleTitles[i];
            const linkElement = titleElement.querySelector('a');
            if (linkElement) {
                const title = linkElement.innerText.trim();
                const link = linkElement.href;
                results.push({ title, link });
                console.log(`Scraped article ${i + 1}: ${title}`);
            } else {
                console.log(`Skipped article ${i + 1} due to missing link`);
            }
        }
        return results;
    }, numArticles);
}

async function goToNextPage(page, currentPage) {
    const nextPage = currentPage + 1;
    const nextPageUrl = `https://techcrunch.com/category/startups/page/${nextPage}/`;
    console.log(`Navigating to page ${nextPage}: ${nextPageUrl}`);
    
    try {
        await page.goto(nextPageUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        console.log(`Successfully navigated to page ${nextPage}`);
        return true;
    } catch (error) {
        console.error(`Failed to navigate to page ${nextPage}:`, error.message);
        return false;
    }
}

async function fetchArticleContent(page, url) {
    console.log(`Fetching content for article: ${url}`);
    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        return await page.evaluate(() => {
            const contentElement = document.querySelector('.entry-content.wp-block-post-content');
            if (!contentElement) {
                console.log('Content element not found');
                return '';
            }
            
            // Remove any unwanted elements
            const elementsToRemove = contentElement.querySelectorAll('.ad-unit, .wp-block-tc23-marfeel-experience, .social-share');
            elementsToRemove.forEach(el => el.remove());

            // Extract text content
            const paragraphs = contentElement.querySelectorAll('p');
            const content = Array.from(paragraphs).map(p => p.textContent.trim()).join('\n\n');
            
            console.log(`Content length: ${content.length} characters`);
            return content;
        });
    } catch (error) {
        console.error(`Error fetching content for ${url}:`, error.message);
        return '';
    }
}

const textSplitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 200 });

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

async function summarizeArticle(article) {
    if (!article.content || article.content.length === 0) {
        console.log(`Skipping summarization for article: ${article.title} (no content)`);
        return "No content available for summarization.";
    }

    const document = new Document({ pageContent: article.content, metadata: { source: article.link, title: article.title } });
    const splits = await textSplitter.splitDocuments([document]);

    const stuffChain = loadSummarizationChain(llm, { type: "stuff", prompt: stuffPrompt });
    const stuffOutput = await stuffChain.call({ input_documents: splits });
    console.log(`Summary for article: ${article.title}`);
    console.log(stuffOutput.text);

    return stuffOutput.text;
}

async function scrapeTechCrunchStartups() {
    console.log(`Starting TechCrunch Startups scraping process...`);
    console.log(`Starting from page: ${START_PAGE}`);
    console.log(`Max pages to scrape: ${MAX_PAGES}`);
    console.log(`Articles per page: ${ARTICLES_PER_PAGE}`);

    const browser = await puppeteer.launch({
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--start-maximized",
            "--single-process",
            "--no-zygote",
            "--disable-dev-shm-usage",
            "--disable-web-security",
            "--disable-features=IsolateOrigins,site-per-process",
            "--disable-blink-features=AutomationControlled"
        ],
        defaultViewport: null,
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    await page.setJavaScriptEnabled(true);

    try {
        const startUrl = `https://techcrunch.com/category/startups/page/${START_PAGE}/`;
        await page.goto(startUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        console.log(`Navigated to the initial TechCrunch Startups page: ${startUrl}`);

        let allData = [];
        let currentPage = START_PAGE;

        while (currentPage < START_PAGE + MAX_PAGES) {
            console.log(`Scraping page ${currentPage}...`);
            const pageData = await scrapeArticles(page, ARTICLES_PER_PAGE);
            allData = allData.concat(pageData);
            console.log(`Scraped ${pageData.length} articles from page ${currentPage}.`);

            if (currentPage < START_PAGE + MAX_PAGES - 1) {
                const success = await goToNextPage(page, currentPage);
                if (!success) break;
                currentPage++;
            } else {
                break;
            }
        }

        console.log(`Total articles scraped: ${allData.length}`);

        // Fetch content and summarize each article
        const articlesWithSummaries = [];
        for (const article of allData) {
            console.log(`Processing article: ${article.title}`);
            if (article.link && article.link !== '#') {
                const content = await fetchArticleContent(page, article.link);
                const articleWithContent = { ...article, content };
                const summary = await summarizeArticle(articleWithContent);
                articlesWithSummaries.push({ ...articleWithContent, summary });
            } else {
                console.log(`Skipping article due to invalid link: ${article.title}`);
            }
        }

        console.log("All articles processed and summarized.");
        return articlesWithSummaries;
    } catch (error) {
        console.error('Error during scraping process:', error);
        throw error;
    } finally {
        await browser.close();
        console.log("Browser closed. Scraping process finished.");
    }
}

async function main() {
    const retries = 3;
    for (let attempt = 1; attempt <= retries; attempt++) {
        console.log(`Starting attempt ${attempt} of ${retries}`);
        try {
            const results = await scrapeTechCrunchStartups();
            console.log("Scraping and summarization completed successfully.");
            console.log(`Total articles processed: ${results.length}`);
            results.forEach((result, index) => {
                console.log(`\nArticle ${index + 1}:`);
                console.log(`Title: ${result.title}`);
                console.log(`Link: ${result.link}`);
                console.log(`Summary: ${result.summary}`);
            });
            break;
        } catch (error) {
            console.error(`Attempt ${attempt} failed:`, error);
            if (attempt === retries) {
                console.error('All attempts failed.');
            }
        }
    }
}

main().catch(console.error);