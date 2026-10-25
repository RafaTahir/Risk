import { describe, expect, it } from 'vitest';
import { applyAction, canTrade, connectedOwned, createGame, nextTradeValue, reinforcementCount } from '../shared/game';
import { chooseAIAction } from '../shared/ai';
import { TERRITORIES } from '../shared/world';
import type { Card, PlayerSpec } from '../shared/types';
const players: PlayerSpec[] = ['Ada', 'Babbage', 'Curie'].map((name, i) => ({ id: `p${i}`, name, color: '#abc', isAI: true, difficulty: 'general' }));
function seeded(seed = 1234) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
function card(id: string, symbol: Card['symbol']): Card { return { id, symbol, territory: null }; }
function attackFixture() {
  const state = createGame(players, seeded());
  state.phase = 'attack';
  state.reinforcements = 0;
  const from = TERRITORIES[0].id;
  const to = TERRITORIES[0].neighbors[0];
  state.territories[from] = { owner: 'p0', armies: 8 };
  state.territories[to] = { owner: 'p1', armies: 2 };
  return { state, from, to };
}

function expectAICampaignVictory(specs: PlayerSpec[], seed: number) {
  const rng = seeded(seed);
  let state = createGame(specs, rng);
  let commands = 0;
  while (state.phase !== 'gameover' && commands++ < 15000) {
    state = applyAction(state, state.players[state.currentPlayer].id, chooseAIAction(state, rng), rng);
    if (!state.players[state.currentPlayer].alive) throw new Error('Current player is eliminated');
    for (const [id, t] of Object.entries(state.territories)) {
      if (!Number.isSafeInteger(t.armies) || t.armies < (state.occupation?.to === id ? 0 : 1)) throw new Error(`Invalid armies in ${id}`);
    }
    const cards = [...state.deck, ...state.discard, ...state.players.flatMap(p => p.cards)];
    if (cards.length !== 44 || new Set(cards.map(c => c.id)).size !== 44) throw new Error('Card conservation failed');
    for (const p of state.players) {
      if (p.cardCount !== p.cards.length) throw new Error('Public hand size is stale');
      if (p.alive !== Object.values(state.territories).some(t => t.owner === p.id)) throw new Error('Elimination state is stale');
    }
  }
  expect(state.phase, `seed ${seed}, ${commands} commands`).toBe('gameover');
  expect(state.players.filter(p => p.alive)).toHaveLength(1);
  expect(Object.values(state.territories).every(t => t.owner === state.winner)).toBe(true);
}

