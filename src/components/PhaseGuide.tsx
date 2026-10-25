import { useState } from 'react';
import { ArrowRight, Diamond, Circle, Hand } from 'lucide-react';
import type { GameState } from '../../shared/types';
import { CONTINENTS, TERRITORIES, TERRITORY_BY_ID } from '../../shared/world';

const lessons = {
  reinforce: { name: 'Reinforce', title: 'Choose where your next armies matter.', steps: ['Choose one of your territories marked with a diamond.', 'Adjust the army count. The preview shows its strength after deployment.', 'Deploy. Place every reinforcement before attacking.'], rule: 'Your normal turn allowance is territories ÷ 3, rounded down, with a minimum of 3, plus any complete continents. Card exchanges add armies. At 5 or more cards, exchange before deploying.' },
  attack: { name: 'Attack', title: 'Plan a route before rolling.', steps: ['Choose a diamond-marked territory you own with at least 2 armies.', 'Choose an adjacent enemy marked with a ring. Borders and sea connections both count.', 'Choose 1–3 legal dice and roll. You may attack again or finish attacking.'], rule: 'One army must stay behind. The defender rolls up to 2 dice automatically. Compare highest dice first, then the next pair. Every lost comparison costs one army; ties favor the defender. A larger force is no guarantee of a win.' },
  occupy: { name: 'Advance', title: 'Secure your conquered territory.', steps: ['The captured territory already belongs to you.', 'Choose how many armies to advance. The preview shows both resulting counts.', 'Advance to finish the capture and continue your turn.'], rule: 'Move at least the number of dice used in the final attack, and leave at least one army at the source. This required movement cannot be canceled. A conquest earns one card at the end of the turn, regardless of how many territories you capture.' },
  fortify: { name: 'Fortify', title: 'Make one final adjustment.', steps: ['Choose a diamond-marked territory you own with spare armies.', 'Choose a ring-marked adjacent territory you also own.', 'Move armies and end your turn, or skip the move.'], rule: 'This game uses classic adjacent-only fortification: one move between two neighboring friendly territories, leaving one army behind. A route through several friendly territories is not a legal fortification.' },
};
type Lesson = keyof typeof lessons;

export default function PhaseGuide({ game, playerId, selected }: { game: GameState; playerId?: string; selected: string | null }) {
  const [lesson, setLesson] = useState<Lesson>(game.phase === 'gameover' ? 'reinforce' : game.phase);
  const content = lessons[lesson];
  const owned = TERRITORIES.filter(t => game.territories[t.id].owner === playerId);
  const base = Math.max(3, Math.floor(owned.length / 3));
  const held = CONTINENTS.filter(c => TERRITORIES.filter(t => t.continent === c.id).every(t => game.territories[t.id].owner === playerId));
  const info = selected ? TERRITORY_BY_ID[selected] : null;
  const continent = CONTINENTS.find(c => c.id === info?.continent);
  const controlled = continent ? owned.filter(t => t.continent === continent.id).length : 0;
  const total = continent ? TERRITORIES.filter(t => t.continent === continent.id).length : 0;
  return <div className="phase-guide">
    <div className="guide-tabs" role="tablist" aria-label="Turn lessons" onKeyDown={event => {
      const keys = Object.keys(lessons) as Lesson[];
      const index = keys.indexOf(lesson);
      const next = event.key === 'ArrowRight' ? keys[(index + 1) % keys.length] : event.key === 'ArrowLeft' ? keys[(index + keys.length - 1) % keys.length] : event.key === 'Home' ? keys[0] : event.key === 'End' ? keys.at(-1) : undefined;
      if (next) { event.preventDefault(); setLesson(next); document.getElementById(`guide-tab-${next}`)?.focus(); }
    }}>{(Object.keys(lessons) as Lesson[]).map(key => <button key={key} type="button" role="tab" tabIndex={lesson === key ? 0 : -1} aria-selected={lesson === key} aria-controls="guide-lesson" id={`guide-tab-${key}`} onClick={() => setLesson(key)}>{lessons[key].name}</button>)}</div>
    <section id="guide-lesson" role="tabpanel" aria-labelledby={`guide-tab-${lesson}`}><h3>{content.title}</h3><ol>{content.steps.map(step => <li key={step}><ArrowRight size={15}/><span>{step}</span></li>)}</ol><p className="guide-rule">{content.rule}</p></section>
    {lesson === 'reinforce' && playerId && <p className="guide-context"><b>Your table:</b> {owned.length} territories → {owned.length ? base : 0} base armies{held.length ? ` + ${held.reduce((sum, c) => sum + c.bonus, 0)} from ${held.map(c => c.name).join(', ')}` : '; no complete continent'}. {game.phase === 'reinforce' && game.players[game.currentPlayer]?.id === playerId ? `${game.reinforcements} remain to place now.` : 'This is your normal turn allowance; exchanges and earlier deployments change the amount available.'}</p>}
    {info && continent && <p className="guide-context"><b>{info.name}:</b> {continent.name} · you hold {controlled}/{total} territories. Hold all {total} at the start of your turn for +{continent.bonus} armies. Adjacent: {info.neighbors.map(id => TERRITORY_BY_ID[id].name).join(', ')}.</p>}
    <div className="guide-legend" aria-label="Board marker legend"><span><Diamond size={13}/>Eligible starting territory</span><span><Circle size={14}/>Eligible destination</span><span><Hand size={14}/>Select to preview; buttons issue orders</span></div>
    <p className="guide-footnote">Help is optional. Close this guide to keep playing; reopen it with the ? button. Inspecting, rotating and zooming never spend armies.</p>
  </div>;
}
