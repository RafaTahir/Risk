import { describe, expect, it } from 'vitest';
import { applyAction, createGame } from '../shared/game';
import type { Card, Combat, GameAction, GameState, PlayerSpec } from '../shared/types';
import { TERRITORIES } from '../shared/world';
import { boardChoices } from '../src/lib/tabletopGuidance';
import { battlePairs } from '../src/components/BattleReport';

function seeded(seed: number) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }
function fixture(count = 3) {
  const players: PlayerSpec[] = Array.from({ length: count }, (_, index) => ({ id: `p${index}`, name: `Player ${index}`, color: '#abc', isAI: false, difficulty: 'veteran' }));
  return createGame(players, seeded(417 + count));
}
function accepts(state: GameState, playerId: string, action: GameAction) {
  try { applyAction(state, playerId, action, () => .5); return true; }
  catch { return false; }
}
const ids = TERRITORIES.map(territory => territory.id);
const sorted = (values: string[]) => [...values].sort();
const empty = { eligibleSources: [], validTargets: [] };

describe('tabletop affordances agree with authoritative command validation', () => {
  for (const players of [3, 4, 6]) {
    it(`${players} players: every reinforcement origin agrees with accepted deployment commands`, () => {
      const game = fixture(players), before = structuredClone(game), actor = game.players[0].id;
      const choices = boardChoices(game, actor, null, true);
      const legal = ids.filter(territory => accepts(game, actor, { type: 'deploy', territory, count: 1 }));
      expect(sorted(choices.eligibleSources)).toEqual(sorted(legal));
      expect(choices.validTargets).toEqual([]);
      expect(game).toEqual(before);
    });

    for (const phase of ['attack', 'fortify'] as const) {
      it(`${players} players: every ${phase} origin and destination agrees with accepted engine commands`, () => {
        const game = fixture(players), actor = game.players[0].id;
        game.phase = phase; game.reinforcements = 0;
        const before = structuredClone(game), expectedSources: string[] = [];
        for (const from of ids) {
          // Testing every destination also checks non-adjacent, self and enemy/
          // friendly exclusions instead of reproducing the UI filter formula.
          const accepted = ids.filter(to => accepts(game, actor, phase === 'attack'
            ? { type: 'attack', from, to, dice: 1 }
            : { type: 'fortify', from, to, count: 1 }));
          if (accepted.length) expectedSources.push(from);
          const choices = boardChoices(game, actor, from, true);
          expect(sorted(choices.validTargets), `${phase} from ${from}`).toEqual(sorted(accepted));
        }
        expect(sorted(boardChoices(game, actor, null, true).eligibleSources)).toEqual(sorted(expectedSources));
        expect(game).toEqual(before);
      });
    }
  }

  it('removes deployment markers during mandatory trades and restores them after a legal exchange', () => {
    const game = fixture(), actor = game.players[0];
    const cards: Card[] = Array.from({ length: 5 }, (_, index) => ({ id: `test-${index}`, symbol: 'infantry', territory: null }));
    actor.cards = cards; actor.cardCount = cards.length;
    expect(boardChoices(game, actor.id, null, true)).toEqual(empty);
    for (const territory of ids) expect(accepts(game, actor.id, { type: 'deploy', territory, count: 1 })).toBe(false);
    const traded = applyAction(game, actor.id, { type: 'trade', cards: cards.slice(0, 3).map(card => card.id) });
    const legal = ids.filter(territory => accepts(traded, actor.id, { type: 'deploy', territory, count: 1 }));
    expect(sorted(boardChoices(traded, actor.id, null, true).eligibleSources)).toEqual(sorted(legal));
    game.players[0].cards = []; game.players[0].cardCount = 0; game.reinforcements = 0;
    expect(boardChoices(game, actor.id, null, true)).toEqual(empty);
  });

  it('shows only the required occupation pair, with movement limits validated by the engine', () => {
    const game = fixture(), actor = game.players[0].id;
    game.phase = 'attack'; game.reinforcements = 0;
    game.territories.alaska = { owner: actor, armies: 8 };
    game.territories.kamchatka = { owner: 'p1', armies: 1 };
    const rolls = [6, 6, 6, 1];
    const occupied = applyAction(game, actor, { type: 'attack', from: 'alaska', to: 'kamchatka', dice: 3 }, () => (rolls.shift()! - .5) / 6);
    expect(occupied.phase).toBe('occupy');
    expect(boardChoices(occupied, actor, null, true)).toEqual({ eligibleSources: ['alaska'], validTargets: ['kamchatka'] });
    expect(accepts(occupied, actor, { type: 'occupy', count: occupied.occupation!.minimum })).toBe(true);
    expect(accepts(occupied, actor, { type: 'occupy', count: occupied.occupation!.maximum })).toBe(true);
    expect(accepts(occupied, actor, { type: 'occupy', count: occupied.occupation!.minimum - 1 })).toBe(false);
  });

  it('includes legal Pacific sea adjacency and excludes one-army or unavailable origins', () => {
    const game = fixture(), actor = game.players[0].id;
    game.phase = 'attack'; game.reinforcements = 0;
    game.territories.alaska = { owner: actor, armies: 2 };
    game.territories.kamchatka = { owner: 'p1', armies: 2 };
    expect(accepts(game, actor, { type: 'attack', from: 'alaska', to: 'kamchatka', dice: 1 })).toBe(true);
    expect(boardChoices(game, actor, 'alaska', true).validTargets).toContain('kamchatka');
    game.territories.alaska.armies = 1;
    expect(boardChoices(game, actor, 'alaska', true).eligibleSources).not.toContain('alaska');
    expect(boardChoices(game, actor, 'alaska', true).validTargets).toEqual([]);
    expect(boardChoices(null, actor, null, true)).toEqual(empty);
    expect(boardChoices(game, undefined, null, true)).toEqual(empty);
    expect(boardChoices(game, actor, null, false)).toEqual(empty);
    expect(boardChoices(game, 'p1', null, true)).toEqual(empty);
    game.players[0].alive = false;
    expect(boardChoices(game, actor, null, true)).toEqual(empty);
    game.players[0].alive = true; game.phase = 'gameover';
    expect(boardChoices(game, actor, null, true)).toEqual(empty);
    game.phase = 'attack'; game.winner = actor;
    expect(boardChoices(game, actor, null, true)).toEqual(empty);
  });
});

