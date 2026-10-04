// Browser storage that can't take the game down. localStorage throws when site data is blocked (Safari's
// "block all cookies", sandboxed frames, private modes); losing a remembered setting is fine, crashing isn't.

/** A stored JSON value, or the fallback when there is none or it can't be read. */
export function readStored(key, fallback) {
  try {
    const text = localStorage.getItem(key);
    return text === null ? fallback : JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** Stores a value as JSON; quietly does nothing if storage is unavailable or full. */
export function writeStored(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not remembering is better than failing.
  }
}

/** A stored plain string, or the fallback. */
export function readText(key, fallback = null) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Stores a plain string; quietly does nothing if storage is unavailable. */
export function writeText(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // As above.
  }
}

/** Forgets a stored value. */
export function forget(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing to forget.
  }
}
