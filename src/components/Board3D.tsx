import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONTINENTS, TERRITORIES } from '../../shared/world';
import type { GameState } from '../../shared/types';
import WorldMap from './WorldMap';
import { PRINTED_COLORS, labelCorners, paintCounters, paintNames, paintOcean } from './boardSurface';
import { createOrbitDrag, isTableDrag, orbitFromDrag, type TableOrbitDrag } from '../lib/tableInput';
import './Board3D.css';

export interface BoardMotion { id: string; type: 'attack' | 'move' | 'deploy' | 'conquest'; from?: string; to: string; count: number; color: string }
interface Props { game: GameState | null; selected: string | null; target: string | null; validTargets: string[]; eligibleSources?: string[]; onSelect: (id: string) => void; interactive?: boolean; quality: 'low' | 'high'; highContrast?: boolean; reducedMotion: boolean; motion: BoardMotion | null; onMotionEnd?: () => void }
interface TableView { zoom: number; x: number; y: number; rotation: number; tilt: number }
interface BoardApi { update: () => void; animate: () => void; view: () => void; fit: () => void; open: () => void; hit: (x: number, y: number) => string | undefined; pan: (dx: number, dy: number) => {x: number; y: number} }
const point = (x: number, y: number, z = 0) => new THREE.Vector3(x - 550, 320 - y, z);
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const defaultView = (width=typeof window!=='undefined'?window.innerWidth:1100,height=typeof window!=='undefined'?window.innerHeight:640): TableView => { const portrait=height>width; return {zoom:portrait?1.1:1,x:0,y:0,rotation:portrait?Math.PI/2:.16,tilt:50}; };
const boundView = (view: TableView): TableView => ({...view, zoom:clamp(view.zoom,.5,3.5), x:clamp(view.x,-580,580), y:clamp(view.y,-320,320), tilt:clamp(view.tilt,28,78)});