describe('paired battle explanation agrees with confirmed casualties', () => {
  for (const scenario of [
    { attack: [6, 4, 2], defense: [6, 3], armies: 3 },
    { attack: [6], defense: [2, 5], armies: 3 },
    { attack: [1, 1, 1], defense: [1], armies: 1 },
    { attack: [5, 6], defense: [1, 3], armies: 2 },
  ]) {
    it(`explains ${scenario.attack.join(',')} vs ${scenario.defense.join(',')} without rerolling or mutating`, () => {
      const game = fixture(), actor = game.players[0].id;
      game.phase = 'attack'; game.reinforcements = 0;
      game.territories.alaska = { owner: actor, armies: 8 };
      game.territories.kamchatka = { owner: 'p1', armies: scenario.armies };
      const values = [...scenario.attack, ...scenario.defense];
      const result = applyAction(game, actor, { type: 'attack', from: 'alaska', to: 'kamchatka', dice: scenario.attack.length }, () => (values.shift()! - .5) / 6);
      const combat: Combat = result.combat!;
      // Feed unsorted presentation copies to ensure the explanation pairs the
      // highest values itself, while leaving the confirmed record untouched.
      combat.attackDice.reverse(); combat.defenseDice.reverse();
      const before = structuredClone(combat), pairs = battlePairs(combat);
      expect(pairs).toHaveLength(Math.min(scenario.attack.length, scenario.defense.length));
      expect(pairs.filter(pair => pair.lost === 'Attacker')).toHaveLength(combat.attackerLoss);
      expect(pairs.filter(pair => pair.lost === 'Defender')).toHaveLength(combat.defenderLoss);
      for (const pair of pairs.filter(pair => pair.tie)) expect(pair.lost).toBe('Attacker');
      expect(pairs.map(pair => pair.attack)).toEqual([...scenario.attack].sort((a, b) => b - a).slice(0, scenario.defense.length));
      expect(combat).toEqual(before);
      expect(game.territories.alaska.armies - result.territories.alaska.armies).toBe(combat.attackerLoss);
      expect(game.territories.kamchatka.armies - result.territories.kamchatka.armies).toBe(combat.defenderLoss);
    });
  }
});
