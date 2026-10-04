import crypto from 'crypto';
import pg from 'pg';

// Users, sessions and saved designs. The pool appears only when DATABASE_URL exists: without a
// database the API answers 503 and the game runs in guest mode — local development never blocks.

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS designs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    json JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, name)
  );
`;

const SCRYPT_KEY_LENGTH = 64;

let pool = null;

export async function init(url = process.env.DATABASE_URL) {
  if (!url) return false;
  const needsSsl = /proxy|rlwy|render|external/.test(url) && !url.includes('sslmode=disable');
  const candidate = new pg.Pool({
    connectionString: url,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    max: 5,
  });
  try {
    await candidate.query(SCHEMA);
    pool = candidate;
    return true;
  } catch (error) {
    // Leave the pool unset: the API answers 503 and the game keeps running in guest mode.
    await candidate.end().catch(() => {});
    throw error;
  }
}

export const available = () => Boolean(pool);

// ---- Passwords: scrypt with a per-user salt, hashed server-side. ----

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEY_LENGTH).toString('hex');
  return `${salt}:${hash}`;
}

function passwordMatches(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// ---- Accounts ----

export async function createUser(name, password) {
  const taken = await pool.query('SELECT id FROM users WHERE lower(name) = lower($1)', [name]);
  if (taken.rowCount > 0) throw new Error('That name is taken.');
  const result = await pool.query(
    'INSERT INTO users (name, password_hash) VALUES ($1, $2) RETURNING id, name',
    [name, hashPassword(password)],
  );
  return result.rows[0];
}

export async function verifyUser(name, password) {
  const result = await pool.query(
    'SELECT id, name, password_hash FROM users WHERE lower(name) = lower($1)',
    [name],
  );
  const user = result.rows[0];
  if (!user || !passwordMatches(password, user.password_hash)) throw new Error('Wrong name or password.');
  return { id: user.id, name: user.name };
}

export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, userId]);
  return token;
}

export async function userForToken(token) {
  if (!token) return null;
  const result = await pool.query(
    `SELECT u.id, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1`,
    [token],
  );
  return result.rows[0] ?? null;
}

export async function deleteSession(token) {
  await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
}

// ---- Saved designs ----

export async function listDesigns(userId) {
  const result = await pool.query(
    'SELECT name, json, updated_at FROM designs WHERE user_id = $1 ORDER BY updated_at DESC',
    [userId],
  );
  return result.rows.map(row => ({ name: row.name, json: row.json, updatedAt: row.updated_at }));
}

export async function saveDesign(userId, name, json) {
  await pool.query(
    `INSERT INTO designs (user_id, name, json) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, name) DO UPDATE SET json = $3, updated_at = now()`,
    [userId, name, JSON.stringify(json)],
  );
}