import { useEffect, useState } from 'react';
import { ArrowRight, CircleHelp, Dice1, Dice2, Dice3, Flag, Layers3, Minus, Plus, Shield, SkipForward, Swords, X } from 'lucide-react';
import { nextTradeValue } from '../../shared/game';
import type { GameAction, GameState, Player } from '../../shared/types';
import { TERRITORY_BY_ID } from '../../shared/world';
import { defenderLossChance } from '../lib/combatOdds';
import './GameDock.css';

interface GameDockProps {
  game: GameState;
  me?: Player;
  selected: string | null;
  target: string | null;
  myTurn: boolean;
  pending: boolean;
  act: (action: GameAction) => Promise<unknown>;
  onCards: () => void;
  onClearSelection: () => void;
  onHint?: () => void;
  showFirstTurnHelp?: boolean;
  onDismissFirstTurnHelp?: () => void;
}

interface ArmyPickerProps {
  value: number;
  minimum: number;
  maximum: number;
  disabled: boolean;
  onChange: (value: number) => void;
}

function ArmyPicker({ value, minimum, maximum, disabled, onChange }: ArmyPickerProps) {
  return <div className="cdock-picker" role="group" aria-label="Army count">
    <button type="button" aria-label="Fewer armies" disabled={disabled || value <= minimum} onClick={() => onChange(value - 1)}><Minus size={16}/></button>
    <input
      aria-label="Number of armies"
      type="number"
      inputMode="numeric"
      min={minimum}
      max={maximum}
      step={1}
      value={value}
      disabled={disabled}
      onChange={event => {
        const next = Number(event.target.value);
        if (Number.isFinite(next)) onChange(Math.max(minimum, Math.min(maximum, Math.trunc(next))));
      }}
    />
    <button type="button" aria-label="More armies" disabled={disabled || value >= maximum} onClick={() => onChange(value + 1)}><Plus size={16}/></button>
    <button type="button" className="cdock-max" aria-label="MAX" title={`Use all ${maximum} available armies`} disabled={disabled} onClick={() => onChange(maximum)}>MAX</button>
  </div>;
}

const phaseLabels = { reinforce: 'Reinforce', attack: 'Attack', occupy: 'Advance', fortify: 'Fortify', gameover: 'Victory' };
const diceIcons = [Dice1, Dice2, Dice3];

