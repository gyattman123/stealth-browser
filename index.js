const express = require('express');
const { chromium } = require('playwright');
const https = require('https');
const app = express();

/**
 * Basic asset detection by extension.
 * You can expand this if needed (e.g., avif, bmp).
 */
const isAsset = url =>
  /\.(png|jpe?g|gif|webp|svg|ico|mp4|webm|mp3|wav|ogg|css|js|woff2?|ttf|otf)(\?.*)?$/i.test(url);

/**
 * Stream assets directly to the client with permissive CORS.
 * Keeps images/styles/fonts from cross-origin hosts (e.g., upload.wikimedia.org) working.
 */
function streamAsset(input, res) {
  https
    .get(
      input,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: '*/*',
          Referer: 'https://en.wikipedia.org',
          'Accept-Encoding': 'identity'
        }
      },
      stream => {
        res.setHeader('Content-Type', stream.headers['content-type'] || 'application/octet-stream');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        stream.pipe(res);
      }
    )
    .on('error', err => {
      console.error('Asset stream error:', err.message);
      res.status(500).send('Asset stream failed');
    });
}

/**
 * Rewriter for absolute/relative URLs to route through our proxy.
 */
function rewriteUrl(url, origin) {
  if (!url) return url;
  if (url.startsWith('//')) return '/?q=' + encodeURIComponent('https:' + url);
  if (url.startsWith('/')) return '/?q=' + encodeURIComponent(origin + url);
  if (/^https?:\/\//i.test(url)) return '/?q=' + encodeURIComponent(url);
  return url;
}

app.get('/', async (req, res) => {
  let input = req.query.q;
  if (!input) return res.status(400).send('Missing ?q=');

  input = decodeURIComponent(input);

  // Default to a Wikipedia article if a bare term is provided
  if (!/^https?:\/\//i.test(input)) {
    input = 'https://en.wikipedia.org/wiki/' + encodeURIComponent(input);
  }

  // Direct asset passthrough
  if (isAsset(input)) {
    return streamAsset(input, res);
  }

  let browser;
  try {
    // Launch Playwright Chromium
    browser = await chromium.launch({ headless: true });

    // Use a context to control UA/locale; avoids per-page overrides and is cleaner.
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      locale: 'en-US'
    });
    const page = await context.newPage();

    // Intercept requests for performance and containment.
    await page.route('**/*', route => {
      const req = route.request();
      const type = req.resourceType();

      // Block purely cosmetic heavy resources to reduce load (fonts).
      if (type === 'font') return route.abort();

      // Let everything else through; DOM-level rewriting will proxy URLs in the rendered HTML.
      return route.continue();
    });

    // Navigate and wait for network to settle.
    await page.goto(input, { waitUntil: 'networkidle' });

    // Inject a permissive CSP meta in case the page enforces CSP via meta tag.
    await page.addScriptTag({
      content:
        "(() => { const m = document.createElement('meta'); m.httpEquiv='Content-Security-Policy'; m.content=\"default-src * 'unsafe-inline' 'unsafe-eval' data: blob:\"; document.head && document.head.appendChild(m); })();"
    });

    // Containment + URL rewriting in the DOM and runtime.
    await page.evaluate(origin => {
      const proxify = url => rewriteUrl(url, origin);

      function rewriteUrl(url, origin) {
        if (!url) return url;
        if (url.startsWith('//')) return '/?q=' + encodeURIComponent('https:' + url);
        if (url.startsWith('/')) return '/?q=' + encodeURIComponent(origin + url);
        if (/^https?:\/\//i.test(url)) return '/?q=' + encodeURIComponent(url);
        return url;
      }

      // Static DOM rewrites
      document.querySelectorAll('a').forEach(a => (a.href = proxify(a.href)));
      document.querySelectorAll('form').forEach(f => (f.action = proxify(f.action)));

      document.querySelectorAll('img').forEach(img => {
        const raw = img.getAttribute('src');
        if (raw) {
          const rewritten = proxify(raw);
          img.setAttribute('src', rewritten);
          img.src = rewritten;
        }
      });

      document.querySelectorAll('img[data-src]').forEach(img => {
        const raw = img.getAttribute('data-src');
        if (raw) {
          const rewritten = proxify(raw);
          img.setAttribute('src', rewritten);
          img.src = rewritten;
          img.removeAttribute('data-src');
        }
      });

      document.querySelectorAll('[data-srcset], [srcset]').forEach(el => {
        const raw = el.getAttribute('data-srcset') || el.getAttribute('srcset');
        if (raw) {
          const updated = raw
            .split(',')
            .map(part => {
              const [u, scale] = part.trim().split(/\s+/);
              const p = proxify(u);
              return scale ? `${p} ${scale}` : p;
            })
            .join(', ');
          el.setAttribute('srcset', updated);
          el.removeAttribute('data-srcset');
        }
      });

      document.querySelectorAll('source[srcset]').forEach(source => {
        const raw = source.getAttribute('srcset');
        if (raw) {
          const updated = raw
            .split(',')
            .map(part => {
              const [u, scale] = part.trim().split(/\s+/);
              const p = proxify(u);
              return scale ? `${p} ${scale}` : p;
            })
            .join(', ');
          source.setAttribute('srcset', updated);
        }
      });

      // Inline style url(...) rewrites
      document.querySelectorAll('[style]').forEach(el => {
        const style = el.getAttribute('style') || '';
        if (style.includes('url(')) {
          const updated = style.replace(
            /url\(\s*["']?(https?:\/\/[^"')]+)["']?\s*\)/g,
            (_, u) => `url("${proxify(u)}")`
          );
          el.setAttribute('style', updated);
        }
      });

      // Media/iframe/script/link src rewrites
      document
        .querySelectorAll('video, audio, iframe, link[rel="stylesheet"], script[src]')
        .forEach(tag => {
          const attr = tag.tagName === 'LINK' ? 'href' : 'src';
          const val = tag.getAttribute(attr);
          if (val) tag.setAttribute(attr, proxify(val));
        });

      // Runtime containment: fetch / XHR / Image
      const origFetch = window.fetch;
      window.fetch = (...args) => {
        if (typeof args[0] === 'string' && /^https?:\/\//i.test(args[0])) {
          args[0] = proxify(args[0]);
        }
        return origFetch(...args);
      };

      const OrigXHR = window.XMLHttpRequest;
      window.XMLHttpRequest = class extends OrigXHR {
        open(method, url, ...rest) {
          if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
            url = proxify(url);
          }
          return super.open(method, url, ...rest);
        }
      };

      const OrigImage = window.Image;
      window.Image = class extends OrigImage {
        constructor(...args) {
          super(...args);
          Object.defineProperty(this, 'src', {
            configurable: true,
            enumerable: true,
            get: () => super.src,
            set: val => {
              if (typeof val === 'string' && /^https?:\/\//i.test(val)) {
                val = proxify(val);
              }
              super.src = val;
            }
          });
        }
      };

      // Patch MediaWiki dynamic script loader minimally
      const mw = (window.mw = window.mw || {});
      mw.loader = mw.loader || {};
      const origLoad = mw.loader.load;
      mw.loader.load = function (urlOrModule) {
        // If MediaWiki calls loader with a URL, proxify it
        if (typeof urlOrModule === 'string' && /^https?:\/\//i.test(urlOrModule)) {
          const s = document.createElement('script');
          s.src = proxify(urlOrModule);
          document.head.appendChild(s);
          return;
        }
        // Fall back to original if present (module names etc.)
        if (typeof origLoad === 'function') return origLoad.apply(this, arguments);
      };

      // Trap late-added IMG nodes for lazy-loading frameworks
      new MutationObserver(mutations => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node && node.nodeType === 1) {
              if (node.tagName === 'IMG') {
                const raw = node.getAttribute('src');
                if (raw && !raw.startsWith('/?q=')) {
                  const r = proxify(raw);
                  node.setAttribute('src', r);
                  node.src = r;
                }
                const ds = node.getAttribute('data-src');
                if (ds) {
                  const r2 = proxify(ds);
                  node.setAttribute('src', r2);
                  node.src = r2;
                  node.removeAttribute('data-src');
                }
                const ss = node.getAttribute('srcset');
                if (ss) {
                  const upd = ss
                    .split(',')
                    .map(part => {
                      const [u, scale] = part.trim().split(/\s+/);
                      const p = proxify(u);
                      return scale ? `${p} ${scale}` : p;
                    })
                    .join(', ');
                  node.setAttribute('srcset', upd);
                }
              } else {
                // Rewrite common URL-bearing attributes on other nodes
                ['src', 'href'].forEach(attr => {
                  const v = node.getAttribute && node.getAttribute(attr);
                  if (v && /^https?:\/\//i.test(v)) {
                    node.setAttribute(attr, proxify(v));
                  }
                });
              }
            }
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    }, new URL(input).origin);

    // Return rendered HTML
    const html = await page.content();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('Navigation error:', err.message);
    res.status(502).send(`Navigation failed: ${err.message}`);
  } finally {
    if (browser) await browser.close();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Playwright proxy listening on port ${PORT}`);
});
