// Net: the multiplayer client. One WebSocket to the game server; rooms joined by code; every
// player relays their own vehicle's pose and the server rebroadcasts it to the rest of the room.
// The game builds a puppet vehicle per other player from their design, so everyone sees everyone.

const STATE_HZ = 15;

export class Net {
  status = 'offline';     // offline | connecting | online
  room = null;            // room code while in a room, else null
  myId = null;
  mySlot = 0;
  players = new Map();    // id → { id, name, slot, design }
  socket = null;
  name;
  sendTimer = 0;

  // Callbacks the Game wires: onRoster(room code, players), onLeft(id), onState(id, state),
  // onStatus(), onDesign(id, json), onNotice(text).
  constructor(name, callbacks) {
    this.name = name;
    Object.assign(this, callbacks);
  }

  connect() {
    if (this.socket) return;
    this.status = 'connecting';
    this.onStatus?.();
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    this.socket = socket;
    socket.onopen = () => {
      this.status = 'online';
      socket.send(JSON.stringify({ t: 'hello', name: this.name }));
      this.onStatus?.();
    };
    socket.onclose = () => {
      this.status = 'offline';
      const wasInRoom = this.room !== null;
      this.socket = null;
      this.room = null;
      this.myId = null;
      this.players.clear();
      this.onStatus?.();
      if (wasInRoom) this.onRoster?.(null, []);
    };
    socket.onerror = () => { this.status = 'offline'; this.onStatus?.(); };
    socket.onmessage = event => this.receive(event.data);
  }

  send(message) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  receive(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    switch (message.t) {
      case 'welcome':
        this.myId = message.id;
        break;
      case 'room':
        this.room = message.code;
        this.mySlot = message.players.find(player => player.id === message.you)?.slot ?? 0;
        this.players.clear();
        for (const entry of message.players) {
          if (entry.id !== this.myId) this.players.set(entry.id, entry);
        }
        this.onRoster?.(message.code, message.players);
        break;
      case 'joined':
        this.players.set(message.id, message);
        this.onRoster?.(this.room, [...this.players.values()]);
        break;
      case 'left':
        this.players.delete(message.id);
        this.onLeft?.(message.id);
        break;
      case 'design':
        if (this.players.has(message.id)) this.players.get(message.id).design = message.json;
        this.onDesign?.(message.id, message.json);
        break;
      case 'state':
        this.onState?.(message.id, {
          pos: message.p,
          quaternion: message.q,
          speed: message.s,
          flying: message.f,
          boosting: message.b,
        });
        break;
      case 'error':
        this.onNotice?.(message.msg);
        break;
      default:
        break;
    }
  }

  createRoom() {
    this.connect();
    this.send({ t: 'create' });
  }

  joinRoom(code) {
    this.connect();
    this.send({ t: 'join', code });
  }

  leaveRoom() {
    this.send({ t: 'leave' });
    const wasInRoom = this.room !== null;
    this.room = null;
    this.players.clear();
    if (wasInRoom) this.onRoster?.(null, []);
  }

  sendDesign(json) {
    this.send({ t: 'design', json });
  }

  /** Sends this vehicle's pose; Game calls this every frame and the rate is capped here. */
  sendState(vehicle, frameSeconds) {
    if (!this.room) return;
    this.sendTimer += frameSeconds;
    if (this.sendTimer < 1 / STATE_HZ) return;
    this.sendTimer = 0;
    const position = vehicle.drawnPosition();
    const quaternion = vehicle.drawnQuaternion();
    this.send({
      t: 'state',
      p: [round3(position.x), round3(position.y), round3(position.z)],
      q: [round3(quaternion.x), round3(quaternion.y), round3(quaternion.z), round3(quaternion.w)],
      s: Math.round(vehicle.speed() * 10) / 10,
      f: vehicle.flying(),
      b: vehicle.boosting(),
    });
  }
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}