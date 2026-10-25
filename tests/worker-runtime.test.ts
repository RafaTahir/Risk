import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Log, LogLevel, Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RoomState, ServerResponse, Session } from '../shared/types';

type Reply = ServerResponse & { state?: RoomState };
interface StoredRoom {
  state: RoomState;
  members: Record<string, { tokenHash: string; commands: { id: string }[] }>;
}

const root = fileURLToPath(new URL('../', import.meta.url));
const origin = 'http://risk.test';

describe.sequential('bundled Worker with real D1 storage', () => {
  let runtime: Miniflare;
  let persistence: string;

  const createRuntime = () => new Miniflare({
    modules: true,
    scriptPath: path.join(root, 'dist-worker/worker.js'),
    compatibilityDate: '2026-08-01',
    d1Databases: { DB: 'risk-rooms-runtime-test' },
    d1Persist: persistence,
    log: new Log(LogLevel.ERROR),
  });

  beforeAll(async () => {
    await promisify(execFile)(process.execPath, [path.join(root, 'scripts/build-worker.mjs')], { cwd: root });
    persistence = await mkdtemp(path.join(tmpdir(), 'risk-worker-d1-'));
    runtime = createRuntime();
    const database = await runtime.getD1Database('DB');
    const migration = await readFile(path.join(root, 'migrations/0001_rooms.sql'), 'utf8');
    for (const statement of migration.split(';').map(sql => sql.trim()).filter(Boolean)) {
      await database.prepare(statement).run();
    }
  }, 30_000);

  afterAll(async () => {
    await runtime?.dispose();
    if (persistence) await rm(persistence, { recursive: true, force: true });
  }, 10_000);

  const post = (pathname: string, body: unknown) => runtime.dispatchFetch(`${origin}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(body),
  });
  const command = async (event: string, payload: unknown = {}, session?: Session): Promise<Reply> => {
    const response = await post('/api/command', { event, payload, ...(session ? { session } : {}) });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    return await response.json() as Reply;
  };
  const poll = async (session: Session): Promise<Reply> => {
    const response = await post('/api/poll', { session });
    expect(response.status).toBe(200);
    return await response.json() as Reply;
  };

  it('serves the HTTP transport and bounds malformed or foreign requests', async () => {
    const health = await runtime.dispatchFetch(`${origin}/api/health`);
    expect(await health.json()).toEqual({ ok: true });
    const transport = await runtime.dispatchFetch(`${origin}/api/transport`);
    expect(await transport.json()).toEqual({ mode: 'http', persistence: 'd1', pollIntervalMs: 1200 });
    expect((await runtime.dispatchFetch(`${origin}/api/unknown`)).status).toBe(404);
    expect((await runtime.dispatchFetch(`${origin}/api/command`)).status).toBe(405);

    const requests = [
      { headers: { 'Content-Type': 'text/plain' }, body: '{}', status: 415 },
      { headers: { 'Content-Type': 'application/json' }, body: '{', status: 400 },
      { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(16_384) }), status: 413 },
      { headers: { 'Content-Type': 'application/json', Origin: 'https://foreign.example' }, body: '{}', status: 403 },
      { headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }, body: '{}', status: 403 },
    ];
    for (const { status, ...request } of requests) {
      const response = await runtime.dispatchFetch(`${origin}/api/command`, { method: 'POST', ...request });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ ok: false, error: expect.any(String) });
    }
    expect(await command('room:create', { name: 'Invalid', bots: 20, mode: 'private', difficulty: 'general' }))
      .toMatchObject({ ok: false, error: expect.any(String) });
  });

  it('persists rooms and command receipts across runtime restarts while filtering private state', async () => {
    const created = await command('room:create', { name: 'Host', bots: 0, mode: 'private', difficulty: 'general' });
    expect(created.ok).toBe(true);
    const host = created.session!;
    expect(host.code).toMatch(/^[A-F0-9]{10}$/);
    expect(host.token).toMatch(/^[a-f0-9]{64}$/);
    const guestReply = await command('room:join', { code: host.code.toLowerCase(), name: 'Guest' });
    const thirdReply = await command('room:join', { code: host.code, name: 'Third' });
    expect(guestReply.ok).toBe(true);
    expect(thirdReply.ok).toBe(true);
    const guest = guestReply.session!;
    const sessions = [host, guest, thirdReply.session!];
    expect(await command('room:start', {}, guest)).toMatchObject({ ok: false, error: expect.stringMatching(/host/i) });

    const started = await command('room:start', {}, host);
    expect(started.ok).toBe(true);
    expect(started.state!.status).toBe('playing');
    const game = started.state!.game!;
    const actor = sessions.find(session => session.playerId === game.players[game.currentPlayer].id)!;
    const other = sessions.find(session => session.playerId !== actor.playerId)!;
    const territory = Object.keys(game.territories).find(id => game.territories[id].owner === actor.playerId)!;
    const beforeArmies = game.territories[territory].armies;
    const action = { id: 'a'.repeat(32), revision: started.state!.revision, action: { type: 'deploy', territory, count: 1 } };
    expect(await command('game:action', action, other)).toMatchObject({ ok: false, error: expect.stringMatching(/turn/i) });
    const applied = await command('game:action', action, actor);
    expect(applied.ok).toBe(true);
    expect(applied.state!.game!.territories[territory].armies).toBe(beforeArmies + 1);

    // Seed known private hands in real D1 so the privacy assertions exercise
    // nonempty data for every recipient, including persisted deck and discard.
    const database = await runtime.getD1Database('DB');
    const stored = await database.prepare('SELECT data FROM rooms WHERE code = ?').bind(host.code).first<{ data: string }>();
    const document = JSON.parse(stored!.data) as StoredRoom;
    const privateGame = document.state.game!;
    for (const player of privateGame.players) {
      player.cards = [privateGame.deck.shift()!];
      player.cardCount = 1;
    }
    privateGame.discard = [privateGame.deck.shift()!];
    expect(privateGame.deck.length).toBeGreaterThan(0);
    for (const session of sessions) {
      expect(document.members[session.playerId].tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(document.members[session.playerId].tokenHash).not.toBe(session.token);
      expect(stored!.data).not.toContain(session.token);
    }
    expect(document.members[actor.playerId].commands).toHaveLength(1);
    await database.prepare('UPDATE rooms SET data = ?, revision = revision + 1 WHERE code = ?')
      .bind(JSON.stringify(document), host.code).run();

    await runtime.dispose();
    runtime = createRuntime();
    await runtime.ready;

    const invalidResponse = await post('/api/poll', { session: { ...host, token: '0'.repeat(64) } });
    expect(invalidResponse.status).toBe(401);
    const invalid = await invalidResponse.json() as Reply;
    expect(invalid).toMatchObject({ ok: false, error: expect.any(String) });
    expect(invalid.state).toBeUndefined();
    const resumed = await command('room:resume', host, host);
    expect(resumed.ok).toBe(true);
    expect(resumed.session).toEqual(host);

    for (const session of sessions) {
      const restored = await poll(session);
      expect(restored.ok).toBe(true);
      const state = restored.state!;
      expect(state.game!.territories[territory].armies).toBe(beforeArmies + 1);
      expect(state.game!.deck).toEqual([]);
      expect(state.game!.discard).toEqual([]);
      expect(state.game!.players.find(player => player.id === session.playerId)!.cards).toHaveLength(1);
      expect(state.game!.players.filter(player => player.id !== session.playerId).every(player => player.cards.length === 0 && player.cardCount === 1)).toBe(true);
      for (const member of sessions) expect(JSON.stringify(state)).not.toContain(member.token);
      expect(JSON.stringify(state)).not.toContain('tokenHash');
    }

    const retried = await command('game:action', action, actor);
    expect(retried.ok).toBe(true);
    expect(retried.state!.revision).toBe(applied.state!.revision);
    expect(retried.state!.game!.territories[territory].armies).toBe(beforeArmies + 1);
    expect(await command('game:action', { ...action, action: { ...action.action, count: 2 } }, actor))
      .toMatchObject({ ok: false, error: expect.stringMatching(/identifier already used/i) });
    const persisted = await (await runtime.getD1Database('DB')).prepare('SELECT data FROM rooms WHERE code = ?').bind(host.code).first<{ data: string }>();
    expect((JSON.parse(persisted!.data) as StoredRoom).members[actor.playerId].commands).toHaveLength(1);
  }, 30_000);
});
