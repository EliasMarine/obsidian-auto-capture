import { chromium } from 'playwright-core';
import { USER_AGENT, throttle } from './fetcher.js';

// Prefer a browser that's already on the machine over a 150MB Playwright download.
const CHANNELS = ['chrome', 'msedge', 'chromium'];
// Images, fonts and media are never kept, and they're most of a page's bytes.
const SKIP_TYPES = new Set(['image', 'font', 'media']);

let browser = null;
let launching = null;
let unavailable = null;

async function launch() {
  const failures = [];

  // In a container there's no Chrome to borrow, so the image points this at the
  // Chromium it installed. --no-sandbox is required there: the container is the
  // sandbox, and Chromium's own needs privileges we deliberately don't grant.
  const explicitPath = process.env.OAC_BROWSER_PATH;
  if (explicitPath) {
    try {
      return await chromium.launch({
        executablePath: explicitPath,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      });
    } catch (err) {
      failures.push(`${explicitPath}: ${err.message.split('\n')[0]}`);
    }
  }

  for (const channel of CHANNELS) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch (err) {
      failures.push(`${channel}: ${err.message.split('\n')[0]}`);
    }
  }
  try {
    return await chromium.launch({ headless: true });
  } catch (err) {
    failures.push(`bundled: ${err.message.split('\n')[0]}`);
  }
  throw new Error(`no usable browser found (${failures.join(' | ')})`);
}

/** One browser per run — launching costs ~1.5s, each page after that ~0.3s. */
async function getBrowser() {
  // Escape hatch: OAC_NO_RENDER=1 keeps this a pure HTTP tool, no browser launched.
  if (process.env.OAC_NO_RENDER) throw new Error('rendering disabled (OAC_NO_RENDER)');
  if (browser?.isConnected()) return browser;
  if (unavailable) throw unavailable;

  launching ??= launch()
    .then((launched) => {
      browser = launched;
      launching = null;
      return launched;
    })
    .catch((err) => {
      launching = null;
      unavailable = err;
      throw err;
    });
  return launching;
}

/**
 * Load a URL in a real browser and return the HTML *after* scripts have run.
 * Only worth calling when the plain HTTP response turned out to be an empty shell.
 */
export async function renderHtml(url, { timeout = 30000 } = {}) {
  const instance = await getBrowser();
  await throttle(new URL(url).origin);

  const context = await instance.newContext({ userAgent: USER_AGENT });
  try {
    const page = await context.newPage();
    await page.route('**/*', (route) =>
      SKIP_TYPES.has(route.request().resourceType()) ? route.abort() : route.continue(),
    );
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    // Client-rendered pages paint after their data arrives; give the network a
    // moment to go quiet, but never block the whole capture on a chatty page.
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    return { url: page.url(), contentType: 'text/html', body: await page.content() };
  } finally {
    await context.close().catch(() => {});
  }
}

/** Shut the browser down between jobs so Chrome isn't left running. */
export async function closeBrowser() {
  const instance = browser;
  browser = null;
  unavailable = null;
  if (instance) await instance.close().catch(() => {});
}
