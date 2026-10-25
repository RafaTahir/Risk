import { afterEach, describe, expect, it } from 'vitest';
import { createWorker } from '../worker/app';
import type { GameAction, RoomState, Session } from '../shared/types';
import { TERRITORIES } from '../shared/world';
import { createTestDatabase, type SQLiteD1 } from './helpers/d1';

interface Reply { ok: boolean; error?: string; state?: RoomState; session?: Session }
interface StoredRoom { state: RoomState; members: Record<string, { tokenHash: string; lastSeen: number; active: boolean; commands: unknown[] }> }
const databases: SQLiteD1[] = [];
afterEach(() => databases.splice(0).forEach(database => database.close()));

/** Hold actual SQLite read snapshots so competing requests cannot run serially by accident. */
function readBarrier(database: SQLiteD1) {
  const prepare = database.prepare.bind(database);
  let gate: { remaining: number; ready: Promise<void>; release: () => void; versions: number[] } | undefined;
  database.prepare = sql => {
    const statement = prepare(sql);
    if (/\bFROM\s+rooms\b/i.test(sql) && /\bcode\s*=\s*\?/i.test(sql)) {
      const first = statement.first.bind(statement);
      statement.first = async <T = Record<string, unknown>>(column?: string): Promise<T | null> => {
        const row = await first<T>(column);
        const held = gate;
        if (held && held.remaining > 0 && row) {
          held.versions.push((row as unknown as { revision: number }).revision);
          if (--held.remaining === 0) { gate = undefined; held.release(); }
          await held.ready;
        }
        return row;
      };
    }
    return statement;
  };
  return () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const current = { remaining: 2, ready, release, versions: [] as number[] };
    gate = current;
    return current.versions;
  };
}

