import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Server, type Socket } from 'socket.io';
import { applyAction, createGame } from '../shared/game';
import { chooseAIAction } from '../shared/ai';
import { PLAYER_COLORS, type Difficulty, type RoomState, type Session, type ServerResponse, type GameAction } from '../shared/types';

type Ack = (response: ServerResponse) => void;
interface Member { token: string; socketId?: string; commands: Map<string, { payload: string; response: ServerResponse }> }
interface Room { state: RoomState; members: Map<string, Member>; touched: number; timer?: ReturnType<typeof setTimeout> }
interface Options { rng?: () => number; aiDelayMs?: number; roomTtlMs?: number; maxRooms?: number }
const requireThat: (condition: unknown, message: string) => asserts condition = (condition, message) => { if (!condition) throw new Error(message); };
const object = (value: unknown): Record<string, any> => {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value), 'Invalid request.');
  return value;
};
const nameOf = (value: unknown): string => {
  requireThat(typeof value === 'string', 'Enter a commander name.');
  const result = value.trim();
  requireThat(result.length > 0 && result.length <= 24 && !/[\x00-\x1f\x7f]/.test(result), 'Names must contain 1–24 printable characters.');
  return result;
};
const difficultyOf = (value: unknown): Difficulty => {
  requireThat(['recruit', 'veteran', 'general'].includes(value as string), 'Choose a valid difficulty.');
  return value as Difficulty;
};
const secret = () => randomBytes(32).toString('hex');
const tokenMatches = (actual: string, received: unknown) => typeof received === 'string' && /^[a-f0-9]{64}$/.test(received) && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(received, 'hex'));

