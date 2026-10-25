import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONTINENTS, TERRITORIES } from '../../shared/world';
import type { GameState } from '../../shared/types';
import WorldMap from './WorldMap';
import './Board3D.css';

export interface BoardMotion { id: string; type: 'attack' | 'move' | 'deploy' | 'conquest'; from?: string; to: string; count: number; color: string }
interface Props { game: GameState | null; selected: string | null; target: string | null; validTargets: string[]; onSelect: (id: string) => void; interactive?: boolean; quality: 'low' | 'high'; reducedMotion: boolean; motion: BoardMotion | null; onMotionEnd?: () => void }
interface TableView { zoom: number; x: number; y: number; rotation: number; tilt: number }
interface BoardApi { update: () => void; animate: () => void; view: () => void; open: () => void; hit: (x: number, y: number) => string | undefined; pan: (dx: number, dy: number) => {x: number; y: number} }
const point = (x: number, y: number, z = 0) => new THREE.Vector3(x - 550, 320 - y, z);
const oceanLabels = [{id:'pacific',name:'PACIFIC OCEAN',x:145,y:390}, {id:'atlantic',name:'ATLANTIC',x:430,y:249}, {id:'indian',name:'INDIAN OCEAN',x:800,y:470}];
const names: Record<string, string> = { 'northwest-territory':'Northwest Terr.', 'western-united-states':'Western U.S.', 'eastern-united-states':'Eastern U.S.', 'western-australia':'W. Australia', 'eastern-australia':'E. Australia', 'northern-europe':'N. Europe', 'southern-europe':'S. Europe', 'western-europe':'W. Europe' };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const defaultView = (width=typeof window!=='undefined'?window.innerWidth:1100,height=typeof window!=='undefined'?window.innerHeight:640): TableView => { const portrait=height>width; return {zoom:portrait?1.1:1,x:0,y:0,rotation:portrait?Math.PI/2:.16,tilt:50}; };
const boundView = (view: TableView): TableView => ({...view, zoom:clamp(view.zoom,1,3.5), x:clamp(view.x,-580,580), y:clamp(view.y,-320,320), tilt:clamp(view.tilt,28,78)});

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
  const oceanElements = useRef(new Map<string, SVGTextElement>());
  const pointers = useRef(new Map<number, {x: number; y: number; startX: number; startY: number}>());
  const gesture = useRef({dragged:false, suppressUntil:0, distance:0, x:0, y:0, originTerritory:null as string|null});
  const changeView = (next: TableView | ((previous: TableView) => TableView)) => {
    const value = boundView(typeof next === 'function' ? next(viewRef.current) : next);
    viewRef.current = value; setView(value); api.current?.view();
  };
  const reset = () => changeView({...defaultView(stage.current?.clientWidth,stage.current?.clientHeight),zoom:1});

  useEffect(() => {
    if (!host.current || failed) return;
    const container = host.current;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: props.quality === 'high', alpha: false, powerPreference: 'low-power' }); }
    catch { setFailed(true); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, props.quality === 'high' ? 1.5 : 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor('#09141c');
    container.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1100 / 640, 10, 10000); camera.up.set(0,0,1);
    scene.add(new THREE.HemisphereLight('#dcecf5', '#3a2819', 2.3));
    const key = new THREE.DirectionalLight('#fff0d4', 3.6); key.position.set(-500, -250, 1100); scene.add(key);
    const rim = new THREE.DirectionalLight('#8db5cb', 1.5); rim.position.set(550, 400, 500); scene.add(rim);
    const disposable: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];
    const keep = <T extends THREE.BufferGeometry | THREE.Material | THREE.Texture>(item: T): T => { disposable.push(item); return item; };
    const merge = (geometries: THREE.BufferGeometry[]) => { const combined = keep(mergeGeometries(geometries)!); geometries.forEach(g => g.dispose()); return combined; };
    const material = (color: string, metalness = .1, roughness = .7) => keep(new THREE.MeshStandardMaterial({color,metalness,roughness}));
    const brass = material('#b09152',.78,.3), wood = material('#493021',.06,.65), darkWood = material('#211d19',.05,.82);
    const side = material('#695537',.38,.54), ocean = material('#102f3a',.12,.76);
    const halves = [new THREE.Group(),new THREE.Group()]; halves.forEach(group => scene.add(group));
    const halfFor = (x: number) => halves[x < 0 ? 0 : 1];
    const addBox = (parent: THREE.Group | THREE.Scene, width: number, height: number, depth: number, x: number, y: number, z: number, mat: THREE.Material) => {
      const mesh = new THREE.Mesh(keep(new THREE.BoxGeometry(width,height,depth)),mat); mesh.position.set(x,y,z); parent.add(mesh); return mesh;
    };
    // The two real board leaves share a centre hinge. Every territory and piece belongs to its leaf.
    halves.forEach((half,index) => {
      const direction = index === 0 ? -1 : 1, centre = direction * 284;
      addBox(half,566,660,34,centre,0,-27,wood);
      addBox(half,569,663,4,centre,0,-46,darkWood);
      addBox(half,566,659,4,centre,0,-8,brass);
      addBox(half,552,637,10,direction*277,0,-3,ocean);
      addBox(half,565,3,3,centre,326,-4,brass); addBox(half,565,3,3,centre,-326,-4,brass);
      addBox(half,3,652,3,direction*565,0,-4,brass);
      addBox(half,1.7,637,1,direction*1.7,0,2,side);
      // Small reserve trays keep the tabletop equipment close to the map.
      const trayX = direction * 610;
      addBox(half,68,214,13,trayX,-26,-24,wood);
      addBox(half,61,206,2,trayX,-26,-16,darkWood);
      addBox(half,3,212,5,trayX-direction*33,-26,-14,brass);
      addBox(half,3,212,5,trayX+direction*33,-26,-14,brass);
      addBox(half,65,3,5,trayX,-131,-14,brass); addBox(half,65,3,5,trayX,79,-14,brass);
    });
    const floor = new THREE.Mesh(keep(new THREE.PlaneGeometry(12000,12000)),material('#101c23',0,.98)); floor.position.z = -60; scene.add(floor);
    const shadowCanvas = document.createElement('canvas'); shadowCanvas.width = 128; shadowCanvas.height = 64;
    const ctx = shadowCanvas.getContext('2d');
    if (ctx) {
      ctx.scale(1,.5); const gradient = ctx.createRadialGradient(64,64,8,64,64,64); gradient.addColorStop(0,'rgba(0,0,0,.7)'); gradient.addColorStop(.65,'rgba(0,0,0,.42)'); gradient.addColorStop(1,'rgba(0,0,0,0)'); ctx.fillStyle = gradient; ctx.fillRect(0,0,128,128);
      const texture = keep(new THREE.CanvasTexture(shadowCanvas));
      const shadow = new THREE.Mesh(keep(new THREE.PlaneGeometry(1600,1040)),keep(new THREE.MeshBasicMaterial({map:texture,transparent:true,depthWrite:false}))); shadow.position.set(0,10,-59); scene.add(shadow);
    }
    const gridPoints: number[][] = [[],[]];
    for (let x = -550; x <= 550; x += 55) gridPoints[x < 0 ? 0 : 1].push(x,-315,2.1,x,315,2.1);
    for (let y = -310; y <= 310; y += 55) { gridPoints[0].push(-550,y,2.1,0,y,2.1); gridPoints[1].push(0,y,2.1,550,y,2.1); }
    gridPoints.forEach((points,i) => halves[i].add(new THREE.LineSegments(keep(new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(points,3))),keep(new THREE.LineBasicMaterial({color:'#6a99a8',transparent:true,opacity:.13})))));
    const seaRoutes = [[393,122,490,125],[412,370,505,337],[511,265,514,311],[610,259,618,302],[879,381,864,427],[920,433,978,420],[947,449,947,480],[989,434,1002,479],[653,439,697,456],[647,385,703,451],[104,127,35,128],[1065,128,975,128]];
    halves.forEach((half,i) => {
      const routePoints: THREE.Vector3[] = []; seaRoutes.filter(([x]) => (x < 550 ? 0 : 1) === i).forEach(([x1,y1,x2,y2]) => routePoints.push(point(x1,y1,3),point(x2,y2,3)));
      const routes = new THREE.LineSegments(keep(new THREE.BufferGeometry().setFromPoints(routePoints)),keep(new THREE.LineDashedMaterial({color:'#b5b59c',transparent:true,opacity:.4,dashSize:4,gapSize:5}))); routes.computeLineDistances(); half.add(routes);
    });
    const compassPoints: number[] = []; const compassX = -445, compassY = -220;
    for (let i=0;i<48;i++) { const a=i/48*Math.PI*2,b=(i+1)/48*Math.PI*2; compassPoints.push(compassX+Math.cos(a)*31,compassY+Math.sin(a)*31,2.4,compassX+Math.cos(b)*31,compassY+Math.sin(b)*31,2.4); }
    for (let i=0;i<4;i++) { const a=i*Math.PI/2,b=a+Math.PI/4,c=a-Math.PI/4; compassPoints.push(compassX+Math.cos(a)*39,compassY+Math.sin(a)*39,2.4,compassX+Math.cos(b)*8,compassY+Math.sin(b)*8,2.4,compassX+Math.cos(a)*39,compassY+Math.sin(a)*39,2.4,compassX+Math.cos(c)*8,compassY+Math.sin(c)*8,2.4); }
    halves[0].add(new THREE.LineSegments(keep(new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(compassPoints,3))),keep(new THREE.LineBasicMaterial({color:'#b8a174',transparent:true,opacity:.6}))));
    const meshes: THREE.Mesh[] = [], landMaterials: THREE.MeshStandardMaterial[] = [], outlineMaterials: THREE.LineBasicMaterial[] = [];
    TERRITORIES.forEach(t => {
      const shapes: THREE.Shape[] = [];
      for (const path of t.path.split(/(?=M)/).filter(Boolean)) {
        const values = path.match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [], shape = new THREE.Shape();
        for (let i=0;i<values.length;i+=2) { const p=point(values[i],values[i+1]); if (i===0) shape.moveTo(p.x,p.y); else shape.lineTo(p.x,p.y); }
        shape.closePath(); shapes.push(shape);
      }
      const geometry = keep(new THREE.ExtrudeGeometry(shapes,{depth:7,bevelEnabled:true,bevelSegments:1,steps:1,bevelSize:.85,bevelThickness:1.1,curveSegments:1}));
      const land = material('#708783',.2,.62), mesh = new THREE.Mesh(geometry,[land,side]); mesh.position.z=5; mesh.userData.territory=t.id;
      halfFor(t.x-550).add(mesh); meshes.push(mesh); landMaterials.push(land);
      const lines: number[]=[]; shapes.forEach(s => { const pts=s.getPoints(); for(let i=1;i<pts.length;i++) lines.push(pts[i-1].x,pts[i-1].y,13.2,pts[i].x,pts[i].y,13.2); });
      const lineMaterial=keep(new THREE.LineBasicMaterial({color:'#c6b68d',transparent:true,opacity:.64})); outlineMaterials.push(lineMaterial);
      halfFor(t.x-550).add(new THREE.LineSegments(keep(new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(lines,3))),lineMaterial));
    });
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
    const stats={frames:0,drawCalls:0,triangles:0,renderer:'three-webgl',quality:props.quality,zoom:viewRef.current.zoom,rotation:0,tilt:50,opening:false};
    const statsGetter=() => Object.freeze({...stats});
    Object.defineProperty(window,'__riskBoardStats',{configurable:true,get:statsGetter});
    const projectLabels=() => {
      scene.updateMatrixWorld(); camera.updateMatrixWorld();
      const labelScale=clamp(width/1100,.84,1.2)*Math.pow(viewRef.current.zoom,.3);
      TERRITORIES.forEach(t => {
        const position=point(t.x,t.y,41).applyMatrix4(halfFor(t.x-550).matrixWorld).project(camera), element=labelElements.current.get(t.id);
        if(element) { element.setAttribute('transform',`translate(${(position.x+1)*width/2} ${(1-position.y)*height/2}) scale(${labelScale})`); element.setAttribute('visibility',Math.abs(position.x)>1.15 || Math.abs(position.y)>1.15 || position.z>1 ? 'hidden':'visible'); }
      });
      oceanLabels.forEach(t => { const position=point(t.x,t.y,3).applyMatrix4(halfFor(t.x-550).matrixWorld).project(camera),element=oceanElements.current.get(t.id); if(element) {element.setAttribute('x',String((position.x+1)*width/2));element.setAttribute('y',String((1-position.y)*height/2));} });
    };
    const render=(now:number) => {
      frame=0; if(disposed) return;
      if(opening!==null) { const progress=Math.min(1,(now-opening)/520), fold=Math.pow(1-progress,3)*.72; halves[0].rotation.y=fold; halves[1].rotation.y=-fold; if(progress>=1) opening=null; }
      if(animation) {
        const progress=Math.min(1,(now-animation.start)/380), to=TERRITORIES.find(t=>t.id===animation!.motion.to)!, from=TERRITORIES.find(t=>t.id===animation!.motion.from)||to;
        const destination=point(to.x-13,to.y+4,14);
        const origin=animation.motion.type==='deploy' ? new THREE.Vector3(to.x<550?-610:610,20,-14) : point(from.x-13,from.y+4,14);
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
        landMaterials[i].color.set(CONTINENTS.find(c=>c.id===t.continent)!.color).multiplyScalar(.67);
        const active=t.id===p.selected || t.id===p.target;
        landMaterials[i].emissive.copy(color);landMaterials[i].emissiveIntensity=active?.36:t.id===hover?.22:p.validTargets.includes(t.id)?.1:0;
        outlineMaterials[i].color.set(active?'#fff0b8':p.validTargets.includes(t.id)?'#d3eac6':'#b9aa82');outlineMaterials[i].opacity=active?1:.64;
        const isCannon=state ? state.armies>=10 : i%9===0;
        if(isCannon)place(cannonSets,cannonCounts,t.x-550-13,320-t.y-4,14,color);
        else place(unitSets,unitCounts,t.x-550-13,320-t.y-4,14,color);
      });
      const reserveColor=p.game?.players[p.game.currentPlayer]?.color || '#c7a258';color.set(reserveColor);
      reserveUnits.forEach(p=>place(unitSets,unitCounts,p.x,p.y,-14,color));
      reserveCannons.forEach(p=>place(cannonSets,cannonCounts,p.x,p.y,-14,color));
      unitSets.forEach((set,half)=>set.forEach(piece=>piece.count=unitCounts[half]));
      cannonSets.forEach((set,half)=>set.forEach(piece=>piece.count=cannonCounts[half]));
      [...unitSets.flat(),...cannonSets.flat()].forEach(piece=>{piece.instanceMatrix.needsUpdate=true;if(piece.instanceColor)piece.instanceColor.needsUpdate=true;});
      // Skin and rifles keep their own material colour, while the uniforms follow the commander.
      unitSets.forEach(set=>[2,4].forEach(part=>{for(let i=0;i<set[part].count;i++)set[part].setColorAt(i,new THREE.Color('#ffffff'));if(set[part].instanceColor)set[part].instanceColor.needsUpdate=true;}));
      invalidate();
    };
    const animate=() => {
      const p=current.current; animation=null; moving.visible=false;
      if(p.motion && !p.reducedMotion && TERRITORIES.some(t=>t.id===p.motion!.to)) {
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
        pointers.current.clear();gesture.current.dragged=false;
      }
      if(width!==nextWidth || height!==nextHeight) { width=nextWidth;height=nextHeight;renderer.setSize(width,height);setViewport({width,height}); }
      else if(!renderer.domElement.width || renderer.domElement.style.width==='') renderer.setSize(width,height);
      const v=viewRef.current,elevation=THREE.MathUtils.degToRad(v.tilt),direction=new THREE.Vector3(Math.sin(v.rotation)*Math.cos(elevation),-Math.cos(v.rotation)*Math.cos(elevation),Math.sin(elevation));
      camera.aspect=width/height;camera.zoom=1;camera.updateProjectionMatrix();
      const fitKey=`${width}:${height}:${v.rotation}:${v.tilt}`;
      if(fitKey!==lastFit) {
        lastFit=fitKey;let near=400,far=6000;const corner=new THREE.Vector3();
        for(let i=0;i<18;i++) {const distance=(near+far)/2;camera.position.copy(direction).multiplyScalar(distance);camera.lookAt(0,0,0);camera.updateMatrixWorld();let fits=true;
          for(const x of [-650,650])for(const y of [-345,345])for(const z of [-50,54]) {corner.set(x,y,z).project(camera);if(Math.abs(corner.x)>.97 || Math.abs(corner.y)>.89)fits=false;}
          if(fits)far=distance;else near=distance;
        } fitDistance=far;
      }
      camera.zoom=v.zoom;camera.position.copy(direction).multiplyScalar(fitDistance).add(new THREE.Vector3(v.x,v.y,0));camera.lookAt(v.x,v.y,0);camera.updateProjectionMatrix();camera.updateMatrixWorld();
      stats.zoom=v.zoom;stats.rotation=v.rotation;stats.tilt=v.tilt;invalidate();
    };
    const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2();
    const hit=(x:number,y:number) => {const rect=renderer.domElement.getBoundingClientRect();pointer.set((x-rect.left)/rect.width*2-1,-(y-rect.top)/rect.height*2+1);raycaster.setFromCamera(pointer,camera);return raycaster.intersectObjects(meshes,false)[0]?.object.userData.territory as string|undefined;};
    const pan=(dx:number,dy:number) => {
      const plane=new THREE.Plane(new THREE.Vector3(0,0,1),0),before=new THREE.Vector3(),after=new THREE.Vector3();
      raycaster.setFromCamera(new THREE.Vector2(0,0),camera);raycaster.ray.intersectPlane(plane,before);
      raycaster.setFromCamera(new THREE.Vector2(dx/width*2,-dy/height*2),camera);raycaster.ray.intersectPlane(plane,after);
      return {x:before.x-after.x,y:before.y-after.y};
    };
    api.current={update,animate,view:resize,open,hit,pan};
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
  },[props.quality,failed]);
  useEffect(()=>{api.current?.update();},[props.game,props.selected,props.target,props.validTargets]);
  useEffect(()=>{api.current?.animate();},[props.motion,props.reducedMotion]);
  useEffect(()=>{api.current?.open();},[props.game?.id,props.quality,props.reducedMotion,failed]);

  const pointerDown=(event:ReactPointerEvent<HTMLDivElement>) => {
    if((event.target as Element).closest('.board3d-controls') || event.button===1)return;
    event.currentTarget.setPointerCapture(event.pointerId);
    if(pointers.current.size===0){gesture.current.dragged=false;gesture.current.suppressUntil=0;gesture.current.originTerritory=(event.target as Element).closest('[data-territory]')?.getAttribute('data-territory')||null;}
    pointers.current.set(event.pointerId,{x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY});
    const points=[...pointers.current.values()];
    if(points.length===2){gesture.current.dragged=true;gesture.current.distance=Math.hypot(points[0].x-points[1].x,points[0].y-points[1].y);gesture.current.x=(points[0].x+points[1].x)/2;gesture.current.y=(points[0].y+points[1].y)/2;}
  };
  const pointerMove=(event:ReactPointerEvent<HTMLDivElement>) => {
    const previous=pointers.current.get(event.pointerId);if(!previous)return;
    const dx=event.clientX-previous.x,dy=event.clientY-previous.y;
    if(Math.hypot(event.clientX-previous.startX,event.clientY-previous.startY)>(event.pointerType==='touch'?8:5))gesture.current.dragged=true;
    pointers.current.set(event.pointerId,{...previous,x:event.clientX,y:event.clientY});
    const points=[...pointers.current.values()];
    if(points.length>=2) {
      const distance=Math.hypot(points[0].x-points[1].x,points[0].y-points[1].y),x=(points[0].x+points[1].x)/2,y=(points[0].y+points[1].y)/2;
      const delta=api.current?.pan(x-gesture.current.x,y-gesture.current.y)||{x:0,y:0};
      changeView(v=>({...v,zoom:v.zoom*(distance/Math.max(1,gesture.current.distance)),x:v.x+delta.x,y:v.y+delta.y}));
      gesture.current.distance=distance;gesture.current.x=x;gesture.current.y=y;
    } else if(gesture.current.dragged) {
      if(panMode || event.shiftKey || (event.buttons&2)!==0){const delta=api.current?.pan(dx,dy)||{x:0,y:0};changeView(v=>({...v,x:v.x+delta.x,y:v.y+delta.y}));}
      else changeView(v=>({...v,rotation:v.rotation+dx*.006,tilt:v.tilt+dy*.15}));
    }
  };
  const pointerUp=(event:ReactPointerEvent<HTMLDivElement>) => {
    if(!pointers.current.has(event.pointerId))return;
    pointers.current.delete(event.pointerId);
    if(gesture.current.dragged)gesture.current.suppressUntil=performance.now()+350;
    // A remaining touch becomes a fresh drag anchor after a pinch.
    pointers.current.forEach((p,id)=>pointers.current.set(id,{...p,startX:p.x,startY:p.y}));
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
  };

  if(failed)return <div className="board3d-fallback"><WorldMap {...props}/><span className="board3d-fallback-note">2D map · WebGL unavailable</span></div>;
  return <div className={`board3d ${panMode?'is-panning':''} ${viewport.width<600 && view.zoom<1.5?'is-overview':''}`} ref={stage} tabIndex={0} aria-label="Three dimensional world tabletop. Drag to rotate and tilt. Pinch or scroll to zoom. Shift-drag to pan."
    onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onContextMenu={event=>event.preventDefault()}
    onClick={event=>{if((event.target as Element).closest('.board3d-controls') || current.current.interactive===false || performance.now()<gesture.current.suppressUntil)return;const id=gesture.current.originTerritory || (event.target as Element).closest('[data-territory]')?.getAttribute('data-territory') || api.current?.hit(event.clientX,event.clientY);gesture.current.originTerritory=null;if(id)current.current.onSelect(id);}}
    onKeyDown={event=>{if(event.target!==event.currentTarget)return;const step=event.shiftKey?80:0;if(event.key==='+' || event.key==='='){event.preventDefault();changeView(v=>({...v,zoom:v.zoom+.5}));}else if(event.key==='-'){event.preventDefault();changeView(v=>({...v,zoom:v.zoom-.5}));}else if(event.key==='0'){event.preventDefault();reset();}else if(event.key.startsWith('Arrow')){event.preventDefault();changeView(v=>event.key==='ArrowLeft'?{...v,rotation:v.rotation-(step?0:.15),x:v.x-step}:event.key==='ArrowRight'?{...v,rotation:v.rotation+(step?0:.15),x:v.x+step}:event.key==='ArrowUp'?{...v,tilt:v.tilt+(step?0:5),y:v.y+step}:{...v,tilt:v.tilt-(step?0:5),y:v.y-step});}}}>
    <div className="board3d-canvas" ref={host} aria-hidden="true"/>
    <svg className="board3d-labels" viewBox={`0 0 ${viewport.width} ${viewport.height}`} preserveAspectRatio="none" aria-label="Territories and armies" role="group">
      {oceanLabels.map(t=><text key={t.id} ref={element=>{if(element)oceanElements.current.set(t.id,element);else oceanElements.current.delete(t.id);}} className="board3d-ocean-name" aria-hidden="true">{t.name}</text>)}
      {TERRITORIES.map(t=>{
        const state=props.game?.territories[t.id],owner=props.game?.players.find(p=>p.id===state?.owner),active=props.selected===t.id || props.target===t.id,valid=props.validTargets.includes(t.id);
        return <g key={t.id} ref={element=>{if(element)labelElements.current.set(t.id,element);else labelElements.current.delete(t.id);}} className={`board3d-territory-label ${active?'active':''} ${valid?'valid':''}`} data-territory={t.id} data-selected={active} role="button" tabIndex={props.interactive===false?-1:0} aria-disabled={props.interactive===false} aria-pressed={active} aria-label={`${t.name}${owner?`, ${owner.name}, ${state!.armies} armies`:''}${valid?', available target':''}`}
          onKeyDown={event=>{if(props.interactive!==false && (event.key==='Enter' || event.key===' ')){event.preventDefault();event.stopPropagation();props.onSelect(t.id);}}}>
          <title>{t.name}{owner?` · ${owner.name} · ${state!.armies} armies`:''}</title>
          <rect className="board3d-hit" x="-29" y="-20" width="58" height="43" rx="5"/>
          <text className="board3d-name" y="-15">{names[t.id]||t.name}</text>
          {state && <><rect className="board3d-count-bg" x="3" y="1" width="23" height="18" rx="5" style={{stroke:owner?.color||'#b9aa82'}}/>
          <text className="board3d-count" x="14.5" y="14">{state.armies}</text></>}
          {valid && <circle cx="31" cy="10" r="2.5" fill="#e3e8a6"/>}
        </g>;
      })}
    </svg>
    <div className="board3d-controls" aria-label="Table view controls">
      <div className="board3d-zoom">
        <button type="button" aria-label="Zoom out" disabled={view.zoom<=1} onClick={()=>changeView(v=>({...v,zoom:v.zoom-.5}))}>−</button>
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
