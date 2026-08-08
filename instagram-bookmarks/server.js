// ─────────────────────────────────────────────────────────────────────────────
// Instagram Bookmarks — backend
// Node.js · stdlib only (no npm dependencies)
//
// Usage:  node instagram-bookmarks/server.js   → http://localhost:4000
//
// API:
//   GET    /api/bookmarks                → { items: [...] }
//   POST   /api/bookmarks   {url}        → { item }            (202 while enriching)
//   PATCH  /api/bookmarks/:id {dimmed?, caption?, author?}
//   DELETE /api/bookmarks/:id
//   POST   /api/bookmarks/:id/move {index}
//   POST   /api/bookmarks/:id/refresh    → retry metadata fetch
//   POST   /api/reorder     {ids:[...]}  → apply a full ordering
//   POST   /api/import      (raw file body, ?filename=saved_posts.json)
//   GET    /media/:file                  → cached thumbnails
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const store    = require('./lib/store');
const metadata = require('./lib/metadata');
const importer = require('./lib/importer');

const PORT      = Number(process.env.PORT || 4000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY  = 25 * 1024 * 1024;   // generous: DYI exports can be chunky

store.load();

// ── Helpers ───────────────────────────────────────────────────────────────────

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const body = await readBody(req);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { status: 400 });
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon'
};

// Serve a file from `root`, refusing anything that escapes it.
function serveFile(res, root, relative, { immutable = false } = {}) {
  const target = path.resolve(root, '.' + path.posix.resolve('/', relative));
  if (target !== root && !target.startsWith(root + path.sep)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) return sendJson(res, 404, { error: 'not found' });

    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache'
    });
    fs.createReadStream(target).pipe(res);
  });
}

// Metadata fetches run detached so the UI gets its card immediately.
function enrichInBackground(id) {
  metadata.enrich(id).catch(err => console.error(`[enrich] ${id}: ${err.message}`));
}

// ── Routes ────────────────────────────────────────────────────────────────────

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/api/bookmarks' && method === 'GET') {
    return sendJson(res, 200, { items: store.all() });
  }

  if (pathname === '/api/bookmarks' && method === 'POST') {
    const { url: input } = await readJson(req);
    const parsed = metadata.parseUrl(input);
    if (!parsed) {
      return sendJson(res, 400, {
        error: "That doesn't look like an Instagram post link. Expected something like https://www.instagram.com/p/ABC123/"
      });
    }

    const existing = store.findByShortcode(parsed.shortcode);
    if (existing) return sendJson(res, 409, { error: 'Already in your library', item: existing });

    const item = store.add({ ...parsed, source: 'url' });
    enrichInBackground(item.id);
    return sendJson(res, 202, { item });
  }

  const idMatch = pathname.match(/^\/api\/bookmarks\/([A-Za-z0-9_]+)(?:\/(move|refresh))?$/);
  if (idMatch) {
    const [, id, action] = idMatch;
    if (!store.find(id)) return sendJson(res, 404, { error: 'not found' });

    if (!action && method === 'PATCH') {
      const patch = await readJson(req);
      const clean = {};
      if (typeof patch.dimmed  === 'boolean') clean.dimmed  = patch.dimmed;
      if (typeof patch.caption === 'string')  clean.caption = patch.caption.slice(0, 5000);
      if (typeof patch.author  === 'string')  clean.author  = patch.author.slice(0, 60);
      return sendJson(res, 200, { item: store.update(id, clean) });
    }

    if (!action && method === 'DELETE') {
      return sendJson(res, 200, { item: store.remove(id) });
    }

    if (action === 'move' && method === 'POST') {
      const { index } = await readJson(req);
      if (!Number.isFinite(index)) return sendJson(res, 400, { error: 'index must be a number' });
      return sendJson(res, 200, { item: store.move(id, index) });
    }

    if (action === 'refresh' && method === 'POST') {
      store.update(id, { thumbState: 'pending' });
      enrichInBackground(id);
      return sendJson(res, 202, { item: store.find(id) });
    }

    return sendJson(res, 405, { error: 'method not allowed' });
  }

  if (pathname === '/api/reorder' && method === 'POST') {
    const { ids } = await readJson(req);
    if (!Array.isArray(ids)) return sendJson(res, 400, { error: 'ids must be an array' });
    return sendJson(res, 200, { items: store.reorder(ids) });
  }

  if (pathname === '/api/import' && method === 'POST') {
    const body = await readBody(req);
    const filename = url.searchParams.get('filename') || '';

    let parsed;
    try {
      parsed = importer.parse(body.toString('utf8'), filename);
    } catch (err) {
      return sendJson(res, 400, { error: `Could not read that file: ${err.message}` });
    }

    const added = [];
    let duplicates = 0;
    for (const entry of parsed.entries) {
      if (store.findByShortcode(entry.shortcode)) { duplicates++; continue; }
      added.push(store.add(entry));
    }

    // Enrich a few at a time so an import of hundreds doesn't open hundreds
    // of sockets at once.
    (async () => {
      for (const item of added) {
        await metadata.enrich(item.id).catch(() => {});
      }
    })();

    return sendJson(res, 200, {
      added: added.length,
      duplicates,
      skipped: parsed.skipped,
      items: store.all()
    });
  }

  return sendJson(res, 404, { error: 'unknown endpoint' });
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, url);

    if (pathname.startsWith('/media/')) {
      return serveFile(res, store.MEDIA_DIR, pathname.slice('/media'.length), { immutable: true });
    }

    // Android share-target: the share sheet POSTs (or GETs) here; bounce the
    // shared text back into the UI, which picks it up and adds it.
    if (pathname === '/share') {
      let shared = url.searchParams.get('url') || url.searchParams.get('text') || '';
      if (req.method === 'POST') {
        const body = (await readBody(req)).toString('utf8');
        const fields = new URLSearchParams(body);
        shared = fields.get('url') || fields.get('text') || shared;
      }
      res.writeHead(303, { Location: '/?add=' + encodeURIComponent(shared) });
      return res.end();
    }

    if (pathname === '/') return serveFile(res, PUBLIC_DIR, 'index.html');
    return serveFile(res, PUBLIC_DIR, pathname);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error('[server]', err);
    if (!res.headersSent) sendJson(res, status, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Instagram Bookmarks → http://localhost:${PORT}`);
  console.log(`Library: ${store.STORE_FILE} (${store.all().length} bookmarks)`);
});

// Make sure a pending debounced write lands before we exit.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    store.flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}

module.exports = server;
