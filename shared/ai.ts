import type { Card, GameAction, GameState } from './types';
import { canTrade } from './game';
import { CONTINENTS, TERRITORIES } from './world';

/** The computer uses the same public position and validated actions as a human. */
export function chooseAIAction(state: GameState, rng: () => number = Math.random): GameAction {
  const player = state.players[state.currentPlayer];
  if (!player || state.phase === 'gameover') throw new Error('There is no active computer turn.');
  const level = player.difficulty === 'general' ? 2 : player.difficulty === 'veteran' ? 1 : 0;
  const owned = TERRITORIES.filter(t => state.territories[t.id]?.owner === player.id);
  const enemies = (id: string) => (TERRITORIES.find(t => t.id === id)?.neighbors ?? [])
    .filter(n => state.territories[n]?.owner !== player.id);
  const enemyStrength = (id: string) => enemies(id).reduce((sum, n) => sum + Math.max(0, state.territories[n].armies - 1), 0);
  const continentValue = (continent: string) => {
    const members = TERRITORIES.filter(t => t.continent === continent);
    const count = members.filter(t => state.territories[t.id]?.owner === player.id).length;
    const bonus = CONTINENTS.find(c => c.id === continent)?.bonus ?? 0;
    return (count / members.length) ** 2 * bonus * 2 + (members.length - count === 1 ? bonus * 2 : 0);
  };
  const attackValue = (from: string, to: string) => {
    const origin = state.territories[from];
    const target = state.territories[to];
    const definition = TERRITORIES.find(t => t.id === to)!;
    const victim = state.players.find(p => p.id === target.owner);
    const victimTerritories = Object.values(state.territories).filter(t => t.owner === target.owner).length;
    const elimination = victimTerritories === 1 ? 7 + (victim?.cardCount ?? 0) * 2 : 0;
    const firstCard = !state.conqueredThisTurn ? 2 : 0;
    return origin.armies - target.armies * 1.4 + continentValue(definition.continent) * (level ? 1 : 0.25)
      + elimination * (level ? 1 : 0.3) + firstCard - Math.max(0, enemies(from).length - 1) * 0.3;
  };
  const strongestPlan = (id: string) => {
    const candidates = enemies(id);
    return candidates.length ? Math.max(...candidates.map(n => attackValue(id, n))) : -100;
  };
  const pick = <T>(items: T[], score: (item: T) => number): T => {
    if (!items.length) throw new Error('The computer has no legal territory.');
    return items.map(item => ({ item, value: score(item) + rng() * (level === 0 ? 6 : level === 1 ? 1.5 : 0.3) }))
      .sort((a, b) => b.value - a.value)[0].item;
  };
  const validSet = (): Card[] | null => {
    const cards = player.cards;
    const options: Card[][] = [];
    for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) for (let k = j + 1; k < cards.length; k++) {
      const set = [cards[i], cards[j], cards[k]];
      if (canTrade(set)) options.push(set);
    }
    if (!options.length) return null;
    return options.sort((a, b) => {
      const score = (set: Card[]) => (set.some(c => c.territory && state.territories[c.territory]?.owner === player.id) ? 4 : 0)
        - set.filter(c => c.symbol === 'wild').length;
      return score(b) - score(a);
    })[0];
  };

  if (state.phase === 'reinforce') {
    const set = validSet();
    // Trade promptly to keep turns moving; prefer owned territory bonuses and conserve wilds.
    if (set && (!state.resumePhase || player.cards.length >= 5)) return { type: 'trade', cards: set.map(c => c.id) };
    if (state.reinforcements < 1) throw new Error('Reinforcement phase has no available troops or card set.');
    const border = owned.filter(t => enemies(t.id).length > 0);
    const territory = pick(border.length ? border : owned, t => {
      const defendingContinent = TERRITORIES.filter(m => m.continent === t.continent)
        .every(m => state.territories[m.id]?.owner === player.id);
      const defenseNeed = Math.max(0, enemyStrength(t.id) - state.territories[t.id].armies);
      return strongestPlan(t.id) + (defendingContinent ? defenseNeed * (level === 2 ? 1.2 : 0.5) : 0)
        + continentValue(t.continent) * (level ? 0.7 : 0.2);
    });
    return { type: 'deploy', territory: territory.id, count: state.reinforcements };
  }

  if (state.phase === 'attack') {
    const attacks = owned.flatMap(from => enemies(from.id).map(to => ({ from: from.id, to })))
      .filter(({ from, to }) => {
        const available = state.territories[from].armies - 1;
        const defending = state.territories[to].armies;
        if (available < 1) return false;
        if (level === 0) return available >= defending + 1 && (available >= 3 || defending === 1);
        const threshold = level === 2 ? 1.18 : 1.35;
        const finishingContinent = TERRITORIES.filter(t => t.continent === TERRITORIES.find(t => t.id === to)!.continent)
          .filter(t => state.territories[t.id]?.owner !== player.id).length === 1;
        return available >= Math.max(2, defending * threshold) || (finishingContinent && available >= defending + 1);
      });
    if (!attacks.length) return { type: 'endAttack' };
    const chosen = pick(attacks, ({ from, to }) => attackValue(from, to));
    return { type: 'attack', ...chosen, dice: Math.min(3, state.territories[chosen.from].armies - 1) };
  }

  if (state.phase === 'occupy') {
    const occupation = state.occupation;
    if (!occupation) throw new Error('Occupation details are missing.');
    const targetThreat = enemyStrength(occupation.to);
    const originThreat = enemyStrength(occupation.from);
    let count = occupation.maximum;
    if (enemies(occupation.to).length === 0) count = occupation.minimum;
    else if (originThreat > 0 && level > 0) {
      const proportion = (targetThreat + 2) / (targetThreat + originThreat + 4);
      count = Math.round((occupation.maximum + 1) * proportion);
    }
    return { type: 'occupy', count: Math.min(occupation.maximum, Math.max(occupation.minimum, count)) };
  }

  if (state.phase === 'fortify') {
    const front = owned.filter(t => enemies(t.id).length);
    const distance = new Map(front.map(t => [t.id, 0]));
    const queue = front.map(t => t.id);
    for (let i = 0; i < queue.length; i++) {
      const current = TERRITORIES.find(t => t.id === queue[i])!;
      for (const neighbor of current.neighbors) {
        if (state.territories[neighbor].owner === player.id && !distance.has(neighbor)) {
          distance.set(neighbor, distance.get(current.id)! + 1);
          queue.push(neighbor);
        }
      }
    }
    const moves: { from: string; to: string; count: number; score: number }[] = [];
    for (const from of owned) {
      const stack = state.territories[from.id].armies;
      const reserve = enemies(from.id).length ? Math.max(2, Math.ceil(enemyStrength(from.id) * 0.6)) : 1;
      const available = stack - reserve;
      if (available < 1) continue;
      for (const to of owned) {
        if (from.id === to.id || !from.neighbors.includes(to.id)) continue;
        if (!enemies(to.id).length && (distance.get(to.id) ?? Infinity) >= (distance.get(from.id) ?? Infinity)) continue;
        const difference = enemyStrength(to.id) - state.territories[to.id].armies;
        const score = available + difference * 0.4 + strongestPlan(to.id) * 0.2 + continentValue(to.continent);
        // Moving an interior stack is always useful; exposed stacks move only to a stronger plan.
        if (!enemies(from.id).length || strongestPlan(to.id) + available > strongestPlan(from.id) + 2) {
          moves.push({ from: from.id, to: to.id, count: available, score });
        }
      }
    }
    if (!moves.length) return { type: 'endTurn' };
    const best = pick(moves, move => move.score);
    return { type: 'fortify', from: best.from, to: best.to, count: best.count };
  }
  throw new Error('Unknown computer turn phase.');
}
