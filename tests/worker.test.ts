import { afterEach, describe, expect, it } from 'vitest';
import { createWorker } from '../worker/app';
import type { RoomState, ServerResponse, Session } from '../shared/types';
import { createTestDatabase, type SQLiteD1 } from './helpers/d1';

type Reply = ServerResponse & { state?: RoomState };
type Options = Parameters<typeof createWorker>[0];
type Environment = Parameters<ReturnType<typeof createWorker>['fetch']>[1];
const databases: SQLiteD1[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); });

function fixture(options: Options = {}) {
  const db = createTestDatabase();
  databases.push(db);
  const env = { DB: db as unknown as Environment['DB'] };
  let time = 1_000_000;
  const settings = { rng: () => 0.999, now: () => time, ...options };
  let worker = createWorker(settings);
  const request = async (path: string, body?: unknown, headers?: HeadersInit) => {
    const response = await worker.fetch(new Request(`https://risk.example${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: 'https://risk.example' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);
    return { response, data: await response.json() as Reply };
  };
  const command = async (event: string, payload: unknown = {}, session?: Session) => (await request('/api/command', { event, payload, ...(session ? { session } : {}) })).data;
  const poll = async (session: Session) => (await request('/api/poll', { session })).data;
  const create = async (payload: Record<string, unknown> = {}) => command('room:create', {
    name: 'Host', bots: 0, difficulty: 'veteran', mode: 'private', ...payload,
  });
  return { db, env, request, command, poll, create, advance: (milliseconds: number) => { time += milliseconds; }, restart: () => { worker = createWorker(settings); } };
}

describe('durable HTTP multiplayer', () => {
  it('authenticates two commanders, hides secrets, and commits retry receipts with the game state', async () => {
    const f = fixture();
    expect((await f.request('/api/health')).data).toEqual({ ok: true });
    expect((await f.request('/api/transport')).data).toEqual({ mode: 'http', persistence: 'd1', pollIntervalMs: 1200 });
    const host = await f.create({ bots: 1, difficulty: 'general' });
    expect(host.ok).toBe(true);
    expect(host.session!.code).toMatch(/^[A-F0-9]{10}$/);
    expect(host.session!.playerId).toMatch(/^[a-f0-9]{32}$/);
    expect(host.session!.token).toMatch(/^[a-f0-9]{64}$/);
    const guest = await f.command('room:join', { name: 'Guest', code: host.session!.code.toLowerCase() });
    expect(guest.ok).toBe(true);
    expect((await f.command('room:start', {}, guest.session)).ok).toBe(false);
    const started = await f.command('room:start', {}, host.session);
    expect(started.ok).toBe(true);
    const state = started.state!;
    expect(state.game!.players[state.game!.currentPlayer].id).toBe(host.session!.playerId);
    expect(state.game!.deck).toEqual([]);
    expect(state.game!.discard).toEqual([]);
    expect(state.game!.players.filter(p => p.id !== host.session!.playerId).every(p => !p.cards.length)).toBe(true);
    const stored = f.db.database.prepare('SELECT data FROM rooms WHERE code = ?').get(host.session!.code)!;
    expect(String(stored.data)).not.toContain(host.session!.token);
    expect(String(stored.data)).not.toContain(guest.session!.token);
    expect(JSON.stringify(state)).not.toContain(host.session!.token);

    const territory = Object.keys(state.game!.territories).find(id => state.game!.territories[id].owner === host.session!.playerId)!;
    const action = { id: '1'.padStart(32, '0'), revision: state.revision, action: { type: 'deploy', territory, count: 1 } };
    expect((await f.command('game:action', action, guest.session)).error).toMatch(/turn/i);
    const forged = await f.command('game:action', action, { ...host.session!, token: 'f'.repeat(64) });
    expect(forged.ok).toBe(false);
    expect(forged.state).toBeUndefined();
    expect((await f.command('game:action', { ...action, action: { ...action.action, count: '9000' } }, host.session)).ok).toBe(false);
    const applied = await Promise.all([f.command('game:action', action, host.session), f.command('game:action', action, host.session)]);
    expect(applied.every(result => result.ok)).toBe(true);
    const latest = (await f.poll(host.session!)).state!;
    expect(latest.revision).toBe(state.revision + 1);
    expect(latest.game!.territories[territory].armies).toBe(state.game!.territories[territory].armies + 1);
    const collision = await f.command('game:action', { ...action, action: { type: 'endAttack' } }, host.session);
    expect(collision.ok).toBe(false);
    expect(collision.error).toMatch(/identifier|used/i);
    const stale = await f.command('game:action', { ...action, id: '2'.padStart(32, '0') }, host.session);
    expect(stale.ok).toBe(false);
    expect(stale.state!.revision).toBe(latest.revision);

    f.restart();
    const resumed = await f.command('room:resume', host.session);
    expect(resumed.ok).toBe(true);
    expect(resumed.session).toEqual(host.session);
    expect(resumed.state!.game!.territories[territory].armies).toBe(latest.game!.territories[territory].armies);
    expect((await f.command('game:action', action, host.session)).ok).toBe(true);
    expect((await f.poll(guest.session!)).state!.revision).toBe(latest.revision);
  });

  it('derives presence without changing the board revision and transfers a vacated lobby to an active human', async () => {
    const f = fixture();
    const host = await f.create();
    const absent = await f.command('room:join', { name: 'Absent', code: host.session!.code });
    const guest = await f.command('room:join', { name: 'Guest', code: host.session!.code });
    const before = (await f.poll(guest.session!)).state!;
    f.advance(21_000);
    const seen = (await f.poll(guest.session!)).state!;
    expect(seen.revision).toBe(before.revision);
    expect(seen.players.find(p => p.id === host.session!.playerId)!.connected).toBe(false);
    expect(seen.players.find(p => p.id === guest.session!.playerId)!.connected).toBe(true);
    expect(seen.hostId).toBe(host.session!.playerId);
    expect((await f.command('room:addBot', { difficulty: 'general' }, guest.session)).ok).toBe(false);
    expect((await f.command('room:start', {}, host.session)).ok).toBe(false);
    expect((await f.command('room:resume', host.session)).ok).toBe(true);
    expect((await f.command('room:leave', {}, host.session)).ok).toBe(true);
    const inherited = (await f.poll(guest.session!)).state!;
    expect(inherited.hostId).toBe(guest.session!.playerId);
    expect(inherited.players.some(p => p.id === host.session!.playerId)).toBe(false);
    expect((await f.poll(host.session!)).ok).toBe(false);
    expect((await f.command('room:removePlayer', { playerId: absent.session!.playerId }, guest.session)).ok).toBe(true);
    expect((await f.poll(absent.session!)).ok).toBe(false);
    expect((await f.command('room:addBot', { difficulty: 'recruit' }, guest.session)).ok).toBe(true);
    expect((await f.command('room:addBot', { difficulty: 'general' }, guest.session)).ok).toBe(true);
    expect((await f.command('room:start', {}, guest.session)).ok).toBe(true);
  });

  it('advances at most one computer action per due time across concurrent polls and Worker restarts', async () => {
    const f = fixture({ rng: () => 0, aiDelayMs: 450 });
    const host = await f.create({ mode: 'solo', bots: 2 });
    expect(host.ok).toBe(true);
    expect(host.state!.game!.players[0].isAI).toBe(true);
    const revision = host.state!.revision;
    expect((await f.poll(host.session!)).state!.revision).toBe(revision);
    f.advance(450);
    const polls = await Promise.all(Array.from({ length: 5 }, () => f.poll(host.session!)));
    expect(polls.every(result => result.ok)).toBe(true);
    const next = (await f.poll(host.session!)).state!;
    expect(next.revision).toBe(revision + 1);
    expect((await f.poll(host.session!)).state!.revision).toBe(next.revision);
    f.restart();
    expect((await f.poll(host.session!)).state!.revision).toBe(next.revision);
    f.advance(450);
    expect((await f.poll(host.session!)).state!.revision).toBe(next.revision + 1);
    const persisted = f.db.database.prepare('SELECT data FROM rooms WHERE code = ?').get(host.session!.code)!.data;
    f.advance(60_000);
    expect(f.db.database.prepare('SELECT data FROM rooms WHERE code = ?').get(host.session!.code)!.data).toBe(persisted);
  });

  it('retains earned card counts while hiding the cards of computer opponents', async () => {
    let seed = 42;
    const f = fixture({ rng: () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; } });
    const host = await f.create({ mode: 'solo', bots: 2, difficulty: 'recruit' });
    let state = host.state!;
    expect(state.game!.players[state.game!.currentPlayer].isAI).toBe(true);
    for (let count = 0; count < 600 && state.game!.players[state.game!.currentPlayer].isAI; count++) {
      f.advance(450);
      state = (await f.poll(host.session!)).state!;
    }
    expect(state.game!.players[state.game!.currentPlayer].id).toBe(host.session!.playerId);
    const bots = state.game!.players.filter(player => player.isAI);
    expect(bots.every(player => player.cards.length === 0)).toBe(true);
    expect(bots.some(player => player.cardCount > 0)).toBe(true);
    expect(state.game!.deck).toEqual([]);
    expect(state.game!.discard).toEqual([]);
  });

  it('limits room and roster growth and reclaims empty or expired rooms', async () => {
    const f = fixture({ maxRooms: 1, roomTtlMs: 30_000 });
    expect((await f.create({ bots: 500 })).ok).toBe(false);
    expect((await f.create({ name: 'x'.repeat(25) })).ok).toBe(false);
    const host = await f.create({ bots: 5 });
    expect(host.ok).toBe(true);
    expect((await f.create()).ok).toBe(false);
    expect((await f.command('room:join', { code: host.session!.code, name: 'Overflow' })).ok).toBe(false);
    expect((await f.command('room:addBot', { difficulty: 'general' }, host.session)).ok).toBe(false);
    expect((await f.command('room:leave', {}, host.session)).ok).toBe(true);
    const replacement = await f.create();
    expect(replacement.ok).toBe(true);
    f.advance(30_001);
    expect((await f.poll(replacement.session!)).ok).toBe(false);
    expect((await f.create()).ok).toBe(true);
  });
});
