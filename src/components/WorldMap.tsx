import { useId } from 'react';
import type { CSSProperties } from 'react';
import type { GameState } from '../../shared/types';
import { CONTINENTS, TERRITORIES } from '../../shared/world';
import './WorldMap.css';

interface WorldMapProps {
  game: GameState | null;
  selected: string | null;
  target: string | null;
  validTargets: string[];
  onSelect: (id: string) => void;
  interactive?: boolean;
}
const shortNames: Record<string,string[]> = {
  'northwest-territory':['NORTHWEST','TERRITORY'], 'western-united-states':['WESTERN','UNITED STATES'],
  'eastern-united-states':['EASTERN','UNITED STATES'], 'central-america':['CENTRAL','AMERICA'],
  'great-britain':['GREAT','BRITAIN'], 'northern-europe':['NORTHERN','EUROPE'],
  'western-europe':['WESTERN','EUROPE'], 'southern-europe':['SOUTHERN','EUROPE'],
  'north-africa':['NORTH AFRICA'], 'east-africa':['EAST AFRICA'], 'south-africa':['SOUTH AFRICA'],
  'middle-east':['MIDDLE EAST'], 'western-australia':['WESTERN','AUSTRALIA'],
  'eastern-australia':['EASTERN','AUSTRALIA'], 'new-guinea':['NEW GUINEA'],
};
export default function WorldMap({ game, selected, target, validTargets, onSelect, interactive = true }: WorldMapProps) {
  const uid = useId().replaceAll(':','');
  const ocean = `${uid}-ocean`; const grid = `${uid}-grid`; const glow = `${uid}-glow`;
  return <div className="world-map">
    <svg viewBox="0 0 1100 640" role="group" aria-label="World conquest map, 42 territories" className="world-map-svg">
      <defs>
        <radialGradient id={ocean}><stop offset="0" stopColor="#19343d"/><stop offset="1" stopColor="#0b1d28"/></radialGradient>
        <pattern id={grid} width="55" height="55" patternUnits="userSpaceOnUse"><path d="M55 0 H0 V55" fill="none" stroke="#8aa5ad" strokeOpacity=".065" strokeWidth=".75"/></pattern>
        <filter id={glow} x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="3"/></filter>
      </defs>
      <rect width="1100" height="640" fill={`url(#${ocean})`}/>
      <rect width="1100" height="640" fill={`url(#${grid})`}/>
      <g className="map-coordinates" aria-hidden="true">
        {[0,1,2,3,4,5,6,7,8,9].map(i=><text key={i} x={55+i*110} y="25">{Math.abs(160-i*40)}° {i<4?'W':'E'}</text>)}
        {[0,1,2,3,4].map(i=><text key={i} x="17" y={102+i*110}>{Math.abs(60-i*30)}°</text>)}
        <path d="M35 44 H1065 V595 H35 Z" fill="none" stroke="currentColor" strokeOpacity=".35"/>
      </g>
      <g className="map-ocean-labels" aria-hidden="true">
        <text x="171" y="406" transform="rotate(-16 171 406)">PACIFIC OCEAN</text>
        <text x="438" y="232" transform="rotate(-67 438 232)">ATLANTIC OCEAN</text>
        <text x="796" y="479" transform="rotate(-12 796 479)">INDIAN OCEAN</text>
        <text x="541" y="568">SOUTH ATLANTIC</text>
      </g>
      <g className="map-routes" aria-hidden="true">
        <path d="M393 122 Q439 89 490 125 M412 370 Q453 318 505 337 M511 265 L514 311 M610 259 L618 302 M879 381 L864 427 M920 433 L978 420 M947 449 L947 480 M989 434 L1002 479 M653 439 L697 456 M647 385 L703 451 M104 127 Q50 114 35 128 M1065 128 Q1046 109 975 128"/>
      </g>
      {TERRITORIES.map(t=>{
        const territory = game?.territories[t.id];
        const player = game?.players.find(p=>p.id === territory?.owner);
        const continent = CONTINENTS.find(c=>c.id === t.continent)!;
        const active = t.id === selected; const targeted = t.id === target; const valid = validTargets.includes(t.id);
        const color = player?.color ?? continent.color;
        const labels = shortNames[t.id] ?? [t.name.toUpperCase()];
        return <g key={t.id} className={`map-territory ${active?'is-selected':''} ${targeted?'is-target':''} ${valid?'is-valid':''} ${interactive?'is-interactive':''}`}
          style={{'--territory-color':color} as CSSProperties} tabIndex={interactive?0:-1} role="button"
          aria-label={`${t.name}${player?`, ${player.name}, ${territory?.armies} armies`:''}${active?', selected':''}${valid?', available target':''}`}
          aria-pressed={active || targeted} onClick={()=>interactive && onSelect(t.id)}
          onKeyDown={e=>{if(interactive && (e.key==='Enter' || e.key===' ')){e.preventDefault();onSelect(t.id);}}}>
          <title>{t.name}{player?` · ${player.name} · ${territory?.armies} armies`:''}</title>
          {(active || targeted) && <path d={t.path} fill="none" stroke={color} strokeWidth="9" opacity=".45" filter={`url(#${glow})`}/>}
          <path className="map-land" d={t.path}/>
          <path className="map-land-edge" d={t.path}/>
          <text className="map-territory-name" x={t.x} y={t.y-(territory?10:2)-(labels.length-1)*4}>
            {labels.map((line,i)=><tspan key={line} x={t.x} dy={i===0?0:9}>{line}</tspan>)}
          </text>
          {territory && <g className="map-army" transform={`translate(${t.x} ${t.y+10})`}>
            <rect x="-12" y="-10" width="24" height="20" rx="6"/>
            <text y="4">{territory.armies}</text>
          </g>}
          {valid && <circle className="map-target-dot" cx={t.x+18} cy={t.y+10} r="3"/>}
        </g>;
      })}
      <g className="map-compass" transform="translate(105 526)" aria-hidden="true">
        <circle r="31"/><circle r="26"/><path d="M0 -39 L7 -7 L0 0 L-7 -7 Z" className="map-compass-north"/><path d="M0 39 L-7 7 L0 0 L7 7 Z M-39 0 L-7 -7 L0 0 L-7 7 Z M39 0 L7 7 L0 0 L7 -7 Z"/>
        <text x="0" y="-45">N</text><text x="0" y="55">S</text><text x="-48" y="4">W</text><text x="48" y="4">E</text>
      </g>
      <g className="map-footer" aria-hidden="true"><text x="48" y="621">WORLD THEATRE / CLASSIC TERRITORIES</text><text x="1053" y="621" textAnchor="end">42 TERRITORIES · 6 CONTINENTS</text></g>
    </svg>
  </div>;
}
export { WorldMap };