export default function Board3D(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const current = useRef(props); current.current = props;
  const api = useRef<BoardApi | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<TableView>(defaultView);
  const viewRef = useRef(view);
  const portraitRef = useRef(typeof window!=='undefined' && window.innerHeight>window.innerWidth);
  const [viewport, setViewport] = useState({width:1100,height:640});
  const [panMode, setPanMode] = useState(false);
  const labelElements = useRef(new Map<string, SVGGElement>());
  const routeElement = useRef<SVGGElement>(null);
  const routeLine = useRef<SVGPathElement>(null);
  const routeArrow = useRef<SVGPathElement>(null);
  const pointers = useRef(new Map<number, {x: number; y: number; startX: number; startY: number}>());
  const orbitDrag = useRef<TableOrbitDrag<TableView> | null>(null);
  const gesture = useRef({dragged:false, suppressUntil:0, distance:0, x:0, y:0, originTerritory:null as string|null});
  const pointerViewport = () => ({width:stage.current?.clientWidth || 1100,height:stage.current?.clientHeight || 640});
  const cancelGesture = () => {
    const ids=[...pointers.current.keys()]; pointers.current.clear(); orbitDrag.current=null;
    gesture.current.dragged=true; gesture.current.originTerritory=null; gesture.current.suppressUntil=performance.now()+350;
    ids.forEach(id=>{if(stage.current?.hasPointerCapture(id))stage.current.releasePointerCapture(id);});
  };
  const changeView = (next: TableView | ((previous: TableView) => TableView)) => {
    const value = boundView(typeof next === 'function' ? next(viewRef.current) : next);
    viewRef.current = value; setView(value); api.current?.view();
  };
  const reset = () => {cancelGesture();changeView({...defaultView(stage.current?.clientWidth,stage.current?.clientHeight),zoom:1});api.current?.fit();};
  useEffect(()=>{const blur=()=>cancelGesture();window.addEventListener('blur',blur);return()=>window.removeEventListener('blur',blur);},[]);

  useEffect(() => {
    if (!host.current || failed) return;
    const container = host.current;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: props.quality === 'high', alpha: false, powerPreference: 'low-power' }); }
    catch { setFailed(true); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, props.quality === 'high' ? 1.5 : 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor('#192327');
    container.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1100 / 640, 10, 10000); camera.up.set(0,0,1);
    scene.add(new THREE.HemisphereLight('#fff5df', '#38382c', 1.6));
    const key = new THREE.DirectionalLight('#fff4df', 2); key.position.set(-500, -250, 1100); scene.add(key);
    const rim = new THREE.DirectionalLight('#cedae0', .6); rim.position.set(550, 400, 500); scene.add(rim);
    const disposable: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];
    const keep = <T extends THREE.BufferGeometry | THREE.Material | THREE.Texture>(item: T): T => { disposable.push(item); return item; };
    const merge = (geometries: THREE.BufferGeometry[]) => { const combined = keep(mergeGeometries(geometries)!); geometries.forEach(g => g.dispose()); return combined; };
    const material = (color: string, metalness = .1, roughness = .7) => keep(new THREE.MeshStandardMaterial({color,metalness,roughness}));
    const brass = material('#24251f',.05,.83), wood = material('#343129',.02,.92), darkWood = material('#171b19',.02,.93);
    const side = material('#63543b',.02,.92), ocean = material('#d1bd8e',.01,.96);
    const halves = [new THREE.Group(),new THREE.Group()]; halves.forEach(group => scene.add(group));
    const halfFor = (x: number) => halves[x < 0 ? 0 : 1];
    const addBox = (parent: THREE.Group | THREE.Scene, width: number, height: number, depth: number, x: number, y: number, z: number, mat: THREE.Material) => {
      const mesh = new THREE.Mesh(keep(new THREE.BoxGeometry(width,height,depth)),mat); mesh.position.set(x,y,z); parent.add(mesh); return mesh;
    };
    // The two real board leaves share a centre hinge. Every territory and piece belongs to its leaf.
    halves.forEach((half,index) => {
      const direction = index === 0 ? -1 : 1, centre = direction * 284;
      addBox(half,566,660,8,centre,0,-5,wood);
      addBox(half,569,663,1.5,centre,0,-9.5,darkWood);
      addBox(half,566,659,1.2,centre,0,-.8,brass);
      addBox(half,552,637,1.2,direction*277,0,-.2,ocean);
      addBox(half,565,3,1.5,centre,326,.2,brass); addBox(half,565,3,1.5,centre,-326,.2,brass);
      addBox(half,3,652,1.5,direction*565,0,.2,brass);
      addBox(half,1.2,637,.3,direction*1.2,0,.55,side);
      // Small reserve trays keep the tabletop equipment close to the map.
      const trayX = direction * 610;
      addBox(half,68,214,7,trayX,-26,-5,wood);
      addBox(half,61,206,1,trayX,-26,-1,darkWood);
      addBox(half,3,212,5,trayX-direction*33,-26,-.5,brass);
      addBox(half,3,212,5,trayX+direction*33,-26,-.5,brass);
      addBox(half,65,3,5,trayX,-131,-.5,brass); addBox(half,65,3,5,trayX,79,-.5,brass);
    });
    const floor = new THREE.Mesh(keep(new THREE.PlaneGeometry(12000,12000)),material('#182327',0,.98)); floor.position.z = -16; scene.add(floor);
    const shadowCanvas = document.createElement('canvas'); shadowCanvas.width = 128; shadowCanvas.height = 64;
    const ctx = shadowCanvas.getContext('2d');
    if (ctx) {
      ctx.scale(1,.5); const gradient = ctx.createRadialGradient(64,64,8,64,64,64); gradient.addColorStop(0,'rgba(0,0,0,.7)'); gradient.addColorStop(.65,'rgba(0,0,0,.42)'); gradient.addColorStop(1,'rgba(0,0,0,0)'); ctx.fillStyle = gradient; ctx.fillRect(0,0,128,128);
      const texture = keep(new THREE.CanvasTexture(shadowCanvas));
      const shadow = new THREE.Mesh(keep(new THREE.PlaneGeometry(1600,1040)),keep(new THREE.MeshBasicMaterial({map:texture,transparent:true,depthWrite:false}))); shadow.position.set(0,10,-15.9); scene.add(shadow);
    }
    const gridPoints: number[][] = [[],[]];
    for (let x = -550; x <= 550; x += 55) gridPoints[x < 0 ? 0 : 1].push(x,-315,.43,x,315,.43);
    for (let y = -310; y <= 310; y += 55) { gridPoints[0].push(-550,y,.43,0,y,.43); gridPoints[1].push(0,y,.43,550,y,.43); }
    gridPoints.forEach((points,i) => halves[i].add(new THREE.LineSegments(keep(new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(points,3))),keep(new THREE.LineBasicMaterial({color:'#856b40',transparent:true,opacity:.1})))));
    const seaRoutes = [[393,122,490,125],[412,370,505,337],[511,265,514,311],[610,259,618,302],[879,381,864,427],[920,433,978,420],[947,449,947,480],[989,434,1002,479],[653,439,697,456],[647,385,703,451],[104,127,35,128],[1065,128,975,128]];
    halves.forEach((half,i) => {
      const routePoints: THREE.Vector3[] = []; seaRoutes.filter(([x]) => (x < 550 ? 0 : 1) === i).forEach(([x1,y1,x2,y2]) => routePoints.push(point(x1,y1,.44),point(x2,y2,.44)));
      const routes = new THREE.LineSegments(keep(new THREE.BufferGeometry().setFromPoints(routePoints)),keep(new THREE.LineDashedMaterial({color:'#6d5431',transparent:true,opacity:.7,dashSize:4,gapSize:5}))); routes.computeLineDistances(); half.add(routes);
    });
    const compassPoints: number[] = []; const compassX = -440, compassY = -40;
    for (let i=0;i<48;i++) { const a=i/48*Math.PI*2,b=(i+1)/48*Math.PI*2; compassPoints.push(compassX+Math.cos(a)*31,compassY+Math.sin(a)*31,.45,compassX+Math.cos(b)*31,compassY+Math.sin(b)*31,.45); }
    for (let i=0;i<4;i++) { const a=i*Math.PI/2,b=a+Math.PI/4,c=a-Math.PI/4; compassPoints.push(compassX+Math.cos(a)*39,compassY+Math.sin(a)*39,.45,compassX+Math.cos(b)*8,compassY+Math.sin(b)*8,.45,compassX+Math.cos(a)*39,compassY+Math.sin(a)*39,.45,compassX+Math.cos(c)*8,compassY+Math.sin(c)*8,.45); }
    halves[0].add(new THREE.LineSegments(keep(new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(compassPoints,3))),keep(new THREE.LineBasicMaterial({color:'#735c37',transparent:true,opacity:.7}))));
    const meshes: THREE.Mesh[] = [], landMaterials: THREE.MeshStandardMaterial[] = [], outlineMaterials: THREE.LineBasicMaterial[] = [];
    const printedLand: THREE.BufferGeometry[][] = [[],[]], counterSurfaces: THREE.BufferGeometry[][] = [[],[]];
    const mapUV = (geometry: THREE.BufferGeometry) => { const positions=geometry.getAttribute('position'),uv=new Float32Array(positions.count*2); for(let i=0;i<positions.count;i++){uv[i*2]=(positions.getX(i)+550)/1100;uv[i*2+1]=(positions.getY(i)+320)/640;} geometry.setAttribute('uv',new THREE.BufferAttribute(uv,2)); return geometry; };
    TERRITORIES.forEach(t => {
      const shapes: THREE.Shape[] = [];
      for (const path of t.path.split(/(?=M)/).filter(Boolean)) {
        const values = path.match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [], shape = new THREE.Shape();
        for (let i=0;i<values.length;i+=2) { const p=point(values[i],values[i+1]); if (i===0) shape.moveTo(p.x,p.y); else shape.lineTo(p.x,p.y); }
        shape.closePath(); shapes.push(shape);
      }
      const geometry = keep(new THREE.ExtrudeGeometry(shapes,{depth:.38,bevelEnabled:true,bevelSegments:1,steps:1,bevelSize:.15,bevelThickness:.15,curveSegments:1}));
      const land = material(PRINTED_COLORS[t.continent],.01,.94), mesh = new THREE.Mesh(geometry,[land,side]); mesh.position.z=.45;
      const half=t.x<550?0:1;
      printedLand[half].push(mapUV(new THREE.ShapeGeometry(shapes)));
      counterSurfaces[half].push(mapUV(new THREE.PlaneGeometry(68,42).translate(t.x-550,320-t.y-10,0))); mesh.userData.territory=t.id;
      halfFor(t.x-550).add(mesh); meshes.push(mesh); landMaterials.push(land);
      const lines: number[]=[]; shapes.forEach(s => { const pts=s.getPoints(); for(let i=1;i<pts.length;i++) lines.push(pts[i-1].x,pts[i-1].y,1.08,pts[i].x,pts[i].y,1.08); });
      const lineMaterial=keep(new THREE.LineBasicMaterial({color:'#54482e',transparent:true,opacity:.88})); outlineMaterials.push(lineMaterial);
      halfFor(t.x-550).add(new THREE.LineSegments(keep(new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(lines,3))),lineMaterial));
    });
    // The names are ink on geometry parallel to the country surfaces. They
    // share the board leaves and camera perspective; no text faces the camera.
    const printScale=Math.min(props.quality==='high'?2:1,renderer.capabilities.maxTextureSize/1100);
    const makeAtlas=() => {const canvas=document.createElement('canvas');canvas.width=Math.floor(1100*printScale);canvas.height=Math.floor(640*printScale);const texture=keep(new THREE.CanvasTexture(canvas));texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=Math.min(4,renderer.capabilities.getMaxAnisotropy());return {canvas,texture,context:canvas.getContext('2d')!};};
    const ink=makeAtlas(),counters=makeAtlas();
    paintOcean(ink.context,printScale);paintNames(ink.context,printScale,false,props.highContrast);ink.texture.needsUpdate=true;
    const inkMaterial=keep(new THREE.MeshStandardMaterial({map:ink.texture,transparent:true,depthWrite:false,roughness:1,metalness:0,polygonOffset:true,polygonOffsetFactor:-1}));
    const countMaterial=keep(new THREE.MeshStandardMaterial({map:counters.texture,transparent:true,depthWrite:false,roughness:.9,metalness:0,polygonOffset:true,polygonOffsetFactor:-2}));
    halves.forEach((half,index)=>{
      const landInk=new THREE.Mesh(merge(printedLand[index]),inkMaterial);landInk.position.z=1.1;half.add(landInk);
      const oceanInk=new THREE.Mesh(keep(mapUV(new THREE.PlaneGeometry(550,640).translate(index===0?-275:275,0,0))),inkMaterial);oceanInk.position.z=.46;half.add(oceanInk);
      const countInk=new THREE.Mesh(merge(counterSurfaces[index]),countMaterial);countInk.position.z=1.35;half.add(countInk);
    });
    let counterSignature='';
    // Low-poly toy infantry: base, a sculpted uniform, face, helmet and rifle. All figures share five geometries.
    const cylinder = (top: number,bottom: number,height: number,x=0,y=0,z=0) => new THREE.CylinderGeometry(top,bottom,height,8).rotateX(Math.PI/2).translate(x,y,z);
    const baseGeo=keep(cylinder(7.5,8.5,3,0,0,1.5));
    const bodyGeo=merge([cylinder(4,5,11,0,0,17),cylinder(1.9,2.1,9,-2.8,0,7),cylinder(1.9,2.1,9,2.8,0,7),cylinder(1.7,1.9,10,-5,-.8,17),cylinder(1.7,1.9,10,5,-.8,17),new THREE.BoxGeometry(11,5,3).translate(0,0,21)]);
    const headGeo=keep(new THREE.SphereGeometry(4.2,8,5).scale(1,.9,1.1).translate(0,0,26));
    const helmetGeo=merge([new THREE.SphereGeometry(5.2,8,4,0,Math.PI*2,0,Math.PI/2).rotateX(Math.PI/2).translate(0,0,28),cylinder(5.7,5.7,.9,0,0,27.8)]);
    const rifleGeo=merge([new THREE.BoxGeometry(2.3,2.8,8).translate(6,-3,14),cylinder(.8,.9,18,6,-3,24)]);
    const unitGeometries=[baseGeo,bodyGeo,headGeo,helmetGeo,rifleGeo];
    const unitMaterials=[material('#ffffff',.5,.32),material('#ffffff',.32,.38),material('#dbb58a',.08,.52),material('#ffffff',.52,.28),material('#302e28',.55,.38)];
    const cannonBarrelGeo=merge([new THREE.CylinderGeometry(2.8,3.5,20,10).rotateX(.2).translate(0,1,12),new THREE.TorusGeometry(3.15,.65,4,10).rotateX(Math.PI/2+.2).translate(0,10.7,14)]);
    const cannonCarriageGeo=merge([new THREE.BoxGeometry(8,14,4).translate(0,-2,6),new THREE.BoxGeometry(4,15,3).translate(0,-10,3)]);
    const cannonWheelGeo=merge([-6,6].map(x => new THREE.CylinderGeometry(5,5,2,10).rotateZ(Math.PI/2).translate(x,-3,5)));
    const cannonGeometries=[cannonBarrelGeo,cannonCarriageGeo,cannonWheelGeo];
    const cannonMaterials=[material('#d1b175',.85,.25),material('#ffffff',.35,.4),material('#282724',.15,.72)];
    const reserveUnits=[{x:-615,y:49},{x:-602,y:20},{x:-617,y:-10},{x:-603,y:-39},{x:602,y:49},{x:615,y:20},{x:601,y:-10},{x:615,y:-39}];
    const reserveCannons=[{x:-610,y:-81},{x:-610,y:-115},{x:610,y:-81},{x:610,y:-115}];
    const instances = (geometries: THREE.BufferGeometry[], materials: THREE.Material[], count: number, parent: THREE.Group) => geometries.map((geometry,i) => { const instance=new THREE.InstancedMesh(geometry,materials[i],count); instance.frustumCulled=false; parent.add(instance); return instance; });
    const unitSets=halves.map(half => instances(unitGeometries,unitMaterials,TERRITORIES.length+reserveUnits.length,half));
    const cannonSets=halves.map(half => instances(cannonGeometries,cannonMaterials,TERRITORIES.length+reserveCannons.length,half));
    const moving=new THREE.Group(); scene.add(moving);
    const movingMaterials=unitMaterials.map(mat => keep(mat.clone()));
    const movingPieces=instances(unitGeometries,movingMaterials,3,moving); moving.visible=false;
    const matrix=new THREE.Matrix4(), color=new THREE.Color();
    const place = (sets: THREE.InstancedMesh[][],counts: number[],x: number,y: number,z: number,ownerColor: THREE.Color) => {
      const half=x<0?0:1,index=counts[half]++;
      matrix.makeTranslation(x,y,z);
      sets[half].forEach((piece,part) => {piece.setMatrixAt(index,matrix);piece.setColorAt(index,part===0?ownerColor.clone().multiplyScalar(.75):ownerColor);});
    };
    let frame=0, disposed=false, hover: string|null=null, animation: {motion:BoardMotion;start:number}|null=null, opening: number|null=null;
    let width=1100,height=640,fitDistance=1400,lastFit='',frames=0;
    const stats={frames:0,drawCalls:0,triangles:0,renderer:'three-webgl',quality:props.quality,zoom:viewRef.current.zoom,rotation:0,tilt:50,fitDistance:0,opening:false,territoryUnits:0,reserveUnits:0,countTokens:0,printedNameCount:TERRITORIES.length,labelPresentation:'board-surface',surfaceLabelSamples:[] as {id:string;corners:{x:number;y:number}[]}[]};
    const statsGetter=() => Object.freeze({...stats});
    Object.defineProperty(window,'__riskBoardStats',{configurable:true,get:statsGetter});
    const projectLabels=() => {
      scene.updateMatrixWorld(); camera.updateMatrixWorld();
      const labelScale=clamp(width/1100,.84,1.2)*Math.pow(viewRef.current.zoom,.3);
      TERRITORIES.forEach(t => {
        const position=point(t.x,t.y,1.5).applyMatrix4(halfFor(t.x-550).matrixWorld).project(camera), element=labelElements.current.get(t.id);
        if(element) { element.setAttribute('transform',`translate(${(position.x+1)*width/2} ${(1-position.y)*height/2}) scale(${labelScale})`); element.setAttribute('visibility',Math.abs(position.x)>1.15 || Math.abs(position.y)>1.15 || position.z>1 ? 'hidden':'visible'); }
      });
      stats.surfaceLabelSamples=['north-africa','china','ukraine'].map(id=>{const territory=TERRITORIES.find(t=>t.id===id)!;return {id,corners:labelCorners(territory).map(corner=>{const p=point(corner.x,corner.y,1.1).applyMatrix4(halfFor(territory.x-550).matrixWorld).project(camera);return {x:(p.x+1)*width/2,y:(1-p.y)*height/2};})};});
      const p = current.current;
      const origin = TERRITORIES.find(t => t.id === p.selected), destination = TERRITORIES.find(t => t.id === p.target);
      const legal = origin && destination && (p.validTargets.includes(destination.id) || (p.game?.phase === 'occupy' && p.game.occupation?.from === origin.id && p.game.occupation.to === destination.id));
      // The Pacific seam is a wrapped sea route. A straight arrow through the whole world would be misleading.
      if (!legal || Math.abs(origin.x - destination.x) > 550) routeElement.current?.setAttribute('visibility','hidden');
      else {
        const from = point(origin.x,origin.y,1.5).applyMatrix4(halfFor(origin.x-550).matrixWorld).project(camera);
        const to = point(destination.x,destination.y,1.5).applyMatrix4(halfFor(destination.x-550).matrixWorld).project(camera);
        const ax=(from.x+1)*width/2, ay=(1-from.y)*height/2, bx=(to.x+1)*width/2, by=(1-to.y)*height/2;
        const distance=Math.hypot(bx-ax,by-ay), ux=(bx-ax)/Math.max(1,distance), uy=(by-ay)/Math.max(1,distance);
        const inset=Math.min(24,distance*.24), endX=bx-ux*inset, endY=by-uy*inset;
        const startX=ax+ux*inset,startY=ay+uy*inset;
        routeElement.current?.setAttribute('visibility',from.z > 1 || to.z > 1 ? 'hidden':'visible');
        routeLine.current?.setAttribute('d',`M${startX} ${startY} L${endX} ${endY}`);
        routeArrow.current?.setAttribute('d',`M${endX} ${endY} L${endX-ux*9-uy*4.5} ${endY-uy*9+ux*4.5} L${endX-ux*9+uy*4.5} ${endY-uy*9-ux*4.5} Z`);
      }
    };
    const render=(now:number) => {
      frame=0; if(disposed) return;
      if(opening!==null) { const progress=Math.min(1,(now-opening)/520), fold=Math.pow(1-progress,3)*.72; halves[0].rotation.y=fold; halves[1].rotation.y=-fold; if(progress>=1) opening=null; }
      if(animation) {
        const progress=Math.min(1,(now-animation.start)/380), to=TERRITORIES.find(t=>t.id===animation!.motion.to)!, from=TERRITORIES.find(t=>t.id===animation!.motion.from)||to;
        const destination=point(to.x-13,to.y+4,1.3);
        const origin=animation.motion.type==='deploy' ? new THREE.Vector3(to.x<550?-610:610,20,-.5) : point(from.x-13,from.y+4,1.3);
        moving.position.lerpVectors(origin,destination,progress);
        moving.position.z+=Math.sin(progress*Math.PI)*24+Math.abs(Math.sin(progress*Math.PI*8))*2;
        moving.scale.setScalar(animation.motion.type==='deploy'?.65+progress*.35:1);
        if(progress>=1) { animation=null; moving.visible=false; current.current.onMotionEnd?.(); }
      }
      projectLabels(); renderer.render(scene,camera); stats.frames=++frames;stats.drawCalls=renderer.info.render.calls;stats.triangles=renderer.info.render.triangles;stats.opening=opening!==null;
      if(animation || opening!==null) frame=requestAnimationFrame(render);
    };
    const invalidate=() => {if(!frame && !disposed) frame=requestAnimationFrame(render);};
    const update=() => {
      const p=current.current,unitCounts=[0,0],cannonCounts=[0,0];
      TERRITORIES.forEach((t,i) => {
        const state=p.game?.territories[t.id],player=p.game?.players.find(player=>player.id===state?.owner);
        color.set(player?.color || CONTINENTS.find(c=>c.id===t.continent)!.color);
        landMaterials[i].color.set(PRINTED_COLORS[t.continent]);
        const active=t.id===p.selected || t.id===p.target;
        landMaterials[i].emissive.copy(color);landMaterials[i].emissiveIntensity=active?.1:t.id===hover?.06:p.validTargets.includes(t.id)?.025:0;
        outlineMaterials[i].color.set(active?'#251e13':p.validTargets.includes(t.id)?'#614421':'#54482e');outlineMaterials[i].opacity=active || p.validTargets.includes(t.id)?1:.88;
        if(state && state.armies>0) {const isCannon=state.armies>=10;
        if(isCannon)place(cannonSets,cannonCounts,t.x-550-13,320-t.y-4,1.3,color);
        else place(unitSets,unitCounts,t.x-550-13,320-t.y-4,1.3,color);}
      });
      const reserveColor=p.game?.players[p.game.currentPlayer]?.color || '#c7a258';color.set(reserveColor);
      if(p.game) {reserveUnits.forEach(p=>place(unitSets,unitCounts,p.x,p.y,-.5,color));
      reserveCannons.forEach(p=>place(cannonSets,cannonCounts,p.x,p.y,-.5,color));}
      stats.territoryUnits=p.game?Object.values(p.game.territories).filter(state=>state.armies>0).length:0;stats.reserveUnits=p.game?reserveUnits.length+reserveCannons.length:0;stats.countTokens=p.game?Object.keys(p.game.territories).length:0;
      const signature=JSON.stringify([p.game?.territories,p.game?.players.map(player=>[player.id,player.color]),p.selected,p.target,p.eligibleSources,p.validTargets]);
      if(signature!==counterSignature){counterSignature=signature;paintCounters(counters.context,printScale,p.game,p.selected,p.target,p.eligibleSources||[],p.validTargets);counters.texture.needsUpdate=true;}
      unitSets.forEach((set,half)=>set.forEach(piece=>piece.count=unitCounts[half]));
      cannonSets.forEach((set,half)=>set.forEach(piece=>piece.count=cannonCounts[half]));
      [...unitSets.flat(),...cannonSets.flat()].forEach(piece=>{piece.instanceMatrix.needsUpdate=true;if(piece.instanceColor)piece.instanceColor.needsUpdate=true;});
      // Skin and rifles keep their own material colour, while the uniforms follow the commander.
      unitSets.forEach(set=>[2,4].forEach(part=>{for(let i=0;i<set[part].count;i++)set[part].setColorAt(i,new THREE.Color('#ffffff'));if(set[part].instanceColor)set[part].instanceColor.needsUpdate=true;}));
      invalidate();
    };
    const animate=() => {
      const p=current.current; animation=null; moving.visible=false;
      if(p.game && p.motion && !p.reducedMotion && TERRITORIES.some(t=>t.id===p.motion!.to)) {
        animation={motion:p.motion,start:performance.now()};
        [0,1,3].forEach(i=>movingMaterials[i].color.set(p.motion!.color));
        movingPieces.forEach(piece=>{for(let i=0;i<3;i++){matrix.compose(new THREE.Vector3(i*15-15,(i%2)*8,0),new THREE.Quaternion(),new THREE.Vector3().setScalar(i<Math.min(3,Math.max(1,p.motion!.count))?1:0));piece.setMatrixAt(i,matrix);}piece.instanceMatrix.needsUpdate=true;});moving.visible=true;
      } else if(p.motion) p.onMotionEnd?.(); invalidate();
    };
    const open=() => { if(current.current.reducedMotion) {opening=null;halves.forEach(half=>half.rotation.y=0);} else opening=performance.now();invalidate(); };
    const resize=() => {
      const nextWidth=container.clientWidth,nextHeight=container.clientHeight;if(!nextWidth || !nextHeight)return;
      const portrait=nextHeight>nextWidth;
      if(portrait!==portraitRef.current) {
        // Keep the player's orbit and zoom relative to the orientation's natural tabletop framing.
        const previousDefault=defaultView(portraitRef.current?640:1100,portraitRef.current?1100:640),nextDefault=defaultView(nextWidth,nextHeight),previous=viewRef.current;
        const reframed=boundView({...previous,rotation:previous.rotation+nextDefault.rotation-previousDefault.rotation,zoom:previous.zoom*nextDefault.zoom/previousDefault.zoom});
        portraitRef.current=portrait;viewRef.current=reframed;setView(reframed);
      }
      if(width!==nextWidth || height!==nextHeight) { cancelGesture();width=nextWidth;height=nextHeight;renderer.setSize(width,height);setViewport({width,height}); }
      else if(!renderer.domElement.width || renderer.domElement.style.width==='') renderer.setSize(width,height);
      const v=viewRef.current,elevation=THREE.MathUtils.degToRad(v.tilt),direction=new THREE.Vector3(Math.sin(v.rotation)*Math.cos(elevation),-Math.cos(v.rotation)*Math.cos(elevation),Math.sin(elevation));
      camera.aspect=width/height;camera.zoom=1;camera.updateProjectionMatrix();
      // Ordinary orbit keeps a fixed radius: dragging never secretly zooms.
      const fitKey=`${width}:${height}`;
      if(fitKey!==lastFit) {
        lastFit=fitKey;let near=400,far=6000;const corner=new THREE.Vector3();
        for(let i=0;i<18;i++) {const distance=(near+far)/2;camera.position.copy(direction).multiplyScalar(distance);camera.lookAt(0,0,0);camera.updateMatrixWorld();let fits=true;
          for(const x of [-650,650])for(const y of [-345,345])for(const z of [-50,54]) {corner.set(x,y,z).project(camera);if(Math.abs(corner.x)>.97 || Math.abs(corner.y)>.89)fits=false;}
          if(fits)far=distance;else near=distance;
        } fitDistance=far;
      }
      camera.zoom=v.zoom;camera.position.copy(direction).multiplyScalar(fitDistance).add(new THREE.Vector3(v.x,v.y,0));camera.lookAt(v.x,v.y,0);camera.updateProjectionMatrix();camera.updateMatrixWorld();
      stats.zoom=v.zoom;stats.rotation=v.rotation;stats.tilt=v.tilt;stats.fitDistance=fitDistance;invalidate();
    };
    const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2();
    const hit=(x:number,y:number) => {const rect=renderer.domElement.getBoundingClientRect();pointer.set((x-rect.left)/rect.width*2-1,-(y-rect.top)/rect.height*2+1);raycaster.setFromCamera(pointer,camera);return raycaster.intersectObjects(meshes,false)[0]?.object.userData.territory as string|undefined;};
    const pan=(dx:number,dy:number) => {
      const plane=new THREE.Plane(new THREE.Vector3(0,0,1),0),before=new THREE.Vector3(),after=new THREE.Vector3();
      raycaster.setFromCamera(new THREE.Vector2(0,0),camera);raycaster.ray.intersectPlane(plane,before);
      raycaster.setFromCamera(new THREE.Vector2(dx/width*2,-dy/height*2),camera);raycaster.ray.intersectPlane(plane,after);
      return {x:before.x-after.x,y:before.y-after.y};
    };
    api.current={update,animate,view:resize,fit:()=>{lastFit='';resize();},open,hit,pan};
    const pointerMove=(e:PointerEvent) => {if(pointers.current.size)return;const id=current.current.interactive===false?null:hit(e.clientX,e.clientY)||null;if(hover!==id){hover=id;renderer.domElement.style.cursor=id?'pointer':'';update();}};
    const pointerLeave=() => {if(hover){hover=null;update();}};
    const lost=(e:Event) => {e.preventDefault();setFailed(true);};
    renderer.domElement.addEventListener('pointermove',pointerMove);renderer.domElement.addEventListener('pointerleave',pointerLeave);renderer.domElement.addEventListener('webglcontextlost',lost);
    const wheel=(e:WheelEvent) => {if((e.target as Element).closest('.board3d-controls'))return;e.preventDefault();const next=boundView({...viewRef.current,zoom:viewRef.current.zoom*Math.exp(-e.deltaY*.0015)});viewRef.current=next;setView(next);resize();};
    const root=stage.current;root?.addEventListener('wheel',wheel,{passive:false});
    const observer=new ResizeObserver(resize);observer.observe(container);resize();update();animate();
    return () => {
      disposed=true;api.current=null;cancelAnimationFrame(frame);observer.disconnect();root?.removeEventListener('wheel',wheel);
      renderer.domElement.removeEventListener('webglcontextlost',lost);renderer.domElement.removeEventListener('pointermove',pointerMove);renderer.domElement.removeEventListener('pointerleave',pointerLeave);
      disposable.forEach(d=>d.dispose());[...unitSets.flat(),...cannonSets.flat(),...movingPieces].forEach(p=>p.dispose());renderer.dispose();renderer.domElement.remove();
      const descriptor=Object.getOwnPropertyDescriptor(window,'__riskBoardStats');if(descriptor?.get===statsGetter)Reflect.deleteProperty(window,'__riskBoardStats');
    };
  },[props.quality,props.highContrast,failed]);
  useEffect(()=>{api.current?.update();},[props.game,props.selected,props.target,props.validTargets,props.eligibleSources]);
  useEffect(()=>{
    // Fallback/context loss has no render loop to complete queued piece motion.
    if(failed) { if(props.motion) props.onMotionEnd?.(); return; }
    api.current?.animate();
  },[props.motion,props.game?.id,props.reducedMotion,props.onMotionEnd,failed]);
  useEffect(()=>{api.current?.open();},[props.game?.id,props.quality,props.reducedMotion,failed]);

  const pointerDown=(event:ReactPointerEvent<HTMLDivElement>) => {
    if((event.target as Element).closest('.board3d-controls') || event.button===1)return;
    event.currentTarget.setPointerCapture(event.pointerId);
    if(pointers.current.size===0){gesture.current.dragged=false;gesture.current.suppressUntil=0;gesture.current.originTerritory=api.current?.hit(event.clientX,event.clientY)||(event.target as Element).closest('[data-territory]')?.getAttribute('data-territory')||null;orbitDrag.current=createOrbitDrag(viewRef.current,{x:event.clientX,y:event.clientY},pointerViewport());}
    pointers.current.set(event.pointerId,{x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY});
    const points=[...pointers.current.values()];
    if(points.length===2){orbitDrag.current=null;gesture.current.dragged=true;gesture.current.distance=Math.hypot(points[0].x-points[1].x,points[0].y-points[1].y);gesture.current.x=(points[0].x+points[1].x)/2;gesture.current.y=(points[0].y+points[1].y)/2;}
  };
  const pointerMove=(event:ReactPointerEvent<HTMLDivElement>) => {
    const previous=pointers.current.get(event.pointerId);if(!previous)return;
    const dx=event.clientX-previous.x,dy=event.clientY-previous.y;
    if(isTableDrag({x:previous.startX,y:previous.startY},{x:event.clientX,y:event.clientY},event.pointerType))gesture.current.dragged=true;
    pointers.current.set(event.pointerId,{...previous,x:event.clientX,y:event.clientY});
    const points=[...pointers.current.values()];
    if(points.length>=2) {
      orbitDrag.current=null;
      const distance=Math.hypot(points[0].x-points[1].x,points[0].y-points[1].y),x=(points[0].x+points[1].x)/2,y=(points[0].y+points[1].y)/2;
      const delta=api.current?.pan(x-gesture.current.x,y-gesture.current.y)||{x:0,y:0};
      changeView(v=>({...v,zoom:v.zoom*(distance/Math.max(1,gesture.current.distance)),x:v.x+delta.x,y:v.y+delta.y}));
      gesture.current.distance=distance;gesture.current.x=x;gesture.current.y=y;
    } else if(gesture.current.dragged) {
      if(panMode || event.shiftKey || (event.buttons&2)!==0){orbitDrag.current=null;const delta=api.current?.pan(dx,dy)||{x:0,y:0};changeView(v=>({...v,x:v.x+delta.x,y:v.y+delta.y}));}
      else {if(!orbitDrag.current)orbitDrag.current=createOrbitDrag(viewRef.current,{x:previous.x,y:previous.y},pointerViewport());const next=orbitFromDrag(orbitDrag.current,{x:event.clientX,y:event.clientY});changeView(v=>({...v,rotation:next.rotation,tilt:next.tilt}));}
    }
  };
  const pointerUp=(event:ReactPointerEvent<HTMLDivElement>) => {
    if(!pointers.current.has(event.pointerId))return;
    pointers.current.delete(event.pointerId);
    if(event.type==='pointercancel')gesture.current.dragged=true;
    if(gesture.current.dragged)gesture.current.suppressUntil=performance.now()+350;
    // A remaining touch becomes a fresh drag anchor after a pinch.
    pointers.current.forEach((p,id)=>pointers.current.set(id,{...p,startX:p.x,startY:p.y}));
    const remaining=[...pointers.current.values()];orbitDrag.current=remaining.length===1?createOrbitDrag(viewRef.current,remaining[0],pointerViewport()):null;
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
  };

  if(failed)return <div className="board3d-fallback"><WorldMap {...props}/><span className="board3d-fallback-note">2D map · WebGL unavailable</span></div>;
  return <div className={`board3d ${panMode?'is-panning':''} ${viewport.width<600 && view.zoom<1.5?'is-overview':''}`} ref={stage} tabIndex={0} aria-label="Three dimensional world tabletop. Drag to rotate and tilt. Pinch or scroll to zoom. Shift-drag to pan."
    onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onLostPointerCapture={event=>{if(pointers.current.has(event.pointerId))cancelGesture();}} onContextMenu={event=>event.preventDefault()}
    onClick={event=>{if((event.target as Element).closest('.board3d-controls') || current.current.interactive===false || performance.now()<gesture.current.suppressUntil)return;const id=gesture.current.originTerritory || api.current?.hit(event.clientX,event.clientY) || (event.target as Element).closest('[data-territory]')?.getAttribute('data-territory');gesture.current.originTerritory=null;if(id)current.current.onSelect(id);}}
    onKeyDown={event=>{if(event.target!==event.currentTarget)return;const step=event.shiftKey?80:0;if(event.key==='+' || event.key==='='){event.preventDefault();changeView(v=>({...v,zoom:v.zoom+.5}));}else if(event.key==='-'){event.preventDefault();changeView(v=>({...v,zoom:v.zoom-.5}));}else if(event.key==='0'){event.preventDefault();reset();}else if(event.key.startsWith('Arrow')){event.preventDefault();changeView(v=>event.key==='ArrowLeft'?{...v,rotation:v.rotation-(step?0:.15),x:v.x-step}:event.key==='ArrowRight'?{...v,rotation:v.rotation+(step?0:.15),x:v.x+step}:event.key==='ArrowUp'?{...v,tilt:v.tilt+(step?0:5),y:v.y+step}:{...v,tilt:v.tilt-(step?0:5),y:v.y-step});}}}>
    <div className="board3d-canvas" ref={host} aria-hidden="true"/>
    <svg className="board3d-labels" viewBox={`0 0 ${viewport.width} ${viewport.height}`} preserveAspectRatio="none" aria-label="Territory selection; names and counts are printed on the board" role="group">
      <g ref={routeElement} className="board3d-route-preview" visibility="hidden" aria-hidden="true" data-testid="board-route-preview"><path ref={routeLine} className="board3d-route-line"/><path ref={routeArrow} className="board3d-route-arrow"/></g>
      {TERRITORIES.map(t=>{
        const state=props.game?.territories[t.id],owner=props.game?.players.find(p=>p.id===state?.owner),active=props.selected===t.id || props.target===t.id,valid=props.validTargets.includes(t.id),source=Boolean(props.eligibleSources?.includes(t.id));
        return <g key={t.id} ref={element=>{if(element)labelElements.current.set(t.id,element);else labelElements.current.delete(t.id);}} className={`board3d-territory-label ${active?'active':''} ${valid?'valid':''} ${source?'eligible-source':''} ${props.target===t.id?'is-destination':''}`} data-territory={t.id} data-selected={active} data-eligible-source={source} data-valid-target={valid} role="button" tabIndex={props.interactive===false?-1:0} aria-disabled={props.interactive===false} aria-pressed={active} aria-label={`${t.name}${owner?`, ${owner.name}, ${state!.armies} armies`:''}${props.selected===t.id?', selected origin':''}${props.target===t.id?', selected destination':''}${valid?', available target':''}${source?', available origin':''}`}
          onKeyDown={event=>{if(props.interactive!==false && (event.key==='Enter' || event.key===' ')){event.preventDefault();event.stopPropagation();props.onSelect(t.id);}}}>
          <rect className="board3d-hit" x="-29" y="-20" width="58" height="43" rx="5"/>
        </g>;
      })}
    </svg>
    <div className="board3d-controls" aria-label="Table view controls">
      <div className="board3d-zoom">
        <button type="button" aria-label="Zoom out" disabled={view.zoom<=.5} onClick={()=>changeView(v=>({...v,zoom:v.zoom-.5}))}>−</button>
        <button type="button" className="board3d-reset" aria-label="Reset table view" title="Fit the whole board" onClick={reset}>{view.zoom.toFixed(1)}×</button>
        <button type="button" aria-label="Zoom in" disabled={view.zoom>=3.5} onClick={()=>changeView(v=>({...v,zoom:v.zoom+.5}))}>+</button>
      </div>
      <details className="board3d-view-options"><summary aria-label="Table view options">View <span aria-hidden="true">⌄</span></summary><div className="board3d-view-panel">
        <span className="board3d-view-tip">Drag to rotate & tilt<br/>Pinch or scroll to zoom</span>
        <div className="board3d-mode"><button type="button" aria-label="Rotate board" aria-pressed={!panMode} onClick={()=>setPanMode(false)}>Rotate</button><button type="button" aria-label="Pan map" aria-pressed={panMode} onClick={()=>setPanMode(true)}>Pan</button></div>
        <div className="board3d-option-row"><span>Rotate</span><button type="button" aria-label="Rotate left" onClick={()=>changeView(v=>({...v,rotation:v.rotation-.2}))}>↶</button><button type="button" aria-label="Rotate right" onClick={()=>changeView(v=>({...v,rotation:v.rotation+.2}))}>↷</button></div>
        <div className="board3d-option-row"><span>Tilt</span><button type="button" aria-label="Lower viewing angle" onClick={()=>changeView(v=>({...v,tilt:v.tilt-8}))}>↘</button><button type="button" aria-label="Raise viewing angle" onClick={()=>changeView(v=>({...v,tilt:v.tilt+8}))}>↗</button></div>
        <div className="board3d-pan" aria-label="Pan map directions"><button type="button" aria-label="Pan west" onClick={()=>changeView(v=>({...v,x:v.x-80}))}>←</button><button type="button" aria-label="Pan north" onClick={()=>changeView(v=>({...v,y:v.y+65}))}>↑</button><button type="button" aria-label="Pan south" onClick={()=>changeView(v=>({...v,y:v.y-65}))}>↓</button><button type="button" aria-label="Pan east" onClick={()=>changeView(v=>({...v,x:v.x+80}))}>→</button></div>
        <button type="button" className="board3d-open" aria-label="Open board" onClick={()=>api.current?.open()}>Replay opening</button>
        <span className="board3d-view-tip">Shift-drag to pan · arrows to orbit</span>
      </div></details>
    </div>
  </div>;
}
export { Board3D };
