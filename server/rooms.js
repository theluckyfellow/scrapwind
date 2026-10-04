import crypto from 'crypto';

// Rooms: ephemeral multiplayer sessions keyed by a short human code. The first player in creates
// the room; the roster carries everyone's design so a late joiner can build full puppet vehicles.
// There is no host authority: every client simulates its own vehicle and relays poses.

const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O/1/I/L: codes are read aloud and typed
const CODE_LENGTH = 5;
const MAX_PLAYERS = 8;
const MIN_STATE_INTERVAL_MS = 30; // drop state floods; the client only sends at 15 Hz anyway

let nextPlayerId = 1;

export class Room {
  code;
  players = new Map(); // id → player
  nextSlot = 0;

  constructor(code) {
    this.code = code;
  }

  join(player) {
    if (this.players.size >= MAX_PLAYERS) return false;
    player.slot = this.nextSlot++;
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
      lastStateAt: 0,
      send: text => { if (socket.readyState === socket.OPEN) socket.send(text); },
      socket,
    };
  }

  /** Routes one message from a connected player; returns true when handled. */
  handle(player, text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return false;
    }
    if (typeof message.t !== 'string') return false;

    switch (message.t) {
      case 'hello': {
        if (typeof message.name === 'string' && message.name.trim()) player.name = message.name.trim().slice(0, 24);
        player.send(JSON.stringify({ t: 'welcome', id: player.id, name: player.name }));
        return true;
      }
      case 'create': {
        if (player.room) this.leaveRoom(player);
        const room = this.createRoom();
        room.join(player);
        player.room = room;
        player.send(JSON.stringify({ t: 'room', code: room.code, you: player.id, players: room.roster() }));
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
          player.send(JSON.stringify({ t: 'error', msg: 'That room is full (8 drivers max).' }));
          return true;
        }
        player.room = room;
        player.send(JSON.stringify({ t: 'room', code: room.code, you: player.id, players: room.roster() }));
        return true;
      }
      case 'leave': {
        this.leaveRoom(player);
        return true;
      }
      case 'design': {
        if (isSaneDesign(message.json)) player.design = message.json;
        if (player.room) player.room.broadcast({ t: 'design', id: player.id, json: player.design }, player.id);
        return true;
      }
      case 'state': {
        if (!player.room) return true;
        const now = Date.now();
        if (now - player.lastStateAt < MIN_STATE_INTERVAL_MS) return true;
        player.lastStateAt = now;
        player.room.broadcast({
          t: 'state',
          id: player.id,
          p: clampTriple(message.p),
          q: clampTriple(message.q),
          s: Number(message.s) || 0,
          f: Boolean(message.f),
          b: Boolean(message.b),
        }, player.id);
        return true;
      }
      default:
        return false;
    }
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

function clampTriple(value) {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)
    ? value.map(n => Math.max(-100000, Math.min(100000, n)))
    : [0, 0, 0];
}

/** Designs are blueprints: an object with mounts at least. Size-capped, structure-checked lightly. */
function isSaneDesign(json) {
  return Boolean(json) && typeof json === 'object' && Array.isArray(json.mounts)
    && JSON.stringify(json).length < 200000;
}