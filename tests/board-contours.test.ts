import { describe, expect, it } from 'vitest';
import { TERRITORIES } from '../shared/world';
import { BOARD_CONTOURS, BOARD_CONTOUR_STATS, boardContour, type BoardPoint } from '../src/lib/boardContours';

const key = (point: BoardPoint) => `${point.x},${point.y}`;
const pairKey = (a: string, b: string) => a < b ? `${a}|${b}` : `${b}|${a}`;
const original = Object.fromEntries(TERRITORIES.map(territory => [territory.id, territory.path.split(/(?=M)/).filter(Boolean).map(path => {
  const values = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  return Array.from({ length: values.length / 2 }, (_, index) => ({ x: values[index * 2], y: values[index * 2 + 1] }));
})]));
const area = (ring: readonly BoardPoint[]) => ring.reduce((sum, point, index) => {
  const next = ring[(index + 1) % ring.length]; return sum + point.x * next.y - next.x * point.y;
}, 0) / 2;
const segments = (rings: readonly (readonly BoardPoint[])[]) => rings.flatMap(ring => ring.map((a, index) => ({ a, b: ring[(index + 1) % ring.length] })));
const cross = (a: BoardPoint, b: BoardPoint, c: BoardPoint) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const intersects = (a: BoardPoint, b: BoardPoint, c: BoardPoint, d: BoardPoint) => cross(a, b, c) * cross(a, b, d) < -1e-9 && cross(c, d, a) * cross(c, d, b) < -1e-9;
function distance(point: BoardPoint, a: BoardPoint, b: BoardPoint) {
  const dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - a.x - dx * t, point.y - a.y - dy * t);
}
function contains(point: BoardPoint, ring: readonly BoardPoint[]) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const a = ring[index], b = ring[previous];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function graph(contours: Record<string, readonly (readonly BoardPoint[])[]>) {
  const edges = new Map<string, { a: BoardPoint; b: BoardPoint; owners: Set<string>; directions: string[] }>();
  const neighbors = new Map<string, Set<string>>();
  for (const [id, rings] of Object.entries(contours)) for (const { a, b } of segments(rings)) {
    const ak = key(a), bk = key(b), edgeKey = pairKey(ak, bk), edge = edges.get(edgeKey) || { a, b, owners: new Set<string>(), directions: [] };
    edge.owners.add(id); edge.directions.push(`${ak}>${bk}`); edges.set(edgeKey, edge);
    for (const [point, neighbor] of [[ak, bk], [bk, ak]]) {
      const set = neighbors.get(point) || new Set<string>(); set.add(neighbor); neighbors.set(point, set);
    }
  }
  return { edges, neighbors };
}
const smooth = Object.fromEntries(TERRITORIES.map(territory => [territory.id, boardContour(territory.id).rings]));

