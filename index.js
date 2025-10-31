const express = require('express');
const puppeteer = require('puppeteer');
const app = express();

app.get('/', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('Missing ?url=');

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-features=site-per-process',
        '--single-process'
      ]
    });

    const page = await browser.newPage();

    // Set headers for stealth
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36");
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

    // Load the page
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 3000)); // Let JS settle

    // Rewrite links and forms to stay inside proxy
    await page.evaluate(() => {
      const rewrite = href => {
        if (!href || !href.startsWith('http')) return href;
        return '/?url=' + encodeURIComponent(href);
      };

      document.querySelectorAll('a').forEach(a => {
        a.href = rewrite(a.href);
      });

      document.querySelectorAll('form').forEach(form => {
        const action = form.getAttribute('action');
        if (action && action.startsWith('http')) {
          form.setAttribute('action', '/?url=' + encodeURIComponent(action));
        }
      });
    });

    // Get HTML and sanitize it
    let html = await page.content();
    html = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // Remove all scripts
      .replace(/<meta[^>]*http-equiv=["']?refresh["']?[^>]*>/gi, ''); // Remove meta refresh

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    console.error(`Navigation error: ${err.message}`);
    res.status(504).send(`Navigation failed: ${err.message}`);
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log('🚀 Puppeteer proxy with full sanitization running');
});
