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
const MAX_BODY_BYTES = 128 * 1024;
const MAX_SOCKET_MESSAGE_BYTES = 64 * 1024;
const MAX_SOCKETS_PER_ADDRESS = 12;
const MAX_MESSAGES_PER_SECOND = 90;   // a client sends ~15 states a second; far beyond that is a flood
const AUTH_ATTEMPTS_PER_MINUTE = 12;
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
  let url;
  try {
    url = new URL(request.url, 'http://localhost'); // never built from the Host header
  } catch {
    return reply(response, 400, { error: 'Bad request.' });
  }
  if (url.pathname.startsWith('/api/')) return apiRoute(request, response, url);
  if (request.method !== 'GET' && request.method !== 'HEAD') return reply(response, 405, { error: 'Method not allowed.' });
  return serveStatic(request, response, url.pathname);
});

// ---- Static client ----

function serveStatic(request, response, pathname) {
  let relative;
  try {
    relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    return reply(response, 400, { error: 'Bad request.' });
  }
  const file = path.normalize(path.join(DIST, relative));
  if (!file.startsWith(DIST + path.sep) && file !== DIST) return reply(response, 403, { error: 'Forbidden.' });
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

const authAttempts = new Map(); // address → { count, since }

async function apiRoute(request, response, url) {
  const route = `${request.method} ${url.pathname}`;
  try {
    if (route === 'GET /api/health') {
      return reply(response, 200, { ok: true, db: db.available() });
    }
    if (!db.available()) return reply(response, 503, { error: 'Accounts are offline: no database is configured.' });

    if (route === 'POST /api/register' || route === 'POST /api/login') {
      if (!allowAuthAttempt(clientAddress(request))) {
        return reply(response, 429, { error: 'Too many sign-in attempts. Wait a minute and try again.' });
      }
      const body = await readBody(request);
      const name = String(body.name ?? '').trim();
      const password = String(body.password ?? '');
      if (name.length < 2 || name.length > 24) return reply(response, 400, { error: 'Names are 2–24 characters.' });
      if (password.length < 4 || password.length > 200) return reply(response, 400, { error: 'Passwords are 4–200 characters.' });
      const user = route.endsWith('register') ? await db.createUser(name, password) : await db.verifyUser(name, password);
      const token = await db.createSession(user.id);
      return reply(response, 200, { token, name: user.name });
    }
    if (route === 'POST /api/logout') {
      const token = bearer(request);
      if (await db.userForToken(token)) await db.deleteSession(token);
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
      if (!body.json || typeof body.json !== 'object' || Array.isArray(body.json)) {
        return reply(response, 400, { error: 'That is not a design.' });
      }
      await db.saveDesign(user.id, decodeURIComponent(designSave[1]), body.json);
      return reply(response, 200, { ok: true });
    }
    return reply(response, 404, { error: 'No such API route.' });
  } catch (error) {
    if (error instanceof db.PublicError) return reply(response, error.status, { error: error.message });
    console.error('api error:', route, error.message);
    return reply(response, 500, { error: 'Something went wrong on the server.' });
  }
}

function bearer(request) {
  const header = request.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

async function requireUser(request) {
  const user = await db.userForToken(bearer(request));
  if (!user) throw new db.PublicError(401, 'Sign in first.');
  return user;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let text = '';
    request.on('data', chunk => {
      text += chunk;
      if (text.length > MAX_BODY_BYTES) {
        reject(new db.PublicError(413, 'That request is too large.'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new db.PublicError(400, 'That request is not valid JSON.'));
      }
    });
    request.on('error', reject);
  });
}

function reply(response, status, body) {
  if (response.headersSent) return;
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** The caller's address: behind Railway's proxy the first X-Forwarded-For hop, else the socket's. */
function clientAddress(request) {
  const forwarded = request.headers['x-forwarded-for'];
  return (typeof forwarded === 'string' && forwarded.split(',')[0].trim()) || request.socket.remoteAddress || 'unknown';
}

function allowAuthAttempt(address) {
  const now = Date.now();
  const record = authAttempts.get(address);
  if (!record || now - record.since > 60000) {
    authAttempts.set(address, { count: 1, since: now });
    return true;
  }
  record.count++;
  return record.count <= AUTH_ATTEMPTS_PER_MINUTE;
}

setInterval(() => {
  const now = Date.now();
  for (const [address, record] of authAttempts) if (now - record.since > 60000) authAttempts.delete(address);
}, 60000).unref();

// ---- Rooms over WebSocket ----

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_SOCKET_MESSAGE_BYTES });
const hub = new RoomHub();
const socketsPerAddress = new Map();

wss.on('connection', (socket, request) => {
  const address = clientAddress(request);
  const open = (socketsPerAddress.get(address) ?? 0) + 1;
  if (open > MAX_SOCKETS_PER_ADDRESS) {
    socket.close(1008, 'Too many connections from one address.');
    return;
  }
  socketsPerAddress.set(address, open);

  socket.isAlive = true;
  const player = hub.connect(socket);
  let windowStart = Date.now();
  let messagesInWindow = 0;
  socket.on('pong', () => { socket.isAlive = true; });
  socket.on('message', (data, isBinary) => {
    const now = Date.now();
    if (now - windowStart > 1000) {
      windowStart = now;
      messagesInWindow = 0;
    }
    if (++messagesInWindow > MAX_MESSAGES_PER_SECOND) {
      socket.terminate(); // a flood, not a player
      return;
    }
    if (isBinary) return;
    hub.handle(player, data.toString());
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    hub.disconnect(player);
    const remaining = (socketsPerAddress.get(address) ?? 1) - 1;
    if (remaining > 0) socketsPerAddress.set(address, remaining);
    else socketsPerAddress.delete(address);
  };
  socket.on('close', close);
  socket.on('error', close);
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
