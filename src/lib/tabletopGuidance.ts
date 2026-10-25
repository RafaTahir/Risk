import type { GameState } from '../../shared/types';
import { TERRITORIES, TERRITORY_BY_ID } from '../../shared/world';

/** Presentation only: orders still pass through the authoritative rules engine. */
export function boardChoices(game: GameState | null, playerId: string | undefined, selected: string | null, enabled: boolean) {
  const empty = { eligibleSources: [] as string[], validTargets: [] as string[] };
  if (!game || !enabled || !playerId || game.winner || game.players[game.currentPlayer]?.id !== playerId) return empty;
  const player = game.players.find(item => item.id === playerId);
  if (!player?.alive) return empty;
  if (game.phase === 'reinforce') {
    return game.reinforcements > 0 && player.cardCount < 5
      ? { eligibleSources: TERRITORIES.filter(t => game.territories[t.id].owner === playerId).map(t => t.id), validTargets: [] }
      : empty;
  }
  if (game.phase === 'occupy') return game.occupation
    ? { eligibleSources: [game.occupation.from], validTargets: [game.occupation.to] }
    : empty;
  if (game.phase !== 'attack' && game.phase !== 'fortify') return empty;
  const targets = (id: string) => TERRITORY_BY_ID[id].neighbors.filter(neighbor =>
    game.phase === 'attack' ? game.territories[neighbor].owner !== playerId : game.territories[neighbor].owner === playerId);
  const eligibleSources = TERRITORIES.filter(t => game.territories[t.id].owner === playerId && game.territories[t.id].armies > 1 && targets(t.id).length > 0).map(t => t.id);
  return { eligibleSources, validTargets: selected && eligibleSources.includes(selected) ? targets(selected) : [] };
}
