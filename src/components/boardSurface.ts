import { CONTINENTS, TERRITORIES, type TerritoryDefinition } from '../../shared/world';
import type { GameState } from '../../shared/types';
import { boardContour } from '../lib/boardContours';

// Original printed artwork, informed by Hasbro's B7404 board. These colors
// describe the physical map and never replace ownership or game rules.
export const PRINTED_COLORS: Record<string, string> = {
  'north-america': '#e3c465', 'south-america': '#cc9454', europe: '#719cb0',
  africa: '#bc7062', asia: '#8eaa6d', australia: '#a48daf',
};
export interface SurfaceLabel { x: number; y: number; lines: string[]; size: number; angle?: number }
const placements: Record<string, Partial<SurfaceLabel>> = {
  alaska: { y: 119, size: 10 },
  'northwest-territory': { y: 106, lines: ['NORTHWEST', 'TERRITORY'], size: 8 },
  greenland: { x: 374, y: 103, size: 8.5 },
  alberta: { y: 151, size: 9 }, ontario: { y: 153, size: 9 }, quebec: { y: 171, size: 8 },
  'western-united-states': { x: 196, y: 213, lines: ['WESTERN', 'UNITED STATES'], size: 7.6 },
  'eastern-united-states': { x: 286, y: 217, lines: ['EASTERN', 'UNITED STATES'], size: 7 },
  'central-america': { x: 257, y: 285, lines: ['CENTRAL', 'AMERICA'], size: 6.8, angle: .58 },
  venezuela: { y: 337, size: 8.5 }, peru: { y: 393, size: 10 }, brazil: { y: 382, size: 11 },
  argentina: { x: 372, y: 478, size: 7.3 }, iceland: { y: 123, size: 7 },
  'great-britain': { x: 507, y: 180, lines: ['GREAT', 'BRITAIN'], size: 6.4 },
  scandinavia: { x: 586, y: 118, size: 7, angle: -.68 },
  'northern-europe': { y: 180, lines: ['NORTHERN', 'EUROPE'], size: 7 },
  'western-europe': { x: 531, y: 240, lines: ['WESTERN', 'EUROPE'], size: 6.8 },
  'southern-europe': { x: 594, y: 233, lines: ['SOUTHERN', 'EUROPE'], size: 6.8 },
  ukraine: { x: 653, y: 160, size: 10 },
  'north-africa': { x: 538, y: 325, lines: ['NORTH', 'AFRICA'], size: 9.6 },
  egypt: { y: 310, size: 9 }, 'east-africa': { x: 653, y: 377, lines: ['EAST', 'AFRICA'], size: 8 },
  congo: { y: 388, size: 9 }, 'south-africa': { x: 614, y: 447, lines: ['SOUTH', 'AFRICA'], size: 8.5 },
  madagascar: { x: 704, y: 461, size: 6.4, angle: -1.13 },
  ural: { x: 725, y: 143, size: 9 }, siberia: { x: 783, y: 111, size: 9 }, yakutsk: { y: 99, size: 9 },
  kamchatka: { x: 969, y: 125, size: 7.5 }, irkutsk: { x: 873, y: 151, size: 8.5 },
  mongolia: { x: 891, y: 207, size: 9 }, japan: { x: 1004, y: 251, size: 7, angle: -.98 },
  afghanistan: { x: 746, y: 233, size: 7.3 }, china: { x: 855, y: 274, size: 11 },
  'middle-east': { x: 698, y: 293, lines: ['MIDDLE', 'EAST'], size: 8.5 },
  india: { x: 800, y: 325, size: 9 }, siam: { x: 880, y: 345, size: 8 },
  indonesia: { x: 875, y: 435, size: 6.2, angle: .18 },
  'new-guinea': { x: 1000, y: 419, lines: ['NEW GUINEA'], size: 6.8, angle: .18 },
  'western-australia': { x: 929, y: 489, lines: ['WESTERN', 'AUSTRALIA'], size: 8 },
  'eastern-australia': { x: 997, y: 488, lines: ['EASTERN', 'AUSTRALIA'], size: 8 },
};
export function surfaceLabel(territory: TerritoryDefinition): SurfaceLabel {
  return { x: territory.x, y: territory.y - 11, lines: [territory.name.toUpperCase()], size: 8.5, ...placements[territory.id] };
}
export function labelCorners(territory: TerritoryDefinition) {
  const label = surfaceLabel(territory), width = Math.max(...label.lines.map(line => line.length)) * label.size * .59;
  const height = label.lines.length * label.size * 1.05, angle = label.angle || 0;
  return [[-width / 2, -height / 2], [width / 2, -height / 2], [width / 2, height / 2], [-width / 2, height / 2]].map(([x, y]) => ({ x: label.x + x * Math.cos(angle) - y * Math.sin(angle), y: label.y + x * Math.sin(angle) + y * Math.cos(angle) }));
}
export function paintNames(context: CanvasRenderingContext2D, scale: number, clear = true, contrast = false) {
  context.setTransform(scale, 0, 0, scale, 0, 0); if (clear) context.clearRect(0, 0, 1100, 640);
  context.fillStyle = contrast ? '#0b0c09' : '#251f18'; context.textAlign = 'center'; context.textBaseline = 'middle';
  for (const territory of TERRITORIES) {
    const label = surfaceLabel(territory);
    context.save(); context.clip(new Path2D(boardContour(territory.id).path)); context.translate(label.x, label.y); context.rotate(label.angle || 0);
    context.font = `700 ${label.size}px Georgia, serif`;
    const lineHeight = label.size * 1.05;
    label.lines.forEach((line, index) => { const y=(index - (label.lines.length - 1) / 2) * lineHeight; if(contrast){context.strokeStyle='#0b0c09';context.lineWidth=.25;context.strokeText(line,0,y);}context.fillText(line, 0, y); });
    context.restore();
  }
}
export function paintOcean(context: CanvasRenderingContext2D, scale: number) {
  context.setTransform(scale, 0, 0, scale, 0, 0); context.clearRect(0, 0, 1100, 640);
  context.fillStyle = '#796342'; context.textAlign = 'center'; context.textBaseline = 'middle';
  context.font = 'italic 11px Georgia, serif';
  context.fillText('PACIFIC OCEAN', 155, 270); context.fillText('ATLANTIC OCEAN', 429, 242); context.fillText('INDIAN OCEAN', 794, 464);
  // This legend is ink on the map, not another application panel.
  context.fillStyle = '#e9d9b0'; context.fillRect(30, 458, 210, 151);
  context.strokeStyle = '#73613d'; context.lineWidth = .7; context.strokeRect(30, 458, 210, 151); context.strokeRect(34, 462, 202, 143);
  context.fillStyle = '#3c3021'; context.font = '700 10px Georgia, serif'; context.fillText('CONTINENT REINFORCEMENTS', 135, 477);
  CONTINENTS.forEach((continent, index) => {
    const y = 497 + index * 17;
    context.fillStyle = PRINTED_COLORS[continent.id]; context.fillRect(45, y - 4, 8, 8);
    context.fillStyle = '#3c3021'; context.font = '9px Georgia, serif'; context.textAlign = 'left'; context.fillText(continent.name, 62, y);
    context.textAlign = 'right'; context.fillText(`+${continent.bonus}`, 220, y);
  });
  // A small engraved ship and compass retain the illustrated physical-map feel.
  context.strokeStyle = '#8a714e'; context.fillStyle = '#8a714e'; context.lineWidth = .7;
  context.beginPath(); context.moveTo(420, 278); context.lineTo(451, 278); context.lineTo(444, 285); context.lineTo(426, 285); context.closePath(); context.stroke();
  context.beginPath(); context.moveTo(435, 253); context.lineTo(435, 278); context.moveTo(437, 256); context.lineTo(448, 271); context.lineTo(437, 271); context.closePath(); context.stroke();
  context.beginPath(); context.moveTo(432, 259); context.lineTo(424, 273); context.lineTo(432, 273); context.closePath(); context.stroke();
}
export function paintCounters(context: CanvasRenderingContext2D, scale: number, game: GameState | null, selected: string | null, target: string | null, sources: string[], targets: string[]) {
  context.setTransform(scale, 0, 0, scale, 0, 0); context.clearRect(0, 0, 1100, 640);
  if (!game) return;
  context.textAlign = 'center'; context.textBaseline = 'middle';
  for (const territory of TERRITORIES) {
    const state = game.territories[territory.id]; if (!state) continue;
    const owner = game.players.find(player => player.id === state.owner), x = territory.x + 13, y = territory.y + 11;
    const active = selected === territory.id || target === territory.id;
    context.fillStyle = active ? '#f8e8bc' : '#eee0bb'; context.strokeStyle = owner?.color || '#423321'; context.lineWidth = 2.5;
    context.beginPath(); context.arc(x, y, 10, 0, Math.PI * 2); context.fill(); context.stroke();
    context.fillStyle = '#201d17'; context.font = `700 ${state.armies > 999 ? 7 : state.armies > 99 ? 8.5 : 10.5}px Georgia, serif`; context.fillText(String(state.armies), x, y + .5);
    if (sources.includes(territory.id)) {
      context.strokeStyle = '#332e24'; context.fillStyle = '#f7edce'; context.lineWidth = 1;
      context.beginPath(); context.moveTo(territory.x - 26, y); context.lineTo(territory.x - 22, y - 4); context.lineTo(territory.x - 18, y); context.lineTo(territory.x - 22, y + 4); context.closePath(); context.fill(); context.stroke();
    }
    if (targets.includes(territory.id)) {
      context.strokeStyle = active ? '#241c13' : '#6a4b22'; context.lineWidth = 1.2; context.setLineDash(active ? [] : [2.5, 2]);
      context.beginPath(); context.arc(x, y, 14, 0, Math.PI * 2); context.stroke(); context.setLineDash([]);
    }
  }
}
