const express = require('express');
const puppeteer = require('puppeteer');
const app = express();

app.get('/', async (req, res) => {
  let input = req.query.q;
  if (!input) return res.status(400).send('Missing ?q=');

  // Convert search term to Wikipedia article if not a full URL
  if (!input.startsWith('http')) {
    input = 'https://en.wikipedia.org/wiki/' + encodeURIComponent(input);
  }

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
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36");
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

    await page.goto(input, { waitUntil: 'networkidle2', timeout: 60000 });

    // Rewrite links and forms to stay inside proxy
    await page.evaluate(() => {
      const rewrite = href => {
        if (!href || !href.startsWith('http')) return href;
        return '/?q=' + encodeURIComponent(href);
      };

      document.querySelectorAll('a').forEach(a => {
        a.href = rewrite(a.href);
      });

      document.querySelectorAll('form').forEach(form => {
        const action = form.getAttribute('action');
        if (action && action.startsWith('/')) {
          form.setAttribute('action', '/?q=' + encodeURIComponent('https://www.google.com' + action));
        } else if (action && action.startsWith('http')) {
          form.setAttribute('action', '/?q=' + encodeURIComponent(action));
        }
      });
    });

    const html = await page.content();
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
  console.log('🚀 Full JS Puppeteer proxy running');
});
