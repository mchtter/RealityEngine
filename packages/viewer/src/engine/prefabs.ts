import { type CityPrefabId, busTerminalBays, prefabParams } from '@opentwin/shared';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as THREE from 'three/webgpu';
import { paint } from './geom';

/**
 * Built-in procedural models (prefabs) of placed objects: low-poly, vertex
 * coloured, meant to read at a glance (a turbine is a turbine), not to be
 * realistic. Built in the placement frame — model x east, y north, z up at
 * heading 0, origin at the placement point on the ground — and returned in
 * three.js axes (x, y up, z south).
 */
export interface PrefabMesh {
  /** Opaque parts (vertex colours). */
  body: THREE.BufferGeometry;
  /** Glazing (shared glass material). */
  glass: THREE.BufferGeometry | null;
  /** Parts that turn (rotor): geometry centred on its hub, hub position, spin axis (three axes). */
  rotors: { geometry: THREE.BufferGeometry; at: THREE.Vector3; axis: THREE.Vector3; rpm: number }[];
}

const C = (hex: string) => new THREE.Color(hex);

type G = THREE.BufferGeometry;

const prep = (g: G, c: THREE.Color): G => {
  const out = g.index ? g.toNonIndexed() : g;
  out.deleteAttribute('uv');
  return paint(out, c);
};

/**
 * Box of w (east) × d (north) × h (up) with its base centre at (x, y, z),
 * turned `deg` clockwise (seen from above) about its centre.
 */
function B(w: number, d: number, h: number, c: THREE.Color, x = 0, y = 0, z = 0, deg = 0): G {
  const g = new THREE.BoxGeometry(w, h, d);
  if (deg) g.rotateY((-deg * Math.PI) / 180);
  g.translate(x, z + h / 2, -y);
  return prep(g, c);
}

/** Upright cylinder (radius r at the base, rt at the top) standing at (x, y, z). */
function CYL(r: number, h: number, c: THREE.Color, x = 0, y = 0, z = 0, seg = 16, rt = r): G {
  const g = new THREE.CylinderGeometry(rt, r, h, seg);
  g.translate(x, z + h / 2, -y);
  return prep(g, c);
}

/**
 * Plate of w (east) × len (along its slope) × t, tilted `tilt`° up towards the
 * north (faces south), lowest edge at height z, centred on (x, y).
 */
function PANEL(
  w: number,
  len: number,
  t: number,
  c: THREE.Color,
  x: number,
  y: number,
  z: number,
  tilt: number,
): G {
  const g = new THREE.BoxGeometry(w, t, len);
  g.rotateX((tilt * Math.PI) / 180);
  const rise = (Math.sin((tilt * Math.PI) / 180) * len) / 2;
  g.translate(x, z + rise + t, -y);
  return prep(g, c);
}

/** Beam between two model-frame points (square section s). */
function BEAM(
  a: [number, number, number],
  b: [number, number, number],
  s: number,
  c: THREE.Color,
): G {
  const pa = new THREE.Vector3(a[0], a[2], -a[1]);
  const pb = new THREE.Vector3(b[0], b[2], -b[1]);
  const len = pa.distanceTo(pb);
  const g = new THREE.BoxGeometry(s, len, s);
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    pb.clone().sub(pa).normalize(),
  );
  g.applyQuaternion(q);
  const mid = pa.add(pb).multiplyScalar(0.5);
  g.translate(mid.x, mid.y, mid.z);
  return prep(g, c);
}

const merge = (parts: G[]): G => mergeGeometries(parts);
const mergeOrNull = (parts: G[]): G | null => (parts.length ? merge(parts) : null);

const steel = C('#9aa0a6');
const white = C('#eef0ef');
const concrete = C('#b9b4aa');
const dark = C('#2b2f33');
const gravel = C('#8d887e');

// ─── Energy ─────────────────────────────────────────────────────────────────

function windTurbine(p: Record<string, number>): PrefabMesh {
  const { hubHeight: H, rotor: D } = p;
  const body = merge([
    CYL(2.4, 2, concrete, 0, 0, 0, 20, 2.4),
    CYL(2.1, H - 2, white, 0, 0, 2, 20, 1.3),
    B(3.4, 11, 3.6, white, 0, 2.5, H - 1.8),
  ]);
  const R = D / 2;
  const blade = (deg: number) => {
    const g = new THREE.BoxGeometry(Math.max(1.2, R * 0.06), R, 0.5);
    g.translate(0, R / 2 + 1.2, 0);
    g.rotateZ((deg * Math.PI) / 180);
    return prep(g, white);
  };
  const hub = new THREE.SphereGeometry(1.8, 12, 8);
  const rotor = merge([prep(hub, C('#d9dcdc')), blade(0), blade(120), blade(240)]);
  return {
    body,
    glass: null,
    // Rotor in front of the nacelle (south side), spinning about the north axis.
    rotors: [
      {
        geometry: rotor,
        at: new THREE.Vector3(0, H, 3.4),
        axis: new THREE.Vector3(0, 0, 1),
        rpm: 12,
      },
    ],
  };
}

function solarFarm(p: Record<string, number>): PrefabMesh {
  const { width: w, depth: d, rowGap, tilt } = p;
  const panel = C('#1d2f5a');
  const frame = C('#8a9096');
  const rows = Math.min(250, Math.max(1, Math.floor((d - 10) / rowGap)));
  const parts: G[] = [B(w + 8, d + 8, 0.05, C('#8f9a6a'), 0, 0, 0)];
  const len = Math.min(5, rowGap * 0.6);
  for (let i = 0; i < rows; i++) {
    const y = -d / 2 + 5 + (i + 0.5) * ((d - 10) / rows);
    parts.push(PANEL(w - 10, len, 0.12, panel, 0, y, 0.6, tilt));
    parts.push(B(w - 10, 0.15, 0.6, frame, 0, y - len / 2 + 0.3, 0));
  }
  // Perimeter fence.
  for (const [fw, fd, fx, fy] of [
    [w + 8, 0.1, 0, -d / 2 - 4],
    [w + 8, 0.1, 0, d / 2 + 4],
    [0.1, d + 8, -w / 2 - 4, 0],
    [0.1, d + 8, w / 2 + 4, 0],
  ] as const)
    parts.push(B(fw, fd, 2, steel, fx, fy, 0));
  // Control building beside the field (where the default interior puts the yard).
  parts.push(B(14, 8, 3.5, concrete, w / 2 + 19, -d / 2 + 20, 0));
  return { body: merge(parts), glass: null, rotors: [] };
}

