import type { BoardEvent, GameState } from '../../shared/types';

export interface PlaybackCursor { gameId: string; lastId: number }
/** Consume confirmed events once, including multiple actions between HTTP polls. */
export function readBoardEvents(cursor: PlaybackCursor | null, game: GameState, playSetup: boolean): { cursor: PlaybackCursor; events: BoardEvent[] } {
  const journal = game.presentationEvents ?? [];
  const lastId = journal.at(-1)?.id ?? 0;
  if (cursor?.gameId !== game.id) {
    const setup = journal.find(event => event.type === 'setup');
    return { cursor: { gameId: game.id, lastId }, events: playSetup && game.turn === 1 && setup ? journal : [] };
  }
  return { cursor: { gameId: game.id, lastId: Math.max(cursor.lastId, lastId) }, events: journal.filter(event => event.id > cursor.lastId) };
}