function fixture(options: Parameters<typeof createWorker>[0] = {}) {
  const database = createTestDatabase();
  databases.push(database);
  const arm = readBarrier(database);
  let worker = createWorker({ rng: () => 0.999, aiDelayMs: 100, ...options });
  const env = { DB: database };
  const request = (path: string, body: unknown, headers: Record<string, string> = {}) => worker.fetch(new Request(`https://risk.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  }), env);
  const send = async (event: string, payload: unknown = {}, session?: Session): Promise<Reply> =>
    (await request('/api/command', { event, payload, session })).json() as Promise<Reply>;
  const poll = async (session: Session, revision?: number): Promise<Reply> =>
    (await request('/api/poll', { session, revision })).json() as Promise<Reply>;
  const raw = (code: string) => {
    const row = database.database.prepare('SELECT * FROM rooms WHERE code = ?').get(code)!;
    return { ...row, revision: row.revision as number, data: JSON.parse(row.data as string) as StoredRoom };
  };
  const seed = (code: string, change: (stored: StoredRoom) => void) => {
    const room = raw(code);
    change(room.data);
    database.database.prepare('UPDATE rooms SET data = ? WHERE code = ?').run(JSON.stringify(room.data), code);
  };
  const restart = () => { worker = createWorker({ rng: () => 0.999, aiDelayMs: 100, ...options }); };
  return { database, env, arm, raw, seed, restart, request, send, poll, fetch: (request: Request) => worker.fetch(request, env) };
}

async function solo(f: ReturnType<typeof fixture>) {
  const created = await f.send('room:create', { name: 'Host', mode: 'solo', bots: 2, difficulty: 'recruit' });
  expect(created.ok).toBe(true);
  expect(created.state?.game?.players[created.state.game.currentPlayer].id).toBe(created.session!.playerId);
  return { session: created.session!, state: created.state! };
}

function owned(state: RoomState, playerId: string) {
  return Object.keys(state.game!.territories).find(id => state.game!.territories[id].owner === playerId)!;
}
const command = (id: string, revision: number, action: GameAction) => ({ id: id.repeat(32).slice(0, 32), revision, action });

describe('D1 atomic state and durable receipts', () => {
  it('rejects one of two different human commands that read the same board without losing the accepted move', async () => {
    const f = fixture();
    const { session, state } = await solo(f);
    const territory = owned(state, session.playerId);
    const armies = state.game!.territories[territory].armies;
    const versions = f.arm();
    const replies = await Promise.all([
      f.send('game:action', command('a', state.revision, { type: 'deploy', territory, count: 1 }), session),
      f.send('game:action', command('b', state.revision, { type: 'deploy', territory, count: 1 }), session),
    ]);
    expect(versions).toHaveLength(2);
    expect(versions[0]).toBe(versions[1]);
    expect(replies.filter(reply => reply.ok)).toHaveLength(1);
    expect(replies.find(reply => !reply.ok)?.error).toMatch(/board changed|latest|revision/i);
    const latest = (await f.poll(session)).state!;
    expect(latest.revision).toBe(state.revision + 1);
    expect(latest.game!.territories[territory].armies).toBe(armies + 1);
    expect(latest.game!.reinforcements).toBe(state.game!.reinforcements - 1);
  });

  it('commits one attack and its receipt when duplicate requests race, and replays it after a Worker restart', async () => {
    const f = fixture();
    const { session } = await solo(f);
    let from = '';
    let to = '';
    f.seed(session.code, stored => {
      const game = stored.state.game!;
      const origin = TERRITORIES.find(territory => game.territories[territory.id].owner === session.playerId
        && territory.neighbors.some(id => game.territories[id].owner !== session.playerId))!;
      from = origin.id;
      to = origin.neighbors.find(id => game.territories[id].owner !== session.playerId)!;
      game.phase = 'attack';
      game.reinforcements = 0;
      game.territories[from].armies = 8;
      game.territories[to].armies = 8;
    });
    const before = f.raw(session.code).data.state;
    const attack = command('c', before.revision, { type: 'attack', from, to, dice: 3 });
    const versions = f.arm();
    const replies = await Promise.all([f.send('game:action', attack, session), f.send('game:action', attack, session)]);
    expect(versions).toHaveLength(2);
    expect(versions[0]).toBe(versions[1]);
    expect(replies.every(reply => reply.ok)).toBe(true);
    let latest = (await f.poll(session)).state!;
    expect(latest.revision).toBe(before.revision + 1);
    expect(latest.game!.territories[from].armies).toBe(6);
    expect(latest.game!.territories[to].armies).toBe(8);
    expect(latest.game!.log.filter(entry => entry.type === 'attack')).toHaveLength(1);
    const combat = latest.game!.combat;
    f.restart();
    expect((await f.send('game:action', attack, session)).ok).toBe(true);
    latest = (await f.poll(session)).state!;
    expect(latest.revision).toBe(before.revision + 1);
    expect(latest.game!.combat).toEqual(combat);
    expect((await f.send('game:action', { ...attack, action: { ...attack.action, dice: 2 } }, session)).ok).toBe(false);
    expect((await f.poll(session)).state!.game!.territories[from].armies).toBe(6);
  });

  it('allows only one due AI action when two polls read the same SQL generation', async () => {
    let now = 1_000_000;
    const f = fixture({ now: () => now });
    const { session } = await solo(f);
    f.seed(session.code, stored => {
      const game = stored.state.game!;
      game.currentPlayer = game.players.findIndex(player => player.isAI);
      game.phase = 'reinforce';
      game.reinforcements = 4;
    });
    f.database.database.prepare('UPDATE rooms SET next_ai_at = ? WHERE code = ?').run(now, session.code);
    const before = f.raw(session.code).data.state;
    const total = Object.values(before.game!.territories).reduce((sum, territory) => sum + territory.armies, 0);
    now += 100;
    const versions = f.arm();
    const replies = await Promise.all([f.poll(session), f.poll(session)]);
    expect(versions).toHaveLength(2);
    expect(versions[0]).toBe(versions[1]);
    expect(replies.every(reply => reply.ok)).toBe(true);
    const latest = f.raw(session.code).data.state;
    expect(latest.revision).toBe(before.revision + 1);
    expect(latest.game!.phase).toBe('attack');
    expect(Object.values(latest.game!.territories).reduce((sum, territory) => sum + territory.armies, 0)).toBe(total + 4);
  });

  it('preserves a human endTurn racing with a stale heartbeat and does not invalidate commands with repeated polls', async () => {
    let now = 1_000_000;
    const f = fixture({ now: () => now });
    const { session } = await solo(f);
    const originalRevision = (await f.poll(session)).state!.revision;
    for (let index = 0; index < 3; index++) {
      now += 6_000;
      expect((await f.poll(session)).state!.revision).toBe(originalRevision);
    }
    f.seed(session.code, stored => { stored.state.game!.phase = 'fortify'; stored.state.game!.reinforcements = 0; });
    now += 6_000;
    const versions = f.arm();
    const [moved, heartbeat] = await Promise.all([
      f.send('game:action', command('d', originalRevision, { type: 'endTurn' }), session),
      f.poll(session),
    ]);
    expect(versions).toHaveLength(2);
    expect(versions[0]).toBe(versions[1]);
    expect(moved.ok).toBe(true);
    expect(heartbeat.ok).toBe(true);
    const stored = f.raw(session.code).data;
    expect(stored.state.game!.turn).toBe(2);
    expect(stored.state.revision).toBe(originalRevision + 1);
    expect(stored.members[session.playerId].lastSeen).toBe(now);
  });

  it('keeps both an AI move and a human departure when their document writes race', async () => {
    const now = 1_000_000;
    const f = fixture({ now: () => now });
    const host = await f.send('room:create', { name: 'Host', mode: 'private', bots: 1, difficulty: 'recruit' });
    const guest = await f.send('room:join', { name: 'Guest', code: host.session!.code });
    expect((await f.send('room:start', {}, host.session)).ok).toBe(true);
    f.seed(host.session!.code, stored => {
      const game = stored.state.game!;
      game.currentPlayer = game.players.findIndex(player => player.isAI);
      game.phase = 'reinforce';
      game.reinforcements = 4;
    });
    f.database.database.prepare('UPDATE rooms SET next_ai_at = ? WHERE code = ?').run(now, host.session!.code);
    const before = f.raw(host.session!.code).data.state;
    const armies = Object.values(before.game!.territories).reduce((sum, territory) => sum + territory.armies, 0);
    const versions = f.arm();
    const [left, polled] = await Promise.all([
      f.send('room:leave', {}, host.session),
      f.poll(guest.session!),
    ]);
    expect(versions).toHaveLength(2);
    expect(versions[0]).toBe(versions[1]);
    expect(left.ok).toBe(true);
    expect(polled.ok).toBe(true);
    const stored = f.raw(host.session!.code).data;
    expect(stored.members[host.session!.playerId].active).toBe(false);
    expect(stored.members[guest.session!.playerId].active).toBe(true);
    expect(stored.state.revision).toBe(before.revision + 2);
    expect(stored.state.game!.phase).toBe('attack');
    expect(Object.values(stored.state.game!.territories).reduce((sum, territory) => sum + territory.armies, 0)).toBe(armies + 4);
    expect((await f.poll(guest.session!)).state!.players.find(player => player.id === host.session!.playerId)!.connected).toBe(false);
  });
});

describe('Worker session and request boundaries', () => {
  it('stores token hashes, authenticates membership, and masks all other hands and draw piles on every response', async () => {
    const f = fixture();
    const host = await f.send('room:create', { name: 'Host', mode: 'private', bots: 1, difficulty: 'recruit' });
    const guest = await f.send('room:join', { name: 'Guest', code: host.session!.code });
    expect(guest.ok).toBe(true);
    expect((await f.send('room:start', {}, host.session)).ok).toBe(true);
    f.seed(host.session!.code, stored => {
      const game = stored.state.game!;
      game.players.forEach((player, index) => {
        player.cards = [{ id: `private-card-${index}`, territory: null, symbol: 'wild' }];
        player.cardCount = 1;
      });
      game.deck = [{ id: 'private-deck-card', territory: null, symbol: 'wild' }];
      game.discard = [{ id: 'private-discard-card', territory: null, symbol: 'wild' }];
    });
    const stored = f.raw(host.session!.code).data;
    expect(JSON.stringify(stored)).not.toContain(host.session!.token);
    expect(JSON.stringify(stored)).not.toContain(guest.session!.token);
    const expectedHash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(host.session!.token))).toString('hex');
    expect(stored.members[host.session!.playerId].tokenHash).toBe(expectedHash);
    for (const session of [host.session!, guest.session!]) {
      for (const reply of [await f.poll(session), await f.send('game:action', command('e', -1, { type: 'endTurn' }), session)]) {
        const state = reply.state!;
        expect(state).toBeDefined();
        expect(state.game!.players.find(player => player.id === session.playerId)!.cards).toHaveLength(1);
        expect(state.game!.players.filter(player => player.id !== session.playerId).every(player => player.cards.length === 0 && player.cardCount === 1)).toBe(true);
        expect(state.game!.deck).toEqual([]);
        expect(state.game!.discard).toEqual([]);
        const serialized = JSON.stringify(reply);
        expect(serialized).not.toContain('private-deck-card');
        expect(serialized).not.toContain('private-discard-card');
        expect(serialized).not.toContain('tokenHash');
        expect(serialized).not.toContain('lastSeen');
        expect(serialized).not.toContain(host.session!.token);
        expect(serialized).not.toContain(guest.session!.token);
      }
    }
    const forgedResponse = await f.request('/api/poll', { session: { ...host.session!, token: guest.session!.token } });
    expect(forgedResponse.status).toBe(401);
    const forged = await forgedResponse.json() as Reply;
    expect(forged.ok).toBe(false);
    expect(forged.state).toBeUndefined();
    expect((await f.send('room:resume', { ...host.session!, token: guest.session!.token })).state).toBeUndefined();
  });

  it('invalidates a removed member token across poll, resume and command requests', async () => {
    const f = fixture();
    const host = await f.send('room:create', { name: 'Host', mode: 'private', bots: 0, difficulty: 'recruit' });
    const guest = await f.send('room:join', { name: 'Guest', code: host.session!.code });
    expect((await f.send('room:removePlayer', { playerId: guest.session!.playerId }, host.session)).ok).toBe(true);
    for (const reply of [await f.poll(guest.session!), await f.send('room:resume', guest.session), await f.send('room:addBot', { difficulty: 'general' }, guest.session)]) {
      expect(reply.ok).toBe(false);
      expect(reply.state).toBeUndefined();
    }
    expect((await f.request('/api/poll', { session: guest.session })).status).toBe(401);
    expect(f.raw(host.session!.code).data.members[guest.session!.playerId]).toBeUndefined();
  });

  it('rejects foreign origins, credentials in URLs, and bodies over the limit before any database work', async () => {
    const f = fixture();
    let queries = 0;
    const prepare = f.database.prepare.bind(f.database);
    f.database.prepare = sql => { queries++; return prepare(sql); };
    const create = { event: 'room:create', payload: { name: 'Host', mode: 'private', bots: 0, difficulty: 'recruit' } };
    for (const origin of ['https://foreign.example', 'http://risk.example', 'https://risk.example:444', 'null']) {
      const response = await f.request('/api/command', create, { Origin: origin });
      expect(response.status).toBe(403);
      expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
    }
    const oversized = await f.request('/api/command', { ...create, padding: 'x'.repeat(17_000) });
    expect(oversized.status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(create)));
      controller.enqueue(new TextEncoder().encode(' '.repeat(17_000)));
      controller.close();
    } });
    const streamed = await f.fetch(new Request('https://risk.example/api/command', {
      method: 'POST', body: stream, duplex: 'half', headers: { 'Content-Type': 'application/json' },
    } as RequestInit & { duplex: 'half' }));
    expect(streamed.status).toBe(413);
    const inURL = await f.fetch(new Request(`https://risk.example/api/poll?token=${'a'.repeat(64)}&code=0123456789`));
    expect(inURL.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await inURL.json())).not.toContain('a'.repeat(64));
    expect(queries).toBe(0);
    expect((await f.request('/api/command', create, { Origin: 'https://risk.example' })).status).toBe(200);
  });

  it('expires persisted sessions after inactivity across isolate restarts', async () => {
    let now = 1_000_000;
    const f = fixture({ now: () => now, roomTtlMs: 30_000, presenceTtlMs: 10_000 });
    const created = await f.send('room:create', { name: 'Host', mode: 'private', bots: 0, difficulty: 'recruit' });
    now += 31_000;
    f.restart();
    const expiredResponse = await f.request('/api/poll', { session: created.session });
    expect(expiredResponse.status).toBe(404);
    const expired = await expiredResponse.json() as Reply;
    expect(expired.ok).toBe(false);
    expect(expired.state).toBeUndefined();
    expect((await f.send('room:resume', created.session)).ok).toBe(false);
  });
});
