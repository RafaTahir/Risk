import { CONTINENTS, TERRITORIES } from './world';
import type { BoardEvent, Card, CardSymbol, GameAction, GameLog, GameState, PlayerSpec } from './types';

const definitions = new Map(TERRITORIES.map(t => [t.id, t]));
const symbols: CardSymbol[] = ['infantry', 'cavalry', 'artillery'];
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function shuffle<T>(items: T[], rng: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
function log(state: GameState, text: string, type: GameLog['type']) {
  state.log.push({ id: (state.log.at(-1)?.id ?? 0) + 1, text, type });
  if (state.log.length > 100) state.log.shift();
}
function boardEvent(state: GameState, outcome: Omit<BoardEvent, 'id'>) {
  const events = state.presentationEvents ?? [];
  state.presentationEvents = [...events.slice(-63), { ...outcome, id: (events.at(-1)?.id ?? 0) + 1 }];
}
const territoryName = (id: string) => definitions.get(id)?.name ?? id;
function integer(value: number, minimum: number, maximum: number, label: string) {
  assert(Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    `${label} must be a whole number from ${minimum} to ${maximum}.`);
}
function syncCards(state: GameState) {
  state.players.forEach(player => { player.cardCount = player.cards.length; });
}

/** The number shown before deployment, including all controlled continents. */
export function reinforcementCount(state: GameState, playerId: string): number {
  const owned = TERRITORIES.filter(t => state.territories[t.id]?.owner === playerId);
  if (!owned.length) return 0;
  return Math.max(3, Math.floor(owned.length / 3)) + CONTINENTS.reduce((sum, continent) => {
    const territories = TERRITORIES.filter(t => t.continent === continent.id);
    return sum + (territories.every(t => state.territories[t.id]?.owner === playerId) ? continent.bonus : 0);
  }, 0);
}

/** Classic progressive exchange schedule, shared across all commanders. */
export function nextTradeValue(tradeCount: number): number {
  return [4, 6, 8, 10, 12, 15][tradeCount] ?? 15 + (tradeCount - 5) * 5;
}

export function canTrade(cards: Card[]): boolean {
  if (cards.length !== 3 || new Set(cards.map(card => card.id)).size !== 3 || cards.some(card => ![...symbols, 'wild'].includes(card.symbol))) return false;
  const ordinary = cards.filter(card => card.symbol !== 'wild').map(card => card.symbol);
  return new Set(ordinary).size === 1 || new Set(ordinary).size === ordinary.length;
}

/** Connected-path fortification: every territory traversed must be friendly. */
export function connectedOwned(state: GameState, from: string, to: string, playerId: string): boolean {
  if (!definitions.has(from) || !definitions.has(to)) return false;
  if (state.territories[from]?.owner !== playerId || state.territories[to]?.owner !== playerId) return false;
  const visited = new Set<string>([from]);
  const queue = [from];
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    if (id === to) return true;
    for (const neighbor of definitions.get(id)!.neighbors) {
      if (!visited.has(neighbor) && state.territories[neighbor]?.owner === playerId) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return false;
}

/** Randomized automatic setup uses exactly the classic initial army allowance. */
export function createGame(specs: PlayerSpec[], rng: () => number = Math.random): GameState {
  assert(specs.length >= 3 && specs.length <= 6, 'Classic world conquest requires 3–6 players.');
  assert(new Set(specs.map(p => p.id)).size === specs.length && specs.every(p => p.id), 'Player identities must be unique.');
  const state: GameState = {
    id: `game-${Math.floor(rng() * 0xFFFFFFFF).toString(36)}`,
    players: specs.map(p => ({ ...p, alive: true, cards: [], cardCount: 0, connected: true })),
    territories: {}, currentPlayer: 0, phase: 'reinforce', reinforcements: 0,
    turn: 1, conqueredThisTurn: false, tradeCount: 0, discard: [], log: [],
    combat: null, occupation: null, winner: null,
    deck: shuffle<Card>([
      ...TERRITORIES.map((t, index) => ({ id: t.id, territory: t.id, symbol: symbols[index % symbols.length] })),
      { id: 'wild-1', territory: null, symbol: 'wild' },
      { id: 'wild-2', territory: null, symbol: 'wild' },
    ], rng),
  };
  shuffle(TERRITORIES, rng).forEach((territory, index) => {
    state.territories[territory.id] = { owner: specs[index % specs.length].id, armies: 1 };
  });
  const initialArmies = ({ 3: 35, 4: 30, 5: 25, 6: 20 } as Record<number, number>)[specs.length];
  for (const player of specs) {
    const owned = TERRITORIES.filter(t => state.territories[t.id].owner === player.id);
    for (let remaining = initialArmies - owned.length; remaining > 0; remaining--) {
      state.territories[owned[Math.floor(rng() * owned.length)].id].armies++;
    }
  }
  state.reinforcements = reinforcementCount(state, specs[0].id);
  log(state, `The world is divided. ${specs[0].name} takes command with ${state.reinforcements} reinforcements.`, 'turn');
  boardEvent(state, { type: 'setup', playerId: specs[0].id, color: specs[0].color, count: initialArmies * specs.length, placements: TERRITORIES.map(t => ({ territory: t.id, owner: state.territories[t.id].owner, count: state.territories[t.id].armies })) });
  return state;
}

function finishTurn(state: GameState, rng: () => number) {
  const previous = state.players[state.currentPlayer];
  if (state.conqueredThisTurn) {
    if (!state.deck.length) {
      state.deck = shuffle(state.discard, rng);
      state.discard = [];
    }
    const card = state.deck.pop();
    if (card) {
      previous.cards.push(card);
      log(state, `${previous.name} earned a territory card.`, 'card');
    }
  }
  do { state.currentPlayer = (state.currentPlayer + 1) % state.players.length; }
  while (!state.players[state.currentPlayer].alive);
  state.turn++;
  state.phase = 'reinforce';
  state.conqueredThisTurn = false;
  state.combat = null;
  state.occupation = null;
  delete state.resumePhase;
  const current = state.players[state.currentPlayer];
  state.reinforcements = reinforcementCount(state, current.id);
  log(state, `${current.name} takes command. ${state.reinforcements} new armies are ready.`, 'turn');
}

/** All clients, including AI, pass through the same authoritative validation. */
export function applyAction(original: GameState, playerId: string, action: GameAction, rng: () => number = Math.random): GameState {
  assert(original.phase !== 'gameover', 'This campaign has ended.');
  assert(original.players[original.currentPlayer]?.id === playerId, 'Wait for your turn.');
  assert(action && typeof action === 'object', 'Invalid command.');
  const state = structuredClone(original);
  const player = state.players[state.currentPlayer];
  let outcome: Omit<BoardEvent, 'id'> | undefined;
  const owns = (id: string) => Boolean(definitions.has(id) && state.territories[id]?.owner === playerId);
  const phase = (expected: GameState['phase']) => assert(state.phase === expected, `This command is only available during ${expected}.`);

  switch (action.type) {
    case 'trade': {
      phase('reinforce');
      assert(!state.resumePhase || player.cards.length >= 5, 'Stop exchanging inherited cards once fewer than five remain.');
      assert(Array.isArray(action.cards) && action.cards.length === 3 && new Set(action.cards).size === 3, 'Select three different cards.');
      const cards = action.cards.map(id => player.cards.find(card => card.id === id));
      assert(cards.every(Boolean), 'You do not own these cards.');
      const selected = cards as Card[];
      assert(canTrade(selected), 'Trade three matching symbols or one of each. Wild cards substitute for any symbol.');
      const armies = nextTradeValue(state.tradeCount++);
      state.reinforcements += armies;
      player.cards = player.cards.filter(card => !action.cards.includes(card.id));
      state.discard.push(...selected);
      const eligible = selected.filter(card => card.territory && owns(card.territory));
      assert(action.bonusTerritory === undefined || eligible.some(card => card.territory === action.bonusTerritory), 'The bonus must go on an owned territory in this card set.');
      const ownedCard = action.bonusTerritory ? eligible.find(card => card.territory === action.bonusTerritory) : eligible[0];
      if (ownedCard?.territory) {
        state.territories[ownedCard.territory].armies += 2;
        outcome = { type: 'deploy', playerId, color: player.color, to: ownedCard.territory, count: 2 };
      }
      log(state, `${player.name} traded a set for ${armies} armies${ownedCard?.territory ? ` and 2 on ${territoryName(ownedCard.territory)}` : ''}.`, 'card');
      break;
    }
    case 'deploy': {
      phase('reinforce');
      assert(player.cards.length < 5, 'Exchange a card set before deploying when holding five or more cards.');
      assert(owns(action.territory), 'You can reinforce only your own territory.');
      integer(action.count, 1, state.reinforcements, 'Armies');
      state.territories[action.territory].armies += action.count;
      state.reinforcements -= action.count;
      outcome = { type: 'deploy', playerId, color: player.color, to: action.territory, count: action.count };
      if (!state.reinforcements) {
        state.phase = 'attack';
        delete state.resumePhase;
      }
      break;
    }
    case 'attack': {
      phase('attack');
      assert(owns(action.from), 'Your attacking territory must belong to you.');
      assert(definitions.has(action.to) && !owns(action.to), 'Choose an enemy territory.');
      assert(definitions.get(action.from)!.neighbors.includes(action.to), 'Attacks must follow a border or sea connection.');
      const from = state.territories[action.from];
      const to = state.territories[action.to];
      const defenderColor = state.players.find(defender => defender.id === to.owner)?.color;
      integer(action.dice, 1, Math.min(3, from.armies - 1), 'Attacking dice');
      const roll = (count: number) => Array.from({ length: count }, () => 1 + Math.floor(rng() * 6)).sort((a, b) => b - a);
      const attackDice = roll(action.dice);
      const defenseDice = roll(Math.min(2, to.armies));
      let attackerLoss = 0;
      let defenderLoss = 0;
      for (let i = 0; i < Math.min(attackDice.length, defenseDice.length); i++) {
        if (attackDice[i] > defenseDice[i]) defenderLoss++;
        else attackerLoss++;
      }
      from.armies -= attackerLoss;
      to.armies -= defenderLoss;
      state.combat = { from: action.from, to: action.to, attackDice, defenseDice, attackerLoss, defenderLoss, conquered: to.armies === 0, at: Date.now() };
      outcome = { type: 'attack', playerId, color: player.color, from: action.from, to: action.to, count: action.dice, defenderColor, attackerLoss, defenderLoss, attackDice: [...attackDice], defenseDice: [...defenseDice] };
      log(state, `${territoryName(action.from)} → ${territoryName(action.to)}: attacker lost ${attackerLoss}, defender lost ${defenderLoss}.`, 'attack');
      if (to.armies === 0) {
        const defeated = state.players.find(p => p.id === to.owner)!;
        to.owner = playerId;
        state.phase = 'occupy';
        state.conqueredThisTurn = true;
        state.occupation = { from: action.from, to: action.to, minimum: action.dice, maximum: from.armies - 1 };
        log(state, `${player.name} conquered ${territoryName(action.to)}.`, 'conquest');
        if (!TERRITORIES.some(t => state.territories[t.id].owner === defeated.id)) {
          defeated.alive = false;
          player.cards.push(...defeated.cards);
          defeated.cards = [];
          log(state, `${player.name} eliminated ${defeated.name} and claimed their cards.`, 'conquest');
        }
      }
      break;
    }
    case 'occupy': {
      phase('occupy');
      const occupation = state.occupation;
      assert(occupation, 'There is no conquered territory to occupy.');
      integer(action.count, occupation.minimum, occupation.maximum, 'Occupying armies');
      state.territories[occupation.from].armies -= action.count;
      state.territories[occupation.to].armies += action.count;
      outcome = { type: 'conquest', playerId, color: player.color, from: occupation.from, to: occupation.to, count: action.count };
      state.occupation = null;
      state.phase = 'attack';
      if (TERRITORIES.every(t => owns(t.id))) {
        state.phase = 'gameover';
        state.winner = playerId;
        log(state, `${player.name} has conquered the world. Victory!`, 'victory');
      } else if (player.cards.length >= 6) {
        state.phase = 'reinforce';
        state.reinforcements = 0;
        state.resumePhase = 'attack';
        log(state, `${player.name} must exchange inherited cards and deploy those armies before continuing.`, 'card');
      }
      break;
    }
    case 'endAttack':
      phase('attack');
      state.phase = 'fortify';
      break;
    case 'fortify': {
      phase('fortify');
      assert(action.from !== action.to, 'Choose a different destination territory.');
      assert(owns(action.from) && owns(action.to), 'Fortify between your own territories.');
      assert(definitions.get(action.from)!.neighbors.includes(action.to), 'Classic fortification requires adjacent territories.');
      integer(action.count, 1, state.territories[action.from].armies - 1, 'Moving armies');
      state.territories[action.from].armies -= action.count;
      state.territories[action.to].armies += action.count;
      outcome = { type: 'move', playerId, color: player.color, from: action.from, to: action.to, count: action.count };
      log(state, `${player.name} moved ${action.count} armies from ${territoryName(action.from)} to ${territoryName(action.to)}.`, 'fortify');
      finishTurn(state, rng);
      break;
    }
    case 'endTurn':
      phase('fortify');
      finishTurn(state, rng);
      break;
    default:
      throw new Error('Unknown command.');
  }
  syncCards(state);
  if (outcome) boardEvent(state, outcome);
  return state;
}
