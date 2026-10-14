import { type CityModel, CutGround, GroundModel, TRACK_SPACING } from '@opentwin/city-core';
import * as THREE from 'three/webgpu';
import { MeshBuilder, toThree } from './geom';
import type { DtMaterials } from './materials';

type P2 = [number, number];

/**
 * Over the street surface: the bed above the asphalt (0.10) and the raised
 * surfaces a tram's strip runs through (sidewalk / island 0.24, which the
 * compiler cuts away under the bed, but a neighbouring kerb face stays).
 */
const BED_LIFT = 0.26;
const TIE_LIFT = 0.29;
/** Standard gauge, rail centre to rail centre (m). */
const GAUGE = 1.5;
const RAIL_TOP = 0.42;
const TIE_LENGTH = 2.6;
/** Catenary: a mast every MAST_STEP metres, the contact wire at WIRE_HEIGHT. */
const MAST_STEP = 55;
const WIRE_HEIGHT = 5.8;
const STEP = 3;
const STEEL = new THREE.Color('#6f7378');

function densify(line: P2[], step: number): P2[] {
  const out: P2[] = [line[0]];
  for (let k = 1; k < line.length; k++) {
    const a = line[k - 1];
    const b = line[k];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let i = 1; i <= n; i++)
      out.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
  }
  return out;
}

/** The line's stations: point, unit normal (left), arc length. */
function stations(line: P2[]) {
  const pts = densify(line, STEP);
  let s = 0;
  return pts.map((p, k) => {
    const a = pts[Math.max(0, k - 1)];
    const b = pts[Math.min(pts.length - 1, k + 1)];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    if (k) s += Math.hypot(p[0] - pts[k - 1][0], p[1] - pts[k - 1][1]);
    return { p, n: [-(b[1] - a[1]) / l, (b[0] - a[0]) / l] as P2, s };
  });
}

/**
 * Rail lines at the surface (CityModel.rails): the ballast bed (concrete for
 * a tram), per track a band of concrete sleepers and two rails, and — the
 * lines here are all electric — the catenary: a mast every 55 m beside the
 * bed with its cantilever over the tracks, a contact wire over each track.
 */
