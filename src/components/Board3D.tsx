import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { CONTINENTS, TERRITORIES } from '../../shared/world';
import type { GameState } from '../../shared/types';
import WorldMap from './WorldMap';
import './Board3D.css';

export interface BoardMotion { id: string; type: 'attack' | 'move' | 'deploy' | 'conquest'; from?: string; to: string; count: number; color: string }
interface Props { game: GameState | null; selected: string | null; target: string | null; validTargets: string[]; onSelect: (id: string) => void; interactive?: boolean; quality: 'low' | 'high'; reducedMotion: boolean; motion: BoardMotion | null; onMotionEnd?: () => void }
interface BoardApi { update: () => void; animate: () => void; view: () => void }
const point = (x: number, y: number, z = 0) => new THREE.Vector3(x - 550, 320 - y, z);
const oceanLabels = [{id:'pacific',name:'PACIFIC OCEAN',x:145,y:390}, {id:'atlantic',name:'ATLANTIC',x:430,y:249}, {id:'indian',name:'INDIAN OCEAN',x:800,y:470}];
const names: Record<string, string> = { 'northwest-territory':'Northwest Terr.', 'western-united-states':'Western U.S.', 'eastern-united-states':'Eastern U.S.', 'western-australia':'W. Australia', 'eastern-australia':'E. Australia', 'northern-europe':'N. Europe', 'southern-europe':'S. Europe', 'western-europe':'W. Europe' };

