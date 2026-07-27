// Identifies itself at the end, but leads with a real browser UA — a lot of sites
// 403 anything that doesn't look like a browser.
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36 Obsidian-auto-capture/1.0';

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const REQUEST_GAP_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ponytail: one gate per origin, in-process only. Enough for a single local user.
const nextAllowedAt = new Map();

/** Politeness gate. Exported so browser-rendered loads queue behind plain fetches too. */
export async function throttle(origin) {
  const now = Date.now();
  const at = Math.max(now, nextAllowedAt.get(origin) ?? 0);
  nextAllowedAt.set(origin, at + REQUEST_GAP_MS);
  if (at > now) await sleep(at - now);
}

/** GET a URL as text. Retries transient failures, gives up immediately on 4xx. */
export async function fetchText(rawUrl, { retries = 2, timeout = 20000 } = {}) {
  const origin = new URL(rawUrl).origin;
  let lastError = new Error('request failed');

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
    await throttle(origin);
    try {
      const res = await fetch(rawUrl, {
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout),
      });
      if (res.ok) {
        return {
          url: res.url || rawUrl,
          contentType: res.headers.get('content-type') ?? '',
          body: await res.text(),
        };
      }
      const err = new Error(`HTTP ${res.status} ${res.statusText}`.trim());
      if (!RETRYABLE.has(res.status)) throw Object.assign(err, { fatal: true });
      lastError = err;
    } catch (err) {
      if (err?.fatal) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError;
}

// Escape everything except `*` (wildcard) and a trailing `$` (end anchor).
function robotsPattern(rule) {
  const anchored = rule.endsWith('$');
  const body = (anchored ? rule.slice(0, -1) : rule)
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/**
 * Fetch and parse robots.txt for an origin.
 * Returns { isAllowed(pathname), sitemaps }. Unreachable robots.txt means allow-all.
 */
export async function loadRobots(origin) {
  let text = '';
  try {
    ({ body: text } = await fetchText(`${origin}/robots.txt`, { retries: 0, timeout: 8000 }));
  } catch {
    return { isAllowed: () => true, sitemaps: [] };
  }

  const rules = [];
  const sitemaps = [];
  let agents = [];
  let collectingAgents = false;

  for (const line of text.split(/\r?\n/)) {
    const stripped = line.replace(/#.*/, '').trim();
    const sep = stripped.indexOf(':');
    if (sep < 0) continue;
    const key = stripped.slice(0, sep).trim().toLowerCase();
    const value = stripped.slice(sep + 1).trim();
    if (!value) continue;

    if (key === 'user-agent') {
      if (!collectingAgents) agents = [];
      collectingAgents = true;
      agents.push(value.toLowerCase());
      continue;
    }
    collectingAgents = false;
    if (key === 'sitemap') sitemaps.push(value);
    else if ((key === 'allow' || key === 'disallow') && agents.includes('*')) {
      rules.push({ allow: key === 'allow', length: value.length, test: robotsPattern(value) });
    }
  }

  // Longest matching rule wins; Allow beats Disallow at equal length (per the spec).
  const isAllowed = (pathname) => {
    let winner = null;
    for (const rule of rules) {
      if (!rule.test.test(pathname)) continue;
      if (!winner || rule.length > winner.length || (rule.length === winner.length && rule.allow)) {
        winner = rule;
      }
    }
    return winner ? winner.allow : true;
  };

  return { isAllowed, sitemaps };
}