export function buildRails(model: CityModel, mats: DtMaterials): THREE.Group | null {
  const rails = model.rails ?? [];
  if (!rails.length) return null;
  const ground = new CutGround(model.terrain, model.terrainCut);
  // Building footprints on a 50 m grid: no mast or wire inside a building
  // (a station hall over the tracks, or a line a few metres off in the data).
  const cells = new Map<string, P2[][]>();
  for (const b of model.buildings) {
    const ring = b.footprint.outer as P2[];
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    for (let cx = Math.floor(Math.min(...xs) / 50); cx <= Math.floor(Math.max(...xs) / 50); cx++)
      for (
        let cy = Math.floor(Math.min(...ys) / 50);
        cy <= Math.floor(Math.max(...ys) / 50);
        cy++
      ) {
        const k = `${cx},${cy}`;
        const list = cells.get(k) ?? [];
        list.push(ring);
        cells.set(k, list);
      }
  }
  const inRing = (x: number, y: number, r: P2[]) => {
    let c = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++)
      if (
        r[i][1] > y !== r[j][1] > y &&
        x < ((r[j][0] - r[i][0]) * (y - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]
      )
        c = !c;
    return c;
  };
  const indoors = (x: number, y: number) =>
    (cells.get(`${Math.floor(x / 50)},${Math.floor(y / 50)}`) ?? []).some((r) => inRing(x, y, r));
  // On the street surface where a line runs in a street (a tram), which lies
  // above the raw terrain in town; on the ground (or a trench floor) elsewhere.
  const streets = new GroundModel(model);
  const h = (x: number, y: number) =>
    ground.inTrench(x, y) || ground.inLid(x, y) ? ground.heightAt(x, y) : streets.streetAt(x, y);
  const bed = new MeshBuilder();
  bed.defineAttribute('rb', 1);
  const ties = new MeshBuilder();
  const steel = new MeshBuilder();
  const wires = new MeshBuilder();
  wires.defineAttribute('fk', 1);
  wires.setAttribute('fk', [5]);
  const ids: string[] = [];

  /** A band along the line between offsets o0..o1 at a lift; uv.x = metres along. */
  const band = (
    mb: MeshBuilder,
    st: ReturnType<typeof stations>,
    o0: number,
    o1: number,
    lift: number,
    owner: number,
  ) => {
    let prev: [number, number] | null = null;
    for (const { p, n, s } of st) {
      const a = [p[0] + n[0] * o0, p[1] + n[1] * o0] as P2;
      const b = [p[0] + n[0] * o1, p[1] + n[1] * o1] as P2;
      const va = mb.vertex(toThree(a[0], a[1], h(a[0], a[1]) + lift), [0, 1, 0], undefined, s, 0);
      const vb = mb.vertex(toThree(b[0], b[1], h(b[0], b[1]) + lift), [0, 1, 0], undefined, s, 1);
      if (prev) {
        // Counter-clockwise seen from above (o0 is the left edge).
        mb.triangle(prev[0], vb, va, owner);
        mb.triangle(prev[0], prev[1], vb, owner);
      }
      prev = [va, vb];
    }
  };
  /** A rail: its head as a raised strip with two sides, from the ties up. */
  const rail = (st: ReturnType<typeof stations>, o: number, owner: number) => {
    const w = 0.07;
    for (let k = 1; k < st.length; k++) {
      const q = [st[k - 1], st[k]];
      const pt = (i: number, d: number, z: number): [number, number, number] => {
        const { p, n } = q[i];
        const x = p[0] + n[0] * (o + d);
        const y = p[1] + n[1] * (o + d);
        return [x, y, h(x, y) + z];
      };
      const uv: [number, number][] = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ];
      steel.quad(
        [pt(0, -w, RAIL_TOP), pt(0, w, RAIL_TOP), pt(1, w, RAIL_TOP), pt(1, -w, RAIL_TOP)],
        [0, 0, 1],
        STEEL,
        uv,
        0,
        owner,
      );
      steel.quad(
        [pt(1, w, TIE_LIFT), pt(1, w, RAIL_TOP), pt(0, w, RAIL_TOP), pt(0, w, TIE_LIFT)],
        [q[0].n[0], q[0].n[1], 0],
        STEEL,
        uv,
        0,
        owner,
      );
      steel.quad(
        [pt(0, -w, TIE_LIFT), pt(0, -w, RAIL_TOP), pt(1, -w, RAIL_TOP), pt(1, -w, TIE_LIFT)],
        [-q[0].n[0], -q[0].n[1], 0],
        STEEL,
        uv,
        0,
        owner,
      );
    }
  };
  /** A box between two points (masts, cantilevers), four sides. */
  const beam = (
    a: [number, number, number],
    b: [number, number, number],
    w: number,
    owner: number,
  ) => {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(d[0], d[1], d[2]) || 1;
    const u = [d[0] / len, d[1] / len, d[2] / len];
    // Two axes across the beam.
    const ref = Math.abs(u[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
    const s1 = [
      u[1] * ref[2] - u[2] * ref[1],
      u[2] * ref[0] - u[0] * ref[2],
      u[0] * ref[1] - u[1] * ref[0],
    ];
    const l1 = Math.hypot(s1[0], s1[1], s1[2]) || 1;
    const e1 = s1.map((v) => (v / l1) * (w / 2));
    const e2 = [
      u[1] * e1[2] - u[2] * e1[1],
      u[2] * e1[0] - u[0] * e1[2],
      u[0] * e1[1] - u[1] * e1[0],
    ];
    const c = (p: number[], s: number, t: number): [number, number, number] => [
      p[0] + e1[0] * s + e2[0] * t,
      p[1] + e1[1] * s + e2[1] * t,
      p[2] + e1[2] * s + e2[2] * t,
    ];
    const uv: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    for (const [s0, t0, s1b, t1b] of [
      [-1, -1, 1, -1],
      [1, -1, 1, 1],
      [1, 1, -1, 1],
      [-1, 1, -1, -1],
    ]) {
      const n = [
        e1[0] * (s0 + s1b) + e2[0] * (t0 + t1b),
        e1[1] * (s0 + s1b) + e2[1] * (t0 + t1b),
        e1[2] * (s0 + s1b) + e2[2] * (t0 + t1b),
      ];
      const nl = Math.hypot(n[0], n[1], n[2]) || 1;
      wires.quad(
        [c(a, s0, t0), c(a, s1b, t1b), c(b, s1b, t1b), c(b, s0, t0)],
        [n[0] / nl, n[1] / nl, n[2] / nl],
        STEEL,
        uv,
        0,
        owner,
      );
    }
  };

  for (const r of rails) {
    const label =
      r.kind === 'tram'
        ? 'Tramvay hattı'
        : r.kind === 'subway'
          ? 'Metro hattı'
          : 'Banliyö / demiryolu hattı';
    ids.push(`rail|${r.ref}|${r.name ? `${label} · ${r.name}` : label}`);
    const owner = ids.length - 1;
    const st = stations(r.points as P2[]);
    if (st.length < 2) continue;
    const half = r.width / 2;
    bed.setAttribute('rb', [r.kind === 'tram' ? 1 : 0]);
    band(bed, st, half, -half, BED_LIFT, owner);
    const centres = Array.from(
      { length: r.tracks },
      (_, k) => (k - (r.tracks - 1) / 2) * TRACK_SPACING,
    );
    for (const c of centres) {
      // A tram's rails are set in its concrete bed: no sleepers.
      if (r.kind !== 'tram')
        band(ties, st, c + TIE_LENGTH / 2, c - TIE_LENGTH / 2, TIE_LIFT, owner);
      rail(st, c + GAUGE / 2, owner);
      rail(st, c - GAUGE / 2, owner);
    }
    // Catenary.
    const side = half + 0.6;
    const far = centres[0] - 0.4;
    let next = 10;
    for (const { p, n, s } of st) {
      if (s < next) continue;
      next += MAST_STEP;
      if (indoors(p[0] + n[0] * side, p[1] + n[1] * side) || indoors(p[0], p[1])) continue;
      const base: [number, number, number] = [
        p[0] + n[0] * side,
        p[1] + n[1] * side,
        h(p[0] + n[0] * side, p[1] + n[1] * side),
      ];
      const top: [number, number, number] = [base[0], base[1], base[2] + WIRE_HEIGHT + 1.4];
      beam(base, top, 0.28, owner);
      const z = h(p[0], p[1]) + WIRE_HEIGHT + 1.1;
      beam([top[0], top[1], z], [p[0] + n[0] * far, p[1] + n[1] * far, z], 0.12, owner);
    }
    for (const c of centres) {
      let prev: number[] | null = null;
      for (const { p, n } of st) {
        const x = p[0] + n[0] * c;
        const y = p[1] + n[1] * c;
        const cur = [x, y, h(x, y) + WIRE_HEIGHT];
        if (prev && !indoors((prev[0] + x) / 2, (prev[1] + y) / 2))
          beam(prev as [number, number, number], cur as [number, number, number], 0.05, owner);
        prev = cur;
      }
    }
  }

  const group = new THREE.Group();
  group.name = 'rails';
  const add = (mb: MeshBuilder, mat: THREE.Material, name: string, uv: boolean, color: boolean) => {
    if (!mb.indices.length) return;
    const mesh = new THREE.Mesh(mb.build({ uv, color }), mat);
    mesh.name = name;
    mesh.receiveShadow = true;
    mesh.castShadow = name === 'rail-catenary';
    mesh.userData.pick = { ids, owners: mb.triangleOwner };
    mesh.userData.role = 'ground:near';
    group.add(mesh);
  };
  add(bed, mats.railBed, 'rail-bed', false, false);
  add(ties, mats.railTies, 'rail-ties', true, false);
  add(steel, mats.railSteel, 'rail-steel', false, false);
  add(wires, mats.fence, 'rail-catenary', false, true);
  return group.children.length ? group : null;
}
