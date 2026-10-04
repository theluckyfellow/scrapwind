import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import * as db from './db.js';
import { RoomHub } from './rooms.js';

// Scrapwind's server: the built client, the HTTP API (accounts + saved designs) and the rooms'
// WebSocket relay, all on one port. Without DATABASE_URL the account API answers 503 and the
// game keeps working in guest mode; rooms never needed the database.

const PORT = Number(process.env.PORT) || 8080;
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const MAX_BODY_BYTES = 500000;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain',
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return apiRoute(request, response, url);
  if (request.method !== 'GET' && request.method !== 'HEAD') return reply(response, 405, { error: 'Method not allowed.' });
  return serveStatic(request, response, url.pathname);
});

// ---- Static client ----

function serveStatic(request, response, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(DIST, relative));
  if (!file.startsWith(DIST)) return reply(response, 403, { error: 'Forbidden.' });
  fs.readFile(file, (error, data) => {
    if (error) {
      // Unknown paths fall back to the client shell; the game is a single page.
      fs.readFile(path.join(DIST, 'index.html'), (fallbackError, index) => {
        if (fallbackError) return reply(response, 404, { error: 'Not found. Did the client get built?' });
        response.writeHead(200, { 'Content-Type': MIME['.html'] });
        response.end(index);
      });
      return;
    }
    response.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=86400',
    });
    response.end(request.method === 'HEAD' ? undefined : data);
  });
}

// ---- HTTP API: accounts and saved designs ----

async function apiRoute(request, response, url) {
  const route = `${request.method} ${url.pathname}`;
  try {
    if (route === 'GET /api/health') {
      return reply(response, 200, { ok: true, db: db.available() });
    }
    if (!db.available()) return reply(response, 503, { error: 'Accounts are offline: no database is configured.' });

    if (route === 'POST /api/register' || route === 'POST /api/login') {
      const body = await readBody(request);
      const name = String(body.name ?? '').trim();
      const password = String(body.password ?? '');
      if (name.length < 2 || name.length > 24) return reply(response, 400, { error: 'Names are 2–24 characters.' });
      if (password.length < 4) return reply(response, 400, { error: 'Passwords are at least 4 characters.' });
      const user = route.endsWith('register') ? await db.createUser(name, password) : await db.verifyUser(name, password);
      const token = await db.createSession(user.id);
      return reply(response, 200, { token, name: user.name });
    }
    if (route === 'POST /api/logout') {
      const user = await db.userForToken(bearer(request));
      if (user) await db.deleteSession(bearer(request));
      return reply(response, 200, { ok: true });
    }
    if (route === 'GET /api/designs') {
      const user = await requireUser(request);
      return reply(response, 200, { designs: await db.listDesigns(user.id) });
    }
    const designSave = route.match(/^PUT \/api\/designs\/([^/]+)$/);
    if (designSave) {
      const user = await requireUser(request);
      const body = await readBody(request);
      if (!body.json || typeof body.json !== 'object') return reply(response, 400, { error: 'That is not a design.' });
      await db.saveDesign(user.id, decodeURIComponent(designSave[1]), body.json);
      return reply(response, 200, { ok: true });
    }
    return reply(response, 404, { error: 'No such API route.' });
  } catch (error) {
    return reply(response, error.message.includes('taken') || error.message.includes('Wrong') ? 401 : 400,
      { error: error.message });
  }
}

function bearer(request) {
  const header = request.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

async function requireUser(request) {
  const user = await db.userForToken(bearer(request));
  if (!user) throw new Error('Sign in first.');
  return user;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let text = '';
    request.on('data', chunk => {
      text += chunk;
      if (text.length > MAX_BODY_BYTES) {
        reject(new Error('That request is too large.'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error('That request is not valid JSON.'));
      }
    });
    request.on('error', reject);
  });
}

function reply(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

// ---- Rooms over WebSocket ----

const wss = new WebSocketServer({ server, path: '/ws' });
const hub = new RoomHub();

wss.on('connection', socket => {
  socket.isAlive = true;
  const player = hub.connect(socket);
  socket.on('pong', () => { socket.isAlive = true; });
  socket.on('message', data => {
    if (typeof data !== 'string' && data.length > 300000) return;
    hub.handle(player, data.toString());
  });
  socket.on('close', () => hub.disconnect(player));
  socket.on('error', () => hub.disconnect(player));
});

// Dead sockets out: no pong in 30 seconds means the room gets its seat back.
setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive) {
      socket.isAlive = false;
      socket.ping();
    } else {
      socket.terminate();
    }
  }
}, 30000).unref();

// ---- Boot ----

db.init()
  .then(ok => console.log(ok ? 'database connected' : 'no DATABASE_URL: guest mode, accounts offline'))
  .catch(error => console.error('database failed to initialise; accounts offline:', error.message));

server.listen(PORT, () => console.log(`scrapwind server on :${PORT}`));