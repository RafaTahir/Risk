import { afterEach, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import type { AddressInfo } from 'node:net';
import { createServer } from '../server/app';
import type { RoomState, ServerResponse } from '../shared/types';

const servers: ReturnType<typeof createServer>[] = [];
const clients: Socket[] = [];
afterEach(async () => { clients.splice(0).forEach(s => s.disconnect()); await Promise.all(servers.splice(0).map(s => s.close())); });
async function fixture(rng = () => 0.999, options: Parameters<typeof createServer>[0] = {}) {
  const server = createServer({ rng, aiDelayMs: 2, ...options });
  servers.push(server);
  await new Promise<void>(resolve => server.httpServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
  async function client() {
    const socket = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    clients.push(socket);
    let state: RoomState;
    socket.on('room:state', next => { state = next; });
    await new Promise<void>(resolve => socket.on('connect', resolve));
    return { socket, get state() { return state; }, send: (event: string, data: unknown = {}) => new Promise<ServerResponse>(resolve => socket.emit(event, data, resolve)) };
  }
  return { client, url };
}
async function until(predicate: () => boolean, timeout = 4000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}

describe('authoritative multiplayer', () => {
  it('creates, joins and starts a private room, enforces ownership and applies each command once', async () => {
    const f = await fixture();
    expect(await (await fetch(`${f.url}/api/health`)).json()).toEqual({ ok: true });
    const host = await f.client(); const guest = await f.client();
    const created = await host.send('room:create', { name: 'Host', bots: 1, difficulty: 'general', mode: 'private' });
    expect(created.ok).toBe(true);
    const joined = await guest.send('room:join', { code: created.session!.code, name: 'Guest' });
    expect(joined.ok).toBe(true);
    expect((await guest.send('room:start')).ok).toBe(false);
    expect((await host.send('room:start')).ok).toBe(true);
    await until(() => Boolean(guest.state?.game));
    expect(host.state.game!.players[host.state.game!.currentPlayer].id).toBe(created.session!.playerId);
    const state = host.state;
    expect(state.game!.deck).toEqual([]);
    expect(state.game!.discard).toEqual([]);
    expect(JSON.stringify(state)).not.toContain(created.session!.token);
    const territory = Object.keys(state.game!.territories).find(id => state.game!.territories[id].owner === created.session!.playerId)!;
    const command = { id: 'deploy-1', revision: state.revision, action: { type: 'deploy', territory, count: 1 } };
    expect((await guest.send('game:action', command)).error).toMatch(/turn/);
    expect((await host.send('game:action', { ...command, action: { ...command.action, count: '9000' } })).ok).toBe(false);
    expect((await host.send('game:action', { ...command, revision: -1 })).ok).toBe(false);
    expect((await host.send('game:action', { ...command, action: { ...command.action, padding: 'x'.repeat(1100) } })).error).toMatch(/too large/);
    expect((await host.send('game:action', command)).ok).toBe(true);
    const revision = host.state.revision;
    const armies = host.state.game!.territories[territory].armies;
    expect((await host.send('game:action', command)).ok).toBe(true);
    expect(host.state.revision).toBe(revision);
    expect(host.state.game!.territories[territory].armies).toBe(armies);
    expect((await host.send('game:action', { ...command, action: { type: 'endAttack' } })).ok).toBe(false);
    expect((await host.send('game:action', null)).ok).toBe(false);
    host.socket.disconnect();
    await until(() => guest.state.players.find(p => p.id === created.session!.playerId)?.connected === false);
    const resumed = await f.client();
    expect((await resumed.send('room:resume', { ...created.session!, token: 'a'.repeat(64) })).ok).toBe(false);
    expect((await resumed.send('room:resume', created.session)).ok).toBe(true);
    expect(resumed.state.game!.territories[territory].armies).toBe(armies);
    expect((await resumed.send('game:action', command)).ok).toBe(true);
    const replacement = await f.client();
    expect((await replacement.send('room:resume', created.session)).ok).toBe(true);
    await until(() => !resumed.socket.connected);
    expect(replacement.state.players.find(p => p.id === created.session!.playerId)?.connected).toBe(true);
  });

  it('advances computer turns, randomizes the opener, hides earned cards, and pauses without humans', async () => {
    let seed = 42;
    const f = await fixture(() => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; });
    const host = await f.client();
    const created = await host.send('room:create', { name: 'Solo', bots: 2, difficulty: 'recruit', mode: 'solo' });
    expect(created.ok).toBe(true);
    expect(host.state.game!.players[0].isAI).toBe(true);
    await until(() => host.state.game!.turn >= 3);
    const game = host.state.game!;
    expect(game.players[game.currentPlayer].id).toBe(created.session!.playerId);
    expect(game.players.filter(p => p.isAI).every(p => p.cards.length === 0)).toBe(true);
    expect(game.players.some(p => p.isAI && p.cardCount > 0)).toBe(true);
    const territory = Object.keys(game.territories).find(id => game.territories[id].owner === created.session!.playerId)!;
    await host.send('game:action', { id: 'deploy', revision: host.state.revision, action: { type: 'deploy', territory, count: game.reinforcements } });
    await host.send('game:action', { id: 'endAttack', revision: host.state.revision, action: { type: 'endAttack' } });
    await host.send('game:action', { id: 'endTurn', revision: host.state.revision, action: { type: 'endTurn' } });
    host.socket.disconnect();
    await new Promise(resolve => setTimeout(resolve, 50));
    const reconnect = await f.client();
    expect((await reconnect.send('room:resume', created.session)).ok).toBe(true);
    expect(reconnect.state.game!.turn).toBe(4);
    await until(() => reconnect.state.game!.turn >= 6);
  });

  it('restricts lobby management and validates roster inputs', async () => {
    const f = await fixture(); const host = await f.client(); const guest = await f.client();
    expect((await host.send('room:create', { name: 'X', bots: 500, difficulty: 'general', mode: 'private' })).ok).toBe(false);
    const created = await host.send('room:create', { name: 'Host', bots: 0, difficulty: 'veteran', mode: 'private' });
    const joined = await guest.send('room:join', { code: created.session!.code.toLowerCase(), name: 'Guest' });
    expect(joined.ok).toBe(true);
    expect((await host.send('room:start')).ok).toBe(false);
    expect((await guest.send('room:addBot', { difficulty: 'general' })).ok).toBe(false);
    expect((await host.send('room:addBot', { difficulty: 'invalid' })).ok).toBe(false);
    expect((await host.send('room:addBot', { difficulty: 'general' })).ok).toBe(true);
    expect((await host.send('room:removePlayer', { playerId: joined.session!.playerId })).ok).toBe(true);
    expect((await guest.send('room:resume', joined.session)).ok).toBe(false);
    expect((await guest.send('room:join', { code: created.session!.code, name: 'Guest again' })).ok).toBe(true);
    expect((await host.send('room:start')).ok).toBe(true);
    expect((await host.send('room:removePlayer', { playerId: host.state.players.find(p => p.isAI)!.id })).ok).toBe(false);
  });

  it('preserves a disconnected host and hands an explicitly vacated lobby to an online human', async () => {
    const f = await fixture();
    const host = await f.client(); const absent = await f.client(); const guest = await f.client();
    const created = await host.send('room:create', { name: 'Host', bots: 0, difficulty: 'veteran', mode: 'private' });
    const absentSeat = await absent.send('room:join', { code: created.session!.code, name: 'Absent' });
    const guestSeat = await guest.send('room:join', { code: created.session!.code, name: 'Guest' });

    host.socket.disconnect();
    await until(() => guest.state.players.find(p => p.id === created.session!.playerId)?.connected === false);
    expect(guest.state.hostId).toBe(created.session!.playerId);
    expect((await guest.send('room:addBot', { difficulty: 'recruit' })).ok).toBe(false);

    const resumed = await f.client();
    expect((await resumed.send('room:resume', created.session)).ok).toBe(true);
    absent.socket.disconnect();
    await until(() => guest.state.players.find(p => p.id === absentSeat.session!.playerId)?.connected === false);
    expect((await resumed.send('room:leave')).ok).toBe(true);
    await until(() => !guest.state.players.some(p => p.id === created.session!.playerId));
    expect(guest.state.hostId).toBe(guestSeat.session!.playerId);
    expect((await guest.send('room:removePlayer', { playerId: absentSeat.session!.playerId })).ok).toBe(true);
    expect((await guest.send('room:addBot', { difficulty: 'recruit' })).ok).toBe(true);
    expect((await guest.send('room:addBot', { difficulty: 'veteran' })).ok).toBe(true);
    expect((await guest.send('room:start')).ok).toBe(true);
    expect(guest.state.status).toBe('playing');
  });
});


describe('transport and lifecycle limits', () => {
  it('rejects foreign origins for WebSocket and polling handshakes', async () => {
    const f = await fixture();
    for (const transports of [['websocket'], ['polling']]) {
      const rejected = io(f.url, { transports, extraHeaders: { Origin: 'https://foreign.example' }, reconnection: false, timeout: 1000 });
      clients.push(rejected);
      const outcome = await new Promise<string>(resolve => {
        rejected.on('connect', () => resolve('connected'));
        rejected.on('connect_error', () => resolve('rejected'));
      });
      expect(outcome).toBe('rejected');
    }
    const accepted = io(f.url, { transports: ['websocket'], extraHeaders: { Origin: f.url }, reconnection: false });
    clients.push(accepted);
    await new Promise<void>((resolve, reject) => { accepted.on('connect', resolve); accepted.on('connect_error', reject); });
    expect(accepted.connected).toBe(true);
  });

  it('reclaims empty lobbies immediately and expires disconnected rooms', async () => {
    const f = await fixture(() => 0.999, { maxRooms: 1, roomTtlMs: 30 });
    const first = await f.client(); const second = await f.client();
    const request = { name: 'Host', bots: 0, difficulty: 'general', mode: 'private' };
    expect((await first.send('room:create', request)).ok).toBe(true);
    expect((await second.send('room:create', request)).ok).toBe(false);
    expect((await first.send('room:leave')).ok).toBe(true);
    const created = await second.send('room:create', request);
    expect(created.ok).toBe(true);
    second.socket.disconnect();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect((await first.send('room:resume', created.session)).error).toMatch(/expired/);
    expect((await first.send('room:create', request)).ok).toBe(true);
  });

  it('bounds events per connection and across replacement connections', async () => {
    const f = await fixture();
    const socket = await f.client();
    let response: ServerResponse = { ok: true };
    for (let i = 0; i < 121; i++) response = await socket.send('room:start');
    expect(response.error).toMatch(/Too many requests/);
    for (let connection = 0; connection < 4; connection++) {
      const next = await f.client();
      for (let i = 0; i < 120; i++) response = await next.send('room:start');
      next.socket.disconnect();
    }
    const next = await f.client();
    response = await next.send('room:start');
    expect(response.error).toMatch(/from this network/);
  });
});
