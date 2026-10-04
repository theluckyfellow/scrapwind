import crypto from 'crypto';

// Rooms: ephemeral multiplayer sessions keyed by a short human code. The first player in creates
// the room; the roster carries everyone's design so a late joiner can build full puppet vehicles.
// There is no host authority: every client simulates its own vehicle and relays poses.
// Nothing a client sends is trusted: every message is checked and rebuilt from known fields before
// it is relayed, and each kind of message has its own rate limit.

const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O/1/I/L: codes are read aloud and typed
const CODE_LENGTH = 5;
const MAX_PLAYERS = 8;
const MAX_ROOMS = 2000;
const MAX_NAME_LENGTH = 24;
const WORLD_LIMIT = 100000;        // m; positions beyond this are nonsense
const MAX_SPEED = 400;             // m/s
const SEND_BACKLOG_LIMIT = 1 << 20; // bytes queued for a slow reader before we stop sending it extras

// Minimum milliseconds between messages of each kind from one player; faster ones are dropped.
const MIN_INTERVAL_MS = { state: 30, design: 1500, create: 1000, join: 500, hello: 1000, leave: 250, grid: 100 };
const MAX_GRID_RELAYS = 32;     // the valley has 13; room for more, not for abuse

// Design fields and their checks. Designs are rebuilt from these alone, so nothing else (and no deep
// nesting) ever reaches another client.
const MAX_MOUNTS = 96;
const MAX_POSITION = 10;           // m from the frame's origin
const WORD = /^[A-Za-z][A-Za-z0-9]{0,23}$/;
const PAINT = /^#[0-9a-fA-F]{6}$/;

let nextPlayerId = 1;

export class Room {
  code;
  players = new Map(); // id → player
  grid = new Set();    // relay ids the crew has woken: the room's shared progress

  constructor(code) {
    this.code = code;
  }

  join(player) {
    if (this.players.size >= MAX_PLAYERS) return false;
    player.slot = this.lowestFreeSlot();
    // Tell everyone already here about the newcomer (they need the design to build its puppet).
    this.broadcast({ t: 'joined', id: player.id, name: player.name, slot: player.slot, design: player.design }, player.id);
    this.players.set(player.id, player);
    return true;
  }

  leave(playerId) {
    if (!this.players.delete(playerId)) return false;
    this.broadcast({ t: 'left', id: playerId });
    return true;
  }

  isEmpty() { return this.players.size === 0; }

  broadcast(message, exceptId = null) {
    const text = JSON.stringify(message);
    for (const player of this.players.values()) {
      if (player.id !== exceptId) player.send(text);
    }
  }

  /** The full roster, designs included, for someone just joining or reconnecting. */
  roster() {
    return [...this.players.values()].map(player => ({
      id: player.id, name: player.name, slot: player.slot, design: player.design,
    }));
  }

  /** Spawn slots are reused, so join-and-leave churn never pushes newcomers off the start pad. */
  lowestFreeSlot() {
    const taken = new Set([...this.players.values()].map(player => player.slot));
    let slot = 0;
    while (taken.has(slot)) slot++;
    return slot;
  }
}

export class RoomHub {
  rooms = new Map(); // code → Room

  connect(socket) {
    return {
      id: nextPlayerId++,
      name: 'Drifter',
      slot: 0,
      design: null,
      room: null,
      lastAt: {},          // message kind → time of the last one accepted
      send: text => {
        if (socket.readyState !== socket.OPEN || socket.bufferedAmount > SEND_BACKLOG_LIMIT) return;
        socket.send(text);
      },
      socket,
    };
  }

  /** Routes one message from a connected player; returns true when handled. Never throws. */
  handle(player, text) {
    try {
      return this.route(player, text);
    } catch (error) {
      console.error('room message failed:', error.message);
      return false;
    }
  }

  route(player, text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return false;
    }
    if (!message || typeof message !== 'object' || typeof message.t !== 'string') return false;
    if (!this.allow(player, message.t)) return true;