describe('classic world conquest engine', () => {
  it('initializes all 42 territories with the correct three-player army allowance and 44 cards', () => {
    const state = createGame(players, seeded());
    expect(Object.keys(state.territories)).toHaveLength(42);
    for (const player of state.players) {
      expect(Object.values(state.territories).filter(t => t.owner === player.id).reduce((n, t) => n + t.armies, 0)).toBe(35);
    }
    expect(state.deck).toHaveLength(44);
    expect(new Set(state.deck.map(c => c.id)).size).toBe(44);
    expect(state.reinforcements).toBe(reinforcementCount(state, 'p0'));
  });

  it('rejects out-of-turn, fractional, enemy, and oversized deployments without mutating state', () => {
    const state = createGame(players, seeded());
    const before = structuredClone(state);
    const owned = TERRITORIES.find(t => state.territories[t.id].owner === 'p0')!.id;
    expect(() => applyAction(state, 'p1', { type: 'deploy', territory: owned, count: 1 })).toThrow('turn');
    for (const count of [0, -1, 0.5, 1e6, NaN]) expect(() => applyAction(state, 'p0', { type: 'deploy', territory: owned, count })).toThrow();
    expect(state).toEqual(before);
    const next = applyAction(state, 'p0', { type: 'deploy', territory: owned, count: state.reinforcements });
    expect(next.phase).toBe('attack');
    expect(state).toEqual(before);
  });

  it('awards ties to the defender and limits dice by available armies', () => {
    const { state, from, to } = attackFixture();
    const next = applyAction(state, 'p0', { type: 'attack', from, to, dice: 3 }, () => 0.5);
    expect(next.combat?.attackerLoss).toBe(2);
    expect(next.combat?.defenderLoss).toBe(0);
    expect(next.territories[from].armies).toBe(6);
    expect(() => applyAction(state, 'p0', { type: 'attack', from, to, dice: 4 })).toThrow();
  });

  it('requires occupation after conquering and retains at least one army behind', () => {
    const { state, from, to } = attackFixture();
    const rolls = [0.99, 0.99, 0.99, 0, 0];
    const won = applyAction(state, 'p0', { type: 'attack', from, to, dice: 3 }, () => rolls.shift()!);
    expect(won.phase).toBe('occupy');
    expect(won.occupation).toEqual({ from, to, minimum: 3, maximum: 7 });
    expect(() => applyAction(won, 'p0', { type: 'occupy', count: 2 })).toThrow();
    expect(() => applyAction(won, 'p0', { type: 'occupy', count: 8 })).toThrow();
    const occupied = applyAction(won, 'p0', { type: 'occupy', count: 7 });
    expect(occupied.territories[from].armies).toBe(1);
    expect(occupied.territories[to]).toEqual({ owner: 'p0', armies: 7 });
    expect(occupied.conqueredThisTurn).toBe(true);
  });

  it('validates card sets and the global escalating exchange schedule', () => {
    expect(canTrade([card('a', 'infantry'), card('b', 'cavalry'), card('c', 'artillery')])).toBe(true);
    expect(canTrade([card('a', 'infantry'), card('b', 'infantry'), card('c', 'wild')])).toBe(true);
    expect(canTrade([card('a', 'infantry'), card('b', 'infantry'), card('c', 'artillery')])).toBe(false);
    expect(canTrade([card('a', 'wild'), card('a', 'wild'), card('c', 'artillery')])).toBe(false);
    expect(Array.from({ length: 9 }, (_, i) => nextTradeValue(i))).toEqual([4, 6, 8, 10, 12, 15, 20, 25, 30]);
    const state = createGame(players, seeded());
    state.players[0].cards = [card('a', 'infantry'), card('b', 'infantry'), card('c', 'infantry'), card('d', 'cavalry'), card('e', 'artillery')];
    const owned = TERRITORIES.find(t => state.territories[t.id].owner === 'p0')!.id;
    expect(() => applyAction(state, 'p0', { type: 'deploy', territory: owned, count: 1 })).toThrow('Exchange');
    const traded = applyAction(state, 'p0', { type: 'trade', cards: ['a', 'b', 'c'] });
    expect(traded.reinforcements).toBe(state.reinforcements + 4);
    expect(traded.players[0].cardCount).toBe(2);
    expect(traded.discard).toHaveLength(3);
  });

  it('fortifies through friendly paths once and awards only one conquest card per turn', () => {
    const { state, from, to } = attackFixture();
    state.phase = 'fortify';
    state.conqueredThisTurn = true;
    state.territories[to].owner = 'p0';
    expect(connectedOwned(state, from, to, 'p0')).toBe(true);
    const next = applyAction(state, 'p0', { type: 'fortify', from, to, count: 7 });
    expect(next.currentPlayer).toBe(1);
    expect(next.phase).toBe('reinforce');
    expect(next.players[0].cards).toHaveLength(1);
    expect(next.deck).toHaveLength(43);
    expect(next.territories[from].armies).toBe(1);
  });

  it('executes hundreds of legal AI commands while preserving armies and card conservation', () => {
    const rng = seeded(87);
    let state = createGame(players, rng);
    let commands = 0;
    while (commands < 800 && state.phase !== 'gameover') {
      const action = chooseAIAction(state, rng);
      state = applyAction(state, state.players[state.currentPlayer].id, action, rng);
      for (const [id, territory] of Object.entries(state.territories)) {
        expect(Number.isInteger(territory.armies)).toBe(true);
        expect(territory.armies).toBeGreaterThanOrEqual(state.phase === 'occupy' && state.occupation?.to === id ? 0 : 1);
      }
      expect(state.deck.length + state.discard.length + state.players.reduce((sum, p) => sum + p.cards.length, 0)).toBe(44);
      commands++;
    }
    expect(commands).toBeGreaterThan(30);
    expect(state.turn).toBeGreaterThan(3);
  });
});

