import crypto from 'crypto';
import fs from 'fs';
import { promisify } from 'util';
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
// "Bob" and "bob" are one account. Kept separate from SCHEMA: an older database that already holds
// such a pair can't take the index, and that must not stop the server from starting.
const CASE_INSENSITIVE_NAMES = 'CREATE UNIQUE INDEX IF NOT EXISTS users_name_lower ON users (lower(name))';

const SCRYPT_KEY_LENGTH = 64;
const MAX_DESIGN_NAME_LENGTH = 40;
const MAX_DESIGNS_PER_USER = 60;
const MAX_DESIGN_BYTES = 64 * 1024;
const UNIQUE_VIOLATION = '23505';
const scrypt = promisify(crypto.scrypt); // the async form: hashing must not freeze the relay

/** An error whose message is safe to show the player, with the HTTP status to send it with. */
export class PublicError extends Error {
  status;

  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let pool = null;

export async function init(url = process.env.DATABASE_URL) {
  if (!url) return false;
  const candidate = new pg.Pool({ connectionString: url, ssl: sslOptions(url), max: 5 });
  // An idle client losing its connection (a database restart, a network blip) must not kill the process.
  candidate.on('error', error => console.error('database connection lost:', error.message));
  try {
    await candidate.query(SCHEMA);
    await candidate.query(CASE_INSENSITIVE_NAMES).catch(error => {
      console.error('could not add case-insensitive name index (duplicate names already stored?):', error.message);
    });
    pool = candidate;
    return true;
  } catch (error) {
    // Leave the pool unset: the API answers 503 and the game keeps running in guest mode.
    await candidate.end().catch(() => {});
    throw error;
  }
}

/**
 * TLS for hosted databases. With DATABASE_CA (a PEM certificate, or a path to one) the server's
 * certificate is verified. Without it, a public proxy (Railway's *.proxy.rlwy.net, say) is encrypted
 * but unverified; prefer the private network URL in production, or set DATABASE_CA.
 */
function sslOptions(url) {
  if (url.includes('sslmode=disable')) return undefined;
  const ca = process.env.DATABASE_CA;
  if (ca) return { ca: ca.includes('BEGIN CERTIFICATE') ? ca : fs.readFileSync(ca, 'utf8'), rejectUnauthorized: true };
  return /proxy|rlwy|render|external/.test(url) ? { rejectUnauthorized: false } : undefined;
}

export const available = () => Boolean(pool);

// ---- Passwords: scrypt with a per-user salt, hashed server-side. ----

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, SCRYPT_KEY_LENGTH);
  return `${salt}:${hash.toString('hex')}`;
}

async function passwordMatches(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = await scrypt(password, salt, SCRYPT_KEY_LENGTH);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// ---- Accounts ----

export async function createUser(name, password) {
  const taken = await pool.query('SELECT id FROM users WHERE lower(name) = lower($1)', [name]);
  if (taken.rowCount > 0) throw new PublicError(409, 'That name is taken.');
  try {
    const result = await pool.query(
      'INSERT INTO users (name, password_hash) VALUES ($1, $2) RETURNING id, name',
      [name, await hashPassword(password)],
    );
    return result.rows[0];
  } catch (error) {
    // Two people racing for the same name: the unique index decides, and the loser hears why.
    if (error.code === UNIQUE_VIOLATION) throw new PublicError(409, 'That name is taken.');
    throw error;
  }
}

export async function verifyUser(name, password) {
  const result = await pool.query(
    'SELECT id, name, password_hash FROM users WHERE lower(name) = lower($1) ORDER BY id LIMIT 1',
    [name],
  );
  const user = result.rows[0];
  if (!user || !(await passwordMatches(password, user.password_hash))) throw new PublicError(401, 'Wrong name or password.');
  return { id: user.id, name: user.name };
}

export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, userId]);
  return token;
}

export async function userForToken(token) {
  if (!token || token.length > 128) return null;
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
    'SELECT name, json, updated_at FROM designs WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2',
    [userId, MAX_DESIGNS_PER_USER],
  );
  return result.rows.map(row => ({ name: row.name, json: row.json, updatedAt: row.updated_at }));
}

export async function saveDesign(userId, name, json) {
  const cleanName = String(name).trim();
  if (!cleanName || cleanName.length > MAX_DESIGN_NAME_LENGTH) throw new PublicError(400, 'Design names are 1–40 characters.');
  const text = JSON.stringify(json);
  if (text.length > MAX_DESIGN_BYTES) throw new PublicError(413, 'That design is too large to save.');
  const existing = await pool.query('SELECT 1 FROM designs WHERE user_id = $1 AND name = $2', [userId, cleanName]);
  if (existing.rowCount === 0) {
    const count = await pool.query('SELECT count(*)::int AS n FROM designs WHERE user_id = $1', [userId]);
    if (count.rows[0].n >= MAX_DESIGNS_PER_USER) {
      throw new PublicError(409, `You have ${MAX_DESIGNS_PER_USER} saved designs. Delete one to make room.`);
    }
  }
  await pool.query(
    `INSERT INTO designs (user_id, name, json) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, name) DO UPDATE SET json = $3, updated_at = now()`,
    [userId, cleanName, text],
  );
}
