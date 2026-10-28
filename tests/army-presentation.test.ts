import { describe, expect, it } from 'vitest';
import { createGame } from '../shared/game';
import { initialArmyAllowance, reserveAnchor, reserveArmyCount, reservePieces, setupPlacements } from '../src/lib/armyPresentation';
import { readBoardEvents } from '../src/lib/presentationPlayback';
import type { PlayerSpec } from '../shared/types';
const specs = (count: number): PlayerSpec[] => Array.from({ length: count }, (_, i) => ({ id: `p${i}`, name: `Player ${i}`, color: '#e8b865', isAI: false, difficulty: 'veteran' }));
describe('physical army presentation from confirmed state', () => {
  it('starts empty and represents every actual initial army for all supported player counts', () => {
    expect(reserveArmyCount(null)).toBe(0);
    for (let count = 3; count <= 6; count++) {
      const game = createGame(specs(count), () => .42), placements = setupPlacements(game);
      expect(placements).toHaveLength(42);
      for (const player of game.players) expect(placements.filter(item => item.owner === player.id).reduce((n, item) => n + item.count, 0)).toBe(initialArmyAllowance(count));
      expect(new Set(game.players.map((_, i) => JSON.stringify(reserveAnchor(i, count)))).size).toBe(count);
      expect(reserveArmyCount(game)).toBe(game.reinforcements);
      game.phase = 'attack'; expect(reserveArmyCount(game)).toBe(0);
    }
  });
  it('keeps exact denomination arithmetic and explicitly exposes overflow for large exchanges', () => {
    for (const count of [0, 1, 9, 10, 20, 35, 203, 9999]) {
      const pieces = reservePieces(count);
      expect(pieces.infantry + pieces.artillery * 10 + pieces.overflow).toBe(count);
      expect(pieces.infantry + pieces.artillery).toBeLessThanOrEqual(29);
    }
  });
  it('plays setup only on an intentional fresh start and skips duplicate/reconnected history', () => {
    const game = createGame(specs(3), () => .42);
    const initial = readBoardEvents(null, game, true);
    expect(initial.events.map(event => event.type)).toEqual(['setup']);
    expect(readBoardEvents(initial.cursor, game, true).events).toEqual([]);
    expect(readBoardEvents(null, game, false).events).toEqual([]);
    game.presentationEvents!.push({ id: 2, type: 'deploy', playerId: 'p0', color: '#fff', to: 'alaska', count: 1 }, { id: 3, type: 'deploy', playerId: 'p0', color: '#fff', to: 'alaska', count: 2 });
    const polled = readBoardEvents(initial.cursor, game, false);
    expect(polled.events.map(event => event.id)).toEqual([2, 3]);
    expect(readBoardEvents(polled.cursor, game, false).events).toEqual([]);
  });
});
