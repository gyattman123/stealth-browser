const express = require('express');
const puppeteer = require('puppeteer');
const app = express();

app.get('/', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('Missing ?url=');

  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36");
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    const html = await page.content();
    await browser.close();

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    res.status(500).send(`Error: ${err.message}`);
  }
});

app.listen(process.env.PORT || 3000, () => console.log('🚀 Puppeteer proxy running'));
