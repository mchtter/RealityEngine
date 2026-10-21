import { type Building, type CityModel, Rng, orientedBox } from 'reality-engine-core';
import * as THREE from 'three/webgpu';
import { toThree } from './geom';

/**
 * A mall's front (F5): where its entrance hall, canopy, glazing and pylon
 * stand (buildings.ts draws them) and where its name is written — on the
 * sign band under the parapet, on the entrance canopy and down the pylon
 * (drawn here, canvas text: the worker has no canvas).
 */

type V2 = [number, number];

/** The front wall of a `box` building in tile coordinates (null: none worth a front). */
export interface MallFrame {
  /** Start of the front edge, its direction, the outward normal, its length. */
  a: V2;
  t: V2;
  o: V2;
  len: number;
  /** Floor of the entrance, top of the wall. */
  z0: number;
  wallTop: number;
  /** Entrance hall: from u0 to u1 along the front, `hall` proud. */
  u0: number;
  u1: number;
  /** The brand colour (sign band, pylon). */
  colour: string;
}

export const MALL = {
  /** Sign band under the parapet: height, and its gap below the wall top. */
  band: 1.6,
  bandTop: 0.2,
  /** Entrance hall depth out of the wall; canopy depth, height over the floor, thickness. */
  hall: 1,
  canopyDepth: 3.5,
  canopyZ: 4.5,
  canopyThick: 0.4,
  /** Pylon: width (across the front), depth, height, distance out from the wall. */
  pylon: { width: 2.2, depth: 0.6, height: 9, out: 2.5 },
} as const;

const BRAND = ['#c0392b', '#1f5fa8', '#2f8f4e', '#d68910', '#6c3483', '#17202a'];

export function mallFrame(b: Building): MallFrame | null {
  if (b.form !== 'box') return null;
  const ring = b.footprint.outer as V2[];
  const f = b.facades.find((x) => x.front);
  if (!f) return null;
  const a = ring[f.edge];
  const c = ring[(f.edge + 1) % ring.length];
  const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
  if (len < 20) return null;
  const t: V2 = [(c[0] - a[0]) / len, (c[1] - a[1]) / len];
  // Outward normal: the side of the edge away from the footprint's centre.
  const ob = orientedBox(ring);
  let o: V2 = [t[1], -t[0]];
  const mid: V2 = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
  if ((ob.center[0] - mid[0]) * o[0] + (ob.center[1] - mid[1]) * o[1] > 0) o = [-o[0], -o[1]];
  const w = Math.min(18, len * 0.22);
  const flat = b.roof.shape === 'flat';
  return {
    a,
    t,
    o,
    len,
    z0: b.floorZ,
    wallTop: b.topZ + (flat ? b.roof.parapet : 0),
    u0: len / 2 - w / 2,
    u1: len / 2 + w / 2,
    colour: new Rng(b.seed + 23).pick(BRAND),
  };
}

/** A point on the front: `u` along it, `d` out of the wall, at height z. */
export function frontAt(f: MallFrame, u: number, d: number, z: number): [number, number, number] {
  return [f.a[0] + f.t[0] * u + f.o[0] * d, f.a[1] + f.t[1] * u + f.o[1] * d, z];
}

/** A name to write: middle, the way it faces (plan), its letter height, at most this wide. */
export interface MallSign {
  at: [number, number, number];
  facing: V2;
  text: string;
  height: number;
  maxWidth: number;
  /** Written down the pylon (turned a quarter). */
  vertical?: boolean;
}

/** The name signs of a tile's malls (pure: the tile worker builds them). */
export function mallSigns(model: CityModel): MallSign[] {
  const out: MallSign[] = [];
  for (const b of model.buildings) {
    if (!b.name) continue;
    const f = mallFrame(b);
    if (!f) continue;
    const text = b.name.toLocaleUpperCase('tr');
    const bandMid = f.wallTop - MALL.bandTop - MALL.band / 2;
    // Along the sign band, over the whole front.
    out.push({
      at: frontAt(f, f.len / 2, 0.12, bandMid),
      facing: f.o,
      text,
      height: MALL.band * 0.8,
      maxWidth: f.len * 0.7,
    });
    // Standing on the entrance canopy.
    const canopyTop = f.z0 + MALL.canopyZ + MALL.canopyThick;
    out.push({
      at: frontAt(f, f.len / 2, MALL.canopyDepth - 0.3, canopyTop + 0.75),
      facing: f.o,
      text,
      height: 1.2,
      maxWidth: f.u1 - f.u0 + 3,
    });
    // Down both faces of the pylon (its faces look along the street).
    const P = MALL.pylon;
    const u = Math.min(8, f.len * 0.1);
    for (const s of [1, -1])
      out.push({
        at: frontAt(
          f,
          u + (s * P.depth) / 2 + s * 0.03,
          P.out + P.width / 2,
          f.z0 + P.height * 0.55,
        ),
        facing: [f.t[0] * s, f.t[1] * s],
        text,
        height: P.width * 0.62,
        maxWidth: P.height * 0.8,
        vertical: true,
      });
  }
  return out;
}

/** The signs' meshes (canvas letters, transparent between them); dispose with disposeMallSigns. */
export function buildMallSigns(signs: MallSign[] | undefined, group: THREE.Group): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  for (const s of signs ?? []) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    const font = '800 120px Inter, system-ui, sans-serif';
    ctx.font = font;
    const textWidth = ctx.measureText(s.text).width;
    canvas.width = Math.ceil(textWidth + 40);
    canvas.height = 160;
    ctx.font = font;
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(s.text, 20, 84);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    // Letters this high, narrower if the text would run past its room.
    let h = s.height / 0.75;
    let w = (h * canvas.width) / canvas.height;
    if (w > s.maxWidth) [h, w] = [(h * s.maxWidth) / w, s.maxWidth];
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicNodeMaterial({ map: texture, transparent: true, alphaTest: 0.35 }),
    );
    mesh.position.set(...toThree(s.at[0], s.at[1], s.at[2]));
    // The plane faces +z (three): turn it to face `facing`; down the pylon, a quarter more.
    mesh.rotation.order = 'YXZ';
    mesh.rotation.y = Math.atan2(s.facing[0], -s.facing[1]);
    if (s.vertical) mesh.rotation.z = -Math.PI / 2;
    mesh.name = 'mall-sign';
    group.add(mesh);
    out.push(mesh);
  }
  return out;
}

export function disposeMallSigns(meshes: THREE.Mesh[]): void {
  for (const m of meshes) {
    m.removeFromParent();
    m.geometry.dispose();
    const mat = m.material as THREE.MeshBasicNodeMaterial;
    mat.map?.dispose();
    mat.dispose();
  }
}
