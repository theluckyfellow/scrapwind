// Account API: bearer-token sessions in localStorage, designs saved per user in Postgres.
// Everything here degrades gracefully: without a server database the UI just stays signed out.

import { readText, writeText, forget } from './storage.js';

const TOKEN_KEY = 'scrapwind-token';
const NAME_KEY = 'scrapwind-user';

export function signedIn() {
  return Boolean(readText(TOKEN_KEY) && readText(NAME_KEY));
}

export function userName() {
  return readText(NAME_KEY, '');
}

function store(token, name) {
  writeText(TOKEN_KEY, token);
  writeText(NAME_KEY, name);
}

async function request(path, options = {}) {
  const token = readText(TOKEN_KEY);
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error ?? 'The server said no.');
    error.status = response.status;
    throw error;
  }
  return body;
}

/** Logs in, or registers the account when the name is new. One door, both directions. */
export async function signIn(name, password) {
  let body;
  try {
    body = await request('/api/login', { method: 'POST', body: JSON.stringify({ name, password }) });
  } catch (loginError) {
    if (loginError.status !== 401) throw loginError; // offline, rate-limited, bad input: say so
    try {
      body = await request('/api/register', { method: 'POST', body: JSON.stringify({ name, password }) });
    } catch (registerError) {
      // The name exists, so the login failure was the password.
      throw registerError.status === 409 ? new Error('Wrong password for that name.') : registerError;
    }
  }
  store(body.token, body.name);
  return body.name;
}

export async function signOut() {
  try {
    await request('/api/logout', { method: 'POST', body: '{}' });
  } catch {
    // The token may already be dead; clearing locally is what matters.
  }
  forget(TOKEN_KEY);
  forget(NAME_KEY);
}

export async function listDesigns() {
  const body = await request('/api/designs');
  return body.designs;
}

export async function saveDesign(name, json) {
  await request(`/api/designs/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ json }) });
}