/** In-memory sessions survive socket reconnects, but not a server restart. */
export function createServer(options: Options = {}) {
  const app = express();
  app.disable('x-powered-by');
  const httpServer = createHttpServer(app);
  const io = new Server(httpServer, {
    maxHttpBufferSize: 16_384,
    // Browser clients must originate from the host serving this app. No wildcard CORS.
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      let allowed = !origin;
      try {
        if (origin) {
          const parsed = new URL(origin);
          allowed = ['http:', 'https:'].includes(parsed.protocol) && parsed.host === req.headers.host;
        }
      } catch { allowed = false; }
      callback(null, allowed);
    },
  });
  const rooms = new Map<string, Room>();
  // Shared across connections so reconnecting cannot reset the event allowance.
  const addressRates = new Map<string, { since: number; count: number }>();
  const rng = options.rng ?? (() => randomInt(0x1_0000_0000) / 0x1_0000_0000);
  const ttl = options.roomTtlMs ?? 24 * 60 * 60 * 1000;
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/transport', (_req, res) => res.set('Cache-Control', 'no-store').json({ mode: 'socket', persistence: 'memory' }));
  const online = (room: Room) => [...room.members.values()].some(m => m.socketId && io.sockets.sockets.has(m.socketId));
  const publish = (room: Room, recipientId?: string) => {
    for (const [playerId, member] of room.members) {
      if (!member.socketId || (recipientId && member.socketId !== recipientId)) continue;
      const state = structuredClone(room.state);
      if (state.game) {
        state.game.deck = [];
        state.game.discard = [];
        for (const player of state.game.players) if (player.id !== playerId) player.cards = [];
      }
      io.to(member.socketId).emit('room:state', state);
    }
  };
  const changed = (room: Room) => { room.state.revision++; room.touched = Date.now(); publish(room); };
  const schedule = (room: Room) => {
    if (room.timer || !online(room) || room.state.status !== 'playing') return;
    const game = room.state.game!;
    if (!game.players[game.currentPlayer].isAI) return;
    room.timer = setTimeout(() => {
      room.timer = undefined;
      if (!online(room) || room.state.status !== 'playing') return;
      const current = room.state.game!;
      try {
        room.state.game = applyAction(current, current.players[current.currentPlayer].id, chooseAIAction(current, rng), rng);
        if (room.state.game.winner) room.state.status = 'finished';
        changed(room);
        schedule(room);
      } catch (error) {
        // Keep the position available for inspection/reconnect if an engine invariant fails.
        console.error('Computer turn failed:', error instanceof Error ? error.message : 'unknown error');
      }
    }, options.aiDelayMs ?? 450);
    room.timer.unref();
  };
  const start = (room: Room) => {
    requireThat(room.state.status === 'lobby', 'The campaign has already started.');
    requireThat(room.state.players.length >= 3, 'Add at least three commanders.');
    requireThat(room.state.players.every(p => p.isAI || p.connected), 'Wait for all commanders to reconnect.');
    const order = [...room.state.players];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    room.state.game = createGame(order, rng);
    room.state.status = 'playing';
  };
  const addBot = (room: Room, difficulty: Difficulty) => {
    requireThat(room.state.status === 'lobby' && room.state.players.length < 6, 'The lobby must have an open seat.');
    const color = PLAYER_COLORS.find(c => !room.state.players.some(p => p.color === c))!;
    let number = 1;
    while (room.state.players.some(p => p.name === `CPU ${number}`)) number++;
    room.state.players.push({ id: randomBytes(12).toString('hex'), name: `CPU ${number}`, color, isAI: true, difficulty, connected: true });
  };
  const detach = (socket: Socket, remove: boolean) => {
    const session = socket.data.session as Session | undefined;
    delete socket.data.session;
    if (!session) return;
    const room = rooms.get(session.code);
    const member = room?.members.get(session.playerId);
    if (!room || !member || member.socketId !== socket.id) return;
    member.socketId = undefined;
    if (remove && room.state.status === 'lobby') {
      room.members.delete(session.playerId);
      room.state.players = room.state.players.filter(p => p.id !== session.playerId);
      if (room.state.hostId === session.playerId) {
        const humans = room.state.players.filter(p => !p.isAI);
        room.state.hostId = (humans.find(p => p.connected) ?? humans[0])?.id ?? '';
      }
      if (!room.members.size) { if (room.timer) clearTimeout(room.timer); rooms.delete(session.code); return; }
    } else {
      const player = room.state.players.find(p => p.id === session.playerId);
      if (player) player.connected = false;
      const gamePlayer = room.state.game?.players.find(p => p.id === session.playerId);
      if (gamePlayer) gamePlayer.connected = false;
    }
    changed(room);
    if (!online(room) && room.timer) { clearTimeout(room.timer); room.timer = undefined; }
  };
  const attach = (socket: Socket, room: Room, playerId: string): Session => {
    const member = room.members.get(playerId)!;
    if (member.socketId && member.socketId !== socket.id) {
      const old = io.sockets.sockets.get(member.socketId);
      if (old) { delete old.data.session; old.emit('session:replaced'); old.disconnect(true); }
    }
    member.socketId = socket.id;
    const session = { code: room.state.code, playerId, token: member.token };
    socket.data.session = session;
    room.state.players.find(p => p.id === playerId)!.connected = true;
    const gamePlayer = room.state.game?.players.find(p => p.id === playerId);
    if (gamePlayer) gamePlayer.connected = true;
    return session;
  };
  io.on('connection', socket => {
    let requestWindow = Date.now();
    let requestCount = 0;
    const handle = (event: string, fn: (payload: Record<string, any>) => ServerResponse) => socket.on(event, (payload: unknown, ack?: Ack) => {
      try {
        if (Date.now() - requestWindow >= 10_000) { requestWindow = Date.now(); requestCount = 0; }
        requireThat(++requestCount <= 120, 'Too many requests. Please wait a few seconds.');
        const address = socket.handshake.address;
        let rate = addressRates.get(address);
        if (!rate || Date.now() - rate.since >= 10_000) {
          rate = { since: Date.now(), count: 0 };
          addressRates.set(address, rate);
          if (addressRates.size > 4096) addressRates.delete(addressRates.keys().next().value!);
        }
        requireThat(++rate.count <= 600, 'Too many requests from this network. Please wait a few seconds.');
        const result = fn(object(payload));
        if (typeof ack === 'function') ack(result);
      } catch (error) {
        if (typeof ack === 'function') ack({ ok: false, error: error instanceof Error ? error.message : 'Invalid request.' });
      }
    });
    const current = (host = false) => {
      const session = socket.data.session as Session | undefined;
      const room = session && rooms.get(session.code);
      requireThat(session && room && room.members.get(session.playerId)?.socketId === socket.id, 'Join or reconnect to a room first.');
      if (host) requireThat(room.state.hostId === session.playerId, 'Only the host can do that.');
      return { room, session, member: room.members.get(session.playerId)! };
    };
    handle('room:create', data => {
      requireThat(!socket.data.session, 'Leave your current room first.');
      requireThat(rooms.size < (options.maxRooms ?? 500), 'All rooms are occupied. Try again later.');
      const name = nameOf(data.name);
      const difficulty = difficultyOf(data.difficulty);
      requireThat(data.mode === 'solo' || data.mode === 'private', 'Choose a valid room mode.');
      requireThat(Number.isInteger(data.bots) && data.bots >= (data.mode === 'solo' ? 2 : 0) && data.bots <= 5, 'Choose a valid number of computer players.');
      let code: string;
      do { code = randomBytes(5).toString('hex').toUpperCase(); } while (rooms.has(code));
      const playerId = randomBytes(16).toString('hex');
      const room: Room = { state: { code, revision: 0, hostId: playerId, players: [{ id: playerId, name, color: PLAYER_COLORS[0], isAI: false, difficulty, connected: true }], status: 'lobby', game: null }, members: new Map([[playerId, { token: secret(), commands: new Map() }]]), touched: Date.now() };
      for (let i = 0; i < data.bots; i++) addBot(room, difficulty);
      rooms.set(code, room);
      const session = attach(socket, room, playerId);
      if (data.mode === 'solo') start(room);
      changed(room); schedule(room);
      return { ok: true, session };
    });
    handle('room:join', data => {
      requireThat(!socket.data.session, 'Leave your current room first.');
      const name = nameOf(data.name);
      requireThat(typeof data.code === 'string' && /^[a-f0-9]{10}$/i.test(data.code.trim()), 'Enter a valid room code.');
      const room = rooms.get(data.code.trim().toUpperCase());
      requireThat(room && room.state.status === 'lobby', 'Room not found or campaign already started.');
      requireThat(room.state.players.length < 6, 'This room is full.');
      const playerId = randomBytes(16).toString('hex');
      room.state.players.push({ id: playerId, name, color: PLAYER_COLORS.find(c => !room.state.players.some(p => p.color === c))!, isAI: false, difficulty: 'veteran', connected: true });
      room.members.set(playerId, { token: secret(), commands: new Map() });
      const session = attach(socket, room, playerId);
      changed(room);
      return { ok: true, session };
    });
    handle('room:resume', data => {
      requireThat(typeof data.code === 'string' && /^[A-F0-9]{10}$/.test(data.code) && typeof data.playerId === 'string' && /^[a-f0-9]{32}$/.test(data.playerId), 'Invalid session.');
      const room = rooms.get(data.code);
      const member = room?.members.get(data.playerId);
      requireThat(room && member && tokenMatches(member.token, data.token), 'This session is invalid or has expired.');
      const previous = socket.data.session as Session | undefined;
      requireThat(!previous || (previous.code === data.code && previous.playerId === data.playerId), 'Leave your current room first.');
      const session = attach(socket, room, data.playerId);
      changed(room); schedule(room);
      return { ok: true, session };
    });
    handle('room:addBot', data => { const { room } = current(true); addBot(room, difficultyOf(data.difficulty)); changed(room); return { ok: true }; });
    handle('room:removePlayer', data => {
      const { room, session } = current(true);
      requireThat(room.state.status === 'lobby', 'The campaign has already started.');
      requireThat(typeof data.playerId === 'string' && data.playerId !== session.playerId, 'You cannot remove yourself.');
      requireThat(room.state.players.some(p => p.id === data.playerId), 'Player not found.');
      const member = room.members.get(data.playerId);
      const removed = member?.socketId && io.sockets.sockets.get(member.socketId);
      if (removed) { delete removed.data.session; removed.emit('room:removed'); }
      room.members.delete(data.playerId);
      room.state.players = room.state.players.filter(p => p.id !== data.playerId);
      changed(room); return { ok: true };
    });
    handle('room:start', () => { const { room } = current(true); start(room); changed(room); schedule(room); return { ok: true }; });
    handle('game:action', data => {
      const { room, session, member } = current();
      requireThat(typeof data.id === 'string' && /^[\w-]{1,80}$/.test(data.id), 'Invalid command identifier.');
      const payload = JSON.stringify({ revision: data.revision, action: data.action });
      requireThat(payload.length <= 1024, 'Command is too large.');
      const previous = member.commands.get(data.id);
      if (previous) { requireThat(previous.payload === payload, 'Command identifier already used.'); publish(room, socket.id); return previous.response; }
      requireThat(room.state.game && room.state.status === 'playing', 'Start a campaign first.');
      requireThat(Number.isSafeInteger(data.revision) && data.revision === room.state.revision, 'The board changed. Try again with the latest position.');
      requireThat(data.action && typeof data.action === 'object' && !Array.isArray(data.action), 'Invalid command.');
      room.state.game = applyAction(room.state.game, session.playerId, data.action as GameAction, rng);
      if (room.state.game.winner) room.state.status = 'finished';
      const response = { ok: true };
      member.commands.set(data.id, { payload, response });
      if (member.commands.size > 256) member.commands.delete(member.commands.keys().next().value!);
      changed(room); schedule(room); return response;
    });
    handle('room:leave', () => { detach(socket, true); return { ok: true }; });
    socket.on('disconnect', () => detach(socket, false));
  });
  const reaper = setInterval(() => {
    for (const [address, rate] of addressRates) if (Date.now() - rate.since >= 10_000) addressRates.delete(address);
    for (const [code, room] of rooms) if (!online(room) && Date.now() - room.touched > ttl) {
      if (room.timer) clearTimeout(room.timer);
      rooms.delete(code);
    }
  }, Math.min(ttl, 60_000));
  reaper.unref();
  return { app, httpServer, io, close: async () => {
    clearInterval(reaper);
    for (const room of rooms.values()) if (room.timer) clearTimeout(room.timer);
    await new Promise<void>(resolve => io.close(() => resolve()));
    rooms.clear();
    addressRates.clear();
  } };
}