describe('classic rules edge cases', () => {
  it.each([3, 4, 5, 6])('uses the exact initial army allowance for %i players', count => {
    const specs = Array.from({ length: count }, (_, i) => ({ ...players[0], id: `p${i}` }));
    const state = createGame(specs, seeded(count));
    const allowances = [0, 0, 0, 35, 30, 25, 20];
    for (const player of state.players) {
      const owned = Object.values(state.territories).filter(t => t.owner === player.id);
      expect(owned.reduce((total, t) => total + t.armies, 0)).toBe(allowances[count]);
      expect(owned.length).toBeGreaterThanOrEqual(Math.floor(42 / count));
    }
  });

  it('has the traditional continent sizes, bonuses, and symmetric sea connections', () => {
    const state = createGame(players, seeded());
    const expected: [string, number, number][] = [['north-america', 9, 5], ['south-america', 4, 2], ['europe', 7, 5], ['africa', 6, 3], ['asia', 12, 7], ['australia', 4, 2]];
    for (const [continent, count, bonus] of expected) {
      for (const t of TERRITORIES) state.territories[t.id].owner = t.continent === continent ? 'p0' : 'p1';
      expect(TERRITORIES.filter(t => t.continent === continent)).toHaveLength(count);
      expect(reinforcementCount(state, 'p0')).toBe(Math.max(3, Math.floor(count / 3)) + bonus);
    }
    for (const t of TERRITORIES) for (const neighbor of t.neighbors) {
      expect(TERRITORIES.find(n => n.id === neighbor)?.neighbors).toContain(t.id);
      expect(neighbor).not.toBe(t.id);
    }
    expect(TERRITORIES.find(t => t.id === 'alaska')?.neighbors).toContain('kamchatka');
    expect(TERRITORIES.find(t => t.id === 'japan')?.neighbors).not.toContain('china');
  });

  it('sorts dice before comparisons and applies mixed casualties', () => {
    const { state, from, to } = attackFixture();
    const rolls = [0, 0.99, 0.5, 0.7, 0.5]; // 1,6,4 versus 5,4
    const next = applyAction(state, 'p0', { type: 'attack', from, to, dice: 3 }, () => rolls.shift()!);
    expect(next.combat?.attackDice).toEqual([6, 4, 1]);
    expect(next.combat?.defenseDice).toEqual([5, 4]);
    expect(next.combat?.attackerLoss).toBe(1);
    expect(next.combat?.defenderLoss).toBe(1);
    expect(next.phase).toBe('attack');
  });

  it('rejects unknown territories, nonadjacent attacks, enemy origins and malformed commands', () => {
    const { state, from, to } = attackFixture();
    const distant = TERRITORIES.find(t => t.id !== from && !TERRITORIES.find(t => t.id === from)!.neighbors.includes(t.id))!.id;
    state.territories[distant].owner = 'p1';
    for (const action of [null, { type: '__proto__' }, { type: 'attack', from, to: '__proto__', dice: 1 }, { type: 'attack', from, to: distant, dice: 1 }, { type: 'attack', from: to, to: from, dice: 1 }, { type: 'attack', from, to, dice: Infinity }]) {
      expect(() => applyAction(state, 'p0', action as never)).toThrow();
    }
  });

  it('awards no card without a conquest and reshuffles discards only when needed', () => {
    const state = createGame(players, seeded());
    state.phase = 'fortify';
    const without = applyAction(state, 'p0', { type: 'endTurn' }, seeded());
    expect(without.players[0].cards).toHaveLength(0);
    state.conqueredThisTurn = true;
    state.discard = state.deck;
    state.deck = [];
    const drawn = applyAction(state, 'p0', { type: 'endTurn' }, seeded());
    expect(drawn.players[0].cards).toHaveLength(1);
    expect(drawn.deck).toHaveLength(43);
    expect(drawn.discard).toHaveLength(0);
  });

  it('inherits eliminated cards and forces a trade before resuming attacks', () => {
    const { state, from, to } = attackFixture();
    for (const t of TERRITORIES) state.territories[t.id].owner = 'p2';
    state.territories[from] = { owner: 'p0', armies: 8 };
    state.territories[to] = { owner: 'p1', armies: 1 };
    state.players[0].cards = [card('a', 'infantry'), card('b', 'infantry'), card('c', 'infantry')];
    state.players[1].cards = [card('d', 'cavalry'), card('e', 'cavalry'), card('f', 'cavalry')];
    const rolls = [0.99, 0.99, 0.99, 0];
    let next = applyAction(state, 'p0', { type: 'attack', from, to, dice: 3 }, () => rolls.shift()!);
    expect(next.players[1].alive).toBe(false);
    expect(next.players[1].cards).toHaveLength(0);
    next = applyAction(next, 'p0', { type: 'occupy', count: 3 });
    expect(next.phase).toBe('reinforce');
    expect(next.resumePhase).toBe('attack');
    expect(() => applyAction(next, 'p0', { type: 'deploy', territory: from, count: 1 })).toThrow();
    next = applyAction(next, 'p0', { type: 'trade', cards: ['a', 'b', 'c'] });
    expect(next.reinforcements).toBe(4);
    next = applyAction(next, 'p0', { type: 'deploy', territory: from, count: 4 });
    expect(next.phase).toBe('attack');
    expect(next.resumePhase).toBeUndefined();
  });

  it.each(['recruit', 'veteran', 'general'] as const)('finishes full %s AI campaigns for three seeds with legal states and a single winner', difficulty => {
    for (const seed of [1, 87, 2026]) {
      expectAICampaignVictory(players.map(p => ({ ...p, difficulty })), seed);
    }
  }, 20000);

  it.each([4, 5, 6].flatMap(count => [1, 87].map(seed => ({ count, seed }))))('finishes a full $count-player mixed-difficulty campaign with seed $seed', ({ count, seed }) => {
    const difficulties = ['recruit', 'veteran', 'general'] as const;
    const specs = Array.from({ length: count }, (_, i) => ({
      ...players[0], id: `p${i}`, name: `Player ${i + 1}`, difficulty: difficulties[i % difficulties.length],
    }));
    expectAICampaignVictory(specs, seed);
  }, 20000);
});

