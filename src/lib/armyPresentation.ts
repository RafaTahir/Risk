import type { GameState } from '../../shared/types';
import { TERRITORIES } from '../../shared/world';

/** Classic quick-setup allocation; setup has already been decided by the server. */
export function initialArmyAllowance(playerCount: number): number {
  return ({ 3: 35, 4: 30, 5: 25, 6: 20 } as Record<number, number>)[playerCount] ?? 0;
}
export function reserveArmyCount(game: GameState | null): number {
  return game?.phase === 'reinforce' ? Math.max(0, game.reinforcements) : 0;
}
/** Two sides of the table, up to three clearly separate player trays per side. */
export function reserveAnchor(playerIndex: number, playerCount: number) {
  const rows = Math.ceil(playerCount / 2), row = Math.floor(playerIndex / 2);
  return { x: playerIndex % 2 === 0 ? -625 : 625, y: (row - (rows - 1) / 2) * 220, z: 1.3 };
}
/** Artillery represents ten armies. Large trades retain their exact printed total. */
export function reservePieces(count: number) {
  const total = Math.max(0, Math.floor(count));
  const artillery = Math.min(20, Math.floor(total / 10)), infantry = total % 10;
  const representedArmies = artillery * 10 + infantry;
  return { infantry, artillery, representedArmies, overflow: total - representedArmies };
}
export function setupPlacements(game: GameState, allocations?: { territory: string; owner: string; count: number }[]) {
  return TERRITORIES.flatMap(territory => {
    const allocated = allocations?.find(item => item.territory === territory.id);
    const state = allocated ? { owner: allocated.owner, armies: allocated.count } : game.territories[territory.id];
    const index = game.players.findIndex(player => player.id === state?.owner);
    if (!state || index < 0 || state.armies <= 0) return [];
    return [{ territory: territory.id, owner: state.owner, color: game.players[index].color,
      count: state.armies, from: reserveAnchor(index, game.players.length) }];
  });
}
