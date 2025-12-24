const fetch = require('node-fetch');
const { Client } = require('@notionhq/client');
const fs = require('fs').promises;
const path = require('path');

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const notion = new Client({ auth: NOTION_TOKEN });

async function searchForArticles() {
  console.log('🔍 Starting search for Israel tech news...');
  
  const searches = [
    'Israel tech startups news today',
    'Israeli founders technology latest',
    'Israel venture capital investments recent',
    'Israeli companies technology announcements',
    'Israel AI technology news'
  ];

  const allArticles = [];

  for (const query of searches) {
    console.log(`   Searching: ${query}...`);
    
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          messages: [{
            role: 'user',
            content: `Search for the most recent tech news article about: ${query}. 
            
Return ONLY a JSON object (no markdown, no backticks):
{
  "title": "exact article title",
  "description": "2-3 sentence summary focusing on key facts",
  "url": "full article URL",
  "source": "publication name",
  "date": "YYYY-MM-DD format"
}`
          }],
          tools: [{
            type: "web_search_20250305",
            name: "web_search"
          }]
        })
      });

      const data = await response.json();
      
      let articleText = data.content
        .filter(item => item.type === 'text')
        .map(item => item.text)
        .join('\n');

      articleText = articleText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      
      const article = JSON.parse(articleText);
      
      if (article.title && article.url) {
        allArticles.push(article);
        console.log(`   ✅ Found: ${article.title}`);
      }

      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(`   ❌ Error searching "${query}":`, error.message);
    }
  }

  return allArticles;
}

async function pushToNotion(articles) {
  console.log('\n📤 Pushing to Notion...');
  
  const results = [];
  
  for (const article of articles) {
    try {
      const response = await notion.pages.create({
        parent: { database_id: NOTION_DATABASE_ID },
        properties: {
          Title: {
            title: [{ text: { content: article.title } }]
          },
          Description: {
            rich_text: [{ text: { content: article.description } }]
          },
          URL: {
            url: article.url
          },
          Source: {
            rich_text: [{ text: { content: article.source } }]
          },
          Date: {
            date: { start: article.date }
          }
        }
      });
      
      console.log(`   ✅ Pushed to Notion: ${article.title}`);
      results.push({ success: true, article: article.title });
    } catch (error) {
      console.error(`   ❌ Failed to push "${article.title}":`, error.message);
      results.push({ success: false, article: article.title, error: error.message });
    }
  }
  
  return results;
}

async function saveToMarkdown(articles) {
  console.log('\n📝 Saving to Markdown...');
  
  const date = new Date().toISOString().split('T')[0];
  const year = new Date().getFullYear();
  const month = String(new Date().getMonth() + 1).padStart(2, '0');
  
  let markdown = `# Israel Tech News - ${date}\n\n`;
  markdown += `> Daily curated tech news related to Israel, Israeli founders, startups, and companies.\n\n`;
  
  articles.forEach((article, index) => {
    markdown += `## ${index + 1}. ${article.title}\n\n`;
    markdown += `**Source:** ${article.source}  \n`;
    markdown += `**Date:** ${article.date}  \n`;
    markdown += `**Link:** [Read Full Article](${article.url})\n\n`;
    markdown += `${article.description}\n\n`;
    markdown += `---\n\n`;
  });
  
  const dir = path.join('articles', year.toString(), month);
  await fs.mkdir(dir, { recursive: true });
  
  const filename = path.join(dir, `${date}.md`);
  await fs.writeFile(filename, markdown);
  
  console.log(`   ✅ Saved to ${filename}`);
  
  await updateIndex(date, articles.length);
  
  return filename;
}

async function updateIndex(date, articleCount) {
  const indexPath = 'README.md';
  
  let content = '';
  try {
    content = await fs.readFile(indexPath, 'utf8');
  } catch {
    content = `# Israel Tech News Archive\n\nAutomated daily collection of Israel-related tech news.\n\n## Recent Updates\n\n`;
  }
  
  const newEntry = `- [${date}](./articles/${date.substring(0,4)}/${date.substring(5,7)}/${date}.md) - ${articleCount} articles\n`;
  
  if (!content.includes(newEntry)) {
    const lines = content.split('\n');
    const insertIndex = lines.findIndex(line => line.startsWith('- ['));
    
    if (insertIndex > -1) {
      lines.splice(insertIndex, 0, newEntry);
    } else {
      lines.push(newEntry);
    }
    
    await fs.writeFile(indexPath, lines.join('\n'));
    console.log('   ✅ Updated README.md');
  }
}

async function main() {
  console.log('🚀 Israel Tech News Agent Starting...\n');
  
  if (!NOTION_DATABASE_ID) {
    console.error('❌ NOTION_DATABASE_ID is required!');
    process.exit(1);
  }
  
  if (!ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY is required!');
    process.exit(1);
  }
  
  try {
    const articles = await searchForArticles();
    console.log(`\n✅ Found ${articles.length} articles total`);
    
    if (articles.length === 0) {
      console.log('⚠️  No articles found. Exiting.');
      return;
    }
    
    await saveToMarkdown(articles);
    
    const notionResults = await pushToNotion(articles);
    const successCount = notionResults.filter(r => r.success).length;
    
    console.log(`\n✅ Complete! ${successCount}/${articles.length} articles pushed to Notion`);
    
    await fs.writeFile(
      'last-run.json',
      JSON.stringify({
        date: new Date().toISOString(),
        articlesFound: articles.length,
        articlesPublished: successCount
      }, null, 2)
    );
    
  } catch (error) {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { searchForArticles, pushToNotion, saveToMarkdown };
