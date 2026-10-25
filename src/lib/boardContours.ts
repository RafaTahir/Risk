import { TERRITORIES } from '../../shared/world';

export interface BoardPoint { readonly x: number; readonly y: number }
export interface BoardContour {
  readonly id: string;
  /** The same flattened geometry used for print clipping, SVG and mesh hits. */
  readonly path: string;
  readonly rings: readonly (readonly BoardPoint[])[];
}

interface SourceEdge {
  readonly a: BoardPoint;
  readonly b: BoardPoint;
  readonly owners: Set<string>;
}
interface SourceVertex {
  readonly point: BoardPoint;
  readonly neighbors: Set<string>;
}
interface RoundedCorner {
  readonly from: string;
  readonly to: string;
  readonly points: readonly BoardPoint[];
}

const key = (point: BoardPoint) => `${point.x},${point.y}`;
const edgeKey = (a: string, b: string) => a < b ? `${a}|${b}` : `${b}|${a}`;
const quantized = (x: number, y: number): BoardPoint => Object.freeze({ x: Math.round(x * 100_000) / 100_000, y: Math.round(y * 100_000) / 100_000 });
const sourceRings = new Map<string, BoardPoint[][]>();
const vertices = new Map<string, SourceVertex>();
const edges = new Map<string, SourceEdge>();

for (const territory of TERRITORIES) {
  const rings = territory.path.split(/(?=M)/).filter(Boolean).map(path => {
    const values = path.match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
    return Array.from({ length: values.length / 2 }, (_, index) => quantized(values[index * 2], values[index * 2 + 1]));
  });
  sourceRings.set(territory.id, rings);
  for (const ring of rings) for (let index = 0; index < ring.length; index++) {
    const a = ring[index], b = ring[(index + 1) % ring.length], ak = key(a), bk = key(b), ek = edgeKey(ak, bk);
    const edge = edges.get(ek) || { a, b, owners: new Set<string>() };
    edge.owners.add(territory.id); edges.set(ek, edge);
    for (const [point, neighbor] of [[a, bk], [b, ak]] as const) {
      const pointKey = key(point), vertex = vertices.get(pointKey) || { point, neighbors: new Set<string>() };
      vertex.neighbors.add(neighbor); vertices.set(pointKey, vertex);
    }
  }
}

function distanceToSegment(point: BoardPoint, a: BoardPoint, b: BoardPoint): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
}

const corners = new Map<string, RoundedCorner>();
for (const [pointKey, vertex] of vertices) {
  // Preserve every multi-country junction, including sea/coast junctions.
  // Only a continuous boundary with the same owners on both sides may bend.
  if (vertex.neighbors.size !== 2) continue;
  const [from, to] = [...vertex.neighbors].sort();
  const before = edges.get(edgeKey(pointKey, from))!, after = edges.get(edgeKey(pointKey, to))!;
  if ([...before.owners].sort().join('|') !== [...after.owners].sort().join('|')) continue;
  const p = vertex.point, a = vertices.get(from)!.point, b = vertices.get(to)!.point;
  const firstLength = Math.hypot(a.x - p.x, a.y - p.y), secondLength = Math.hypot(b.x - p.x, b.y - p.y);
  let clearance = Infinity;
  for (const edge of edges.values()) {
    if (key(edge.a) === pointKey || key(edge.b) === pointKey) continue;
    clearance = Math.min(clearance, distanceToSegment(p, edge.a, edge.b));
  }
  // Every arc stays inside this vertex's disjoint safety neighborhood. That
  // prevents smoothing either bank of a narrow sea channel into its neighbor.
  const reach = Math.min(7, firstLength * .28, secondLength * .28, clearance * .28);
  if (reach < .04) continue;
  const entry = { x: p.x + (a.x - p.x) / firstLength * reach, y: p.y + (a.y - p.y) / firstLength * reach };
  const exit = { x: p.x + (b.x - p.x) / secondLength * reach, y: p.y + (b.y - p.y) / secondLength * reach };
  const points = Array.from({ length: 7 }, (_, index) => {
    const t = index / 6, u = 1 - t;
    return quantized(u * u * entry.x + 2 * u * t * p.x + t * t * exit.x, u * u * entry.y + 2 * u * t * p.y + t * t * exit.y);
  });
  corners.set(pointKey, { from, to, points: Object.freeze(points) });
}

const contours: Record<string, BoardContour> = {};
for (const territory of TERRITORIES) {
  const rings = sourceRings.get(territory.id)!.map(ring => {
    const output: BoardPoint[] = [];
    ring.forEach((point, index) => {
      const corner = corners.get(key(point));
      if (!corner) { output.push(point); return; }
      const previous = key(ring[(index + ring.length - 1) % ring.length]), next = key(ring[(index + 1) % ring.length]);
      if (previous === corner.from && next === corner.to) output.push(...corner.points);
      else if (previous === corner.to && next === corner.from) output.push(...[...corner.points].reverse());
      else output.push(point);
    });
    return Object.freeze(output);
  });
  const path = rings.map(ring => ring.map((point, index) => `${index ? 'L' : 'M'}${point.x} ${point.y}`).join(' ') + ' Z').join(' ');
  contours[territory.id] = Object.freeze({ id: territory.id, path, rings: Object.freeze(rings) });
}

export const BOARD_CONTOURS: Readonly<Record<string, BoardContour>> = Object.freeze(contours);
export const BOARD_CONTOUR_STATS = Object.freeze({ sourceVertices: vertices.size, sourceEdges: edges.size, roundedCorners: corners.size, fixedJunctions: [...vertices.values()].filter(vertex => vertex.neighbors.size !== 2).length });

export function boardContour(id: string): BoardContour {
  const contour = BOARD_CONTOURS[id];
  if (!contour) throw new Error(`Unknown board territory: ${id}`);
  return contour;
}
