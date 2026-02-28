/**
 * PostSpark Screenshot Service — Railway
 *
 * Endpoints:
 *   GET  /health                 — liveness check
 *   POST /screenshot             — single page screenshot (PNG, backward compat)
 *   POST /screenshot/multi       — batch screenshots → JSON { screenshots: { [url]: base64 }, errors: {} }
 *   POST /screenshot/element     — element-level capture → JSON { elements: { [selector]: base64 }, notFound: [] }
 *   POST /discover               — discover internal pages → JSON { homepage, discoveredPages: [] }
 *
 * Architecture: Browser Pool — one Chromium instance kept alive, isolated
 * BrowserContexts per request (fast, ~50ms vs ~2-3s for full browser launch).
 */

const express = require('express');
const { chromium } = require('playwright');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ─── Browser Pool ──────────────────────────────────────────────────────────────

let browser = null;
let browserLaunchPromise = null; // mutex: prevents concurrent launches

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;

  // If already launching, wait for that promise instead of launching again
  if (browserLaunchPromise) {
    await browserLaunchPromise;
    if (browser && browser.isConnected()) return browser;
  }

  console.log('[pool] Launching Chromium browser...');
  const isLinux = process.platform === 'linux';

  browserLaunchPromise = chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      ...(isLinux ? ['--disable-dev-shm-usage', '--disable-gpu', '--single-process'] : []),
    ],
  }).then((b) => {
    browser = b;
    browser.on('disconnected', () => {
      console.warn('[pool] Browser disconnected — will relaunch on next request');
      browser = null;
    });
    console.log('[pool] Browser ready');
    return browser;
  }).finally(() => {
    browserLaunchPromise = null;
  });

  return browserLaunchPromise;
}

/** Close a context and its associated browser (Windows per-request mode) */
async function closeContext(ctx) {
  if (!ctx) return;
  await ctx.close().catch(() => {});
  if (ctx.__browser) await ctx.__browser.close().catch(() => {});
}

const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  ...(process.platform === 'linux' ? ['--disable-dev-shm-usage', '--disable-gpu', '--single-process'] : []),
];

const CONTEXT_OPTIONS = (viewport) => ({
  viewport,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  locale: 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  ignoreHTTPSErrors: true,
});

/**
 * Create an isolated browser context.
 * - Linux/Railway: reuses the shared browser pool (fast, ~50ms)
 * - Windows/dev: launches a fresh browser per-request (stable, ~2s)
 */
async function createContext(viewport = { width: 1440, height: 900 }) {
  if (process.platform === 'linux') {
    // Pool mode: reuse shared browser
    const b = await getBrowser();
    return b.newContext(CONTEXT_OPTIONS(viewport));
  }

  // Windows: fresh browser per request to avoid pool instability
  const b = await chromium.launch({ headless: true, args: BROWSER_ARGS });
  const ctx = await b.newContext(CONTEXT_OPTIONS(viewport));
  // Attach browser to context so it can be closed together
  ctx.__browser = b;
  return ctx;
}

// ─── Shared Helpers ───────────────────────────────────────────────────────────

/** Remove cookie banners, chat widgets, and other overlays */
const COOKIE_REMOVAL_SCRIPT = () => {
  const SELECTORS = [
    '[class*="cookie"]',
    '[class*="gdpr"]',
    '[class*="consent"]',
    '[class*="banner"]',
    '[id*="cookie"]',
    '[id*="gdpr"]',
    '[id*="consent"]',
    '.chat-widget',
    '[data-cookiebanner]',
    '#onetrust-consent-sdk',
    '.cc-window',
    '.cookielaw-bar',
  ];
  const remove = () => {
    SELECTORS.forEach((sel) => {
      try {
        document.querySelectorAll(sel).forEach((el) => el.remove());
      } catch (_) {}
    });
  };
  remove();
  setInterval(remove, 800);
};