export default function GameDock({ game, me, selected, target, myTurn, pending, act, onCards, onClearSelection, onHint, showFirstTurnHelp, onDismissFirstTurnHelp }: GameDockProps) {
  const [count, setCount] = useState(1);
  const [dice, setDice] = useState(3);
  const origin = selected ? game.territories[selected] : undefined;
  const originInfo = selected ? TERRITORY_BY_ID[selected] : undefined;
  const destination = target ? game.territories[target] : undefined;
  const destinationInfo = target ? TERRITORY_BY_ID[target] : undefined;
  const owner = game.players.find(player => player.id === origin?.owner);
  const friendly = Boolean(me && origin?.owner === me.id);
  const adjacent = Boolean(selected && target && originInfo?.neighbors.includes(target));
  const active = Boolean(myTurn && me?.alive && game.players[game.currentPlayer]?.id === me.id && !game.winner && game.phase !== 'gameover');
  const cards = me?.cards.length ?? 0;
  const mustTrade = game.phase === 'reinforce' && cards >= 5;
  const occupation = game.phase === 'occupy' ? game.occupation : null;
  const minimum = occupation?.minimum ?? 1;
  const available = game.phase === 'reinforce' ? game.reinforcements : occupation?.maximum ?? Math.max(0, (origin?.armies ?? 1) - 1);
  const maximum = Math.max(minimum, available);
  const actual = Math.max(minimum, Math.min(maximum, count));
  const maximumDice = Math.min(3, Math.max(0, (origin?.armies ?? 1) - 1));
  const actualDice = Math.max(1, Math.min(maximumDice, dice));
  const neighboringEnemies = originInfo?.neighbors.filter(id => game.territories[id].owner !== me?.id) ?? [];
  const neighboringFriends = originInfo?.neighbors.filter(id => game.territories[id].owner === me?.id) ?? [];
  const hasEligibleSource = Object.entries(game.territories).some(([id, state]) => state.owner === me?.id && state.armies > 1 && TERRITORY_BY_ID[id].neighbors.some(neighbor => game.phase === 'attack' ? game.territories[neighbor].owner !== me?.id : game.territories[neighbor].owner === me?.id));

  useEffect(() => {
    setCount(game.phase === 'reinforce' ? Math.max(1, game.reinforcements) : game.phase === 'occupy' ? game.occupation?.maximum ?? 1 : 1);
  }, [game.id, selected, target, game.phase, game.reinforcements, game.occupation?.minimum, game.occupation?.maximum]);

  if (!active) {
    if (!origin || !originInfo) return null;
    return <aside className="cdock cdock-inspection" aria-label="Selected territory">
      <span className="cdock-owner-dot" style={{ background: owner?.color }} aria-hidden="true"/>
      <div className="cdock-inspection-name"><b>{originInfo.name}</b><span>{owner?.name ?? 'Unclaimed'}</span></div>
      <span className="cdock-strength"><Shield size={14}/><b>{origin.armies}</b><span>armies</span></span>
      <button type="button" className="cdock-icon" aria-label="Clear territory selection" onClick={onClearSelection}><X size={17}/></button>
    </aside>;
  }

  const validCount = Number.isSafeInteger(actual) && actual >= minimum && actual <= available;
  const canDeploy = game.phase === 'reinforce' && friendly && Boolean(originInfo) && !mustTrade && validCount;
  const canAttack = game.phase === 'attack' && friendly && adjacent && Boolean(destination && destination.owner !== me?.id) && maximumDice > 0;
  const canOccupy = game.phase === 'occupy' && Boolean(occupation) && validCount;
  const canFortify = game.phase === 'fortify' && friendly && adjacent && selected !== target && destination?.owner === me?.id && validCount;
  const sourceHasRoute = game.phase === 'attack' ? neighboringEnemies.length > 0 : game.phase === 'fortify' ? neighboringFriends.length > 0 : true;
  const showPicker = game.phase === 'occupy' || (friendly && available > 0 && sourceHasRoute && !mustTrade);
  const showSecondary = game.phase === 'attack' || game.phase === 'fortify';
  const fromId = occupation?.from ?? selected;
  const toId = occupation?.to ?? target;
  const fromInfo = fromId ? TERRITORY_BY_ID[fromId] : undefined;
  const toInfo = toId ? TERRITORY_BY_ID[toId] : undefined;
  const fromState = fromId ? game.territories[fromId] : undefined;
  const toState = toId ? game.territories[toId] : undefined;

  let instruction = game.phase === 'reinforce' ? 'Choose your territory to reinforce.' : game.phase === 'attack' ? 'Choose your territory, then an adjacent enemy.' : game.phase === 'occupy' ? 'Move armies into your conquered territory.' : 'Choose two adjacent territories you own.';
  if (mustTrade) instruction = `Trade a set before deploying · ${cards} cards in hand.`;
  else if (game.phase === 'attack' && !hasEligibleSource) instruction = 'No legal attacks remain. Finish attacking to continue.';
  else if (game.phase === 'fortify' && !hasEligibleSource) instruction = 'No adjacent move is available. Skip to end your turn.';
  else if (origin && !friendly && game.phase !== 'occupy') instruction = 'Choose a territory you own.';
  else if (friendly && available < 1 && game.phase !== 'reinforce') instruction = 'Keep one army here. Choose a stronger territory.';
  else if (friendly && game.phase === 'attack' && !neighboringEnemies.length) instruction = 'No adjacent enemy here. Choose a border territory.';
  else if (friendly && game.phase === 'fortify' && !neighboringFriends.length) instruction = 'No adjacent friendly territory here. Choose another origin.';
  else if (friendly && game.phase === 'attack' && !canAttack) instruction = `Choose an adjacent enemy · ${neighboringEnemies.length} available.`;
  else if (friendly && game.phase === 'fortify' && !canFortify) instruction = `Choose a friendly neighbor · ${neighboringFriends.length} available.`;

  const phaseDetail = game.phase === 'reinforce' ? `${game.reinforcements} armies ready${game.resumePhase ? ' · resume attack after deploying' : ''}` : game.phase === 'occupy' ? `${minimum}–${available} armies` : game.phase === 'fortify' ? 'One adjacent move' : 'Ties defend';
  const showRoute = Boolean(fromInfo && fromState);
  const showDestination = Boolean(occupation) || (game.phase !== 'reinforce' && friendly && available > 0 && sourceHasRoute);
  let actionPreview = instruction;
  if (canDeploy && origin) actionPreview = `After deploy · ${origin.armies + actual} armies here · ${game.reinforcements - actual} in reserve`;
  else if (canOccupy && fromState && toState) actionPreview = `After advance · ${fromState.armies - actual} left behind · ${toState.armies + actual} at destination`;
  else if (canFortify && fromState && toState) actionPreview = `After move · ${fromState.armies - actual} left behind · ${toState.armies + actual} at destination`;
  else if (canAttack && destination) actionPreview = `${actualDice} attack ${actualDice === 1 ? 'die' : 'dice'} vs ${Math.min(2, destination.armies)} defense · ties defend · ${Math.round(defenderLossChance(actualDice, Math.min(2, destination.armies)) * 100)}% chance to remove a defender this roll · leave 1 behind`;

  return <aside className={`cdock cdock-active cdock-${game.phase}${mustTrade ? ' cdock-trade-required' : ''}`} aria-label="Turn controls" aria-busy={pending}>
    {showFirstTurnHelp && !selected && onHint && <div className="cdock-first-guide" data-testid="first-turn-guide"><span>First turn?</span><button type="button" onClick={onHint} aria-label="Show legal moves"><CircleHelp size={16}/>Show legal moves</button><button type="button" aria-label="Dismiss first-turn guide" onClick={onDismissFirstTurnHelp}><X size={16}/></button></div>}
    <div className="cdock-heading">
      <div className="cdock-overview">
        <div className="cdock-phase"><span>{phaseLabels[game.phase]}</span><span className="cdock-phase-detail">{phaseDetail}</span></div>
        {showRoute ? <div className="cdock-route">
          <span className="cdock-territory"><span className="cdock-owner-dot" style={{ background: game.players.find(player => player.id === fromState?.owner)?.color }} aria-hidden="true"/><b title={fromInfo?.name}>{fromInfo?.name}</b><span className="cdock-army-badge" aria-label={`${fromState?.armies} armies`}>{fromState?.armies}</span></span>
          {showDestination && <><ArrowRight size={14} className="cdock-route-arrow" aria-hidden="true"/>{toInfo && toState ? <span className="cdock-territory"><b title={toInfo.name}>{toInfo.name}</b><span className="cdock-army-badge" aria-label={`${toState.armies} armies`}>{toState.armies}</span></span> : <span className="cdock-placeholder">{game.phase === 'attack' ? 'Choose an enemy' : 'Choose a neighbor'}</span>}</>}
        </div> : <p className="cdock-prompt">{instruction}</p>}
      </div>
      <div className="cdock-tools">
        {onHint && <button type="button" className="cdock-icon cdock-help" aria-label="Explain this phase" title="Explain this phase" onClick={onHint}><CircleHelp size={18}/></button>}
        <button type="button" className={`cdock-cards${mustTrade ? ' cdock-cards-required' : ''}`} aria-label={mustTrade ? 'Trade cards before deploying' : 'Your territory cards'} title={`${cards} cards · next set +${nextTradeValue(game.tradeCount)} armies`} onClick={onCards}><Layers3 size={17}/>{mustTrade && <span>Trade cards</span>}<b>{cards}</b></button>
        {selected && game.phase !== 'occupy' && <button type="button" className="cdock-icon" aria-label="Clear territory selection" onClick={onClearSelection}><X size={17}/></button>}
      </div>
      {showRoute && <p className={`cdock-action-preview${canDeploy || canOccupy || canFortify || canAttack ? ' is-ready' : ''}`} data-testid="action-preview" title={actionPreview} aria-live="polite" aria-atomic="true">{actionPreview}</p>}
    </div>
    {(showPicker || showSecondary) && <div className={`cdock-controls${!showPicker ? ' cdock-controls-quiet' : ''}`}>
      {showPicker && (game.phase === 'attack' ? <div className="cdock-dice" role="group" aria-label="Attacking dice">{diceIcons.map((Icon, index) => {
        const number = index + 1;
        return <button type="button" key={number} aria-label={`${number} attacking ${number === 1 ? 'die' : 'dice'}`} aria-pressed={actualDice === number} title={`${number} ${number === 1 ? 'die' : 'dice'}`} disabled={pending || number > maximumDice} onClick={() => setDice(number)}><Icon size={19}/><span>{number}</span></button>;
      })}</div> : <ArmyPicker value={actual} minimum={minimum} maximum={maximum} disabled={pending || mustTrade} onChange={setCount}/>)}
      {showPicker && game.phase === 'reinforce' && <button type="button" className="cdock-primary" aria-label="Deploy armies" disabled={!canDeploy || pending} onClick={() => { if (canDeploy && selected && !pending) void act({ type: 'deploy', territory: selected, count: actual }); }}><Plus size={17}/><span>Deploy<span className="cdock-long-label"> armies</span></span></button>}
      {showPicker && game.phase === 'attack' && <button type="button" className="cdock-primary" aria-label="Roll for battle" disabled={!canAttack || pending} onClick={() => { if (canAttack && selected && target && !pending) void act({ type: 'attack', from: selected, to: target, dice: actualDice }); }}><Swords size={17}/><span><span className="cdock-long-label">Roll for </span>battle</span></button>}
      {showPicker && game.phase === 'occupy' && <button type="button" className="cdock-primary" aria-label="Advance armies" disabled={!canOccupy || pending} onClick={() => { if (canOccupy && !pending) void act({ type: 'occupy', count: actual }); }}><Flag size={17}/><span>Advance<span className="cdock-long-label"> armies</span></span></button>}
      {showPicker && game.phase === 'fortify' && <button type="button" className="cdock-primary" aria-label="Fortify & end turn" disabled={!canFortify || pending} onClick={() => { if (canFortify && selected && target && !pending) void act({ type: 'fortify', from: selected, to: target, count: actual }); }}><Shield size={17}/><span>Fortify<span className="cdock-long-label"> & end turn</span></span></button>}
      {showSecondary && <button type="button" className="cdock-secondary" aria-label={game.phase === 'attack' ? 'Finish attacking' : 'Skip & end turn'} disabled={pending} onClick={() => { if (!pending) void act({ type: game.phase === 'attack' ? 'endAttack' : 'endTurn' }); }}><span>{game.phase === 'attack' ? 'Finish attacking' : 'Skip & end turn'}</span><SkipForward size={14}/></button>}
    </div>}
  </aside>;
}
