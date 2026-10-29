import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import barrel from '../src/assets/cannon-barrel.json';
import compass from '../src/assets/compass-rose.json';

function geometry(asset: { positions: number[]; indices: number[] }) {
  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.Float32BufferAttribute(asset.positions, 3));
  result.setIndex(asset.indices); result.computeVertexNormals(); return result;
}
describe('Blender tabletop meshes', () => {
  it('keeps bounded valid geometry and a real recessed cannon muzzle', () => {
    for (const asset of [barrel, compass]) {
      expect(asset.positions.every(Number.isFinite)).toBe(true);
      expect(asset.positions.length % 3).toBe(0);
      expect(asset.indices.length % 3).toBe(0);
      expect(Math.max(...asset.indices)).toBeLessThan(asset.positions.length / 3);
      expect(asset.indices.length / 3).toBeLessThan(150);
    }
    const shape = geometry(barrel), material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(shape, material); mesh.updateMatrixWorld();
    const hit = (x: number) => new THREE.Raycaster(new THREE.Vector3(x, 30, 14), new THREE.Vector3(0, -1, 0)).intersectObject(mesh)[0]?.point.y;
    expect(hit(0)).toBeCloseTo(8.8, 4);
    expect(hit(2.5)).toBeCloseTo(11, 4);
    shape.dispose(); material.dispose();
  });
});
