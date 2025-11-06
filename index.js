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
          'User-Agent': 'Mozilla/5.0',
          'Accept': '*/*',
          'Referer': 'https://en.wikipedia.org',
          'Accept-Encoding': 'identity'
        }
      }, stream => {
        res.removeHeader('Content-Security-Policy');
        res.removeHeader('Content-Security-Policy-Report-Only');
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

    await page.goto(input, { waitUntil: 'networkidle2', timeout: 30000 });

    await page.evaluate(() => {
      const rewrite = url => {
        if (!url) return url;
        if (url.startsWith('//')) return '/?q=' + encodeURIComponent('https:' + url);
        if (url.startsWith('/')) return '/?q=' + encodeURIComponent(location.origin + url);
        if (url.startsWith('http')) return '/?q=' + encodeURIComponent(url);
        return url;
      };

      // Static rewrites
      document.querySelectorAll('a').forEach(a => a.href = rewrite(a.href));
      document.querySelectorAll('form').forEach(f => f.action = rewrite(f.action));
      document.querySelectorAll('img').forEach(img => {
        const raw = img.getAttribute('src');
        if (raw) {
          const rewritten = rewrite(raw);
          img.setAttribute('src', rewritten);
          img.src = rewritten;
        }
      });
      document.querySelectorAll('img[data-src]').forEach(img => {
        const raw = img.getAttribute('data-src');
        if (raw) {
          const rewritten = rewrite(raw);
          img.setAttribute('src', rewritten);
          img.src = rewritten;
          img.removeAttribute('data-src');
        }
      });
      document.querySelectorAll('[data-srcset], [srcset]').forEach(el => {
        const raw = el.getAttribute('data-srcset') || el.getAttribute('srcset');
        if (raw) {
          const updated = raw.split(',').map(part => {
            const [url, scale] = part.trim().split(' ');
            const proxied = rewrite(url);
            return scale ? `${proxied} ${scale}` : proxied;
          }).join(', ');
          el.setAttribute('srcset', updated);
          el.removeAttribute('data-srcset');
        }
      });
      document.querySelectorAll('source[srcset]').forEach(source => {
        const raw = source.getAttribute('srcset');
        if (raw) {
          const updated = raw.split(',').map(part => {
            const [url, scale] = part.trim().split(' ');
            const proxied = rewrite(url);
            return scale ? `${proxied} ${scale}` : proxied;
          }).join(', ');
          source.setAttribute('srcset', updated);
        }
      });
      document.querySelectorAll('[style]').forEach(el => {
        const style = el.getAttribute('style');
        if (style && style.includes('url(')) {
          const updated = style.replace(/url\(["']?(https?:\/\/[^"')]+)["']?\)/g, (_, url) => {
            return `url("${rewrite(url)}")`;
          });
          el.setAttribute('style', updated);
        }
      });
      document.querySelectorAll('video, audio, iframe, link[rel="stylesheet"], script[src]').forEach(tag => {
        const attr = tag.tagName === 'LINK' ? 'href' : 'src';
        const val = tag.getAttribute(attr);
        if (val) tag.setAttribute(attr, rewrite(val));
      });

      // Dynamic containment patch
      window.fetch = (orig => (...args) => {
        if (args[0] && typeof args[0] === 'string' && args[0].startsWith('http')) {
          args[0] = rewrite(args[0]);
        }
        return orig(...args);
      })(window.fetch);

      window.XMLHttpRequest = class extends XMLHttpRequest {
        open(method, url, ...rest) {
          if (url && typeof url === 'string' && url.startsWith('http')) {
            url = rewrite(url);
          }
          super.open(method, url, ...rest);
        }
      };

      window.Image = class extends Image {
        constructor(...args) {
          super(...args);
          Object.defineProperty(this, 'src', {
            set: val => {
              if (val && typeof val === 'string' && val.startsWith('http')) {
                val = rewrite(val);
              }
              super.src = val;
            }
          });
        }
      };

      // MutationObserver for late image loads
      new MutationObserver(mutations => {
        mutations.forEach(m => {
          m.addedNodes.forEach(node => {
            if (node.tagName === 'IMG') {
              const raw = node.getAttribute('src');
              if (raw && !raw.startsWith('/?q=')) {
                const rewritten = rewrite(raw);
                node.setAttribute('src', rewritten);
                node.src = rewritten;
              }
            }
          });
        });
      }).observe(document.body, { childList: true, subtree: true });
    });

    const html = await page.content();
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    console.error(`Navigation error: ${err.message}`);
    res.status(502).send(`Navigation failed: ${err.message}`);
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log('🚀 Proxy running with full containment, CSP stripping, and crashout resistance');
});
