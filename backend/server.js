// ─────────────────────────────────────────────────────────────────────────────
// Space Missions Dashboard — Backend Server
// Node.js · stdlib only (no npm dependencies)
//
// Usage:
//   1. cp .env.example .env  and add your Anthropic API key
//   2. node backend/server.js
//   3. Open http://localhost:3000
//
// API Endpoints:
//   GET  /api/missions                              → full dataset (JSON)
//   GET  /api/mission-count?company=NASA            → { result: number }
//   GET  /api/success-rate?company=SpaceX           → { result: float }
//   GET  /api/missions-by-date?start=YYYY-MM-DD&end=YYYY-MM-DD → { result: string[] }
//   GET  /api/top-companies?n=5                     → { result: [name, count][] }
//   GET  /api/mission-status-count                  → { result: object }
//   GET  /api/missions-by-year?year=2020            → { result: number }
//   GET  /api/most-used-rocket                      → { result: string }
//   GET  /api/average-missions-per-year?start=2010&end=2020 → { result: float }
//   POST /api/chat                                  → Anthropic proxy
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const http     = require('http');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const missions = require('./missions');

// ── Bootstrap ─────────────────────────────────────────────────────────────────

missions.loadData();

// ── Environment ───────────────────────────────────────────────────────────────

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, ...rest] = line.split('=');
    if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
  });
}
loadEnv();

const PORT     = process.env.PORT || 3000;
const API_KEY  = process.env.ANTHROPIC_API_KEY;
const MODEL    = 'claude-sonnet-4-20250514';

const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

// ── Helpers ───────────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.ico':  'image/x-icon',
  '.csv':  'text/csv',
};

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseQuery(url) {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  return Object.fromEntries(new URLSearchParams(url.slice(idx + 1)));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// ── API Routes ────────────────────────────────────────────────────────────────

async function handleAPI(req, res, urlPath) {
  const q = parseQuery(req.url);

  // Full dataset for the frontend dashboard
  if (urlPath === '/api/missions' && req.method === 'GET') {
    return json(res, 200, missions.getMissions());
  }

  // ── 8 Required Functions ──────────────────────────────────────────────────

  if (urlPath === '/api/mission-count' && req.method === 'GET') {
    return json(res, 200, { result: missions.getMissionCountByCompany(q.company) });
  }

  if (urlPath === '/api/success-rate' && req.method === 'GET') {
    return json(res, 200, { result: missions.getSuccessRate(q.company) });
  }

  if (urlPath === '/api/missions-by-date' && req.method === 'GET') {
    return json(res, 200, { result: missions.getMissionsByDateRange(q.start, q.end) });
  }

  if (urlPath === '/api/top-companies' && req.method === 'GET') {
    return json(res, 200, { result: missions.getTopCompaniesByMissionCount(q.n) });
  }

  if (urlPath === '/api/mission-status-count' && req.method === 'GET') {
    return json(res, 200, { result: missions.getMissionStatusCount() });
  }

  if (urlPath === '/api/missions-by-year' && req.method === 'GET') {
    return json(res, 200, { result: missions.getMissionsByYear(q.year) });
  }

  if (urlPath === '/api/most-used-rocket' && req.method === 'GET') {
    return json(res, 200, { result: missions.getMostUsedRocket() });
  }

  if (urlPath === '/api/average-missions-per-year' && req.method === 'GET') {
    return json(res, 200, { result: missions.getAverageMissionsPerYear(q.start, q.end) });
  }

  // ── AI Chat Proxy ─────────────────────────────────────────────────────────

  if (urlPath === '/api/chat' && req.method === 'POST') {
    if (!API_KEY) {
      return json(res, 503, { error: { message: 'ANTHROPIC_API_KEY not configured. See .env.example.' } });
    }
    try {
      const body = await readBody(req);
      proxyChat(JSON.parse(body), res);
    } catch (e) {
      json(res, 400, { error: { message: 'Invalid JSON body' } });
    }
    return;
  }

  json(res, 404, { error: `Unknown endpoint: ${urlPath}` });
}

// ── Anthropic Proxy ───────────────────────────────────────────────────────────

function proxyChat(body, res) {
  const payload = JSON.stringify({
    model:      MODEL,
    max_tokens: 1000,
    system:     body.system,
    messages:   body.messages,
  });

  const options = {
    hostname: 'api.anthropic.com',
    path:     '/v1/messages',
    method:   'POST',
    headers: {
      'Content-Type':      'application/json',
      'Content-Length':    Buffer.byteLength(payload),
      'x-api-key':         API_KEY,
      'anthropic-version': '2023-06-01',
    },
  };

  const req = https.request(options, apiRes => {
    let data = '';
    apiRes.on('data', chunk => (data += chunk));
    apiRes.on('end', () => {
      res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
      res.end(data);
    });
  });

  req.on('error', err => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: err.message } }));
  });

  req.write(payload);
  req.end();
}

// ── Static File Server ────────────────────────────────────────────────────────

function serveStatic(req, res, urlPath) {
  let filePath = urlPath === '/' ? '/index.html' : urlPath;
  filePath = path.join(FRONTEND_DIR, filePath);

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
  fs.createReadStream(filePath).pipe(res);
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlPath = req.url.split('?')[0];

  if (urlPath.startsWith('/api/')) {
    await handleAPI(req, res, urlPath);
  } else {
    serveStatic(req, res, urlPath);
  }
});

server.listen(PORT, () => {
  console.log(`\n  Space Missions Dashboard`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`\n  API endpoints:`);
  console.log(`  GET  /api/missions`);
  console.log(`  GET  /api/mission-count?company=NASA`);
  console.log(`  GET  /api/success-rate?company=SpaceX`);
  console.log(`  GET  /api/missions-by-date?start=YYYY-MM-DD&end=YYYY-MM-DD`);
  console.log(`  GET  /api/top-companies?n=5`);
  console.log(`  GET  /api/mission-status-count`);
  console.log(`  GET  /api/missions-by-year?year=2020`);
  console.log(`  GET  /api/most-used-rocket`);
  console.log(`  GET  /api/average-missions-per-year?start=2010&end=2020`);
  console.log(`  POST /api/chat\n`);
});