describe('edition-specific rules', () => {
  it('permits adjacent fortification but rejects a longer friendly path', () => {
    const state = createGame(players, seeded());
    state.phase = 'fortify';
    for (const id of ['alaska', 'alberta', 'western-united-states']) state.territories[id] = { owner: 'p0', armies: 5 };
    expect(connectedOwned(state, 'alaska', 'western-united-states', 'p0')).toBe(true);
    expect(() => applyAction(state, 'p0', { type: 'fortify', from: 'alaska', to: 'western-united-states', count: 4 })).toThrow('adjacent');
    const next = applyAction(state, 'p0', { type: 'fortify', from: 'alaska', to: 'alberta', count: 4 });
    expect(next.territories.alaska.armies).toBe(1);
    expect(next.territories.alberta.armies).toBe(9);
    expect(() => applyAction(next, 'p0', { type: 'endTurn' })).toThrow('turn');
  });

  it('allows choosing exactly one owned card territory for the two-army bonus', () => {
    const state = createGame(players, seeded());
    state.territories.alaska = { owner: 'p0', armies: 2 };
    state.territories.alberta = { owner: 'p0', armies: 3 };
    state.players[0].cards = [{ id: 'a', territory: 'alaska', symbol: 'infantry' }, { id: 'b', territory: 'alberta', symbol: 'infantry' }, card('c', 'infantry')];
    expect(() => applyAction(state, 'p0', { type: 'trade', cards: ['a', 'b', 'c'], bonusTerritory: 'china' })).toThrow('bonus');
    const next = applyAction(state, 'p0', { type: 'trade', cards: ['a', 'b', 'c'], bonusTerritory: 'alberta' });
    expect(next.territories.alaska.armies).toBe(2);
    expect(next.territories.alberta.armies).toBe(5);
    expect(next.players[0].cards).toHaveLength(0);
  });

  it('requires enough inherited trades to get below five, then prohibits more', () => {
    let state = createGame(players, seeded());
    state.resumePhase = 'attack';
    state.reinforcements = 0;
    state.players[0].cards = Array.from({ length: 8 }, (_, i) => card(String(i), 'infantry'));
    state = applyAction(state, 'p0', { type: 'trade', cards: ['0', '1', '2'] });
    const owned = TERRITORIES.find(t => state.territories[t.id].owner === 'p0')!.id;
    expect(() => applyAction(state, 'p0', { type: 'deploy', territory: owned, count: 1 })).toThrow('Exchange');
    state = applyAction(state, 'p0', { type: 'trade', cards: ['3', '4', '5'] });
    expect(state.reinforcements).toBe(10);
    expect(state.players[0].cards).toHaveLength(2);
    state.players[0].cards.push(card('8', 'infantry'));
    expect(() => applyAction(state, 'p0', { type: 'trade', cards: ['6', '7', '8'] })).toThrow('Stop exchanging');
    expect(chooseAIAction(state, seeded()).type).toBe('deploy');
  });

  it('rejects forged card symbols and stolen or repeated cards', () => {
    expect(canTrade([card('a', 'unknown' as never), card('b', 'unknown' as never), card('c', 'unknown' as never)])).toBe(false);
    const state = createGame(players, seeded());
    state.players[0].cards = [card('a', 'infantry'), card('b', 'infantry'), card('c', 'infantry')];
    for (const cards of [['a', 'a', 'a'], ['a', 'b', 'stolen']]) expect(() => applyAction(state, 'p0', { type: 'trade', cards })).toThrow();
  });
});

