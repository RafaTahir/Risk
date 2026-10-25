import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { createOrbitDrag, isTableDrag, orbitFromDrag, TABLE_TILT_MAX, TABLE_TILT_MIN } from '../src/lib/tableInput';

const point = { x: 400, y: 300 };
const desktop = { width: 1200, height: 800 };
const view = { rotation: .16, tilt: 50, zoom: 1.8, x: 120, y: -70 };

function projectFarBoardPoint(cameraView: typeof view, originRotation: number) {
  // Match the real board's Z-up orbital camera. This checks visible movement,
  // not just the arithmetic sign of a stored yaw/elevation value.
  const elevation = cameraView.tilt * Math.PI / 180;
  const target = new Vector3(cameraView.x, cameraView.y, 0);
  const camera = new PerspectiveCamera(38, desktop.width / desktop.height, 10, 10000);
  camera.up.set(0, 0, 1);
  camera.position.set(Math.sin(cameraView.rotation) * Math.cos(elevation), -Math.cos(cameraView.rotation) * Math.cos(elevation), Math.sin(elevation)).multiplyScalar(1000).add(target);
  camera.zoom = cameraView.zoom;
  camera.lookAt(target); camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  return new Vector3(-Math.sin(originRotation) * 100, Math.cos(originRotation) * 100, 0).add(target).project(camera);
}

describe('screen-space tabletop orbit', () => {
  it('reverses right/left swivel and up/down tilt relative to the pointer, with pan and zoom unchanged', () => {
    const anchor = createOrbitDrag(view, point, desktop);
    const right = orbitFromDrag(anchor, { x: point.x + 120, y: point.y });
    const left = orbitFromDrag(anchor, { x: point.x - 120, y: point.y });
    const up = orbitFromDrag(anchor, { x: point.x, y: point.y - 80 });
    const down = orbitFromDrag(anchor, { x: point.x, y: point.y + 80 });
    expect(right.rotation).toBeCloseTo(view.rotation - Math.PI / 10);
    expect(left.rotation).toBeCloseTo(view.rotation + Math.PI / 10);
    expect(up.tilt).toBe(44);
    expect(down.tilt).toBe(56);
    for (const result of [right, left, up, down]) {
      expect(result).toMatchObject({ zoom: view.zoom, x: view.x, y: view.y });
    }
  });

  it('uses the same viewport fraction on desktop and portrait touch displays without rotating input axes', () => {
    const landscape = orbitFromDrag(createOrbitDrag(view, point, desktop), { x: point.x + 120, y: point.y - 80 });
    const portrait = { width: 390, height: 844 };
    const rotated = { ...view, rotation: Math.PI / 2 };
    const result = orbitFromDrag(createOrbitDrag(rotated, point, portrait), { x: point.x + 39, y: point.y - 84.4 });
    expect(result.rotation - rotated.rotation).toBeCloseTo(landscape.rotation - view.rotation);
    expect(result.tilt).toBeCloseTo(landscape.tilt);
    expect(result.x).toBe(view.x);
    expect(result.y).toBe(view.y);
  });

  it('does not invert screen axes when the board passes a full turn or faces the opposite side', () => {
    for (const rotation of [-Math.PI, 0, Math.PI / 2, Math.PI, Math.PI * 2 - .01, Math.PI * 5]) {
      const result = orbitFromDrag(createOrbitDrag({ ...view, rotation }, point, desktop), { x: point.x + 120, y: point.y - 80 });
      expect(result.rotation - rotation).toBeCloseTo(-Math.PI / 10);
      expect(result.tilt).toBe(44);
    }
  });

  it('moves the visible far board edge opposite the hand using the actual orbital camera projection', () => {
    for (const rotation of [0, Math.PI / 2, Math.PI, Math.PI * 2 - .01]) {
      const start = { ...view, rotation };
      const anchor = createOrbitDrag(start, point, desktop);
      const before = projectFarBoardPoint(start, rotation);
      const right = projectFarBoardPoint(orbitFromDrag(anchor, { x: point.x + 120, y: point.y }), rotation);
      const up = projectFarBoardPoint(orbitFromDrag(anchor, { x: point.x, y: point.y - 80 }), rotation);
      const down = projectFarBoardPoint(orbitFromDrag(anchor, { x: point.x, y: point.y + 80 }), rotation);
      expect(right.x).toBeLessThan(before.x);
      expect(up.y).toBeLessThan(before.y); // NDC +Y is toward the top of the screen.
      expect(down.y).toBeGreaterThan(before.y);
    }
  });

  it('depends on the current pointer and original anchor, not intermediate event count', () => {
    const anchor = createOrbitDrag(view, point, desktop);
    const direct = orbitFromDrag(anchor, { x: 760, y: 140 });
    for (let step = 1; step < 36; step++) orbitFromDrag(anchor, { x: point.x + step * 10, y: point.y - step * 4 });
    expect(orbitFromDrag(anchor, { x: 760, y: 140 })).toEqual(direct);
    expect(orbitFromDrag(anchor, point)).toEqual(view);
  });

  it('clamps tilt away from horizontal or the underside and reverses without accumulating clamp drift', () => {
    const anchor = createOrbitDrag(view, point, desktop);
    expect(orbitFromDrag(anchor, { ...point, y: -2000 }).tilt).toBe(TABLE_TILT_MIN);
    expect(orbitFromDrag(anchor, { ...point, y: 2000 }).tilt).toBe(TABLE_TILT_MAX);
    expect(orbitFromDrag(anchor, point)).toEqual(view);
  });

  it('rebases continuously after a pinch, pointer-count change, reset or resize', () => {
    const moved = orbitFromDrag(createOrbitDrag(view, point, desktop), { x: 520, y: 220 });
    const newView = { ...moved, zoom: 2.5, x: -80, y: 65 };
    const remainingTouch = { x: 280, y: 600 };
    const rebased = createOrbitDrag(newView, remainingTouch, { width: 390, height: 844 });
    expect(orbitFromDrag(rebased, remainingTouch)).toEqual(newView);
    const after = orbitFromDrag(rebased, { x: 319, y: 600 });
    expect(after.rotation - newView.rotation).toBeCloseTo(-Math.PI / 10);
    expect(after).toMatchObject({ tilt: newView.tilt, zoom: 2.5, x: -80, y: 65 });
  });

  it('snapshots mutable browser input and view objects before later events can change them', () => {
    const mutableView = { ...view }, mutablePoint = { ...point }, mutableViewport = { ...desktop };
    const anchor = createOrbitDrag(mutableView, mutablePoint, mutableViewport);
    mutableView.rotation = 4; mutablePoint.x = -900; mutableViewport.width = 40;
    expect(orbitFromDrag(anchor, point)).toEqual(view);
    expect(orbitFromDrag(anchor, { x: point.x + 120, y: point.y }).rotation).toBeCloseTo(view.rotation - Math.PI / 10);
  });
});

describe('selection versus deliberate drag', () => {
  it('allows click and touch jitter but detects deliberate movement in either direction', () => {
    expect(isTableDrag(point, { x: 403, y: 304 })).toBe(false);
    expect(isTableDrag(point, { x: 406, y: 300 })).toBe(true);
    expect(isTableDrag(point, { x: 394, y: 300 })).toBe(true);
    expect(isTableDrag(point, { x: 408, y: 300 }, 'touch')).toBe(false);
    expect(isTableDrag(point, { x: 409, y: 300 }, 'touch')).toBe(true);
    expect(isTableDrag(point, { x: 400, y: 291 }, 'touch')).toBe(true);
  });
});
