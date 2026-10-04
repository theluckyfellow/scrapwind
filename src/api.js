// Account API: bearer-token sessions in localStorage, designs saved per user in Postgres.
// Everything here degrades gracefully: without a server database the UI just stays signed out.

const TOKEN_KEY = 'scrapwind-token';
const NAME_KEY = 'scrapwind-user';

export function signedIn() {
  return Boolean(localStorage.getItem(TOKEN_KEY) && localStorage.getItem(NAME_KEY));
}

export function userName() {
  return localStorage.getItem(NAME_KEY) ?? '';
}

function store(token, name) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(NAME_KEY, name);
}

async function request(path, options = {}) {
  const token = localStorage.getItem(TOKEN_KEY);
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'The server said no.');
  return body;
}

/** Logs in, or registers the account when the name is new. One door, both directions. */
export async function signIn(name, password) {
  let body;
  try {
    body = await request('/api/login', { method: 'POST', body: JSON.stringify({ name, password }) });
  } catch {
    body = await request('/api/register', { method: 'POST', body: JSON.stringify({ name, password }) });
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
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(NAME_KEY);
}

export async function listDesigns() {
  const body = await request('/api/designs');
  return body.designs;
}

export async function saveDesign(name, json) {
  await request(`/api/designs/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ json }) });
}