export default function Board3D(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const current = useRef(props); current.current = props;
  const api = useRef<BoardApi | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState({zoom:1,x:0,y:0});
  const viewRef = useRef(view); viewRef.current = view;
  const [positions, setPositions] = useState<Record<string, {x: number; y: number}>>({});

  useEffect(() => {
    if (!host.current || failed) return;
    const container = host.current;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: props.quality === 'high', alpha: false, powerPreference: 'low-power' }); }
    catch { setFailed(true); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, props.quality === 'high' ? 1.5 : 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor('#07131d');
    container.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(37, 1100 / 640, 1, 4000);
    camera.position.set(0, -350, 1080); camera.lookAt(0, 0, 0);
    scene.add(new THREE.HemisphereLight('#d7edff', '#473623', 2.1));
    const key = new THREE.DirectionalLight('#fff0d0', 3.5); key.position.set(-400, 300, 850); scene.add(key);
    const rim = new THREE.DirectionalLight('#7da8c0', 1.2); rim.position.set(500, -300, 400); scene.add(rim);
    const disposable: (THREE.BufferGeometry | THREE.Material)[] = [];
    const keep = <T extends THREE.BufferGeometry | THREE.Material>(item: T): T => { disposable.push(item); return item; };
    const brass = keep(new THREE.MeshStandardMaterial({ color: '#9a8050', metalness: .75, roughness: .32 }));
    const side = keep(new THREE.MeshStandardMaterial({ color: '#716345', metalness: .45, roughness: .54 }));
    const ocean = keep(new THREE.MeshStandardMaterial({ color: '#092530', metalness: .08, roughness: .93 }));
    const plinth = new THREE.Mesh(keep(new THREE.BoxGeometry(1120, 650, 17)), brass); plinth.position.z = -14; scene.add(plinth);
    const surface = new THREE.Mesh(keep(new THREE.BoxGeometry(1107, 637, 12)), ocean); surface.position.z = -4; scene.add(surface);
    const gridPoints: number[] = [];
    for (let x = -550; x <= 550; x += 55) gridPoints.push(x, -315, 2.1, x, 315, 2.1);
    for (let y = -310; y <= 310; y += 55) gridPoints.push(-550, y, 2.1, 550, y, 2.1);
    const grid = new THREE.LineSegments(keep(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(gridPoints, 3))), keep(new THREE.LineBasicMaterial({ color: '#6a99a8', transparent: true, opacity: .13 }))); scene.add(grid);
    const seaRoutes = [[393,122,490,125],[412,370,505,337],[511,265,514,311],[610,259,618,302],[879,381,864,427],[920,433,978,420],[947,449,947,480],[989,434,1002,479],[653,439,697,456],[647,385,703,451],[104,127,35,128],[1065,128,975,128]];
    const routePoints: THREE.Vector3[] = []; seaRoutes.forEach(([x1,y1,x2,y2]) => routePoints.push(point(x1,y1,3),point(x2,y2,3)));
    const routes = new THREE.LineSegments(keep(new THREE.BufferGeometry().setFromPoints(routePoints)), keep(new THREE.LineDashedMaterial({color:'#b5b59c',transparent:true,opacity:.38,dashSize:4,gapSize:5}))); routes.computeLineDistances(); scene.add(routes);
    const compassPoints: number[] = [];
    const compassX = -445, compassY = -220;
    for (let i = 0; i < 64; i++) { const a = i / 64 * Math.PI * 2, b = (i + 1) / 64 * Math.PI * 2; compassPoints.push(compassX + Math.cos(a) * 31, compassY + Math.sin(a) * 31, 2.4, compassX + Math.cos(b) * 31, compassY + Math.sin(b) * 31, 2.4); }
    for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2, b = a + Math.PI / 4, c = a - Math.PI / 4; compassPoints.push(compassX + Math.cos(a)*39, compassY + Math.sin(a)*39, 2.4, compassX + Math.cos(b)*8, compassY + Math.sin(b)*8, 2.4, compassX + Math.cos(a)*39, compassY + Math.sin(a)*39, 2.4, compassX + Math.cos(c)*8, compassY + Math.sin(c)*8, 2.4); }
    scene.add(new THREE.LineSegments(keep(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(compassPoints, 3))), keep(new THREE.LineBasicMaterial({color:'#b8a174', transparent:true, opacity:.6}))));
    const meshes: THREE.Mesh[] = [];
    const landMaterials: THREE.MeshStandardMaterial[] = [];
    const outlineMaterials: THREE.LineBasicMaterial[] = [];
    TERRITORIES.forEach(t => {
      const shapes: THREE.Shape[] = [];
      for (const path of t.path.split(/(?=M)/).filter(Boolean)) {
        const values = path.match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
        const shape = new THREE.Shape();
        for (let i = 0; i < values.length; i += 2) { const p = point(values[i], values[i + 1]); if (i === 0) shape.moveTo(p.x, p.y); else shape.lineTo(p.x, p.y); }
        shape.closePath(); shapes.push(shape);
      }
      const geometry = keep(new THREE.ExtrudeGeometry(shapes, { depth: 6, bevelEnabled: true, bevelSegments: 1, steps: 1, bevelSize: .85, bevelThickness: 1.1, curveSegments: 1 }));
      const material = keep(new THREE.MeshStandardMaterial({ color: '#708783', roughness: .66, metalness: .16 }));
      const mesh = new THREE.Mesh(geometry, [material, side]); mesh.position.z = 5; mesh.userData.territory = t.id; scene.add(mesh); meshes.push(mesh); landMaterials.push(material);
      const lines: number[] = [];
      shapes.forEach(s => { const pts = s.getPoints(); for (let i = 1; i < pts.length; i++) lines.push(pts[i-1].x, pts[i-1].y, 12.2, pts[i].x, pts[i].y, 12.2); });
      const lineMaterial = keep(new THREE.LineBasicMaterial({ color: '#c6b68d', transparent: true, opacity: .64 })); outlineMaterials.push(lineMaterial);
      scene.add(new THREE.LineSegments(keep(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(lines, 3))), lineMaterial));
    });
    // Three shared instanced meshes make all 42 polished army pieces only three draw calls.
    const pawnMaterial = keep(new THREE.MeshStandardMaterial({ color: '#ffffff', metalness: .48, roughness: .27 }));
    const baseGeo = keep(new THREE.CylinderGeometry(6, 7, 3, 10)); baseGeo.rotateX(Math.PI / 2);
    const bodyGeo = keep(new THREE.CylinderGeometry(2.8, 5, 10, 8)); bodyGeo.rotateX(Math.PI / 2);
    const headGeo = keep(new THREE.SphereGeometry(3.5, 8, 6));
    const bases = new THREE.InstancedMesh(baseGeo, pawnMaterial, TERRITORIES.length);
    const bodies = new THREE.InstancedMesh(bodyGeo, pawnMaterial, TERRITORIES.length);
    const heads = new THREE.InstancedMesh(headGeo, pawnMaterial, TERRITORIES.length);
    const pieces = [bases, bodies, heads]; pieces.forEach(p => { p.frustumCulled = false; scene.add(p); });
    const matrix = new THREE.Matrix4();
    TERRITORIES.forEach((t, i) => pieces.forEach((p, j) => { matrix.makeTranslation(t.x - 550 - 12, 320 - t.y - 4, [15, 21, 28][j]); p.setMatrixAt(i, matrix); }));
    const moving = new THREE.Group(); scene.add(moving);
    const movingMaterial = keep(pawnMaterial.clone());
    for (let i = 0; i < 3; i++) [baseGeo, bodyGeo, headGeo].forEach((g, j) => { const p = new THREE.Mesh(g, movingMaterial); p.position.set(i * 13 - 13, (i % 2) * 7, [2, 8, 15][j]); moving.add(p); });
    moving.visible = false;
    let frame = 0, disposed = false, hover: string | null = null, animation: {motion: BoardMotion; start: number} | null = null;
    let frames = 0;
    const stats = { frames: 0, drawCalls: 0, triangles: 0, renderer: 'three-webgl', quality: props.quality };
    Object.defineProperty(window, '__riskBoardStats', { configurable: true, get: () => Object.freeze({...stats}) });
    const render = (now: number) => {
      frame = 0; if (disposed) return;
      if (animation) {
        const progress = Math.min(1, (now - animation.start) / 380);
        const to = TERRITORIES.find(t => t.id === animation!.motion.to)!;
        const from = TERRITORIES.find(t => t.id === animation!.motion.from) || to;
        moving.position.copy(point(from.x + (to.x - from.x) * progress - 12, from.y + (to.y - from.y) * progress + 4, 14 + Math.sin(progress * Math.PI) * 22 + Math.abs(Math.sin(progress * Math.PI * 8)) * 2));
        moving.scale.setScalar(animation.motion.type === 'deploy' ? .65 + progress * .35 : 1);
        if (progress >= 1) { animation = null; moving.visible = false; current.current.onMotionEnd?.(); }
      }
      renderer.render(scene, camera); stats.frames = ++frames; stats.drawCalls = renderer.info.render.calls; stats.triangles = renderer.info.render.triangles;
      if (animation) frame = requestAnimationFrame(render);
    };
    const invalidate = () => { if (!frame && !disposed) frame = requestAnimationFrame(render); };
    const update = () => {
      const p = current.current;
      TERRITORIES.forEach((t, i) => {
        const state = p.game?.territories[t.id];
        const player = p.game?.players.find(player => player.id === state?.owner);
        const color = new THREE.Color(player?.color || CONTINENTS.find(c => c.id === t.continent)!.color);
        landMaterials[i].color.copy(color).multiplyScalar(.65);
        const active = t.id === p.selected || t.id === p.target;
        landMaterials[i].emissive.copy(color); landMaterials[i].emissiveIntensity = active ? .42 : t.id === hover ? .24 : p.validTargets.includes(t.id) ? .12 : 0;
        outlineMaterials[i].color.set(active ? '#fff0b8' : p.validTargets.includes(t.id) ? '#d3eac6' : '#b9aa82'); outlineMaterials[i].opacity = active ? 1 : .64;
        pieces.forEach(piece => piece.setColorAt(i, color));
      });
      pieces.forEach(p => { if(p.instanceColor) p.instanceColor.needsUpdate = true; }); invalidate();
    };
    const animate = () => {
      const p = current.current;
      animation = null; moving.visible = false;
      if (p.motion && !p.reducedMotion && TERRITORIES.some(t => t.id === p.motion!.to)) { animation = {motion:p.motion, start:performance.now()}; movingMaterial.color.set(p.motion.color); moving.children.forEach((piece, index) => { piece.visible = Math.floor(index / 3) < Math.min(3, Math.max(1, p.motion!.count)); }); moving.visible = true; }
      else if (p.motion) p.onMotionEnd?.();
      invalidate();
    };
    const resize = () => {
      const width = container.clientWidth, height = container.clientHeight; if (!width || !height) return;
      renderer.setSize(width, height); camera.aspect = width / height;
      const v = viewRef.current; camera.zoom = v.zoom;
      camera.position.set(v.x, -350 + v.y, 1080); camera.updateProjectionMatrix(); camera.lookAt(v.x, v.y, 0); camera.updateMatrixWorld();
      const coords: Record<string, {x: number; y: number}> = {};
      TERRITORIES.forEach(t => { const p = point(t.x, t.y, 18).project(camera); coords[t.id] = {x:(p.x + 1) * 550, y:(1-p.y) * 320}; });
      oceanLabels.forEach(t => { const p = point(t.x, t.y, 3).project(camera); coords[t.id] = {x:(p.x + 1) * 550, y:(1-p.y)*320}; });
      setPositions(coords); invalidate();
    };
    api.current = { update, animate, view: resize };
    const raycaster = new THREE.Raycaster(); const pointer = new THREE.Vector2();
    const hit = (e: PointerEvent) => { const rect = renderer.domElement.getBoundingClientRect(); pointer.set((e.clientX-rect.left)/rect.width*2-1, -(e.clientY-rect.top)/rect.height*2+1); raycaster.setFromCamera(pointer, camera); return raycaster.intersectObjects(meshes, false)[0]?.object.userData.territory as string | undefined; };
    const pointerMove = (e: PointerEvent) => { const id = current.current.interactive === false ? null : hit(e) || null; if (hover !== id) { hover = id; renderer.domElement.style.cursor = id ? 'pointer' : ''; update(); } };
    const pointerLeave = () => { if (hover) { hover = null; update(); } };
    const click = (e: PointerEvent) => { if (current.current.interactive !== false) { const id = hit(e); if (id) current.current.onSelect(id); } };
    const lost = (e: Event) => { e.preventDefault(); setFailed(true); };
    renderer.domElement.addEventListener('pointermove', pointerMove); renderer.domElement.addEventListener('pointerleave', pointerLeave); renderer.domElement.addEventListener('click', click); renderer.domElement.addEventListener('webglcontextlost', lost);
    const observer = new ResizeObserver(resize); observer.observe(container); resize(); update(); animate();
    return () => { disposed = true; api.current = null; cancelAnimationFrame(frame); observer.disconnect(); renderer.domElement.removeEventListener('webglcontextlost', lost); renderer.domElement.removeEventListener('pointermove', pointerMove); renderer.domElement.removeEventListener('pointerleave', pointerLeave); renderer.domElement.removeEventListener('click', click); disposable.forEach(d => d.dispose()); pieces.forEach(p => p.dispose()); renderer.dispose(); renderer.domElement.remove(); };
  }, [props.quality, failed]);
  useEffect(() => { api.current?.view(); }, [view]);
  useEffect(() => { api.current?.update(); }, [props.game, props.selected, props.target, props.validTargets]);
  useEffect(() => { api.current?.animate(); }, [props.motion, props.reducedMotion]);

  if (failed) return <div className="board3d-fallback"><WorldMap {...props}/><span className="board3d-fallback-note">2D map · WebGL unavailable</span></div>;
  return <div className="board3d" aria-label="Three dimensional world tabletop">
    <div className="board3d-canvas" ref={host} aria-hidden="true"/>
    <svg className="board3d-labels" viewBox="0 0 1100 640" aria-label="Territories and armies" role="group">
      {oceanLabels.map(t => positions[t.id] && <text key={t.id} className="board3d-ocean-name" x={positions[t.id].x} y={positions[t.id].y} aria-hidden="true">{t.name}</text>)}
      {TERRITORIES.map(t => {
        const pos = positions[t.id]; if (!pos) return null;
        const state = props.game?.territories[t.id]; const owner = props.game?.players.find(p => p.id === state?.owner);
        const active = props.selected === t.id || props.target === t.id; const valid = props.validTargets.includes(t.id);
        return <g key={t.id} transform={`translate(${pos.x} ${pos.y}) scale(${view.zoom})`} className={`board3d-territory-label ${active?'active':''} ${valid?'valid':''}`} role="button" tabIndex={props.interactive === false ? -1 : 0} aria-disabled={props.interactive === false} aria-pressed={active} aria-label={`${t.name}${owner?`, ${owner.name}, ${state!.armies} armies`:''}${valid?', available target':''}`} onClick={() => props.interactive !== false && props.onSelect(t.id)} onKeyDown={e => { if (props.interactive !== false && (e.key === 'Enter' || e.key === ' ')) {e.preventDefault(); props.onSelect(t.id);} }}>
          <title>{t.name}{owner ? ` · ${owner.name} · ${state!.armies} armies` : ''}</title>
          <rect className="board3d-hit" x="-29" y="-20" width="58" height="40" rx="5"/>
          <text className="board3d-name" y="-13">{names[t.id] || t.name}</text>
          <rect className="board3d-count-bg" x="1" y="-5" width="23" height="18" rx="5" style={{stroke: owner?.color || '#b9aa82'}}/>
          <text className="board3d-count" x="12.5" y="8">{state?.armies ?? '·'}</text>
          {valid && <circle cx="29" cy="4" r="2.5" fill="#e3e8a6"/>}
        </g>;
      })}
    </svg>
    <div className="board3d-controls" aria-label="Table view controls">
      {view.zoom > 1 && <div className="board3d-pan" aria-label="Pan map">
        <button type="button" aria-label="Pan west" onClick={() => setView(v => ({...v,x:Math.max(-350,v.x-80)}))}>←</button>
        <button type="button" aria-label="Pan north" onClick={() => setView(v => ({...v,y:Math.min(230,v.y+65)}))}>↑</button>
        <button type="button" aria-label="Pan south" onClick={() => setView(v => ({...v,y:Math.max(-230,v.y-65)}))}>↓</button>
        <button type="button" aria-label="Pan east" onClick={() => setView(v => ({...v,x:Math.min(350,v.x+80)}))}>→</button>
      </div>}
      <button type="button" aria-label="Zoom out" disabled={view.zoom <= 1} onClick={() => setView(v => ({zoom:Math.max(1,v.zoom-.5),x:v.zoom<=1.5?0:v.x,y:v.zoom<=1.5?0:v.y}))}>−</button>
      <button type="button" className="board3d-reset" aria-label="Reset table view" onClick={() => setView({zoom:1,x:0,y:0})}>{view.zoom.toFixed(1)}×</button>
      <button type="button" aria-label="Zoom in" disabled={view.zoom >= 2.5} onClick={() => setView(v => ({...v,zoom:Math.min(2.5,v.zoom+.5)}))}>+</button>
    </div>
    <span className="board3d-caption">WORLD THEATRE <i/> STRATEGIC TABLE</span>
  </div>;
}
export { Board3D };
