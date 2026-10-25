import { applyAction, createGame } from '../shared/game';
import { chooseAIAction } from '../shared/ai';
import { PLAYER_COLORS, type Difficulty, type GameAction, type RoomState, type ServerResponse, type Session } from '../shared/types';

/** The subset of D1 used here also permits exercising the real SQL in SQLite. */
export interface D1Result { success?: boolean; meta: { changes?: number } }
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  run(): Promise<D1Result>;
}
export interface D1Executor { prepare(sql: string): D1PreparedStatement }
export interface D1Database extends D1Executor {
  withSession?(constraint: 'first-primary'): D1Executor;
}
export interface WorkerEnv {
  DB: D1Database;
  ASSETS?: { fetch(request: Request): Promise<Response> };
}
export interface WorkerOptions {
  rng?: () => number;
  now?: () => number;
  aiDelayMs?: number;
  roomTtlMs?: number;
  maxRooms?: number;
  presenceTtlMs?: number;
}
type Reply = ServerResponse & { state?: RoomState };
interface Receipt { id: string; payload: string; response: ServerResponse }
interface Member { tokenHash: string; lastSeen: number; active: boolean; commands: Receipt[] }
interface Document { state: RoomState; members: Record<string, Member> }
interface Row { code: string; revision: number; data: string; expires_at: number; next_ai_at: number | null; updated_at: number }
interface Loaded { row: Row; document: Document }
type JsonObject = Record<string, unknown>;
const BODY_LIMIT = 16_384;
const COMMAND_LIMIT = 1_024;
const RETRIES = 3;
const HEARTBEAT_INTERVAL = 5_000;
const requireThat: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};
class HttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
const object = (value: unknown): JsonObject => {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value), 'Invalid request.');
  return value as JsonObject;
};
const nameOf = (value: unknown) => {
  requireThat(typeof value === 'string', 'Enter a commander name.');
  const name = value.trim();
  requireThat(name.length > 0 && name.length <= 24 && !/[\x00-\x1f\x7f]/.test(name), 'Names must contain 1–24 printable characters.');
  return name;
};
const difficultyOf = (value: unknown): Difficulty => {
  requireThat(value === 'recruit' || value === 'veteran' || value === 'general', 'Choose a valid difficulty.');
  return value;
};
const codeOf = (value: unknown) => {
  requireThat(typeof value === 'string' && /^[a-f0-9]{10}$/i.test(value.trim()), 'Enter a valid room code.');
  return value.trim().toUpperCase();
};
const sessionOf = (value: unknown): Session => {
  try {
    const data = object(value);
    requireThat(typeof data.playerId === 'string' && /^[a-f0-9]{32}$/.test(data.playerId)
      && typeof data.token === 'string' && /^[a-f0-9]{64}$/.test(data.token), 'Invalid session.');
    return { code: codeOf(data.code), playerId: data.playerId, token: data.token };
  } catch { throw new HttpError('Invalid session.', 401); }
};
const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), value => value.toString(16).padStart(2, '0')).join('');
const random = () => crypto.getRandomValues(new Uint32Array(1))[0] / 0x1_0000_0000;
const hash = async (token: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), value => value.toString(16).padStart(2, '0')).join('');
const equalHash = (left: string, right: string) => {
  let different = left.length ^ right.length;
  for (let i = 0; i < 64; i++) different |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  return different === 0;
};
// Stable property order makes retries independent of a JSON serializer's key order.
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as JsonObject)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});
const readBody = async (request: Request): Promise<JsonObject> => {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > BODY_LIMIT)) throw new HttpError('Request is too large.', 413);
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new HttpError('Use application/json.', 415);
  if (!request.body) throw new HttpError('Invalid request.', 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > BODY_LIMIT) {
        await reader.cancel();
        throw new HttpError('Request is too large.', 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
  catch { throw new HttpError('Invalid JSON request.', 400); }
};

/** Every durable mutation, including receipts and presence, uses one document CAS. */
export function createWorker(options: WorkerOptions = {}) {
  const now = options.now ?? Date.now;
  const rng = options.rng ?? random;
  const ttl = options.roomTtlMs ?? 24 * 60 * 60 * 1_000;
  const presenceTtl = options.presenceTtlMs ?? 20_000;
  const aiDelay = options.aiDelayMs ?? 450;
  const maxRooms = options.maxRooms ?? 500;
  const connected = (member: Member | undefined, at: number) => Boolean(member?.active && at - member.lastSeen <= presenceTtl);
  const publicState = (document: Document, playerId: string, at: number) => {
    const state = structuredClone(document.state);
    for (const player of state.players) player.connected = player.isAI || connected(document.members[player.id], at);
    if (state.game) {
      state.game.deck = [];
      state.game.discard = [];
      for (const player of state.game.players) {
        player.connected = player.isAI || connected(document.members[player.id], at);
        if (player.id !== playerId) player.cards = [];
      }
    }
    return state;
  };
  const load = async (db: D1Executor, code: string, at: number): Promise<Loaded> => {
    const row = await db.prepare('SELECT code, revision, data, expires_at, next_ai_at, updated_at FROM rooms WHERE code = ? AND expires_at > ?').bind(code, at).first<Row>();
    if (!row) throw new HttpError('This room is invalid or has expired.', 404);
    return { row, document: JSON.parse(row.data) as Document };
  };
  const authenticate = (document: Document, session: Session, tokenHash: string) => {
    const member = document.members[session.playerId];
    if (!member || !document.state.players.some(player => player.id === session.playerId && !player.isAI)
      || !equalHash(member.tokenHash, tokenHash)) throw new HttpError('This session is invalid or has expired.', 401);
    return member;
  };
  const save = async (db: D1Executor, loaded: Loaded, at: number, nextAiAt = loaded.row.next_ai_at) => {
    const result = await db.prepare('UPDATE rooms SET revision = revision + 1, data = ?, expires_at = MAX(expires_at, ?), next_ai_at = ?, updated_at = MAX(updated_at, ?) WHERE code = ? AND revision = ?')
      .bind(JSON.stringify(loaded.document), at + ttl, nextAiAt, at, loaded.row.code, loaded.row.revision).run();
    return result.meta.changes === 1;
  };
  const nextAI = (document: Document, at: number) => document.state.status === 'playing'
    && document.state.game?.players[document.state.game.currentPlayer]?.isAI ? at + aiDelay : null;
  const addBot = (document: Document, difficulty: Difficulty) => {
    const state = document.state;
    requireThat(state.status === 'lobby' && state.players.length < 6, 'The lobby must have an open seat.');
    let number = 1;
    while (state.players.some(player => player.name === `CPU ${number}`)) number++;
    state.players.push({ id: randomHex(16), name: `CPU ${number}`, color: PLAYER_COLORS.find(color => !state.players.some(player => player.color === color))!, isAI: true, difficulty, connected: true });
  };
  const start = (document: Document, at: number) => {
    const state = document.state;
    requireThat(state.status === 'lobby', 'The campaign has already started.');
    requireThat(state.players.length >= 3 && state.players.length <= 6, 'Add at least three commanders.');
    requireThat(state.players.every(player => player.isAI || connected(document.members[player.id], at)), 'Wait for all commanders to reconnect.');
    const order = [...state.players];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    state.game = createGame(order, rng);
    state.status = 'playing';
  };
  const create = async (db: D1Executor, data: JsonObject, at: number): Promise<Reply> => {
    const name = nameOf(data.name);
    const difficulty = difficultyOf(data.difficulty);
    requireThat(data.mode === 'solo' || data.mode === 'private', 'Choose a valid room mode.');
    requireThat(typeof data.bots === 'number' && Number.isInteger(data.bots) && data.bots >= (data.mode === 'solo' ? 2 : 0) && data.bots <= 5, 'Choose a valid number of computer players.');
    // Reclaim a bounded number of expired records when allocating a room.
    await db.prepare('DELETE FROM rooms WHERE code IN (SELECT code FROM rooms WHERE expires_at <= ? LIMIT 100)').bind(at).run();
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const session = { code: randomHex(5).toUpperCase(), playerId: randomHex(16), token: randomHex(32) };
      const document: Document = {
        state: { code: session.code, revision: 1, hostId: session.playerId, players: [{ id: session.playerId, name, color: PLAYER_COLORS[0], isAI: false, difficulty, connected: true }], status: 'lobby', game: null },
        members: { [session.playerId]: { tokenHash: await hash(session.token), lastSeen: at, active: true, commands: [] } },
      };
      for (let i = 0; i < data.bots; i++) addBot(document, difficulty);
      if (data.mode === 'solo') start(document, at);
      // Allocation and the room cap share one SQLite statement and its lock.
      const inserted = await db.prepare('INSERT OR IGNORE INTO rooms (code, revision, data, expires_at, next_ai_at, updated_at) SELECT ?, 0, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM rooms) < ?')
        .bind(session.code, JSON.stringify(document), at + ttl, nextAI(document, at), at, maxRooms).run();
      if (inserted.meta.changes === 1) return { ok: true, session, state: publicState(document, session.playerId, at) };
    }
    throw new Error('All rooms are occupied. Try again later.');
  };
  const join = async (db: D1Executor, data: JsonObject, at: number): Promise<Reply> => {
    const code = codeOf(data.code);
    const name = nameOf(data.name);
    const session = { code, playerId: randomHex(16), token: randomHex(32) };
    const tokenHash = await hash(session.token);
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const loaded = await load(db, code, at);
      const { document } = loaded;
      requireThat(document.state.status === 'lobby', 'Room not found or campaign already started.');
      requireThat(document.state.players.length < 6, 'This room is full.');
      document.state.players.push({ id: session.playerId, name, color: PLAYER_COLORS.find(color => !document.state.players.some(player => player.color === color))!, isAI: false, difficulty: 'veteran', connected: true });
      document.members[session.playerId] = { tokenHash, lastSeen: at, active: true, commands: [] };
      document.state.revision++;
      if (await save(db, loaded, at)) return { ok: true, session, state: publicState(document, session.playerId, at) };
    }
    throw new Error('The lobby changed. Please try again.');
  };
  const authenticated = async (db: D1Executor, event: string, data: JsonObject, session: Session, at: number): Promise<Reply> => {
    const tokenHash = await hash(session.token);
    let latest: Document | undefined;
    try {
      for (let attempt = 0; attempt < RETRIES; attempt++) {
        const loaded = await load(db, session.code, at);
        const { document } = loaded;
        const member = authenticate(document, session, tokenHash);
        latest = document;
        const state = document.state;
        let nextAiAt = loaded.row.next_ai_at;
        let dirty = false;
        if (!member.active || at - member.lastSeen >= HEARTBEAT_INTERVAL || event === 'room:resume') {
          member.lastSeen = Math.max(member.lastSeen, at);
          member.active = true;
          dirty = true;
        }
        if (event === 'poll' || event === 'room:resume') {
          const game = state.game;
          // At most one AI action per request; a committed deadline prevents
          // simultaneous clients from advancing the same turn more quickly.
          if (state.status === 'playing' && game?.players[game.currentPlayer]?.isAI && (nextAiAt === null || nextAiAt <= at)) {
            state.game = applyAction(game, game.players[game.currentPlayer].id, chooseAIAction(game, rng), rng);
            if (state.game.winner) state.status = 'finished';
            state.revision++;
            nextAiAt = nextAI(document, at);
            dirty = true;
          }
          if (!dirty || await save(db, loaded, at, nextAiAt)) return {
            ok: true, ...(event === 'room:resume' ? { session } : {}), state: publicState(document, session.playerId, at),
          };
          continue;
        }
        if (event === 'game:action') {
          requireThat(typeof data.id === 'string' && /^[a-f0-9]{32}$/.test(data.id), 'Invalid command identifier.');
          const payload = canonical({ revision: data.revision, action: data.action });
          requireThat(new TextEncoder().encode(payload).byteLength <= COMMAND_LIMIT, 'Command is too large.');
          const receipt = member.commands.find(command => command.id === data.id);
          if (receipt) {
            requireThat(receipt.payload === payload, 'Command identifier already used.');
            return { ...receipt.response, state: publicState(document, session.playerId, at) };
          }
          requireThat(state.status === 'playing' && state.game, 'Start a campaign first.');
          requireThat(Number.isSafeInteger(data.revision) && data.revision === state.revision, 'The board changed. Try again with the latest position.');
          object(data.action);
          state.game = applyAction(state.game, session.playerId, data.action as GameAction, rng);
          if (state.game.winner) state.status = 'finished';
          state.revision++;
          member.lastSeen = Math.max(member.lastSeen, at);
          member.active = true;
          member.commands.push({ id: data.id, payload, response: { ok: true } });
          if (member.commands.length > 256) member.commands.shift();
          nextAiAt = nextAI(document, at);
          if (await save(db, loaded, at, nextAiAt)) return { ok: true, state: publicState(document, session.playerId, at) };
          // Re-read after a conflict to detect a concurrently committed receipt.
          // Other successful actions then fail the public revision check.
          continue;
        }
        if (event === 'room:leave') {
          if (state.status === 'lobby') {
            delete document.members[session.playerId];
            state.players = state.players.filter(player => player.id !== session.playerId);
            if (state.hostId === session.playerId) {
              const humans = state.players.filter(player => !player.isAI);
              state.hostId = (humans.find(player => connected(document.members[player.id], at)) ?? humans[0])?.id ?? '';
            }
            if (!Object.keys(document.members).length) {
              const deleted = await db.prepare('DELETE FROM rooms WHERE code = ? AND revision = ?').bind(session.code, loaded.row.revision).run();
              if (deleted.meta.changes === 1) return { ok: true };
              continue;
            }
          } else { member.active = false; member.lastSeen = Math.max(member.lastSeen, at); }
          state.revision++;
          if (await save(db, loaded, at, nextAiAt)) return { ok: true };
          continue;
        }
        requireThat(state.hostId === session.playerId, 'Only the host can do that.');
        if (event === 'room:addBot') addBot(document, difficultyOf(data.difficulty));
        else if (event === 'room:removePlayer') {
          requireThat(state.status === 'lobby', 'The campaign has already started.');
          requireThat(typeof data.playerId === 'string' && data.playerId !== session.playerId, 'You cannot remove yourself.');
          requireThat(state.players.some(player => player.id === data.playerId), 'Player not found.');
          delete document.members[data.playerId];
          state.players = state.players.filter(player => player.id !== data.playerId);
        } else if (event === 'room:start') start(document, at);
        else throw new Error('Unknown command.');
        member.lastSeen = Math.max(member.lastSeen, at);
        member.active = true;
        state.revision++;
        nextAiAt = nextAI(document, at);
        if (await save(db, loaded, at, nextAiAt)) return { ok: true, state: publicState(document, session.playerId, at) };
      }
      // Never return an uncommitted candidate after exhausting conflicts.
      const loaded = await load(db, session.code, at);
      authenticate(loaded.document, session, tokenHash);
      latest = loaded.document;
      throw new Error('The room changed. Please try again.');
    } catch (error) {
      // A validator may have rejected an uncommitted candidate. Re-read the
      // durable state and authenticate again before exposing any private hand.
      if (latest) {
        try {
          const loaded = await load(db, session.code, at);
          authenticate(loaded.document, session, tokenHash);
          return { ok: false, error: error instanceof Error ? error.message : 'Invalid request.', state: publicState(loaded.document, session.playerId, at) };
        } catch { /* Removed/expired members receive no room contents. */ }
      }
      throw error;
    }
  };
  return {
    async fetch(request: Request, env: WorkerEnv): Promise<Response> {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
      try {
        const origin = request.headers.get('origin');
        if (origin && origin !== url.origin) throw new HttpError('Requests must come from this site.', 403);
        if (request.headers.get('sec-fetch-site') === 'cross-site') throw new HttpError('Requests must come from this site.', 403);
        if (url.pathname === '/api/health' && request.method === 'GET') return json({ ok: true });
        if (url.pathname === '/api/transport' && request.method === 'GET') return json({ mode: 'http', persistence: 'd1', pollIntervalMs: 1_200 });
        if (url.pathname !== '/api/command' && url.pathname !== '/api/poll') return json({ ok: false, error: 'Not found.' }, 404);
        if (request.method !== 'POST') return json({ ok: false, error: 'Use POST.' }, 405);
        requireThat(env.DB, 'The campaign database is not configured.');
        const body = await readBody(request);
        const db = env.DB.withSession ? env.DB.withSession('first-primary') : env.DB;
        const at = now();
        if (url.pathname === '/api/poll') return json(await authenticated(db, 'poll', {}, sessionOf(body.session), at));
        requireThat(typeof body.event === 'string', 'Invalid command.');
        const data = object(body.payload ?? {});
        if (body.event === 'room:create' || body.event === 'room:join') {
          requireThat(!body.session, 'Leave your current room first.');
          return json(body.event === 'room:create' ? await create(db, data, at) : await join(db, data, at));
        }
        const session = sessionOf(body.session ?? (body.event === 'room:resume' ? data : undefined));
        return json(await authenticated(db, body.event, data, session, at));
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : 'Invalid request.' }, error instanceof HttpError ? error.status : 200);
      }
    },
  };
}
