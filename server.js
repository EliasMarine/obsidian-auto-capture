import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discover } from './discover.js';
import { captureAll, loadIndex } from './capture.js';
import { linkCapturedPages } from './wikilinks.js';
import { closeBrowser } from './render.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4571);
// OAC_CONFIG lets the container keep settings on a mounted volume instead of
// inside the image, where they'd vanish on every rebuild.
const CONFIG_FILE = process.env.OAC_CONFIG || path.join(HERE, 'config.json');
const MAX_BODY = 5 * 1024 * 1024;
const MAX_LOG = 400;

// ponytail: one job at a time, in memory. It's a single-user local tool.
let job = null;
const clients = new Set();

function emit(event) {
  if (job) {
    job.log.push(event);
    if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
  }
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(payload);
}

function startJob(type) {
  job = { type, status: 'running', log: [], cancelled: false };
  return job;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

/** The destination must sit inside a real Obsidian vault — walk up looking for .obsidian. */
async function validateDest(dest) {
  if (!dest || typeof dest !== 'string') return { ok: false, error: 'Destination folder is required.' };
  const abs = path.resolve(dest);
  let dir = abs;
  for (;;) {
    try {
      if ((await fs.stat(path.join(dir, '.obsidian'))).isDirectory()) {
        return { ok: true, dest: abs, vault: dir };
      }
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return { ok: false, error: 'No .obsidian folder found above this path — not an Obsidian vault.' };
    }
    dir = parent;
  }
}

const readConfig = async () => {
  let saved = {};
  try {
    saved = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
  } catch {
    // no config yet — fall through to the environment default
  }
  // The vault sits at a different path inside a container than on the host, so
  // the image supplies the destination rather than shipping a host path.
  return saved.dest ? saved : { ...saved, dest: process.env.OAC_DEFAULT_DEST ?? saved.dest };
};

const writeConfig = (config) =>
  fs.writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8').catch(() => {});

const json = (res, status, data) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};

const routes = {
  'GET /api/config': async (_req, res) => json(res, 200, await readConfig()),

  'POST /api/validate': async (req, res) => json(res, 200, await validateDest((await readJson(req)).dest)),

  'POST /api/discover': async (req, res) => {
    if (job?.status === 'running') return json(res, 409, { error: 'A job is already running.' });
    const { startUrl, dest, cap, scope } = await readJson(req);

    let origin;
    try {
      origin = new URL(startUrl).origin;
    } catch {
      return json(res, 400, { error: 'Enter a valid URL, e.g. https://example.com/docs' });
    }
    const destCheck = await validateDest(dest);
    if (!destCheck.ok) return json(res, 400, { error: destCheck.error });

    await writeConfig({ ...(await readConfig()), startUrl, dest: destCheck.dest, cap, scope });
    const current = startJob('discover');
    json(res, 202, { started: true, origin });

    discover(startUrl, {
      cap: Math.min(Math.max(Number(cap) || 500, 1), 5000),
      scope: scope || undefined,
      onLog: (message) => emit({ type: 'log', message }),
      shouldStop: () => current.cancelled,
    })
      .then(async (found) => {
        const index = await loadIndex(destCheck.dest);
        // Being in the index isn't enough — the note may have been deleted since.
        // Capture re-fetches those, so the review screen must not claim otherwise.
        const stillOnDisk = async (url) => {
          const entry = index.get(url);
          if (!entry) return false;
          try {
            await fs.access(path.resolve(destCheck.dest, entry.file));
            return true;
          } catch {
            return false;
          }
        };
        const urls = await Promise.all(
          found.map(async (item) => ({ ...item, captured: await stillOnDisk(item.url) })),
        );
        await closeBrowser();
        current.status = 'done';
        emit({ type: 'discovered', urls });
      })
      .catch(async (err) => {
        await closeBrowser();
        current.status = 'error';
        emit({ type: 'error', message: err.message });
      });
  },

  'POST /api/capture': async (req, res) => {
    if (job?.status === 'running') return json(res, 409, { error: 'A job is already running.' });
    const { urls, dest, includeImages, mode, wikilinks } = await readJson(req);
    if (!Array.isArray(urls) || urls.length === 0) return json(res, 400, { error: 'No pages selected.' });

    const destCheck = await validateDest(dest);
    if (!destCheck.ok) return json(res, 400, { error: destCheck.error });

    const captureMode = ['skip', 'update', 'overwrite'].includes(mode) ? mode : 'skip';
    const linkNotes = wikilinks !== false;
    await writeConfig({
      ...(await readConfig()),
      includeImages: Boolean(includeImages),
      mode: captureMode,
      wikilinks: linkNotes,
    });
    const current = startJob('capture');
    json(res, 202, { started: true, total: urls.length });

    captureAll(urls, {
      destRoot: destCheck.dest,
      includeImages: Boolean(includeImages),
      mode: captureMode,
      onResult: (result) => emit({ type: 'result', ...result }),
      shouldStop: () => current.cancelled,
    })
      .then(async ({ results, advice }) => {
        let linked = null;
        if (linkNotes && !current.cancelled) {
          emit({ type: 'log', message: 'linking captured pages to each other…' });
          linked = await linkCapturedPages({
            destRoot: destCheck.dest,
            vaultRoot: destCheck.vault,
            index: await loadIndex(destCheck.dest),
          }).catch(() => null);
        }
        await closeBrowser();
        current.status = 'done';
        emit({
          type: 'finished',
          saved: results.filter((r) => r.status === 'saved').length,
          updated: results.filter((r) => r.status === 'updated').length,
          skipped: results.filter((r) => r.status === 'skipped').length,
          failed: results.filter((r) => r.status === 'failed').length,
          advice,
          linked,
        });
      })
      .catch(async (err) => {
        await closeBrowser();
        current.status = 'error';
        emit({ type: 'error', message: err.message });
      });
  },

  'POST /api/cancel': async (_req, res) => {
    if (job) job.cancelled = true;
    json(res, 200, { cancelled: true });
  },

  'GET /api/events': async (_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    // Replay only a live job, so reconnecting mid-crawl resumes but a fresh load starts clean.
    if (job?.status === 'running') {
      for (const event of job.log) res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    clients.add(res);
    res.on('close', () => clients.delete(res));
  },
};

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;
  const handler = routes[`${req.method} ${pathname}`];

  try {
    if (handler) return await handler(req, res);
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const html = await fs.readFile(path.join(HERE, 'public', 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    json(res, 404, { error: 'Not found' });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

// Localhost only — this thing writes to your vault, it has no business on the network.
// In a container that has to be 0.0.0.0 to reach the published port; the exposure
// is still limited to the host's loopback by the "127.0.0.1:4571:4571" binding.
server.listen(PORT, process.env.OAC_HOST || '127.0.0.1', () => {
  process.stdout.write(`Obsidian auto-capture → http://127.0.0.1:${PORT}\n`);
});