function batteryStorage(p: Record<string, number>): PrefabMesh {
  const n = p.containers;
  const parts: G[] = [];
  const cols = 2;
  const rows = Math.ceil(n / cols);
  parts.push(B(34, rows * 5 + 10, 0.1, gravel, 0, 0, 0));
  for (let i = 0; i < n; i++) {
    const x = (i % cols === 0 ? -1 : 1) * 7.5;
    const y = -((rows - 1) * 5) / 2 + Math.floor(i / cols) * 5;
    parts.push(B(12.2, 2.45, 2.6, white, x, y, 0.1));
    parts.push(B(12.25, 2.5, 0.3, C('#2f9e44'), x, y, 2.2));
  }
  parts.push(B(4, 3, 3.2, C('#6c757d'), 0, -(rows * 5) / 2 - 2, 0));
  return { body: merge(parts), glass: null, rotors: [] };
}

function substation(p: Record<string, number>): PrefabMesh {
  const { width: w, depth: d } = p;
  const parts: G[] = [B(w, d, 0.1, gravel, 0, 0, 0)];
  const bays = Math.max(2, Math.min(8, Math.round(w / 15)));
  for (let i = 0; i < bays; i++) {
    const x = -w / 2 + 6 + ((w - 12) * (i + 0.5)) / bays;
    // Transformer with radiators.
    parts.push(B(5, 4, 4, C('#6f767d'), x, d / 6, 0.1));
    parts.push(B(5.6, 0.6, 3, C('#545a60'), x, d / 6 - 2.3, 0.4));
    parts.push(CYL(0.25, 2.2, C('#c9c3b6'), x - 1.2, d / 6, 4.1, 8));
    parts.push(CYL(0.25, 2.2, C('#c9c3b6'), x + 1.2, d / 6, 4.1, 8));
    // Gantry.
    parts.push(BEAM([x - 3, d / 2 - 6, 0], [x - 3, d / 2 - 6, 12], 0.5, steel));
    parts.push(BEAM([x + 3, d / 2 - 6, 0], [x + 3, d / 2 - 6, 12], 0.5, steel));
    parts.push(BEAM([x - 3, d / 2 - 6, 12], [x + 3, d / 2 - 6, 12], 0.4, steel));
  }
  parts.push(
    B(
      Math.min(20, w * 0.4),
      Math.max(4, d / 3 - 4),
      4,
      concrete,
      -w / 2 + 2 + Math.min(20, w * 0.4) / 2,
      -d / 2 + 2 + Math.max(4, d / 3 - 4) / 2,
      0,
    ),
  );
  for (const [fw, fd, fx, fy] of [
    [w, 0.1, 0, -d / 2],
    [w, 0.1, 0, d / 2],
    [0.1, d, -w / 2, 0],
    [0.1, d, w / 2, 0],
  ] as const)
    parts.push(B(fw, fd, 2.4, steel, fx, fy, 0));
  return { body: merge(parts), glass: null, rotors: [] };
}

// ─── Industry ───────────────────────────────────────────────────────────────

function factory(p: Record<string, number>): PrefabMesh {
  const { width: w, depth: d, height: h, levels, chimney } = p;
  const wall = C('#c8c2b4');
  const roof = C('#7d8790');
  const parts: G[] = [B(w, d, h, wall, 0, 0, 0)];
  // Sawtooth roof: north-light teeth across the width.
  const teeth = Math.max(2, Math.round(w / 10));
  const tw = w / teeth;
  for (let i = 0; i < teeth; i++) {
    const x = -w / 2 + tw * (i + 0.5);
    const g = new THREE.BoxGeometry(tw * 1.03, 0.3, d);
    g.rotateZ(Math.atan2(3, tw));
    g.translate(x, h + 1.5, 0);
    parts.push(prep(g, roof));
  }
  const glassParts: G[] = [];
  for (let i = 0; i < teeth; i++)
    glassParts.push(B(0.2, d, 3, C('#9fb3c4'), -w / 2 + tw * (i + 1) - 0.1, 0, h));
  // Office block on the south face, a window band per floor.
  const ow = Math.min(w * 0.4, 40);
  const oh = levels * 3.6;
  parts.push(B(ow, 10, oh, C('#dcd8cf'), -w / 2 + ow / 2, -d / 2 - 5, 0));
  for (let l = 0; l < levels; l++)
    glassParts.push(B(ow - 1, 10.1, 1.5, C('#5f7c96'), -w / 2 + ow / 2, -d / 2 - 5, l * 3.6 + 1.2));
  // Loading doors on the east face.
  for (const y of [-d / 4, d / 4]) parts.push(B(0.3, 5, 5, dark, w / 2 + 0.05, y, 0));
  for (let i = 0; i < chimney; i++) {
    const x = w / 2 - 8 - i * 7;
    const ch = h * 2.2;
    parts.push(CYL(1.6, ch * 0.7, C('#a33a2a'), x, d / 2 - 6, 0, 14, 1.3));
    parts.push(CYL(1.3, ch * 0.15, white, x, d / 2 - 6, ch * 0.7, 14, 1.2));
    parts.push(CYL(1.2, ch * 0.15, C('#a33a2a'), x, d / 2 - 6, ch * 0.85, 14, 1.1));
  }
  return { body: merge(parts), glass: mergeOrNull(glassParts), rotors: [] };
}

function warehouse(p: Record<string, number>): PrefabMesh {
  const { width: w, depth: d, height: h } = p;
  const parts: G[] = [
    B(w, d, h, C('#d3d6d8'), 0, 0, 0),
    B(w + 0.6, d + 0.6, 0.6, C('#8e979e'), 0, 0, h),
  ];
  const docks = Math.max(2, Math.floor(w / 12));
  for (let i = 0; i < docks; i++) {
    const x = -w / 2 + (w * (i + 0.5)) / docks;
    parts.push(B(3.6, 0.3, 4.2, dark, x, -d / 2 - 0.1, 1.2));
    parts.push(B(4.4, 2.5, 1.2, concrete, x, -d / 2 - 1.3, 0));
  }
  parts.push(B(w * 0.98, 0.1, 0.8, C('#1f6fb2'), 0, -d / 2 - 0.06, h - 1.6));
  return { body: merge(parts), glass: null, rotors: [] };
}

// ─── Aviation ───────────────────────────────────────────────────────────────

