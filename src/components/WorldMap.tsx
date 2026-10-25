import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import type { GameState } from '../../shared/types';
import { CONTINENTS, TERRITORIES } from '../../shared/world';
import './WorldMap.css';

interface WorldMapProps {
  game: GameState | null;
  selected: string | null;
  target: string | null;
  validTargets: string[];
  eligibleSources?: string[];
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
export default function WorldMap({ game, selected, target, validTargets, eligibleSources = [], onSelect, interactive = true }: WorldMapProps) {
  const uid = useId().replaceAll(':','');
  const ocean = `${uid}-ocean`; const grid = `${uid}-grid`;
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({width:1100,height:640});
  const [view, setView] = useState({zoom:1,x:550,y:320});
  const viewRef = useRef(view);
  const sizeRef = useRef(size);
  const initialSize = useRef(false);
  const pointers = useRef(new Map<number,{x:number;y:number}>());
  const gesture = useRef({x:0,y:0,distance:0,moved:false});
  const suppressClick = useRef(false);
  const bounds = (next:typeof view) => {
    const currentSize = sizeRef.current;
    const zoom=Math.max(1,Math.min(3,next.zoom));
    const aspect = currentSize.width / currentSize.height;
    const width = Math.max(1100,640*aspect)/zoom;
    const height = width/aspect;
    const maxX = Math.max(0,(1100-width)/2+30);
    const maxY = Math.max(0,(640-height)/2+24);
    return {zoom,x:550+Math.max(-maxX,Math.min(maxX,next.x-550)),y:320+Math.max(-maxY,Math.min(maxY,next.y-320))};
  };
  const changeView = (next:typeof view) => { const bounded = bounds(next); viewRef.current=bounded; setView(bounded); };
  const zoom = (amount:number) => changeView({...viewRef.current,zoom:Math.max(1,Math.min(3,viewRef.current.zoom+amount))});
  const reset = () => changeView({zoom:1,x:550,y:320});
  useEffect(() => {
    const container = host.current; if (!container) return;
    const resize = () => {
      const width=container.clientWidth,height=container.clientHeight; if(!width || !height) return;
      const nextSize={width,height}; sizeRef.current=nextSize; setSize(nextSize);
      if(!initialSize.current) { initialSize.current=true; changeView({zoom:width<600 && height>width?1.5:1,x:550,y:320}); }
      else changeView(viewRef.current);
    };
    const wheel = (event:WheelEvent) => {
      event.preventDefault();
      const v=viewRef.current, viewport=sizeRef.current;
      const nextZoom=Math.max(1,Math.min(3,v.zoom*Math.exp(-event.deltaY*.0015)));
      const units=Math.max(1100,640*viewport.width/viewport.height)/viewport.width/v.zoom;
      const nextUnits=units*v.zoom/nextZoom;
      const rect=container.getBoundingClientRect();
      changeView({zoom:nextZoom,x:v.x+(event.clientX-rect.left-viewport.width/2)*(units-nextUnits),y:v.y+(event.clientY-rect.top-viewport.height/2)*(units-nextUnits)});
    };
    const observer=new ResizeObserver(resize); observer.observe(container); resize();
    container.addEventListener('wheel',wheel,{passive:false});
    return () => { observer.disconnect(); container.removeEventListener('wheel',wheel); };
  },[]);
  const begin = (event:ReactPointerEvent<SVGSVGElement>) => {
    if(event.button!==0) return;
    pointers.current.set(event.pointerId,{x:event.clientX,y:event.clientY});
    const points=[...pointers.current.values()];
    if(points.length===1) { suppressClick.current=false; gesture.current={x:event.clientX,y:event.clientY,distance:0,moved:false}; }
    else { const [a,b]=points; gesture.current={x:(a.x+b.x)/2,y:(a.y+b.y)/2,distance:Math.hypot(a.x-b.x,a.y-b.y),moved:true}; suppressClick.current=true; }
  };
  const move = (event:ReactPointerEvent<SVGSVGElement>) => {
    if(!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId,{x:event.clientX,y:event.clientY});
    const points=[...pointers.current.values()];
    const [a,b]=points;
    const x=b?(a.x+b.x)/2:a.x,y=b?(a.y+b.y)/2:a.y;
    const distance=b?Math.hypot(a.x-b.x,a.y-b.y):0;
    const prior=gesture.current;
    if(!prior.moved && Math.hypot(x-prior.x,y-prior.y)<6) return;
    if(!event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId);
    const v=viewRef.current, viewport=sizeRef.current;
    const units=Math.max(1100,640*viewport.width/viewport.height)/viewport.width/v.zoom;
    const nextZoom=Math.max(1,Math.min(3,distance && prior.distance?v.zoom*distance/prior.distance:v.zoom));
    const nextUnits=units*v.zoom/nextZoom;
    const rect=event.currentTarget.getBoundingClientRect();
    changeView({zoom:nextZoom,x:v.x-(x-prior.x)*units+(x-rect.left-viewport.width/2)*(units-nextUnits),y:v.y-(y-prior.y)*units+(y-rect.top-viewport.height/2)*(units-nextUnits)});
    gesture.current={x,y,distance,moved:true}; suppressClick.current=true;
  };
  const end = (event:ReactPointerEvent<SVGSVGElement>) => {
    pointers.current.delete(event.pointerId);
    if(event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const remaining=[...pointers.current.values()][0];
    if(remaining) gesture.current={...remaining,distance:0,moved:true};
  };
  const aspect=size.width/size.height;
  const width=Math.max(1100,640*aspect)/view.zoom,height=width/aspect;
  const labelScale=Math.max(1,Math.min(2,width/size.width));
  const origin=TERRITORIES.find(t=>t.id===selected),destination=TERRITORIES.find(t=>t.id===target);
  const routeLegal=Boolean(origin && destination && Math.abs(origin.x-destination.x)<=550 && (validTargets.includes(destination.id) || (game?.phase==='occupy' && game.occupation?.from===origin.id && game.occupation.to===destination.id)));
  let routeLine='',routeArrow='';
  if(routeLegal && origin && destination) {
    const dx=destination.x-origin.x,dy=destination.y-origin.y,distance=Math.hypot(dx,dy),ux=dx/Math.max(1,distance),uy=dy/Math.max(1,distance);
    const inset=Math.min(24*labelScale,distance*.24),ax=origin.x+ux*inset,ay=origin.y+uy*inset,bx=destination.x-ux*inset,by=destination.y-uy*inset;
    routeLine=`M${ax} ${ay} L${bx} ${by}`;
    routeArrow=`M${bx} ${by} L${bx-ux*9*labelScale-uy*4.5*labelScale} ${by-uy*9*labelScale+ux*4.5*labelScale} L${bx-ux*9*labelScale+uy*4.5*labelScale} ${by-uy*9*labelScale-ux*4.5*labelScale} Z`;
  }
  return <div className="world-map" ref={host}>
    <svg viewBox={`${view.x-width/2} ${view.y-height/2} ${width} ${height}`} role="group" aria-label="World conquest map, 42 territories" className="world-map-svg" onPointerDown={begin} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
      onClickCapture={event=>{if(suppressClick.current && event.detail!==0){event.preventDefault();event.stopPropagation();}}}
      onKeyDown={event=>{
        if(event.key==='+' || event.key==='='){event.preventDefault();zoom(.5);}
        else if(event.key==='-'){event.preventDefault();zoom(-.5);}
        else if(event.key==='0'){event.preventDefault();reset();}
        else if(event.altKey && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) {
          event.preventDefault(); const v=viewRef.current;
          changeView({...v,x:v.x+(event.key==='ArrowRight'?70:event.key==='ArrowLeft'?-70:0),y:v.y+(event.key==='ArrowDown'?60:event.key==='ArrowUp'?-60:0)});
        }
      }}>
      <defs>
        <radialGradient id={ocean}><stop offset="0" stopColor="#19343d"/><stop offset="1" stopColor="#0b1d28"/></radialGradient>
        <pattern id={grid} width="55" height="55" patternUnits="userSpaceOnUse"><path d="M55 0 H0 V55" fill="none" stroke="#8aa5ad" strokeOpacity=".065" strokeWidth=".75"/></pattern>
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
        const active = t.id === selected; const targeted = t.id === target; const valid = validTargets.includes(t.id); const source = eligibleSources.includes(t.id);
        const ownerColor = player?.color ?? continent.color;
        const labels = shortNames[t.id] ?? [t.name.toUpperCase()];
        return <g key={t.id} className={`map-territory ${active?'is-selected':''} ${targeted?'is-target':''} ${valid?'is-valid':''} ${source?'eligible-source':''} ${interactive?'is-interactive':''}`} data-territory={t.id} data-selected={active || targeted} data-eligible-source={source} data-valid-target={valid}
          style={{'--territory-color':continent.color,'--owner-color':ownerColor} as CSSProperties} tabIndex={interactive?0:-1} role="button"
          aria-label={`${t.name}${player?`, ${player.name}, ${territory?.armies} armies`:''}${active?', selected origin':''}${targeted?', selected destination':''}${valid?', available target':''}${source?', available origin':''}`}
          aria-pressed={active || targeted} aria-disabled={!interactive} onClick={()=>interactive && onSelect(t.id)}
          onKeyDown={e=>{if(interactive && (e.key==='Enter' || e.key===' ')){e.preventDefault();onSelect(t.id);}}}>
          <title>{t.name}{player?` · ${player.name} · ${territory?.armies} armies`:''}</title>
          {(active || targeted) && <path d={t.path} fill="none" stroke="#f9e2a9" strokeWidth="9" opacity=".45"/>}
          <path className="map-land" d={t.path}/>
          <path className="map-land-edge" d={t.path}/>
          <g transform={`translate(${t.x} ${t.y}) scale(${labelScale})`}>
          <text className="map-territory-name" x="0" y={-(territory?10:2)-(labels.length-1)*4}>
            {labels.map((line,i)=><tspan key={line} x="0" dy={i===0?0:9}>{line}</tspan>)}
          </text>
          {source && <path className="map-source-mark" d="M-23 4 L-17 10 L-23 16 L-29 10 Z" aria-hidden="true"/>}
          {valid && <circle className="map-target-ring" cx="0" cy="10" r="16" aria-hidden="true"/>}
          {territory && <g className="map-army" transform="translate(0 10)">
            <rect x="-12" y="-10" width="24" height="20" rx="6"/>
            <text y="4">{territory.armies}</text>
          </g>}
          </g>
        </g>;
      })}
      <g className="map-route-preview" data-testid="board-route-preview" visibility={routeLegal?'visible':'hidden'} aria-hidden="true"><path className="map-route-line" d={routeLine}/><path className="map-route-arrow" d={routeArrow}/></g>
      <g className="map-compass" transform="translate(105 526)" aria-hidden="true">
        <circle r="31"/><circle r="26"/><path d="M0 -39 L7 -7 L0 0 L-7 -7 Z" className="map-compass-north"/><path d="M0 39 L-7 7 L0 0 L7 7 Z M-39 0 L-7 -7 L0 0 L-7 7 Z M39 0 L7 7 L0 0 L7 -7 Z"/>
        <text x="0" y="-45">N</text><text x="0" y="55">S</text><text x="-48" y="4">W</text><text x="48" y="4">E</text>
      </g>
    </svg>
    <div className="world-map-controls" aria-label="Map view controls">
      <details className="world-map-pan"><summary aria-label="Pan map">↔</summary><div>
        <button type="button" aria-label="Pan west" onClick={()=>changeView({...viewRef.current,x:viewRef.current.x-90})}>←</button>
        <button type="button" aria-label="Pan north" onClick={()=>changeView({...viewRef.current,y:viewRef.current.y-70})}>↑</button>
        <button type="button" aria-label="Pan south" onClick={()=>changeView({...viewRef.current,y:viewRef.current.y+70})}>↓</button>
        <button type="button" aria-label="Pan east" onClick={()=>changeView({...viewRef.current,x:viewRef.current.x+90})}>→</button>
      </div></details>
      <button type="button" aria-label="Zoom out" disabled={view.zoom<=1} onClick={()=>zoom(-.5)}>−</button>
      <button type="button" className="world-map-reset" aria-label="Reset table view" title="Fit the whole world (0)" onClick={reset}>{view.zoom.toFixed(1)}×</button>
      <button type="button" aria-label="Zoom in" disabled={view.zoom>=3} onClick={()=>zoom(.5)}>+</button>
    </div>
  </div>;
}
export { WorldMap };