    switch (message.t) {
      case 'hello': {
        const name = cleanName(message.name);
        if (name && name !== player.name) {
          player.name = name;
          player.room?.broadcast({ t: 'renamed', id: player.id, name }, player.id);
        }
        player.send(JSON.stringify({ t: 'welcome', id: player.id, name: player.name }));
        return true;
      }
      case 'create': {
        if (this.rooms.size >= MAX_ROOMS) {
          player.send(JSON.stringify({ t: 'error', msg: 'The server is full of rooms right now. Try again soon.' }));
          return true;
        }
        if (player.room) this.leaveRoom(player);
        const room = this.createRoom();
        room.join(player);
        player.room = room;
        player.send(JSON.stringify({ t: 'room', code: room.code, you: player.id, players: room.roster(), grid: [...room.grid] }));
        return true;
      }
      case 'join': {
        if (player.room) this.leaveRoom(player);
        const room = this.rooms.get(codeOf(message.code));
        if (!room) {
          player.send(JSON.stringify({ t: 'error', msg: 'No room with that code. Check it and try again.' }));
          return true;
        }
        if (!room.join(player)) {
          player.send(JSON.stringify({ t: 'error', msg: `That room is full (${MAX_PLAYERS} drivers max).` }));
          return true;
        }
        player.room = room;
        player.send(JSON.stringify({ t: 'room', code: room.code, you: player.id, players: room.roster(), grid: [...room.grid] }));
        return true;
      }
      case 'grid': {
        if (!player.room || !Array.isArray(message.relays)) return true;
        for (const relay of message.relays.slice(0, MAX_GRID_RELAYS)) {
          if (typeof relay !== 'string' || !WORD.test(relay) || player.room.grid.has(relay)) continue;
          if (player.room.grid.size >= MAX_GRID_RELAYS) break;
          player.room.grid.add(relay);
          player.room.broadcast({ t: 'grid', relay, by: player.name }, player.id);
        }
        return true;
      }
      case 'leave': {
        this.leaveRoom(player);
        return true;
      }
      case 'design': {
        const design = cleanDesign(message.json);
        if (!design) return true;
        const changed = JSON.stringify(design) !== JSON.stringify(player.design);
        player.design = design;
        if (changed && player.room) player.room.broadcast({ t: 'design', id: player.id, json: design }, player.id);
        return true;
      }
      case 'state': {
        if (!player.room) return true;
        const position = finiteList(message.p, 3);
        const rotation = finiteList(message.q, 4);
        if (!position || !rotation) return true;
        const length = Math.hypot(...rotation);
        if (length < 0.5 || length > 1.5) return true; // not a rotation
        player.room.broadcast({
          t: 'state',
          id: player.id,
          p: position.map(value => clamp(value, -WORLD_LIMIT, WORLD_LIMIT)),
          q: rotation.map(value => value / length),
          s: clamp(Number(message.s) || 0, 0, MAX_SPEED),
          f: message.f === true,
          b: message.b === true,
        }, player.id);
        return true;
      }
      default:
        return false;
    }
  }

  /** Per-player, per-kind rate limit. */
  allow(player, kind) {
    const interval = MIN_INTERVAL_MS[kind];
    if (interval === undefined) return true;
    const now = Date.now();
    if (now - (player.lastAt[kind] ?? 0) < interval) return false;
    player.lastAt[kind] = now;
    return true;
  }

  createRoom() {
    let code;
    do {
      code = codeOf(Array.from(crypto.randomBytes(CODE_LENGTH))
        .map(byte => CODE_CHARS[byte % CODE_CHARS.length]).join(''));
    } while (this.rooms.has(code));
    const room = new Room(code);
    this.rooms.set(code, room);
    return room;
  }

  leaveRoom(player) {
    const room = player.room;
    if (!room) return;
    room.leave(player.id);
    player.room = null;
    if (room.isEmpty()) this.rooms.delete(room.code);
  }

  /** Drops dead sockets' players from their rooms; called on socket close. */
  disconnect(player) {
    this.leaveRoom(player);
  }
}

function codeOf(code) {
  return String(code ?? '').toUpperCase().replace(/[^2-9A-Z]/g, '').slice(0, CODE_LENGTH);
}

function cleanName(name) {
  if (typeof name !== 'string') return null;
  // Printable characters only; no control characters or bidi overrides in someone else's name tag.
  const cleaned = name.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim();
  return cleaned ? cleaned.slice(0, MAX_NAME_LENGTH) : null;
}

function finiteList(value, length) {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite) ? value : null;
}

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high);
}

/** Small maps of word → word (panels, control modes) or word → number (alignment, tuning dials). */
function cleanMap(source, valueCheck) {
  const result = {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) return result;
  for (const [key, value] of Object.entries(source).slice(0, 32)) {
    if (WORD.test(key) && valueCheck(value)) result[key] = value;
  }
  return result;
}

/**
 * A design rebuilt from its known fields, or null if it isn't one. The client checks parts and models
 * against its catalogue; here we only guarantee shape, size and finite numbers.
 */
export function cleanDesign(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json) || !Array.isArray(json.mounts)) return null;
  if (json.mounts.length > MAX_MOUNTS) return null;
  const mounts = [];
  for (const mount of json.mounts) {
    if (!mount || typeof mount !== 'object') return null;
    const position = finiteList(mount.position, 3);
    if (!WORD.test(String(mount.part)) || !WORD.test(String(mount.model)) || !position) return null;
    if (position.some(value => Math.abs(value) > MAX_POSITION)) return null;
    mounts.push({ part: mount.part, model: mount.model, position, mirror: mount.mirror === true });
  }
  const isWord = value => typeof value === 'string' && WORD.test(value);
  const isNumber = value => Number.isFinite(value) && Math.abs(value) < 1000;
  return {
    version: Number.isFinite(json.version) ? json.version : 1,
    name: cleanName(json.name) ?? 'Unnamed',
    body: isWord(json.body) ? json.body : 'trekker',
    rideHeight: isNumber(json.rideHeight) ? json.rideHeight : 0.35,
    paint: typeof json.paint === 'string' && PAINT.test(json.paint) ? json.paint : '#e2582c',
    adjustableRideHeight: json.adjustableRideHeight === true,
    panels: cleanMap(json.panels, isWord),
    alignment: cleanMap(json.alignment, isNumber),
    tuning: cleanMap(json.tuning, isNumber),
    controls: cleanMap(json.controls, isWord),
    mounts,
  };
}