function terminal(p: Record<string, number>): PrefabMesh {
  const { length: l, depth: d, levels, gates } = p;
  const h = levels * 6;
  const parts: G[] = [B(l, d, h, C('#d9dde0'), 0, 0, 0)];
  // Wing roof: a thin slab overhanging the landside (south) front.
  parts.push(B(l + 10, d + 24, 1.2, C('#c4c9cd'), 0, -6, h + 1.5));
  for (const x of [-l / 2 + 4, -l / 6, l / 6, l / 2 - 4])
    parts.push(CYL(0.6, 1.5, steel, x, -d / 2 - 14, h, 8));
  const glassParts: G[] = [B(l - 2, 0.3, h - 1, C('#6d8fae'), 0, -d / 2 - 0.1, 0.5)];
  for (let i = 0; i < gates; i++) {
    const x = -l / 2 + 15 + ((l - 30) * (i + 0.5)) / Math.max(1, gates);
    // Jet bridge: corridor out to a rotunda on the apron (north).
    parts.push(B(3.5, 24, 3.2, C('#c7cbce'), x, d / 2 + 12, 5));
    parts.push(CYL(2.2, 5, steel, x, d / 2 + 24, 0, 12));
    parts.push(B(4.2, 4, 3.2, C('#b6bbbf'), x, d / 2 + 25.5, 5));
  }
  return { body: merge(parts), glass: mergeOrNull(glassParts), rotors: [] };
}

function controlTower(p: Record<string, number>): PrefabMesh {
  const { height: h } = p;
  const body = merge([
    B(18, 14, 6, C('#d4d7d9'), 0, 0, 0),
    CYL(3.2, h - 6, C('#e3e5e6'), 0, 0, 0, 16, 2.6),
    CYL(5.5, 1.2, C('#c8ccce'), 0, 0, h - 6, 8, 5.5),
    CYL(5.8, 0.8, C('#9aa1a6'), 0, 0, h, 8, 5.2),
    CYL(0.15, 5, steel, 0, 0, h + 0.8, 6),
  ]);
  const glass = CYL(5.4, 4.8, C('#40607a'), 0, 0, h - 4.8, 8, 5.7);
  return { body, glass, rotors: [] };
}

function hangar(p: Record<string, number>): PrefabMesh {
  const { width: w, depth: d } = p;
  const r = w / 2;
  const g = new THREE.CylinderGeometry(r, r, d, 24, 1, true, -Math.PI / 2, Math.PI);
  g.rotateX(Math.PI / 2);
  g.scale(1, 0.55, 1);
  g.translate(0, 4, 0);
  const shell = prep(g, C('#b9c0c6'));
  const parts: G[] = [shell, B(w, d, 4, C('#aeb5bb'), 0, 0, 0)];
  // Doors on the north face; back wall on the south.
  parts.push(B(w * 0.9, 0.3, 4 + r * 0.45, C('#59626a'), 0, d / 2, 0));
  parts.push(B(w, 0.3, 4 + r * 0.5, C('#aeb5bb'), 0, -d / 2, 0));
  return { body: merge(parts), glass: null, rotors: [] };
}

function runway(p: Record<string, number>): PrefabMesh {
  const { length: l, width: w } = p;
  const paint_ = C('#f1f1ec');
  const parts: G[] = [
    B(w + 15, l + 60, 0.1, C('#7f8a5a'), 0, 0, 0),
    B(w, l, 0.2, C('#3a3c3e'), 0, 0, 0.05),
  ];
  for (let y = -l / 2 + 120; y < l / 2 - 120; y += 60)
    parts.push(B(0.9, 30, 0.05, paint_, 0, y, 0.25));
  for (const end of [-1, 1])
    for (let i = 0; i < 8; i++) {
      const x = -w / 2 + 3 + ((w - 6) * (i + 0.5)) / 8 + (i >= 4 ? 2 : -2);
      parts.push(B(1.8, 30, 0.05, paint_, x, end * (l / 2 - 25), 0.25));
    }
  return { body: merge(parts), glass: null, rotors: [] };
}

// ─── Transit, sports, civic ─────────────────────────────────────────────────

function metroEntrance(p: Record<string, number>): PrefabMesh {
  const { width: w } = p;
  const parts: G[] = [
    B(w, 12, 0.4, C('#4a4f55'), 0, 0, 0),
    B(w - 1, 10, 0.2, C('#2b2f33'), 0, 0.5, 0.4),
  ];
  for (const [x, y] of [
    [-w / 2 + 0.3, -5.7],
    [w / 2 - 0.3, -5.7],
    [-w / 2 + 0.3, 5.7],
    [w / 2 - 0.3, 5.7],
  ])
    parts.push(B(0.25, 0.25, 3.4, steel, x, y, 0.4));
  // Sign pole with the red "M" box.
  parts.push(CYL(0.12, 4.2, steel, w / 2 + 1.5, -6.5, 0, 8));
  parts.push(B(1.2, 0.4, 1.2, C('#d7263d'), w / 2 + 1.5, -6.5, 4.2));
  const glass = B(w + 0.6, 12.6, 0.15, C('#7fa3c2'), 0, 0, 3.8);
  return { body: merge(parts), glass, rotors: [] };
}

function stadium(p: Record<string, number>): PrefabMesh {
  const { length: l, width: w, height: h } = p;
  const r = 100;
  const sx = l / 2 / r;
  const sz = w / 2 / r;
  const lathe = (pts: [number, number][], color: THREE.Color) => {
    const g = new THREE.LatheGeometry(
      pts.map(([a, b]) => new THREE.Vector2(a, b)),
      48,
    );
    g.scale(sx, 1, sz);
    return prep(g, color);
  };
  const inner = 0.62 * r;
  const parts: G[] = [
    B(l * 0.62, w * 0.62, 0.15, C('#3f8f3f'), 0, 0, 0),
    B(105, 68, 0.05, C('#4ea64e'), 0, 0, 0.15),
    // Stands rising outwards, outer wall, roof ring.
    lathe(
      [
        [inner, 1],
        [r * 0.97, h * 0.85],
        [r, h * 0.85],
        [r, 0],
        [inner, 0],
      ],
      C('#9aa3ad'),
    ),
    lathe(
      [
        [r * 0.8, h],
        [r * 1.02, h * 1.02],
        [r * 1.02, h * 0.98],
        [r * 0.8, h * 0.96],
      ],
      white,
    ),
  ];
  return { body: merge(parts), glass: null, rotors: [] };
}

