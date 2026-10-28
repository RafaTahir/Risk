import { describe, expect, it } from 'vitest';
import { applyAction, createGame } from '../shared/game';
import { TERRITORIES } from '../shared/world';
import type { GameState, PlayerSpec } from '../shared/types';

const players: PlayerSpec[] = Array.from({ length: 6 }, (_, index) => ({
  id: `p${index}`, name: `Player ${index}`, color: ['#f00', '#00f', '#0f0', '#ff0', '#f0f', '#0ff'][index],
  isAI: false, difficulty: 'veteran',
}));
function seeded(seed = 821) {
  return () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; };
}
function battle() {
  const game = createGame(players.slice(0, 3), seeded());
  const from = TERRITORIES[0].id, to = TERRITORIES[0].neighbors[0];
  game.phase = 'attack'; game.reinforcements = 0;
  game.territories[from] = { owner: 'p0', armies: 8 };
  game.territories[to] = { owner: 'p1', armies: 2 };
  return { game, from, to };
}

describe('public presentation outcomes', () => {
  it('describes real setup allowances for every supported player count without private state', () => {
    for (const count of [3, 4, 5, 6]) {
      const game = createGame(players.slice(0, count), seeded());
      const total = Object.values(game.territories).reduce((sum, territory) => sum + territory.armies, 0);
      expect(game.presentationEvents).toHaveLength(1);
      expect(game.presentationEvents![0]).toMatchObject({ id: 1, type: 'setup', playerId: 'p0', color: '#f00', count: total });
      const placements = game.presentationEvents![0].placements!;
      expect(placements).toHaveLength(42);
      expect(placements.reduce((sum, placement) => sum + placement.count, 0)).toBe(total);
      for (const placement of placements) expect(placement).toEqual({ territory: placement.territory, owner: game.territories[placement.territory].owner, count: game.territories[placement.territory].armies });
      expect(total).toBe(({ 3: 35, 4: 30, 5: 25, 6: 20 } as Record<number, number>)[count] * count);
    }
  });

  it('records accepted deployment once and preserves original and journal after rejection', () => {
    const game = createGame(players.slice(0, 3), seeded());
    const territory = TERRITORIES.find(t => game.territories[t.id].owner === 'p0')!.id;
    const original = structuredClone(game);
    expect(() => applyAction(game, 'p1', { type: 'deploy', territory, count: 1 })).toThrow();
    expect(() => applyAction(game, 'p0', { type: 'deploy', territory, count: game.reinforcements + 1 })).toThrow();
    expect(game).toEqual(original);
    const deployed = applyAction(game, 'p0', { type: 'deploy', territory, count: 1 });
    expect(deployed.presentationEvents!.at(-1)).toEqual({ id: 2, type: 'deploy', playerId: 'p0', color: '#f00', to: territory, count: 1 });
    expect(deployed.territories[territory].armies - game.territories[territory].armies).toBe(1);
    expect(deployed.presentationEvents![0].placements!.find(item => item.territory === territory)!.count).toBe(game.territories[territory].armies);
    expect(game).toEqual(original);
  });

  it('retains exact defender ties, dice and casualties independently of the latest combat object', () => {
    const { game, from, to } = battle();
    const next = applyAction(game, 'p0', { type: 'attack', from, to, dice: 3 }, () => .5);
    const event = next.presentationEvents!.at(-1)!;
    expect(event).toEqual({ id: 2, type: 'attack', playerId: 'p0', color: '#f00', from, to, count: 3,
      defenderColor: '#00f', attackDice: [4, 4, 4], defenseDice: [4, 4], attackerLoss: 2, defenderLoss: 0 });
    expect(game.territories[from].armies - next.territories[from].armies).toBe(event.attackerLoss);
    expect(game.territories[to].armies - next.territories[to].armies).toBe(event.defenderLoss);
    next.combat!.attackDice[0] = 1;
    expect(event.attackDice).toEqual([4, 4, 4]);
  });

  it('replays conquest and fortification as separate actual movements, using the acting player before turn changes', () => {
    const { game, from, to } = battle();
    const rolls = [.99, .99, .99, 0, 0];
    const won = applyAction(game, 'p0', { type: 'attack', from, to, dice: 3 }, () => rolls.shift()!);
    const occupied = applyAction(won, 'p0', { type: 'occupy', count: 3 });
    expect(occupied.presentationEvents!.at(-1)).toEqual({ id: 3, type: 'conquest', playerId: 'p0', color: '#f00', from, to, count: 3 });
    const fortifying = applyAction(occupied, 'p0', { type: 'endAttack' });
    expect(fortifying.presentationEvents).toEqual(occupied.presentationEvents);
    const fortified = applyAction(fortifying, 'p0', { type: 'fortify', from, to, count: 1 });
    expect(fortified.currentPlayer).toBe(1);
    expect(fortified.presentationEvents!.at(-1)).toEqual({ id: 4, type: 'move', playerId: 'p0', color: '#f00', from, to, count: 1 });
  });

  it('upgrades persisted legacy games and bounds replay across skipped snapshots without reusing event IDs', () => {
    let game = createGame(players.slice(0, 3), seeded());
    delete game.presentationEvents;
    game = JSON.parse(JSON.stringify(game)) as GameState;
    const territory = TERRITORIES.find(t => game.territories[t.id].owner === 'p0')!.id;
    game.reinforcements = 80;
    for (let index = 0; index < 70; index++) game = applyAction(game, 'p0', { type: 'deploy', territory, count: 1 });
    expect(game.presentationEvents).toHaveLength(64);
    expect(game.presentationEvents!.map(event => event.id)).toEqual(Array.from({ length: 64 }, (_, index) => index + 7));
    const serialized = JSON.parse(JSON.stringify(game)) as GameState;
    const recovered = applyAction(serialized, 'p0', { type: 'deploy', territory, count: 1 });
    expect(recovered.presentationEvents!.at(-1)!.id).toBe(71);
    expect(recovered.presentationEvents).toHaveLength(64);
    expect(Object.keys(recovered.presentationEvents![0]).sort()).toEqual(['color', 'count', 'id', 'playerId', 'to', 'type']);
  });
});
