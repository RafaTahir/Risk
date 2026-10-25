import { ArrowRight, Flag, Shield, Swords } from 'lucide-react';
import type { Combat } from '../../shared/types';
import { TERRITORY_BY_ID } from '../../shared/world';

export function Dice({ values, side }: { values: number[]; side: string }) {
  return <div className={`dice-row ${side}`} aria-label={`${side} dice: ${values.join(', ')}`}>{values.map((n, i) => <div className={`die die-${n}`} key={i}>{Array.from({ length: 9 }, (_, j) => <i key={j} className={([[], [4], [0, 8], [0, 4, 8], [0, 2, 6, 8], [0, 2, 4, 6, 8], [0, 2, 3, 5, 6, 8]][n] || []).includes(j) ? 'pip' : ''}/>)}</div>)}</div>;
}

export function battlePairs(combat: Combat) {
  const attack = [...combat.attackDice].sort((a, b) => b - a), defense = [...combat.defenseDice].sort((a, b) => b - a);
  return defense.slice(0, attack.length).map((value, index) => ({ attack: attack[index], defense: value, tie: attack[index] === value, lost: attack[index] > value ? 'Defender' : 'Attacker' }));
}

export function BattleToast({ combat, onOpen, onDismiss }: { combat: Combat; onOpen: () => void; onDismiss: () => void }) {
  return <div className={`battle-toast ${combat.conquered ? 'captured' : ''}`} role="status">
    <button className="battle-summary" aria-label="Explain latest battle" onClick={onOpen}>
      <span className="battle-title">{combat.conquered ? <Flag size={15}/> : <Swords size={15}/>}<b>{TERRITORY_BY_ID[combat.to].name}{combat.conquered ? ' captured' : ''}</b></span>
      <span className="battle-toast-dice"><Dice values={combat.attackDice} side="attacker"/><span>vs</span><Dice values={combat.defenseDice} side="defender"/></span>
      <span className="battle-losses">Attacker −{combat.attackerLoss} · Defender −{combat.defenderLoss}<span className="battle-explain"> · Details ↗</span></span>
    </button><button className="battle-dismiss" aria-label="Dismiss battle result" onClick={onDismiss}>×</button>
  </div>;
}

export default function BattleReport({ combat }: { combat: Combat }) {
  const pairs = battlePairs(combat);
  return <div className={`battle-report${combat.conquered ? ' is-capture' : ''}`}>
    <div className="battle-route"><b>{TERRITORY_BY_ID[combat.from].name}</b><ArrowRight size={17}/><b>{TERRITORY_BY_ID[combat.to].name}</b></div>
    <p className="muted">Highest dice are paired first. Ties favor the defender. Extra, unpaired dice cause no casualties.</p>
    <div className="battle-rolls"><div><span>Attacker</span><Dice values={combat.attackDice} side="attacker"/></div><div><span>Defender</span><Dice values={combat.defenseDice} side="defender"/></div></div>
    <table className="battle-comparisons" aria-label="Dice comparisons"><thead><tr><th>Pair</th><th>Attack</th><th>Defense</th><th>Result</th></tr></thead><tbody>{pairs.map((pair, i) => <tr key={i} style={{ animationDelay: `${i * 100}ms` }}><th scope="row">{i + 1}</th><td>{pair.attack}</td><td>{pair.defense}</td><td>{pair.tie && <span>Tie · </span>}{pair.lost} loses 1</td></tr>)}</tbody></table>
    <div className="battle-casualties" data-testid="battle-casualties"><span><Swords size={17}/>Attacker <b>−{combat.attackerLoss}</b></span><span><Shield size={17}/>Defender <b>−{combat.defenderLoss}</b></span></div>
    <p className="battle-outcome">{combat.conquered ? <><Flag size={18}/><span><b>Territory captured.</b> This roll transferred ownership to the attacker. A capture requires advancing armies before continuing.</span></> : <><Shield size={18}/><span><b>The defender held this roll.</b> The casualties were removed immediately. Follow the turn controls for your next legal action.</span></>}</p>
    <p className="guide-footnote">This report explains the confirmed roll. Opening or dismissing it issues no order and never rerolls dice.</p>
  </div>;
}