function civicBuilding(p: Record<string, number>): PrefabMesh {
  const { width: w, depth: d, levels } = p;
  const fh = 3.6;
  const h = levels * fh;
  const stone = C('#e2d8c3');
  const parts: G[] = [
    B(w + 2, d + 2, 1.2, C('#cfc4ad'), 0, 0, 0),
    B(w, d, h, stone, 0, 0, 1.2),
    B(w + 1, d + 1, 0.8, C('#c9bea8'), 0, 0, h + 1.2),
  ];
  // Portico: columns and pediment on the south front.
  const cols = Math.max(4, Math.min(10, Math.round(w / 6)));
  const pw = Math.min(w * 0.5, 30);
  for (let i = 0; i < cols; i++)
    parts.push(
      CYL(0.6, Math.min(h, 10), white, -pw / 2 + (pw * (i + 0.5)) / cols, -d / 2 - 3, 1.2, 10),
    );
  parts.push(B(pw + 2, 6, 1, stone, 0, -d / 2 - 3, 1.2 + Math.min(h, 10)));
  // Clock tower and flag.
  parts.push(B(6, 6, 9, stone, 0, 0, h + 2));
  parts.push(B(6.6, 6.6, 0.6, C('#b8ad97'), 0, 0, h + 11));
  parts.push(CYL(0.1, 8, steel, 0, 0, h + 11.6, 6));
  parts.push(B(2.4, 0.05, 1.5, C('#e30a17'), 1.25, 0, h + 17.6));
  const glassParts: G[] = [];
  for (let l = 0; l < levels; l++)
    for (const side of [-1, 1])
      glassParts.push(B(w - 3, 0.2, 1.6, C('#4f6478'), 0, side * (d / 2 + 0.05), 1.2 + l * fh + 1));
  return { body: merge(parts), glass: mergeOrNull(glassParts), rotors: [] };
}