describe('elimination timing', () => {
  it.each([5, 6])('handles %i inherited cards before continuing or winning', handSize => {
    const { state, from, to } = attackFixture();
    for (const t of TERRITORIES) state.territories[t.id].owner = 'p2';
    state.territories[from] = { owner: 'p0', armies: 8 };
    state.territories[to] = { owner: 'p1', armies: 1 };
    state.players[1].cards = Array.from({ length: handSize }, (_, i) => card(String(i), 'infantry'));
    const conquer = (original: typeof state) => {
      const rolls = [0.99, 0.99, 0.99, 0];
      const won = applyAction(original, 'p0', { type: 'attack', from, to, dice: 3 }, () => rolls.shift()!);
      expect(() => applyAction(won, 'p0', { type: 'endAttack' })).toThrow('attack');
      return applyAction(won, 'p0', { type: 'occupy', count: 3 });
    };
    const continues = conquer(state);
    expect(continues.phase).toBe(handSize === 5 ? 'attack' : 'reinforce');
    expect(continues.players[0].cardCount).toBe(handSize);
    for (const t of TERRITORIES) if (t.id !== to) state.territories[t.id].owner = 'p0';
    state.players[2].alive = false;
    const victory = conquer(state);
    expect(victory.phase).toBe('gameover');
    expect(victory.winner).toBe('p0');
    expect(() => applyAction(victory, 'p0', { type: 'endAttack' })).toThrow('ended');
  });
});
