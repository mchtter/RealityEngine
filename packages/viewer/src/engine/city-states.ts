import { triangulate } from '@opentwin/city-core';
import type { CityObjectState } from '@opentwin/shared';
import {
  attribute,
  float,
  fract,
  mix,
  oneMinus,
  positionWorld,
  sin,
  step,
  time,
  uniform,
  vec3,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import { toThree } from './geom';

/** Colour per severity (1 low … 4 urgent). */
export const SEVERITY_COLORS: Record<number, string> = {
  1: '#ffd43b',
  2: '#ff922b',
  3: '#ff3b30',
  4: '#e0115f',
};

/** Height of the warning wall around a street piece / point object (m). */
const WALL = 2.2;
/** Marker mast above the object (m). */
const MAST = 25;

/** What the scene needs to place a state: world position and ground height. */
export interface StatePlacement {
  worldOf(lon: number, lat: number): [number, number] | null;
  heightAt(x: number, y: number): number;
  /** Top of a building by its object id (entity id / source ref), if loaded. */
  buildingTop(objectId: string): number | null;
}

const materials = new Map<string, THREE.MeshBasicNodeMaterial>();

/**
 * Materials of a severity (shared): `wall` fades upwards (`wh` 0 → 1),
 * `fill` carries diagonal caution stripes, `beacon` is solid; all pulse,
 * urgent ones faster.
 */
function materialOf(
  severity: number,
  part: 'wall' | 'fill' | 'beacon',
): THREE.MeshBasicNodeMaterial {
  const key = `${severity}:${part}`;
  let m = materials.get(key);
  if (m) return m;
  m = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    // Walls and fills show through buildings (an incident on a sidewalk behind
    // a block is still seen, like the inspect highlight); the beacon is solid.
    depthTest: part === 'beacon',
    side: THREE.DoubleSide,
  });
  const c = vec3(uniform(new THREE.Color(SEVERITY_COLORS[severity] ?? SEVERITY_COLORS[2])));
  const rate = severity >= 4 ? 6 : severity === 3 ? 4 : 2.5;
  const pulse = sin(time.mul(rate)).mul(0.15).add(0.85);
  if (part === 'wall') {
    m.colorNode = c;
    // `wh`: height in the wall (0 at the foot, 1 at the top).
    m.opacityNode = oneMinus(attribute<'float'>('wh', 'float')).mul(0.55).add(0.08).mul(pulse);
  } else if (part === 'fill') {
    const stripe = step(0.5, fract(positionWorld.x.add(positionWorld.z).mul(0.7)));
    m.colorNode = mix(vec3(0.08, 0.06, 0.06), c, stripe);
    m.opacityNode = float(0.6).mul(pulse);
  } else {
    m.colorNode = c;
    m.opacityNode = float(0.95).mul(pulse);
  }
  materials.set(key, m);
  return m;
}

/**
 * Scene overlay of city object states: a pulsing wall along the object's
 * outline (a sidewalk / carriageway segment, a cover, an area; a building up
 * to its roof), a translucent fill on it and a mast with a beacon above, in
 * the severity's colour. Rebuilt when states or loaded tiles change.
 */
export function buildCityStates(states: CityObjectState[], at: StatePlacement): THREE.Group {
  const group = new THREE.Group();
  group.name = 'city-states';
  for (const s of states) {
    const mat = materialOf(s.severity, 'beacon');
    const centre = at.worldOf(s.lon, s.lat);
    if (!centre) continue;
    const ground = at.heightAt(centre[0], centre[1]);
    const ring = (s.outline ?? [])
      .map(([lon, lat]) => at.worldOf(lon, lat))
      .filter((p): p is [number, number] => !!p);
    const top = s.objectKind === 'building' && s.objectId ? at.buildingTop(s.objectId) : null;
    if (ring.length >= 3) {
      const zs = ring.map(([x, y]) => at.heightAt(x, y));
      const base = (k: number) => zs[k] + 0.05;
      const wallTop = (k: number) => (top !== null ? top + 0.6 : zs[k] + WALL);
      const wall: number[] = [];
      const wallH: number[] = [];
      for (let k = 0; k < ring.length; k++) {
        const k1 = (k + 1) % ring.length;
        const [a, b] = [ring[k], ring[k1]];
        const quad = [
          toThree(a[0], a[1], base(k)),
          toThree(b[0], b[1], base(k1)),
          toThree(b[0], b[1], wallTop(k1)),
          toThree(a[0], a[1], wallTop(k)),
        ];
        wall.push(...quad[0], ...quad[1], ...quad[2], ...quad[0], ...quad[2], ...quad[3]);
        wallH.push(0, 0, 1, 0, 1, 1);
      }
      const wallGeo = new THREE.BufferGeometry();
      wallGeo.setAttribute('position', new THREE.Float32BufferAttribute(wall, 3));
      wallGeo.setAttribute('wh', new THREE.Float32BufferAttribute(wallH, 1));
      // The render pipeline's normal pass (MRT) needs normals on every mesh it draws.
      wallGeo.computeVertexNormals();
      // Fill: on the street piece / area, or as a cap over the building.
      const { vertices, indices } = triangulate({ outer: ring, holes: [] });
      // Above the street surface (sidewalks are raised over the terrain).
      const fillZ = top !== null ? top + 0.6 : Math.max(...zs) + 0.35;
      const fill: number[] = [];
      for (const i of indices) fill.push(...toThree(vertices[i * 2], vertices[i * 2 + 1], fillZ));
      const fillGeo = new THREE.BufferGeometry();
      fillGeo.setAttribute('position', new THREE.Float32BufferAttribute(fill, 3));
      fillGeo.computeVertexNormals();
      for (const [geo, part] of [
        [wallGeo, 'wall'],
        [fillGeo, 'fill'],
      ] as const) {
        const mesh = new THREE.Mesh(geo, materialOf(s.severity, part));
        mesh.renderOrder = 997;
        mesh.name = `state-${s.id}`;
        group.add(mesh);
      }
    }
    // Mast and beacon: seen from across the city.
    const foot = top ?? ground;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, MAST, 8), mat);
    mast.position.set(...toThree(centre[0], centre[1], foot + MAST / 2));
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(3, 18, 12), mat);
    beacon.position.set(...toThree(centre[0], centre[1], foot + MAST + 3));
    mast.renderOrder = beacon.renderOrder = 21;
    mast.name = beacon.name = `state-${s.id}`;
    group.add(mast, beacon);
  }
  return group;
}

/** Frees the overlay's geometry (materials are shared). */
export function disposeCityStates(group: THREE.Group): void {
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) m.geometry.dispose();
  });
  group.removeFromParent();
}