function waterTank(p: Record<string, number>): PrefabMesh {
  const { diameter, height } = p;
  const r = diameter / 2;
  const dome = new THREE.SphereGeometry(r, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  dome.scale(1, 0.25, 1);
  dome.translate(0, height, 0);
  return {
    body: merge([
      CYL(r, height, C('#c9d2d6'), 0, 0, 0, 24),
      prep(dome, C('#aab6bc')),
      B(0.6, 0.6, height, steel, r + 0.3, 0, 0),
    ]),
    glass: null,
    rotors: [],
  };
}

function portCrane(p: Record<string, number>): PrefabMesh {
  const { height: h } = p;
  const blue = C('#2f6fb3');
  const legs: [number, number][] = [
    [-8, -10],
    [8, -10],
    [-8, 10],
    [8, 10],
  ];
  const parts: G[] = legs.map(([x, y]) => BEAM([x, y, 0], [x, y * 0.6, h * 0.7], 1.4, blue));
  parts.push(BEAM([-8, -6, h * 0.7], [8, -6, h * 0.7], 1.2, blue));
  parts.push(BEAM([-8, 6, h * 0.7], [8, 6, h * 0.7], 1.2, blue));
  // Boom out over the water (south), backreach to the north.
  parts.push(B(3, 90, 2.4, blue, 0, -20, h * 0.75));
  parts.push(BEAM([0, -6, h * 0.75 + 2.4], [0, 0, h], 0.8, blue));
  parts.push(BEAM([0, 0, h], [0, -55, h * 0.75 + 2.4], 0.5, steel));
  parts.push(B(4, 4, 3, C('#e9ecef'), 0, -12, h * 0.75 - 3));
  return { body: merge(parts), glass: null, rotors: [] };
}

function cellTower(p: Record<string, number>): PrefabMesh {
  const { height: h } = p;
  const g = new THREE.CylinderGeometry(0.5, 2, h, 4, 1, false, Math.PI / 4);
  g.translate(0, h / 2, 0);
  const parts: G[] = [prep(g, C('#b0b5ba')), B(4, 4, 1.2, concrete, 0, 0, 0)];
  for (let i = 0; i < 3; i++) {
    const a = (i * 120 * Math.PI) / 180;
    parts.push(B(0.4, 0.25, 2.2, white, Math.sin(a) * 0.9, Math.cos(a) * 0.9, h - 3, i * 120));
  }
  return { body: merge(parts), glass: null, rotors: [] };
}

// ─── Buildings and public ──────────────────────────────────────────────────

/** Window bands on the long faces, one per floor. */
function bands(
  w: number,
  d: number,
  levels: number,
  fh: number,
  base: number,
  c = C('#4f6478'),
): G[] {
  const out: G[] = [];
  for (let l = 0; l < levels; l++)
    for (const side of [-1, 1])
      out.push(B(w - 2, 0.2, fh * 0.42, c, 0, side * (d / 2 + 0.05), base + l * fh + fh * 0.35));
  return out;
}

const body = (parts: G[], glass: G[] = []): PrefabMesh => ({
  body: merge(parts),
  glass: mergeOrNull(glass),
  rotors: [],
});

function hospital(p: Record<string, number>): PrefabMesh {
  const { width: w, depth: d, levels } = p;
  const h = levels * 4;
  const red = C('#d62828');
  return body(
    [
      B(w, d, h, C('#eef1f2'), 0, 0, 0),
      B(w * 0.4, 10, 4, C('#dfe4e6'), -w / 4, -d / 2 - 5, 0),
      B(w * 0.4 + 2, 12, 0.4, C('#c9d0d3'), -w / 4, -d / 2 - 5, 4),
      // Red cross on the roof edge, helipad on top.
      B(6, 0.4, 2, red, 0, -d / 2 - 0.3, h - 3),
      B(2, 0.4, 6, red, 0, -d / 2 - 0.3, h - 5),
      CYL(Math.min(10, d / 2.5), 0.4, C('#6b7378'), w / 4, 0, h, 24),
      B(1.2, 6, 0.1, white, w / 4 - 2, 0, h + 0.4),
      B(1.2, 6, 0.1, white, w / 4 + 2, 0, h + 0.4),
      B(4, 1.2, 0.1, white, w / 4, 0, h + 0.4),
    ],
    bands(w, d, levels, 4, 0, C('#5d87a6')),
  );
}

function school(p: Record<string, number>): PrefabMesh {
  const { width: w, depth: d, levels } = p;
  const h = levels * 3.6;
  return body(
    [
      B(w + 30, d + 50, 0.08, C('#9b9b93'), 0, -15, 0),
      B(w, d, h, C('#e8c872'), 0, 0, 0),
      B(w + 1, d + 1, 0.6, C('#b45f3c'), 0, 0, h),
      CYL(0.08, 10, steel, w / 2 + 6, -d / 2 - 10, 0, 6),
      B(2.2, 0.05, 1.4, C('#e30a17'), w / 2 + 7.15, -d / 2 - 10, 8.4),
      B(28, 15, 0.05, C('#c56b3c'), -w / 4, -d / 2 - 22, 0.08),
    ],
    bands(w, d, levels, 3.6, 0),
  );
}

function mosque(p: Record<string, number>): PrefabMesh {
  const { size: a, minarets } = p;
  const stone = C('#e6e0d3');
  const lead = C('#7d8a94');
  const hall = a * 0.45;
  const dome = new THREE.SphereGeometry(a * 0.38, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  dome.translate(0, hall + a * 0.08, 0);
  const parts: G[] = [
    B(a * 1.6, a * 2.2, 0.3, C('#cfc6b4'), 0, -a * 0.5, 0),
    B(a, a, hall, stone, 0, 0, 0),
    CYL(a * 0.4, a * 0.08, stone, 0, 0, hall, 16),
    prep(dome, lead),
    CYL(0.15, a * 0.12, C('#c9a227'), 0, 0, hall + a * 0.46, 6),
  ];
  for (const [x, y] of [
    [-a / 2, -a / 2],
    [a / 2, -a / 2],
    [-a / 2, a / 2],
    [a / 2, a / 2],
  ]) {
    const half = new THREE.SphereGeometry(a * 0.14, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    half.translate(x * 0.8, hall, -y * 0.8);
    parts.push(prep(half, lead));
  }
  const spots: [number, number][] = [
    [-a / 2 - 2, -a / 2 - 2],
    [a / 2 + 2, -a / 2 - 2],
    [-a / 2 - 2, a / 2 + 2],
    [a / 2 + 2, a / 2 + 2],
  ];
  const mh = a * 2.2;
  for (const [x, y] of spots.slice(0, minarets)) {
    parts.push(CYL(1.3, mh, stone, x, y, 0, 12, 1.0));
    parts.push(CYL(1.8, 0.6, stone, x, y, mh * 0.72, 12));
    parts.push(CYL(1.1, mh * 0.18, lead, x, y, mh, 12, 0.05));
  }
  return body(parts);
}

function apartmentBlock(p: Record<string, number>): PrefabMesh {
  const { width: w, depth: d, levels } = p;
  const fh = 3;
  const h = levels * fh;
  const parts: G[] = [
    B(w, d, h, C('#e9dccb'), 0, 0, 0),
    B(w + 0.6, d + 0.6, 0.8, C('#cdbfae'), 0, 0, h),
  ];
  for (let l = 1; l < levels; l++)
    parts.push(B(w * 0.9, 1.4, 0.15, C('#d7cbbb'), 0, -d / 2 - 0.7, l * fh));
  parts.push(B(w - 1, 0.3, 2.6, C('#7a8a92'), 0, -d / 2 - 0.15, 0.3));
  return body(parts, bands(w, d, levels, fh, 0));
}

function officeTower(p: Record<string, number>): PrefabMesh {
  const { width: w, depth: d, levels } = p;
  const h = levels * 3.8;
  const glass = [B(w, d, h - 8, C('#5e7f99'), 0, 0, 8)];
  return body(
    [
      B(w + 16, d + 16, 8, C('#c3c7ca'), 0, 0, 0),
      B(w * 0.5, d * 0.5, 6, C('#9aa1a6'), 0, 0, h),
      ...[0.25, 0.5, 0.75].map((f) =>
        B(w + 0.4, d + 0.4, 0.4, C('#aab1b6'), 0, 0, 8 + (h - 8) * f),
      ),
    ],
    glass,
  );
}

function shoppingMall(p: Record<string, number>): PrefabMesh {
  const { width: w, depth: d, levels } = p;
  const h = levels * 5.5;
  return body(
    [
      B(w + 40, d + 60, 0.08, C('#5e6265'), 0, -10, 0),
      B(w, d, h, C('#d8d3cb'), 0, 0, 0),
      B(w * 0.98, 0.3, 2.4, C('#1f6fb2'), 0, -d / 2 - 0.2, h - 3),
    ],
    [
      CYL(12, h + 4, C('#7fa3c2'), 0, -d / 2, 0, 24),
      B(w * 0.6, 0.3, 5, C('#7fa3c2'), 0, -d / 2 - 0.1, 0.3),
    ],
  );
}

/**
 * Intercity bus terminal (otogar): a two-storey ticket hall with a glazed
 * landside front and an entrance canopy, and north of it rows of angled
 * sawtooth bays on an apron, each row under a long canopy on columns with a
 * skylight strip; coaches stand at most bays. Bays from `busTerminalBays`
 * (the facility plan's bay points sit on them).
 */
function busTerminal(p: Record<string, number>): PrefabMesh {
  const { length: l, depth: d, levels } = p;
  const h = levels * 5 + 1;
  const { rows, rowY, bays } = busTerminalBays(p);
  const kerb = C('#cfccc4');
  const glassC = C('#6d8fae');
  const parts: G[] = [
    B(l, d, h, C('#e6e2da'), 0, 0, 0),
    // Roof slab overhanging all round; a darker plinth band.
    B(l + 6, d + 6, 0.9, C('#7f868c'), 0, 0, h),
    B(l + 0.2, d + 0.2, 0.6, C('#8f8a82'), 0, 0, 0),
    // Entrance canopy on the landside (south) front, on two rows of columns.
    B(Math.min(l * 0.5, 80), 9, 0.5, C('#cdd1d4'), 0, -d / 2 - 4.5, 4.8),
  ];
  for (const x of spread3(Math.min(l * 0.5, 80) - 4))
    parts.push(CYL(0.3, 4.8, steel, x, -d / 2 - 8, 0, 8));
  // Sign pylon at the forecourt.
  parts.push(B(2.6, 1, 13, C('#b8322a'), l / 2 - 8, -d / 2 - 14, 0));
  const glass: G[] = [
    B(l - 4, 0.3, h - 2, glassC, 0, -d / 2 - 0.1, 1),
    B(l - 4, 0.3, 3.2, glassC, 0, d / 2 + 0.1, 0.6),
  ];
  // Apron under every row, with the driving lane beyond the bays: raised a
  // little on a 3 m skirt so it shows where the ground rises across the site
  // (the placement stands at the terrain height of its centre).
  const top = 0.6;
  const apronN = rowY[rows - 1] + 20;
  parts.push(B(l + 12, apronN - d / 2, top + 3, C('#3e4246'), 0, (d / 2 + apronN) / 2, -3));
  const coach = [C('#f1f1ee'), C('#d7d9db'), C('#2f5d9c'), C('#b8322a'), C('#e0b23a')];
  bays.forEach((b, k) => {
    // Island finger between bays, angled 30° like the bays.
    parts.push(B(1.1, 11, 0.22, kerb, b.x - 2.1, b.y - 1, top, 30));
    // Coaches at most bays (deterministic pattern).
    if ((k * 7) % 10 < 6) {
      parts.push(B(2.55, 12.2, 2.9, coach[(k * 3) % coach.length], b.x, b.y, top + 0.3, 30));
      glass.push(B(2.6, 11.4, 1.0, C('#1f2b36'), b.x, b.y + 0.2, top + 1.8, 30));
    }
  });
  for (let r = 0; r < rows; r++) {
    const y = rowY[r];
    // Kerb along the back of the row (the passengers' platform).
    parts.push(B(l - 4, 3, 0.25, kerb, 0, y - 8.5, top));
    // Canopy over the platform and the coaches' fronts (their rear and the
    // driving lane stay open: from above the bays still read), on columns.
    parts.push(B(l - 2, 11, 0.5, C('#c9d4dd'), 0, y - 6, 6.2));
    for (let x = -l / 2 + 4; x <= l / 2 - 4; x += 16)
      parts.push(CYL(0.32, 6.2 - top, steel, x, y - 9, top, 8));
    glass.push(B(l - 6, 2.2, 0.2, glassC, 0, y - 6, 6.72));
  }
  return { body: merge(parts), glass: mergeOrNull(glass), rotors: [] };
}

/** Three positions across a width w, centred (columns of a short canopy). */
const spread3 = (w: number) => [-w / 2, 0, w / 2];

function metroStation(p: Record<string, number>): PrefabMesh {
  const { length: l } = p;
  const parts: G[] = [];
  const glass: G[] = [];
  for (const x of [-l / 3, l / 3]) {
    parts.push(B(6, 12, 0.4, C('#4a4f55'), x, 0, 0), B(5, 10, 0.2, dark, x, 0.5, 0.4));
    for (const [dx, dy] of [
      [-2.7, -5.7],
      [2.7, -5.7],
      [-2.7, 5.7],
      [2.7, 5.7],
    ])
      parts.push(B(0.25, 0.25, 3.4, steel, x + dx, dy, 0.4));
    parts.push(
      CYL(0.12, 4.2, steel, x + 4.5, -6.5, 0, 8),
      B(1.2, 0.4, 1.2, C('#d7263d'), x + 4.5, -6.5, 4.2),
    );
    glass.push(B(6.6, 12.6, 0.15, C('#7fa3c2'), x, 0, 3.8));
  }
  // Ventilation shaft head.
  parts.push(B(4, 4, 3, C('#8d949a'), 0, 8, 0), B(4.4, 4.4, 0.3, C('#6c757d'), 0, 8, 3));
  return body(parts, glass);
}

// ─── Street furniture ──────────────────────────────────────────────────────

function busShelter(p: Record<string, number>): PrefabMesh {
  const { width: w } = p;
  return body(
    [
      B(0.12, 0.12, 2.6, steel, -w / 2 + 0.1, 0.6, 0),
      B(0.12, 0.12, 2.6, steel, w / 2 - 0.1, 0.6, 0),
      B(w - 1, 0.4, 0.45, C('#8b6b4a'), 0, 0.3, 0.45),
      CYL(0.06, 3, steel, w / 2 + 0.8, -0.8, 0, 6),
      B(0.5, 0.06, 0.5, C('#1f6fb2'), w / 2 + 0.8, -0.8, 2.6),
    ],
    [B(w, 1.6, 0.08, C('#7fa3c2'), 0, 0, 2.6), B(w, 0.05, 2.2, C('#9fbfd8'), 0, 0.75, 0.3)],
  );
}

function trafficLight(p: Record<string, number>): PrefabMesh {
  const { arm } = p;
  const head = (x: number, z: number): G[] =>
    [
      B(0.35, 0.3, 1.0, C('#1d1f21'), x, 0, z),
      CYL(0.1, 0.05, C('#e03131'), x, -0.17, z + 0.82, 8),
      CYL(0.1, 0.05, C('#f2b705'), x, -0.17, z + 0.5, 8),
      CYL(0.1, 0.05, C('#2f9e44'), x, -0.17, z + 0.18, 8),
    ].map((g) => g);
  return body([
    CYL(0.12, 6, C('#5d6266'), 0, 0, 0, 10, 0.1),
    ...(arm > 0 ? [B(arm, 0.15, 0.15, C('#5d6266'), arm / 2, 0, 5.6)] : []),
    ...head(0.25, 2.4),
    ...(arm > 0 ? head(arm - 0.3, 4.4) : []),
    B(0.25, 0.15, 0.3, C('#e9ecef'), 0, -0.15, 1.1),
  ]);
}

function streetLamp(p: Record<string, number>): PrefabMesh {
  const { height: h } = p;
  return body([
    CYL(0.16, 0.5, C('#5d6266'), 0, 0, 0, 8),
    CYL(0.1, h, C('#5d6266'), 0, 0, 0.5, 8, 0.06),
    B(0.08, 1.6, 0.08, C('#5d6266'), 0, -0.8, h + 0.4),
    B(0.35, 0.65, 0.12, C('#f1f3f5'), 0, -1.55, h + 0.3),
  ]);
}

function bench(p: Record<string, number>): PrefabMesh {
  const { length: l } = p;
  const wood = C('#8b6b4a');
  return body([
    B(l, 0.45, 0.06, wood, 0, 0, 0.45),
    B(l, 0.06, 0.4, wood, 0, 0.22, 0.6),
    B(0.06, 0.45, 0.45, dark, -l / 2 + 0.15, 0, 0),
    B(0.06, 0.45, 0.45, dark, l / 2 - 0.15, 0, 0),
  ]);
}

function pedestrianBridge(p: Record<string, number>): PrefabMesh {
  const { span, height: h } = p;
  const parts: G[] = [B(3.2, span, 0.6, C('#b8bcc0'), 0, 0, h)];
  for (const side of [-1, 1]) {
    parts.push(B(0.08, span, 1.1, steel, side * 1.55, 0, h + 0.6));
    parts.push(B(4, 4, h + 3, C('#c9cdd1'), 0, side * (span / 2 + 2), 0));
  }
  return body(parts, [B(3.4, span, 0.1, C('#9fbfd8'), 0, 0, h + 2.8)]);
}

function fuelStation(p: Record<string, number>): PrefabMesh {
  const { pumps } = p;
  const w = pumps * 6 + 6;
  const parts: G[] = [
    B(w + 20, 40, 0.08, C('#5e6265'), 0, 0, 0),
    B(w, 16, 1, white, 0, 0, 5.5),
    B(w + 0.2, 16.2, 0.4, C('#e03131'), 0, 0, 5.6),
  ];
  for (let i = 0; i < pumps; i++) {
    const x = -w / 2 + 6 + i * 6;
    parts.push(
      B(0.5, 0.5, 5.5, steel, x, 0, 0),
      B(1, 0.6, 1.8, C('#e9ecef'), x, 1.5, 0),
      B(1, 0.6, 1.8, C('#e9ecef'), x, -1.5, 0),
    );
  }
  parts.push(B(16, 10, 4, C('#e9ecef'), 0, 16, 0), B(1.4, 0.5, 7, C('#e03131'), w / 2 + 6, -14, 0));
  return body(parts, [B(14, 0.2, 2.6, C('#7fa3c2'), 0, 10.95, 0.4)]);
}

function evCharger(p: Record<string, number>): PrefabMesh {
  const { chargers } = p;
  const parts: G[] = [];
  for (let i = 0; i < chargers; i++) {
    const x = (i - (chargers - 1) / 2) * 3;
    parts.push(B(0.6, 0.35, 1.6, white, x, 0, 0), B(0.62, 0.37, 0.2, C('#2f9e44'), x, 0, 1.6));
    parts.push(B(2.5, 5, 0.05, C('#2f9e44'), x, -3, 0.01));
  }
  return body(parts);
}

function fireStation(p: Record<string, number>): PrefabMesh {
  const { bays } = p;
  const w = bays * 5 + 10;
  const parts: G[] = [
    B(w, 20, 7, C('#d9d2c4'), 0, 0, 0),
    B(w + 0.6, 20.6, 0.6, C('#b23a32'), 0, 0, 7),
    B(5, 5, 18, C('#b23a32'), w / 2 + 3, 6, 0),
  ];
  for (let i = 0; i < bays; i++)
    parts.push(B(4, 0.3, 4.8, C('#c92a2a'), -w / 2 + 5 + i * 5, -10.05, 0));
  return body(parts);
}

function policeStation(p: Record<string, number>): PrefabMesh {
  const { levels } = p;
  const h = levels * 3.6;
  return body(
    [
      B(30, 18, h, C('#d5dbe0'), 0, 0, 0),
      B(30.2, 18.2, 0.8, C('#1c3f94'), 0, 0, h * 0.5),
      CYL(0.1, 10, steel, 10, 4, h, 6),
      B(32, 22, 0.4, C('#b9c1c8'), 0, 0, h),
    ],
    bands(30, 18, levels, 3.6, 0),
  );
}

function treatmentPlant(p: Record<string, number>): PrefabMesh {
  const { tanks } = p;
  const parts: G[] = [];
  const glass: G[] = [];
  const cols = Math.ceil(tanks / 2);
  for (let i = 0; i < tanks; i++) {
    const x = (Math.floor(i / 2) - (cols - 1) / 2) * 34;
    const y = i % 2 ? 18 : -18;
    parts.push(CYL(15, 4, C('#b9b4aa'), x, y, 0, 32));
    glass.push(CYL(14.2, 0.1, C('#4f7a5a'), x, y, 3.85, 32));
    parts.push(B(0.4, 28, 0.4, steel, x, y, 4.1));
  }
  parts.push(B(24, 12, 6, C('#d9d2c4'), -cols * 17 - 16, 0, 0));
  return body(parts, glass);
}

function lighthouse(p: Record<string, number>): PrefabMesh {
  const { height: h } = p;
  const parts: G[] = [CYL(4, 1.5, C('#9d968a'), 0, 0, 0, 16)];
  const n = 5;
  for (let i = 0; i < n; i++) {
    const z0 = 1.5 + ((h - 1.5) * i) / n;
    const r0 = 2.8 - (1.2 * i) / n;
    const r1_ = 2.8 - (1.2 * (i + 1)) / n;
    parts.push(CYL(r0, (h - 1.5) / n, i % 2 ? C('#c92a2a') : white, 0, 0, z0, 16, r1_));
  }
  parts.push(CYL(2.4, 0.4, dark, 0, 0, h, 16), CYL(1.2, 1, C('#c92a2a'), 0, 0, h + 2.4, 12, 0.1));
  return body(parts, [CYL(1.3, 2, C('#ffe8a3'), 0, 0, h + 0.4, 12)]);
}

function ferryPier(p: Record<string, number>): PrefabMesh {
  const { length: l } = p;
  const parts: G[] = [B(8, l, 0.6, C('#8b7d6b'), 0, l / 2, 1.2)];
  for (let y = 4; y < l; y += 8)
    for (const x of [-3.5, 3.5]) parts.push(CYL(0.35, 3.5, C('#5c5247'), x, y, -2, 8));
  parts.push(
    B(10, 8, 4, C('#e9ecef'), 0, l - 4, 1.8),
    B(10.5, 8.5, 0.4, C('#1f6fb2'), 0, l - 4, 5.8),
  );
  return body(parts);
}

const CONTAINER_COLOURS = [
  '#b23a32',
  '#1f6fb2',
  '#2f9e44',
  '#e8a33c',
  '#6c757d',
  '#d9480f',
  '#0b7285',
].map(C);

function containerStack(p: Record<string, number>): PrefabMesh {
  const { rows, bays, tiers } = p;
  const parts: G[] = [];
  let k = 0;
  for (let r = 0; r < rows; r++)
    for (let b = 0; b < bays; b++)
      for (let t = 0; t < Math.max(1, tiers - ((r + b) % 3 === 0 ? 1 : 0)); t++) {
        k = (k * 1103515245 + 12345) >>> 0;
        const x = (b - (bays - 1) / 2) * 6.4;
        const y = (r - (rows - 1) / 2) * 2.7;
        parts.push(
          B(6.06, 2.44, 2.59, CONTAINER_COLOURS[k % CONTAINER_COLOURS.length], x, y, t * 2.6),
        );
      }
  return body(parts);
}

// ─── Vehicles (also the stand-ins of live feeds) ───────────────────────────

function ship(p: Record<string, number>): PrefabMesh {
  const { length: l } = p;
  const beam = l * 0.15;
  const hull = C('#2b3a55');
  const parts: G[] = [
    B(beam, l * 0.88, l * 0.08, hull, 0, -l * 0.04, -l * 0.04),
    B(beam * 0.99, l * 0.88, 0.6, C('#a61e1e'), 0, -l * 0.04, -l * 0.045),
    // Pointed bow: a diamond prism at the north end of the hull.
    B(beam / Math.SQRT2, beam / Math.SQRT2, l * 0.08, hull, 0, l * 0.4, -l * 0.04, 45),
    B(beam * 0.9, l * 0.12, l * 0.09, white, 0, -l * 0.4, l * 0.04),
    CYL(beam * 0.12, l * 0.05, C('#c92a2a'), 0, -l * 0.42, l * 0.13, 10),
  ];
  for (let i = 0; i < 8; i++)
    parts.push(
      B(
        beam * 0.85,
        l * 0.06,
        2.6 * (1 + (i % 3)),
        CONTAINER_COLOURS[i % 7],
        0,
        -l * 0.25 + i * l * 0.075,
        l * 0.04,
      ),
    );
  return body(parts);
}

function aircraft(p: Record<string, number>): PrefabMesh {
  const { length: l } = p;
  const r = l * 0.055;
  const fuselage = new THREE.CapsuleGeometry(r, l - 2 * r, 6, 12);
  fuselage.rotateX(Math.PI / 2);
  fuselage.translate(0, r + 2.2, 0);
  const tail = C('#c92a2a');
  const parts: G[] = [
    prep(fuselage, white),
    B(l * 0.95, l * 0.14, 0.4, C('#dfe3e6'), 0, -l * 0.02, r + 1.8),
    B(l * 0.32, l * 0.08, 0.3, C('#dfe3e6'), 0, l * 0.43, r * 2 + 2),
    B(0.4, l * 0.12, l * 0.2, tail, 0, l * 0.42, r * 2 + 2),
    ...[-1, 1].map((sx) => {
      // Engines lie along the fuselage axis (north-south).
      const g = new THREE.CylinderGeometry(r * 0.45, r * 0.45, l * 0.12, 12);
      g.rotateX(Math.PI / 2);
      g.translate(sx * l * 0.17, r + 0.9, l * 0.08);
      return prep(g, C('#aeb4b9'));
    }),
    ...[-1, 1].map((sx) => CYL(0.25, 2.2, dark, sx * l * 0.05, 0, 0, 6)),
    CYL(0.25, 2.2, dark, 0, -l * 0.38, 0, 6),
  ];
  return body(parts);
}

function metroTrain(p: Record<string, number>): PrefabMesh {
  const { cars } = p;
  const parts: G[] = [];
  const glass: G[] = [];
  for (let i = 0; i < cars; i++) {
    const y = (i - (cars - 1) / 2) * 20.5;
    parts.push(B(2.8, 20, 3.4, C('#d7dbde'), 0, y, 0.4), B(2.82, 20, 0.3, C('#c92a2a'), 0, y, 1.1));
    glass.push(B(2.84, 18, 0.9, C('#3a4a58'), 0, y, 2.2));
  }
  return body(parts, glass);
}

function cityBus(p: Record<string, number>): PrefabMesh {
  const { length: l } = p;
  return body(
    [
      B(2.55, l, 2.8, C('#e9ecef'), 0, 0, 0.4),
      B(2.57, l, 0.5, C('#1f6fb2'), 0, 0, 0.6),
      ...[-l / 2 + 2.5, l / 2 - 3].flatMap((y) =>
        [-1.1, 1.1].map((x) => CYL(0.5, 0.3, dark, x, y, 0.5, 12)),
      ),
    ],
    [
      B(2.6, l - 1.5, 1.1, C('#3a4a58'), 0, 0.3, 1.8),
      B(2.3, 0.1, 1.4, C('#3a4a58'), 0, -l / 2 - 0.02, 1.5),
    ],
  );
}

function tentCamp(p: Record<string, number>): PrefabMesh {
  const { rows, cols } = p;
  const parts: G[] = [B(cols * 8 + 4, rows * 8 + 4, 0.06, C('#a39e8f'), 0, 0, 0)];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const x = (c - (cols - 1) / 2) * 8;
      const y = (r - (rows - 1) / 2) * 8;
      const tent = new THREE.ConeGeometry(3.2, 3, 4, 1);
      tent.rotateY(Math.PI / 4);
      tent.translate(x, 1.5, -y);
      parts.push(prep(tent, (r + c) % 5 === 0 ? C('#1f6fb2') : C('#f1f3f5')));
    }
  parts.push(B(20, rows * 8, 3, C('#d9d2c4'), cols * 4 + 14, 0, 0));
  return body(parts);
}

function towerCrane(p: Record<string, number>): PrefabMesh {
  const { height: h, jib } = p;
  const yellow = C('#f2b705');
  return body([
    B(6, 6, 1.5, concrete, 0, 0, 0),
    B(1.8, 1.8, h, yellow, 0, 0, 1.5),
    B(2.4, 2.4, 2.4, white, 1.6, 0, h - 1),
    B(jib, 1.2, 1.4, yellow, jib / 2, 0, h + 1.5),
    B(jib * 0.3, 1.2, 1.2, yellow, -jib * 0.15, 0, h + 1.5),
    B(3, 2.4, 2.4, C('#6c757d'), -jib * 0.27, 0, h + 0.2),
    BEAM([0, 0, h + 1.5], [0, 0, h + 8], 0.6, yellow),
    BEAM([0, 0, h + 8], [jib * 0.8, 0, h + 2.9], 0.15, steel),
    BEAM([jib * 0.7, 0, h + 1.5], [jib * 0.7, 0, h * 0.5], 0.08, dark),
  ]);
}

const BUILDERS: Record<CityPrefabId, (p: Record<string, number>) => PrefabMesh> = {
  wind_turbine: windTurbine,
  solar_farm: solarFarm,
  battery_storage: batteryStorage,
  substation,
  factory,
  warehouse,
  airport_terminal: terminal,
  control_tower: controlTower,
  hangar,
  runway,
  metro_entrance: metroEntrance,
  stadium,
  civic_building: civicBuilding,
  water_tank: waterTank,
  port_crane: portCrane,
  cell_tower: cellTower,
  hospital,
  school,
  mosque,
  apartment_block: apartmentBlock,
  office_tower: officeTower,
  shopping_mall: shoppingMall,
  metro_station: metroStation,
  bus_terminal: busTerminal,
  bus_shelter: busShelter,
  traffic_light: trafficLight,
  street_lamp: streetLamp,
  bench,
  pedestrian_bridge: pedestrianBridge,
  fuel_station: fuelStation,
  ev_charger: evCharger,
  fire_station: fireStation,
  police_station: policeStation,
  treatment_plant: treatmentPlant,
  lighthouse,
  ferry_pier: ferryPier,
  container_stack: containerStack,
  ship,
  aircraft,
  metro_train: metroTrain,
  city_bus: cityBus,
  tent_camp: tentCamp,
  tower_crane: towerCrane,
};

const cache = new Map<string, PrefabMesh>();

/** The prefab's geometry for its parameters (cached; shared between placements). */
export function prefabMesh(id: CityPrefabId, given?: Record<string, number>): PrefabMesh {
  const params = prefabParams(id, given);
  const key = `${id}|${JSON.stringify(params)}`;
  let mesh = cache.get(key);
  if (!mesh) {
    mesh = BUILDERS[id](params);
    for (const g of [mesh.body, mesh.glass, ...mesh.rotors.map((r) => r.geometry)]) {
      if (!g) continue;
      g.computeBoundingBox();
      g.computeBoundingSphere();
      g.userData.shared = true;
    }
    cache.set(key, mesh);
  }
  return mesh;
}
