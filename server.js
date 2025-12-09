/**
 * server.js
 * Single-file Node.js server to serve static site + simple projects API (file-backed).
 * - Uses `project.json` (singular) for storage
 * - Migrates legacy `projects.json` automatically (if present)
 * - Endpoints:
 *    GET  /api/projects
 *    POST /api/projects
 *    DELETE /api/projects/:id
 *    POST /api/reset
 * - Serves static files from the current working directory
 *
 * Usage:
 *   node server.js
 *
 * Note: for local dev only. Do not expose this to the public internet without proper security.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const HOST = '0.0.0.0';
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const PUBLIC_DIR = process.cwd();
const DATA_FILE = path.join(PUBLIC_DIR, 'project.json');    // singular
const LEGACY_FILE = path.join(PUBLIC_DIR, 'projects.json'); // legacy fallback

// Sample projects (used to initialize/reset)
const SAMPLE_PROJECTS = [
  {
    id: 'sample_eth_token',
    title: 'Token Sale Smart Contract',
    budget: '$1,200 - $2,500',
    skills: 'solidity,hardhat,security',
    desc: 'Create an audited ERC-20 token sale contract with vesting and whitelist. Deliver tests and deployment scripts.',
    created: Date.now() - 1000 * 60 * 60 * 24 * 4,
    owner: '0xAbC1234aBcD5678EfF0123456789aBcDEF012345'
  },
  {
    id: 'sample_nft_market',
    title: 'NFT Marketplace Frontend',
    budget: '$800 - $1,800',
    skills: 'react,nextjs,ethers.js,ipfs',
    desc: 'Build a responsive marketplace (React) that connects to smart contracts, supports wallet connect and IPFS-hosted metadata.',
    created: Date.now() - 1000 * 60 * 60 * 24 * 2,
    owner: '0xDeF4567DeF8901AbC234567890abcDeF45678901'
  },
  {
    id: 'sample_audit',
    title: 'Smart Contract Security Audit (Small)',
    budget: '$400 - $900',
    skills: 'security,solidity,manual-review',
    desc: 'Perform a security audit on 3 small contracts (<= 500 LOC). Provide report and remediation guidance.',
    created: Date.now() - 1000 * 60 * 60 * 24 * 1,
    owner: null
  }
];

// ----------------- helpers -----------------
function log(...args) { console.log('[server]', ...args); }
function warn(...args) { console.warn('[server]', ...args); }
function errlog(...args) { console.error('[server]', ...args); }

// atomic write: write to temp then rename
function atomicWrite(filePath, data) {
  const tmp = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { encoding: 'utf8' });
    fs.renameSync(tmp, filePath);
    return true;
  } catch (e) {
    errlog('atomicWrite failed', e);
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) {}
    return false;
  }
}

// ensure data file exists (migrate legacy if present)
function ensureDataFile() {
  try {
    if (fs.existsSync(DATA_FILE)) return;
    // migrate legacy
    if (fs.existsSync(LEGACY_FILE)) {
      try {
        const raw = fs.readFileSync(LEGACY_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          atomicWrite(DATA_FILE, JSON.stringify(parsed, null, 2));
          log('Migrated', path.basename(LEGACY_FILE), '→', path.basename(DATA_FILE));
          return;
        } else {
          warn('Legacy file exists but is not an array; ignoring legacy file.');
        }
      } catch (e) {
        warn('Failed parsing legacy file; ignoring migration.', e);
      }
    }
    // create default
    atomicWrite(DATA_FILE, JSON.stringify(SAMPLE_PROJECTS, null, 2));
    log('Created', path.basename(DATA_FILE), 'with sample projects');
  } catch (e) {
    errlog('ensureDataFile error', e);
  }
}

function readDataFile() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      ensureDataFile();
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    errlog('readDataFile error', e);
    return SAMPLE_PROJECTS.slice();
  }
}

function writeDataFile(arr) {
  try {
    const ok = atomicWrite(DATA_FILE, JSON.stringify(arr, null, 2));
    if (!ok) throw new Error('atomic write failed');
    return true;
  } catch (e) {
    errlog('writeDataFile error', e);
    return false;
  }
}

function sendJSON(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function sendPlain(res, statusCode, text) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendFile(res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      sendPlain(res, 404, '404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon'
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('error', function(e) {
      errlog('stream error', e);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server error');
    });
  });
}

// ----------------- server -----------------
const server = http.createServer((req, res) => {
  try {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname || '/';
    // Basic logging
    // log(req.method, pathname);

    // root -> serve specific html if present
    if (pathname === '/' || pathname === '/index.html') {
      const file = path.join(PUBLIC_DIR, 'blockfreelance_modern.html');
      if (fs.existsSync(file)) return sendFile(res, file);
      return sendPlain(res, 200, 'Place blockfreelance_modern.html in this folder and open /blockfreelance_modern.html');
    }

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      return res.end();
    }

    // GET /api/projects -> list
    if (pathname === '/api/projects' && req.method === 'GET') {
      const data = readDataFile();
      return sendJSON(res, 200, { ok: true, projects: data });
    }

    // POST /api/projects -> create
    if (pathname === '/api/projects' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        try {
          const payload = body ? JSON.parse(body) : null;
          if (!payload || typeof payload !== 'object') return sendJSON(res, 400, { ok: false, error: 'Invalid JSON payload' });
          const title = (payload.title || '').toString().trim();
          const desc = (payload.desc || '').toString().trim();
          if (!title || !desc) return sendJSON(res, 400, { ok: false, error: 'title and desc are required' });
          const projects = readDataFile();
          const id = 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
          const project = {
            id,
            title,
            budget: (payload.budget || '').toString(),
            skills: (payload.skills || '').toString(),
            desc,
            created: Date.now(),
            owner: payload.owner || null
          };
          projects.unshift(project);
          const ok = writeDataFile(projects);
          if (!ok) return sendJSON(res, 500, { ok: false, error: 'Failed to write data' });
          return sendJSON(res, 201, { ok: true, project });
        } catch (e) {
          errlog('POST /api/projects error', e);
          return sendJSON(res, 400, { ok: false, error: 'Malformed JSON' });
        }
      });
      return;
    }

    // DELETE /api/projects/:id -> delete by id
    if (pathname.startsWith('/api/projects/') && req.method === 'DELETE') {
      const id = decodeURIComponent(pathname.replace('/api/projects/', ''));
      try {
        const projects = readDataFile();
        const filtered = projects.filter(p => p.id !== id);
        if (filtered.length === projects.length) {
          return sendJSON(res, 404, { ok: false, error: 'Not found' });
        }
        const ok = writeDataFile(filtered);
        if (!ok) return sendJSON(res, 500, { ok: false, error: 'Failed to write data' });
        return sendJSON(res, 200, { ok: true, id });
      } catch (e) {
        errlog('DELETE /api/projects error', e);
        return sendJSON(res, 500, { ok: false, error: 'Server error' });
      }
    }

    // POST /api/reset -> reset to sample projects
    if (pathname === '/api/reset' && req.method === 'POST') {
      const ok = writeDataFile(SAMPLE_PROJECTS.slice());
      if (!ok) return sendJSON(res, 500, { ok: false, error: 'Failed to reset data' });
      return sendJSON(res, 200, { ok: true, message: 'Reset to sample projects' });
    }

    // if path begins with /api but not matched -> 404 JSON
    if (pathname.startsWith('/api/')) {
      return sendJSON(res, 404, { ok: false, error: 'API route not found' });
    }

    // serve static files from PUBLIC_DIR
    const safePath = path.normalize(path.join(PUBLIC_DIR, pathname.replace(/^\/+/, '')));
    if (!safePath.startsWith(PUBLIC_DIR)) {
      return sendPlain(res, 403, 'Forbidden');
    }
    let filePath = safePath;
    if (filePath.endsWith(path.sep)) filePath = path.join(filePath, 'index.html');
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return sendFile(res, filePath);
    }

    return sendPlain(res, 404, 'Not found');
  } catch (e) {
    errlog('Server error', e);
    try { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('Server error'); } catch(e2) {}
  }
});

// ensure data file exists before listening
ensureDataFile();

server.listen(PORT, HOST, () => {
  log(`Server running at http://${HOST}:${PORT}/`);
  log(`Open: http://localhost:${PORT}/blockfreelance_modern.html`);
});