/** Navigate a page with networkidle + extra wait */
async function navigatePage(page, url, waitMs = 1500) {
  // 'load' é mais estável que 'networkidle' em Windows/dev; Railway usa networkidle
  const waitUntil = process.platform === 'linux' ? 'networkidle' : 'load';
  await page.goto(url, { waitUntil, timeout: 30000 });
  await page.waitForTimeout(waitMs);
}

/** Priority keywords for page discovery */
const PAGE_PRIORITY = {
  high: ['/about', '/produto', '/product', '/servic', '/pricing', '/prec', '/contact', '/contato', '/team', '/equipe'],
  medium: ['/blog', '/news', '/case', '/client', '/work', '/portfolio'],
};

function classifyPagePriority(url) {
  const lowerUrl = url.toLowerCase();
  for (const kw of PAGE_PRIORITY.high) {
    if (lowerUrl.includes(kw)) return 'high';
  }
  for (const kw of PAGE_PRIORITY.medium) {
    if (lowerUrl.includes(kw)) return 'medium';
  }
  return 'low';
}

function inferLabel(url) {
  const path = new URL(url).pathname.replace(/\/$/, '');
  const segment = path.split('/').pop() || 'Home';
  return segment.charAt(0).toUpperCase() + segment.slice(1).replace(/[-_]/g, ' ');
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/** Health check */
app.get('/health', async (req, res) => {
  const browserAlive = browser ? browser.isConnected() : false;
  res.json({
    status: 'ok',
    browserAlive,
    timestamp: new Date().toISOString(),
  });
});

// ──────────────────────────────────────────────────────────────────────────────
/** POST /screenshot — single page, returns PNG (backward compatible) */
app.post('/screenshot', async (req, res) => {
  const { url, viewport = { width: 1440, height: 900 } } = req.body;
  if (!url) return res.status(400).json({ error: 'URL obrigatória' });

  let context = null;
  try {
    context = await createContext(viewport);
    const page = await context.newPage();
    await page.addInitScript(COOKIE_REMOVAL_SCRIPT);
    await navigatePage(page, url, 2000);
    const screenshot = await page.screenshot({ type: 'png' });

    res.setHeader('Content-Type', 'image/png');
    res.send(screenshot);
  } catch (error) {
    console.error('[/screenshot] Error:', error.message);
    res.status(500).json({ error: error.message });
  } finally {
    if (context) await closeContext(context);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
/**
 * POST /screenshot/multi — capture multiple pages in one batch
 *
 * Body: { urls: string[], viewport?: {width,height}, maxPages?: number }
 * Response: { screenshots: { [url]: base64string }, errors: { [url]: string } }
 */
app.post('/screenshot/multi', async (req, res) => {
  const { urls, viewport = { width: 1440, height: 900 }, maxPages = 5 } = req.body;

  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'Array "urls" obrigatório' });
  }

  const targets = urls.slice(0, maxPages);
  const screenshots = {};
  const errors = {};

  let context = null;
  try {
    context = await createContext(viewport);

    for (const url of targets) {
      const page = await context.newPage();
      try {
        await page.addInitScript(COOKIE_REMOVAL_SCRIPT);
        await navigatePage(page, url, 1500);
        const buffer = await page.screenshot({ type: 'png' });
        screenshots[url] = buffer.toString('base64');
        console.log(`[/screenshot/multi] ✓ ${url}`);
      } catch (err) {
        console.warn(`[/screenshot/multi] ✗ ${url}: ${err.message}`);
        errors[url] = err.message;
      } finally {
        await page.close().catch(() => {});
      }
    }

    res.json({ screenshots, errors });
  } catch (error) {
    console.error('[/screenshot/multi] Fatal error:', error.message);
    res.status(500).json({ error: error.message });
  } finally {
    if (context) await closeContext(context);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
/**
 * POST /screenshot/element — capture specific CSS selectors on a page
 *
 * Body: { url: string, selectors: string[], viewport?: {width,height} }
 * Response: { elements: { [selector]: base64string }, notFound: string[] }
 */
app.post('/screenshot/element', async (req, res) => {
  const { url, selectors, viewport = { width: 1440, height: 900 } } = req.body;

  if (!url) return res.status(400).json({ error: 'URL obrigatória' });
  if (!selectors || !Array.isArray(selectors) || selectors.length === 0) {
    return res.status(400).json({ error: 'Array "selectors" obrigatório' });
  }

  const elements = {};
  const notFound = [];

  let context = null;
  try {
    context = await createContext(viewport);
    const page = await context.newPage();
    await page.addInitScript(COOKIE_REMOVAL_SCRIPT);
    await navigatePage(page, url, 2000);

    for (const selector of selectors) {
      try {
        const locator = page.locator(selector).first();
        const count = await locator.count();
        if (count === 0) {
          notFound.push(selector);
          continue;
        }
        // Scroll into view before capturing
        await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        const buffer = await locator.screenshot({ type: 'png', timeout: 5000 });
        elements[selector] = buffer.toString('base64');
        console.log(`[/screenshot/element] ✓ ${selector}`);
      } catch (err) {
        console.warn(`[/screenshot/element] ✗ ${selector}: ${err.message}`);
        notFound.push(selector);
      }
    }

    res.json({ elements, notFound });
  } catch (error) {
    console.error('[/screenshot/element] Fatal error:', error.message);
    res.status(500).json({ error: error.message });
  } finally {
    if (context) await closeContext(context);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
/**
 * POST /discover — discover key internal pages from a homepage
 *
 * Body: { url: string, maxLinks?: number }
 * Response: { homepage: string, discoveredPages: [{url, label, priority}] }
 */
app.post('/discover', async (req, res) => {
  const { url, maxLinks = 10 } = req.body;
  if (!url) return res.status(400).json({ error: 'URL obrigatória' });

  let context = null;
  try {
    const base = new URL(url);
    context = await createContext({ width: 1440, height: 900 });
    const page = await context.newPage();
    await page.addInitScript(COOKIE_REMOVAL_SCRIPT);
    await navigatePage(page, url, 1500);

    // Extract all same-origin links from the rendered page
    const rawLinks = await page.evaluate((origin) => {
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      return anchors
        .map((a) => {
          try {
            const href = new URL(a.href, origin);
            if (href.origin !== origin) return null;
            const path = href.pathname;
            // Skip: root, hash-only, anchors, common asset paths, dynamic params
            if (path === '/' || path === '') return null;
            if (a.href.startsWith('#')) return null;
            if (/\.(pdf|jpg|jpeg|png|gif|svg|webp|ico|css|js|woff|woff2)$/i.test(path)) return null;
            if (/\/api\/|\/wp-json\/|\/admin\//i.test(path)) return null;
            return href.href.split('?')[0].split('#')[0]; // strip query + hash
          } catch (_) {
            return null;
          }
        })
        .filter(Boolean);
    }, base.origin);

    // Deduplicate
    const seen = new Set([url]);
    const unique = [];
    for (const link of rawLinks) {
      if (!seen.has(link)) {
        seen.add(link);
        unique.push(link);
      }
    }

    // Score and sort
    const scored = unique.map((pageUrl) => ({
      url: pageUrl,
      label: inferLabel(pageUrl),
      priority: classifyPagePriority(pageUrl),
    }));

    const priorityOrder = { high: 0, medium: 1, low: 2 };
    scored.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    const discoveredPages = scored.slice(0, maxLinks);

    console.log(`[/discover] Found ${discoveredPages.length} pages for ${url}`);
    res.json({ homepage: url, discoveredPages });
  } catch (error) {
    console.error('[/discover] Error:', error.message);
    res.status(500).json({ error: error.message });
  } finally {
    if (context) await closeContext(context);
  }
});

// ─── Startup ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`🚀 Screenshot service on port ${PORT}`);
  // Warm up the browser pool eagerly on startup
  try {
    await getBrowser();
    console.log('✅ Browser pool warmed up');
  } catch (err) {
    console.error('⚠️  Browser warm-up failed (will retry on first request):', err.message);
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[shutdown] Closing browser...');
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});
