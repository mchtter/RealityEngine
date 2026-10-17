import type { CityModel, StationEntrance, UndergroundStructure } from '@opentwin/city-core';
import * as THREE from 'three/webgpu';
import { MeshBuilder, toThree } from './geom';
import type { DtMaterials } from './materials';

/**
 * Under the ground (F5b): metro entrances on the street — the dark mouth of
 * the stairs with railings round it — and, in the underground view, the
 * stations as glowing red volumes at their depth. (The stairs themselves need
 * the ground opened over them: a later step.)
 */

/** Stair mouth: length along the street, width across (m); railing height. */
const MOUTH_LENGTH = 4;
const MOUTH_WIDTH = 1.9;
const RAIL_HEIGHT = 1.05;
/** A level down is about this deep (m): concourse ceiling to floor and slab. */
const LEVEL_DEPTH = 6;
/** A station's glow in the underground view (metro red, dimmed). */
const STATION_COLOUR = new THREE.Color('#a8322b');

export function buildUnderground(model: CityModel, mats: DtMaterials): THREE.Group | null {
  const ug = model.underground;
  if (!ug || (!ug.entrances.length && !ug.structures.length)) return null;
  const group = new THREE.Group();
  group.name = 'underground';
  if (ug.entrances.length) {
    const mouth = new MeshBuilder();
    const rails = new MeshBuilder();
    for (const e of ug.entrances) entrance(e, mouth, rails);
    const m1 = new THREE.Mesh(mouth.build({ uv: true }), mats.tunnelDark);
    m1.name = 'station-entrance-mouth';
    const m2 = new THREE.Mesh(rails.build({ uv: true }), mats.railMetal);
    m2.name = 'station-entrance-rails';
    m2.castShadow = true;
    for (const m of [m1, m2]) {
      m.userData.role = 'underground:entrance';
      group.add(m);
    }
  }
  if (ug.structures.length) {
    const vol = new MeshBuilder();
    // The networks' glowing material (a station reads like a pipe network down there).
    vol.defineAttribute('ua', 1);
    for (const s of ug.structures) volume(s, vol);
    const m = new THREE.Mesh(vol.build({ color: true }), mats.utility);
    m.name = 'station-volumes';
    m.userData.role = 'underground:structure';
    m.renderOrder = 3;
    group.add(m);
  }
  return group;
}

/** The stair mouth (a dark rectangle on the ground) and railings on three sides. */
function entrance(e: StationEntrance, mouth: MeshBuilder, rails: MeshBuilder): void {
  const [x, y, z] = e.position;
  const c = Math.cos(e.heading);
  const s = Math.sin(e.heading);
  const at = (u: number, v: number, h: number): [number, number, number] => [
    x + c * u - s * v,
    y + s * u + c * v,
    z + h,
  ];
  const hl = MOUTH_LENGTH / 2;
  const hw = MOUTH_WIDTH / 2;
  mouth.quad(
    [at(-hl, -hw, 0.04), at(hl, -hw, 0.04), at(hl, hw, 0.04), at(-hl, hw, 0.04)],
    [0, 0, 1],
    undefined,
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
  );
  // The open end (+u) is where one walks in; railings on the long sides and the far end.
  const fence = (a: [number, number], b: [number, number]) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const p0 = at(a[0], a[1], 0);
    const p1 = at(b[0], b[1], 0);
    const nx = -(p1[1] - p0[1]) / len;
    const ny = (p1[0] - p0[0]) / len;
    const top = (p: [number, number, number]): [number, number, number] => [
      p[0],
      p[1],
      p[2] + RAIL_HEIGHT,
    ];
    // railMetal draws a bar every 1/9 uv: 9 × 0.3 a metre, one every ~37 cm.
    const uv: [number, number][] = [
      [0, 0],
      [len * 0.3, 0],
      [len * 0.3, 1],
      [0, 1],
    ];
    // Both faces (a railing is seen from either side).
    rails.quad([p0, p1, top(p1), top(p0)], [nx, ny, 0], undefined, uv);
    rails.quad([p1, p0, top(p0), top(p1)], [-nx, -ny, 0], undefined, uv);
  };
  fence([-hl, -hw], [hl, -hw]);
  fence([-hl, hw], [hl, hw]);
  fence([-hl, -hw], [-hl, hw]);
}

/** A station as a volume at its depth: walls round its outline and its ceiling. */
function volume(s: UndergroundStructure, mb: MeshBuilder): void {
  const top = s.groundZ - 0.8;
  const bottom = s.groundZ - LEVEL_DEPTH * Math.max(1, -s.layer) - 0.5;
  const ring = s.footprint.outer;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    if (a[0] === b[0] && a[1] === b[1]) continue;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    mb.quad(
      [
        [a[0], a[1], bottom],
        [b[0], b[1], bottom],
        [b[0], b[1], top],
        [a[0], a[1], top],
      ],
      [(b[1] - a[1]) / len, -(b[0] - a[0]) / len, 0],
      STATION_COLOUR,
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
    );
  }
  // Ceiling (and floor): the outline triangulated.
  const contour = ring.map((p) => new THREE.Vector2(p[0], p[1]));
  const holes = s.footprint.holes.map((h) => h.map((p) => new THREE.Vector2(p[0], p[1])));
  const tris = THREE.ShapeUtils.triangulateShape(contour, holes);
  const pts = [...ring, ...s.footprint.holes.flat()];
  for (const z of [top, bottom]) {
    const base = pts.map((p) => mb.vertex(toThree(p[0], p[1], z), [0, 1, 0], STATION_COLOUR));
    for (const [i, j, l] of tris) mb.triangle(base[i], base[j], base[l]);
  }
}