describe('coherent physical-board contours', () => {
  it('preserves all identities, components, winding, useful positions and adjacency data without mutating source paths', () => {
    const before = structuredClone(TERRITORIES);
    expect(Object.keys(BOARD_CONTOURS)).toEqual(TERRITORIES.map(territory => territory.id));
    for (const territory of TERRITORIES) {
      const result = boardContour(territory.id);
      expect(result.rings).toHaveLength(original[territory.id].length);
      expect(result.rings.map(area).map(Math.sign)).toEqual(original[territory.id].map(area).map(Math.sign));
      const center = { x: territory.x, y: territory.y };
      expect(result.rings.some(ring => contains(center, ring)), territory.id).toBe(original[territory.id].some(ring => contains(center, ring)));
      const oldArea = original[territory.id].reduce((sum, ring) => sum + Math.abs(area(ring)), 0);
      const newArea = result.rings.reduce((sum, ring) => sum + Math.abs(area(ring)), 0);
      expect(Math.abs(newArea - oldArea) / oldArea, territory.id).toBeLessThan(.015);
      // The serialized path is exactly the same quantized geometry, so print
      // clipping or an SVG hit region cannot drift from the mesh silhouette.
      const values = result.path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      expect(values).toEqual(result.rings.flatMap(ring => ring.flatMap(point => [point.x, point.y])));
    }
    expect(TERRITORIES).toEqual(before);
    expect(() => boardContour('not-a-country')).toThrow('Unknown board territory');
  });

  it('reuses every internal boundary exactly in reverse, preserving border-owner pairs and fixed junctions', () => {
    const rawGraph = graph(original), newGraph = graph(smooth);
    const ownerPairs = (edges: typeof rawGraph.edges) => [...new Set([...edges.values()].filter(edge => edge.owners.size > 1).map(edge => [...edge.owners].sort().join('|')))].sort();
    expect(ownerPairs(newGraph.edges)).toEqual(ownerPairs(rawGraph.edges));
    for (const edge of newGraph.edges.values()) {
      expect(edge.owners.size).toBeLessThanOrEqual(2);
      const midpoint = { x: (edge.a.x + edge.b.x) / 2, y: (edge.a.y + edge.b.y) / 2 };
      const nearest = [...rawGraph.edges.values()].reduce((best, candidate) => distance(midpoint, candidate.a, candidate.b) < distance(midpoint, best.a, best.b) ? candidate : best);
      // Every sampled output segment must still have both original owners if
      // it follows an internal border. Merely retaining one shared straight
      // segment somewhere would miss gaps along independently rounded arcs.
      expect([...edge.owners].sort(), `ownership at ${key(midpoint)}`).toEqual([...nearest.owners].sort());
      if (edge.owners.size === 2) {
        expect(edge.directions).toHaveLength(2);
        expect(edge.directions[0].split('>').reverse().join('>')).toBe(edge.directions[1]);
      }
    }
    const smoothKeys = new Set(Object.values(smooth).flat(2).map(key));
    for (const [point, neighbors] of rawGraph.neighbors) if (neighbors.size > 2) expect(smoothKeys.has(point), `junction ${point}`).toBe(true);
    expect(BOARD_CONTOUR_STATS.roundedCorners).toBe(304);
    expect(BOARD_CONTOUR_STATS.fixedJunctions).toBe(65);
  });

  it('has no self-intersections or new intersections anywhere in the complete map', () => {
    // Checking unique actual output edges catches coast/coast as well as
    // shared-country crossings; identical internal borders are deduplicated.
    const edges = [...graph(smooth).edges.values()];
    let crossing: unknown = null;
    for (let first = 0; first < edges.length && !crossing; first++) for (let second = first + 1; second < edges.length; second++) {
      const a = edges[first], b = edges[second];
      if (intersects(a.a, a.b, b.a, b.b)) { crossing = [a, b]; break; }
    }
    expect(crossing).toBeNull();
  });

  it('actually softens coarse corners while keeping displacement and geometry cost bounded', () => {
    const maxTurn = (ring: readonly BoardPoint[]) => Math.max(...ring.map((point, index) => {
      const previous = ring[(index + ring.length - 1) % ring.length], next = ring[(index + 1) % ring.length];
      const ax = point.x - previous.x, ay = point.y - previous.y, bx = next.x - point.x, by = next.y - point.y;
      return Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / Math.hypot(ax, ay) / Math.hypot(bx, by))));
    }));
    for (const id of ['greenland', 'iceland', 'japan', 'madagascar']) expect(maxTurn(smooth[id][0]), id).toBeLessThan(maxTurn(original[id][0]) * .3);
    let totalPoints = 0;
    for (const territory of TERRITORIES) {
      const oldSegments = segments(original[territory.id]), newSegments = segments(smooth[territory.id]);
      totalPoints += smooth[territory.id].flat().length;
      for (const point of smooth[territory.id].flat()) expect(Math.min(...oldSegments.map(edge => distance(point, edge.a, edge.b))), territory.id).toBeLessThan(3.6);
      for (const point of original[territory.id].flat()) expect(Math.min(...newSegments.map(edge => distance(point, edge.a, edge.b))), territory.id).toBeLessThan(3.6);
    }
    expect(totalPoints).toBeGreaterThan(2000);
    expect(totalPoints).toBeLessThan(2800);
  });

  it('keeps distinct islands and narrow sea channels separated', () => {
    const pairs = [['great-britain', 'western-europe'], ['japan', 'mongolia'], ['madagascar', 'east-africa'], ['new-guinea', 'eastern-australia'], ['indonesia', 'western-australia'], ['siam', 'indonesia']];
    const gap = (a: readonly (readonly BoardPoint[])[], b: readonly (readonly BoardPoint[])[]) => {
      const aa = segments(a), bb = segments(b);
      return Math.min(...a.flat().flatMap(point => bb.map(edge => distance(point, edge.a, edge.b))), ...b.flat().flatMap(point => aa.map(edge => distance(point, edge.a, edge.b))));
    };
    for (const [a, b] of pairs) {
      expect(gap(smooth[a], smooth[b]), `${a}/${b}`).toBeGreaterThan(0);
      expect(gap(smooth[a], smooth[b]), `${a}/${b}`).toBeGreaterThanOrEqual(gap(original[a], original[b]) * .7);
    }
    // The detached Tasmania and Indonesia pieces remain separate components.
    expect(boardContour('eastern-australia').rings).toHaveLength(2);
    expect(boardContour('indonesia').rings).toHaveLength(2);
  });
});
