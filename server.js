import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize as normalizePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { parseTranscript, renderEntry, usingClaude } from './parse.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);

// --- storage ---------------------------------------------------------------

const db = new DatabaseSync(join(ROOT, 'hangar.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at        TEXT NOT NULL,
    tail_number       TEXT NOT NULL DEFAULT '',
    aircraft          TEXT NOT NULL DEFAULT '',
    date_completed    TEXT NOT NULL DEFAULT '',
    tach_time         TEXT NOT NULL DEFAULT '',
    hobbs_time        TEXT NOT NULL DEFAULT '',
    discrepancy       TEXT NOT NULL DEFAULT '',
    description       TEXT NOT NULL DEFAULT '',
    parts_json        TEXT NOT NULL DEFAULT '[]',
    return_to_service INTEGER NOT NULL DEFAULT 0,
    mechanic_name     TEXT NOT NULL DEFAULT '',
    cert_number       TEXT NOT NULL DEFAULT '',
    cert_type         TEXT NOT NULL DEFAULT 'A&P',
    signed            INTEGER NOT NULL DEFAULT 0,
    signed_at         TEXT NOT NULL DEFAULT '',
    transcript        TEXT NOT NULL DEFAULT ''
  );
`);

const EDITABLE = [
  'tail_number', 'aircraft', 'date_completed', 'tach_time', 'hobbs_time',
  'discrepancy', 'description', 'parts_json', 'return_to_service',
  'mechanic_name', 'cert_number', 'cert_type', 'signed', 'signed_at',
];

const withText = (row) => ({ ...row, entry_text: renderEntry(row) });

function listEntries(query) {
  const q = (query || '').trim();
  if (!q) {
    return db.prepare('SELECT * FROM entries ORDER BY id DESC LIMIT 200').all().map(withText);
  }
  const like = `%${q}%`;
  return db.prepare(`
    SELECT * FROM entries
    WHERE tail_number LIKE ?1 COLLATE NOCASE
       OR description  LIKE ?1 COLLATE NOCASE
       OR discrepancy  LIKE ?1 COLLATE NOCASE
       OR parts_json   LIKE ?1 COLLATE NOCASE
       OR aircraft     LIKE ?1 COLLATE NOCASE
    ORDER BY id DESC LIMIT 200
  `).all(like).map(withText);
}

// --- routes ----------------------------------------------------------------

const routes = {
  'GET /api/health': async () => ({ ok: true, ai: usingClaude ? 'claude' : 'fallback' }),

  'GET /api/entries': async (_body, url) => listEntries(url.searchParams.get('q')),

  'POST /api/entries': async (body) => {
    const transcript = String(body.transcript || '').trim();
    if (!transcript) throw httpError(400, 'transcript is required');

    const today = new Date().toISOString().slice(0, 10);
    const f = await parseTranscript(transcript, today);

    const info = db.prepare(`
      INSERT INTO entries (
        created_at, tail_number, aircraft, date_completed, tach_time, hobbs_time,
        discrepancy, description, parts_json, return_to_service,
        mechanic_name, cert_number, cert_type, transcript
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      new Date().toISOString(),
      f.tail_number, f.aircraft, f.date_completed, f.tach_time, f.hobbs_time,
      f.discrepancy, f.description, JSON.stringify(f.parts), f.return_to_service ? 1 : 0,
      String(body.mechanic_name || ''), String(body.cert_number || ''),
      String(body.cert_type || 'A&P'), transcript,
    );

    const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(info.lastInsertRowid);
    return { ...withText(row), needs_review: f.needs_review };
  },

  'PATCH /api/entries/:id': async (body, _url, { id }) => {
    const updates = Object.entries(body).filter(([k]) => EDITABLE.includes(k));
    if (!updates.length) throw httpError(400, 'no editable fields supplied');

    const set = updates.map(([k], i) => `${k} = ?${i + 1}`).join(', ');
    const values = updates.map(([k, v]) =>
      k === 'return_to_service' || k === 'signed' ? (v ? 1 : 0) : String(v ?? ''),
    );
    db.prepare(`UPDATE entries SET ${set} WHERE id = ?${values.length + 1}`).run(...values, id);

    const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
    if (!row) throw httpError(404, 'entry not found');
    return withText(row);
  },

  'DELETE /api/entries/:id': async (_body, _url, { id }) => {
    db.prepare('DELETE FROM entries WHERE id = ?').run(id);
    return { ok: true };
  },
};

const COLUMNS = [
  'id', 'date_completed', 'tail_number', 'aircraft', 'tach_time', 'hobbs_time',
  'discrepancy', 'description', 'parts_json', 'mechanic_name', 'cert_number', 'signed',
];

function exportResponse(res, url) {
  const rows = listEntries(url.searchParams.get('q'));
  const stamp = new Date().toISOString().slice(0, 10);

  if (url.searchParams.get('format') === 'txt') {
    const body = rows.map((r) => r.entry_text).join('\n\n' + '='.repeat(72) + '\n\n');
    return send(res, 200, body || 'No entries.', {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="logbook-${stamp}.txt"`,
    });
  }

  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [COLUMNS.join(','), ...rows.map((r) => COLUMNS.map((c) => cell(r[c])).join(','))].join('\n');
  return send(res, 200, csv, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="logbook-${stamp}.csv"`,
  });
}

// --- plumbing --------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

const httpError = (status, message) => Object.assign(new Error(message), { status });

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'cache-control': 'no-store', ...headers });
  res.end(body);
}

const json = (res, status, data) =>
  send(res, status, JSON.stringify(data), { 'content-type': 'application/json; charset=utf-8' });

function matchRoute(method, pathname) {
  for (const [key, handler] of Object.entries(routes)) {
    const [routeMethod, pattern] = key.split(' ');
    if (routeMethod !== method) continue;

    const patternParts = pattern.split('/');
    const pathParts = pathname.split('/');
    if (patternParts.length !== pathParts.length) continue;

    const params = {};
    const ok = patternParts.every((part, i) => {
      if (part.startsWith(':')) {
        params[part.slice(1)] = decodeURIComponent(pathParts[i]);
        return true;
      }
      return part === pathParts[i];
    });
    if (ok) return { handler, params };
  }
  return null;
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw httpError(413, 'request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'invalid JSON body');
  }
}

async function serveStatic(res, pathname) {
  const rel = normalizePath(pathname === '/' ? '/index.html' : pathname);
  const file = join(PUBLIC, rel);
  // normalize() collapses "..", so anything escaping PUBLIC is caught here.
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden');
  try {
    const body = await readFile(file);
    send(res, 200, body, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
  } catch {
    send(res, 404, 'Not found');
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/export') return exportResponse(res, url);

    const route = matchRoute(req.method, url.pathname);
    if (route) {
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJsonBody(req);
      return json(res, 200, await route.handler(body, url, route.params));
    }

    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'unknown endpoint' });
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
    return serveStatic(res, url.pathname);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    json(res, status, { error: err.message || 'server error' });
  }
}).listen(PORT, () => {
  console.log(`\n  Hangar running at http://localhost:${PORT}`);
  console.log(`  Entry formatting: ${usingClaude ? 'Claude (claude-opus-4-8)' : 'offline fallback — set ANTHROPIC_API_KEY for real formatting'}\n`);
});
