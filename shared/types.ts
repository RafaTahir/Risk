export type Phase = 'reinforce' | 'attack' | 'occupy' | 'fortify' | 'gameover';
export type Difficulty = 'recruit' | 'veteran' | 'general';
export type CardSymbol = 'infantry' | 'cavalry' | 'artillery' | 'wild';
export interface Card { id: string; territory: string | null; symbol: CardSymbol }
export interface Player { id: string; name: string; color: string; isAI: boolean; difficulty: Difficulty; alive: boolean; cards: Card[]; cardCount: number; connected: boolean }
export interface TerritoryState { owner: string; armies: number }
export interface Combat { from: string; to: string; attackDice: number[]; defenseDice: number[]; attackerLoss: number; defenderLoss: number; conquered: boolean; at: number }
export interface Occupation { from: string; to: string; minimum: number; maximum: number }
export interface GameLog { id: number; text: string; type: 'turn' | 'attack' | 'conquest' | 'card' | 'victory' | 'fortify' }
export interface GameState { id: string; players: Player[]; territories: Record<string, TerritoryState>; currentPlayer: number; phase: Phase; reinforcements: number; turn: number; conqueredThisTurn: boolean; tradeCount: number; deck: Card[]; discard: Card[]; log: GameLog[]; combat: Combat | null; occupation: Occupation | null; winner: string | null; resumePhase?: 'attack' }
export type GameAction = { type: 'deploy'; territory: string; count: number } | { type: 'attack'; from: string; to: string; dice: number } | { type: 'occupy'; count: number } | { type: 'endAttack' } | { type: 'fortify'; from: string; to: string; count: number } | { type: 'endTurn' } | { type: 'trade'; cards: string[]; bonusTerritory?: string };
export interface PlayerSpec { id: string; name: string; color: string; isAI: boolean; difficulty: Difficulty }
export interface RoomPlayer extends PlayerSpec { connected: boolean }
export interface RoomState { revision: number; code: string; hostId: string; players: RoomPlayer[]; status: 'lobby' | 'playing' | 'finished'; game: GameState | null }
export interface Session { code: string; playerId: string; token: string }
export interface ServerResponse { ok: boolean; error?: string; session?: Session }
export const PLAYER_COLORS = ['#e8b865', '#5fa9d4', '#d87478', '#81bba5', '#ab8bd3', '#d6935e'];
