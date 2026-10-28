/** Four cardboard quadrants in printed-map coordinates, clockwise by rows. */
export interface FoldPoint { x: number; y: number }
export const PANEL_BOUNDS = [
  { minX: 0, maxX: 550, minY: 0, maxY: 320 },
  { minX: 550, maxX: 1100, minY: 0, maxY: 320 },
  { minX: 0, maxX: 550, minY: 320, maxY: 640 },
  { minX: 550, maxX: 1100, minY: 320, maxY: 640 },
] as const;
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };
/** Three connected hinges form a four-panel snake: NE → SE → SW → NW.
 * Closing the free NE corner first keeps all printed faces inside the stack. */
export function boardFoldPose(progress: number) {
  const p = clamp(progress),upper=smooth(p*3),vertical=smooth((p-1/3)*3),horizontal=smooth((p-2/3)*3);
  return { upper: upper===0?0:Math.PI*upper, horizontal: horizontal===0?0:-Math.PI*horizontal, vertical: vertical===0?0:-Math.PI*vertical, x:284*vertical, y:horizontal===0?0:-165*horizontal };
}
export function boardPanel(x: number, y: number): number { return (x >= 550 ? 1 : 0) + (y >= 320 ? 2 : 0); }
/** Clip filled print to each leaf. The same intersection is reused by both neighbours. */
export function clipPanelRing(points: readonly FoldPoint[], panel: number): FoldPoint[] {
  const b = PANEL_BOUNDS[panel];
  let result = [...points];
  for (const [axis, edge, minimum] of [['x', b.minX, true], ['x', b.maxX, false], ['y', b.minY, true], ['y', b.maxY, false]] as const) {
    const input = result; result = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[(i + input.length - 1) % input.length], c = input[i];
      const insideA = minimum ? a[axis] >= edge : a[axis] <= edge, insideC = minimum ? c[axis] >= edge : c[axis] <= edge;
      if (insideA !== insideC) {
        const t = (edge - a[axis]) / (c[axis] - a[axis]);
        result.push({ x: axis === 'x' ? edge : a.x + (c.x - a.x) * t, y: axis === 'y' ? edge : a.y + (c.y - a.y) * t });
      }
      if (insideC) result.push(c);
    }
  }
  return result.filter((p, i) => i === 0 || Math.hypot(p.x - result[i - 1].x, p.y - result[i - 1].y) > 1e-8)
    .filter((p, i, all) => i !== all.length - 1 || all.length < 2 || Math.hypot(p.x - all[0].x, p.y - all[0].y) > 1e-8);
}
/** Clip original outline/sea-route segments, never invent an ink border at a crease. */
export function clipPanelSegment(a: FoldPoint, b: FoldPoint, panel: number): [FoldPoint, FoldPoint] | null {
  const bounds = PANEL_BOUNDS[panel], dx = b.x - a.x, dy = b.y - a.y;
  let start = 0, end = 1;
  for (const [p, q] of [[-dx, a.x - bounds.minX], [dx, bounds.maxX - a.x], [-dy, a.y - bounds.minY], [dy, bounds.maxY - a.y]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) start = Math.max(start, t); else end = Math.min(end, t);
    if (start >= end) return null;
  }
  return [{ x: a.x + start * dx, y: a.y + start * dy }, { x: a.x + end * dx, y: a.y + end * dy }];
}
