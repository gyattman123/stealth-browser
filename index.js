const express = require('express');
const puppeteer = require('puppeteer');
const https = require('https');
const app = express();

const isAsset = url => /\.(png|jpe?g|gif|webp|svg|ico|mp4|webm|mp3|wav|ogg|css|js|woff2?|ttf|otf)(\?.*)?$/i.test(url);

app.get('/', async (req, res) => {
  let input = req.query.q;
  if (!input) return res.status(400).send('Missing ?q=');

  input = decodeURIComponent(input);

  if (!input.startsWith('http')) {
    input = 'https://en.wikipedia.org/wiki/' + encodeURIComponent(input);
  }

  if (isAsset(input)) {
    try {
      https.get(input, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Referer': 'https://en.wikipedia.org',
          'Accept-Encoding': 'identity'
        }
      }, stream => {
        res.setHeader('Content-Type', stream.headers['content-type'] || 'application/octet-stream');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        stream.pipe(res);
      }).on('error', err => {
        console.error('Asset stream error:', err.message);
        res.status(500).send('Asset stream failed');
      });
      return;
    } catch (err) {
      console.error('Asset error:', err.message);
      return res.status(500).send('Asset proxy error');
    }
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-features=site-per-process',
        '--disable-extensions',
        '--disable-background-networking',
        '--single-process'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36");
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

    await page.goto(input, { waitUntil: 'domcontentloaded', timeout: 30000 });

    await page.evaluate(() => {
      const rewrite = url => {
        if (!url) return url;
        if (url.startsWith('//')) return '/?q=' + encodeURIComponent('https:' + url);
        if (url.startsWith('/')) return '/?q=' + encodeURIComponent(location.origin + url);
        if (url.startsWith('http')) return '/?q=' + encodeURIComponent(url);
        return url;
      };

      document.querySelectorAll('a').forEach(a => {
        a.href = rewrite(a.href);
      });

      document.querySelectorAll('form').forEach(form => {
        const action = form.getAttribute('action');
        if (action) form.setAttribute('action', rewrite(action));
      });

      document.querySelectorAll('img').forEach(img => {
        const src = img.getAttribute('src');
        if (src) img.setAttribute('src', rewrite(src));
      });

      document.querySelectorAll('img[data-src]').forEach(img => {
        const raw = img.getAttribute('data-src');
        if (raw) {
          const rewritten = rewrite(raw);
          img.setAttribute('src', rewritten);
          img.removeAttribute('data-src');
        }
      });

      document.querySelectorAll('[data-srcset]').forEach(el => {
        const raw = el.getAttribute('data-srcset');
        if (raw) {
          const updated = raw.split(',').map(part => {
            const [url, scale] = part.trim().split(' ');
            const proxied = '/?q=' + encodeURIComponent(url.startsWith('//') ? 'https:' + url : url);
            return scale ? `${proxied} ${scale}` : proxied;
          }).join(', ');
          el.setAttribute('srcset', updated);
          el.removeAttribute('data-srcset');
        }
      });

      document.querySelectorAll('[srcset]').forEach(el => {
        const raw = el.getAttribute('srcset');
        if (raw) {
          const updated = raw.split(',').map(part => {
            const [url, scale] = part.trim().split(' ');
            const proxied = '/?q=' + encodeURIComponent(url.startsWith('//') ? 'https:' + url : url);
            return scale ? `${proxied} ${scale}` : proxied;
          }).join(', ');
          el.setAttribute('srcset', updated);
        }
      });

      document.querySelectorAll('source[srcset]').forEach(source => {
        const raw = source.getAttribute('srcset');
        if (raw) {
          const updated = raw.split(',').map(part => {
            const [url, scale] = part.trim().split(' ');
            const proxied = '/?q=' + encodeURIComponent(url.startsWith('//') ? 'https:' + url : url);
            return scale ? `${proxied} ${scale}` : proxied;
          }).join(', ');
          source.setAttribute('srcset', updated);
        }
      });

      document.querySelectorAll('[style]').forEach(el => {
        const style = el.getAttribute('style');
        if (style && style.includes('url(')) {
          const updated = style.replace(/url\(["']?(https?:\/\/[^"')]+)["']?\)/g, (match, url) => {
            return `url("/?q=${encodeURIComponent(url)}")`;
          });
          el.setAttribute('style', updated);
        }
      });

      document.querySelectorAll('video, audio, iframe, link[rel="stylesheet"], script[src]').forEach(tag => {
        const attr = tag.tagName === 'LINK' ? 'href' : 'src';
        const val = tag.getAttribute(attr);
        if (val) tag.setAttribute(attr, rewrite(val));
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
  console.log('🚀 Full containment proxy running with Puppeteer v24+');
});
