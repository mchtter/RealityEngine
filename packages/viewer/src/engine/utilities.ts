import {
  type CityModel,
  type Utility,
  type UtilityKind,
  type UtilityNode,
  terrainHeightAt,
} from 'reality-engine-core';
import * as THREE from 'three/webgpu';
import { MeshBuilder, toThree } from './geom';
import type { DtMaterials } from './materials';

/** Network colours (APWA utility colour code: gas yellow, water blue, sewer green, power red, telecom orange). */
export const UTILITY_COLORS: Record<UtilityKind, string> = {
  gas: '#ffc21a',
  water: '#2f8cff',
  sewer: '#2fbf5b',
  power: '#ff3b30',
  telecom: '#ff8a1f',
  heat: '#e040fb',
};

export const UTILITY_LABEL: Record<UtilityKind, string> = {
  gas: 'Doğalgaz hattı',
  water: 'İçme suyu hattı',
  sewer: 'Kanalizasyon hattı',
  power: 'Elektrik kablosu',
  telecom: 'Fiber / haberleşme hattı',
  heat: 'Isı (bölgesel ısıtma) hattı',
};

const NODE_LABEL: Record<UtilityNode['type'], string> = { manhole: 'rögar / baca', valve: 'vana' };

/** Thin services are drawn at least this thick, or they vanish from a street-height view. */
const MIN_RADIUS = 0.06;

type P3 = [number, number, number];

/**
 * Buried pipes and cables (CityModel.utilities) as tubes, one mesh per
 * network (role `util:<kind>`, shown in the underground view), with the
 * shafts of their manholes / valves; the covers lie on the surface with the
 * street (role `ground:near`). Tubes carry `ua` (metres along the run) for
 * the flow animation of the utility material.
 */
export function buildUtilities(
  model: CityModel,
  mats: DtMaterials,
  parts: { networks?: boolean; covers?: boolean } = { networks: true, covers: true },
): THREE.Group | null {
  const runs = parts.networks ? (model.utilities ?? []) : [];
  const nodes = model.utilityNodes ?? [];
  if (!runs.length && !nodes.length && !model.props.some((p) => p.network)) return null;
  const group = new THREE.Group();
  group.name = 'utilities';
  const cabinets = parts.networks
    ? model.props.filter((p) => p.kind === 'street-cabinet' && p.network)
    : [];
  const kinds = new Set<UtilityKind>(
    parts.networks
      ? [
          ...runs.map((u) => u.kind),
          ...nodes.map((n) => n.kind),
          ...cabinets.map((c) => c.network!),
        ]
      : [],
  );
  for (const kind of kinds) {
    const mb = new MeshBuilder();
    mb.defineAttribute('ua', 1);
    const colour = new THREE.Color(UTILITY_COLORS[kind]);
    const ids: string[] = [];
    for (const u of runs) {
      if (u.kind !== kind || u.path.length < 2) continue;
      ids.push(`utility|${u.ref}|${describe(u, model)}`);
      mb.setOwner(ids.length - 1);
      tube(mb, u.path, Math.max(MIN_RADIUS, u.diameter / 2), colour, u.diameter >= 0.3 ? 14 : 8);
    }
    for (const n of nodes) {
      if (n.kind !== kind) continue;
      ids.push(
        `utility|${n.ref}|${UTILITY_LABEL[n.kind]} ${NODE_LABEL[n.type]}, ${n.depth.toFixed(1)} m derinlik`,
      );
      mb.setOwner(ids.length - 1);
      const r = n.type === 'manhole' ? 0.6 : 0.22;
      const [x, y, z] = n.position;
      mb.setAttribute('ua', [0]);
      tube(
        mb,
        [
          [x, y, z - 0.05],
          [x, y, z - n.depth],
        ],
        r,
        colour.clone().multiplyScalar(0.7),
        14,
        true,
      );
    }
    // Its street cabinets glow with it (the real ones are hidden underground).
    for (const c of cabinets) {
      if (c.network !== kind) continue;
      ids.push(
        `utility|${c.id.replace(/^p:/, '')}|${CABINET_LABEL[kind] ?? 'Sokak dağıtım kutusu'}`,
      );
      mb.setOwner(ids.length - 1);
      mb.setAttribute('ua', [0]);
      cabinetShell(mb, c.position, c.heading, colour);
    }
    if (!mb.indices.length) continue;
    const mesh = new THREE.Mesh(mb.build({ color: true }), mats.utility);
    mesh.name = `utility-${kind}`;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData.pick = { ids, owners: mb.triangleOwner };
    mesh.userData.role = `util:${kind}`;
    group.add(mesh);
  }
  if (parts.covers) {
    const covers = buildCovers(nodes, mats);
    if (covers) group.add(covers);
  }
  return group.children.length ? group : null;
}

const MATERIAL_LABEL: Record<string, string> = {
  concrete: 'beton',
  ductile_iron: 'sfero döküm',
  cast_iron: 'döküm',
  steel: 'çelik',
  PE: 'PE',
  HDPE: 'HDPE',
  PVC: 'PVC',
  copper: 'bakır',
};

/** Inspect text: network, main / service, diameter, material, cover range, reroutes. */
function describe(u: Utility, model: CityModel): string {
  const parts = [
    `${UTILITY_LABEL[u.kind]} · ${u.service ? 'bina bağlantısı' : 'ana hat'}`,
    `Ø${Math.round(u.diameter * 1000)} mm`,
  ];
  if (u.material) parts.push(MATERIAL_LABEL[u.material] ?? u.material);
  const covers = u.path.map(
    (p) => terrainHeightAt(model.terrain, p[0], p[1]) - p[2] - u.diameter / 2,
  );
  const lo = Math.max(0, Math.min(...covers));
  const hi = Math.max(0, Math.max(...covers));
  parts.push(
    hi - lo < 0.1 ? `derinlik ~${lo.toFixed(1)} m` : `derinlik ${lo.toFixed(1)}–${hi.toFixed(1)} m`,
  );
  if (u.rerouted) parts.push(`${u.rerouted} kesişimde başka hattın altından / üstünden geçirildi`);
  return parts.join(', ');
}

/**
 * Tube along a 3D polyline (model coordinates), rings oriented by parallel
 * transport so the surface does not twist; closed end caps when `caps`.
 */
function tube(
  mb: MeshBuilder,
  path: P3[],
  radius: number,
  colour: THREE.Color,
  sides: number,
  caps = false,
): void {
  const pts = path.map((p) => new THREE.Vector3(...toThree(p[0], p[1], p[2])));
  const tangents = pts.map((p, k) => {
    const a = pts[Math.max(0, k - 1)];
    const b = pts[Math.min(pts.length - 1, k + 1)];
    return b.clone().sub(a).normalize();
  });
  // Initial normal: any vector not parallel to the first tangent.
  const t0 = tangents[0];
  let normal = Math.abs(t0.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  normal = normal.sub(t0.clone().multiplyScalar(normal.dot(t0))).normalize();
  let along = 0;
  const rings: number[][] = [];
  for (let k = 0; k < pts.length; k++) {
    const t = tangents[k];
    if (k > 0) {
      along += pts[k].distanceTo(pts[k - 1]);
      // Parallel transport: drop the normal's component along the new tangent.
      normal = normal.sub(t.clone().multiplyScalar(normal.dot(t)));
      if (normal.lengthSq() < 1e-8) normal = new THREE.Vector3(0, 1, 0).cross(t);
      normal.normalize();
    }
    const binormal = t.clone().cross(normal).normalize();
    mb.setAttribute('ua', [along]);
    const ring: number[] = [];
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const n = normal
        .clone()
        .multiplyScalar(Math.cos(a))
        .add(binormal.clone().multiplyScalar(Math.sin(a)));
      const p = pts[k].clone().add(n.clone().multiplyScalar(radius));
      ring.push(mb.vertex([p.x, p.y, p.z], [n.x, n.y, n.z], colour, along, s / sides));
    }
    rings.push(ring);
  }
  for (let k = 1; k < rings.length; k++) {
    const r0 = rings[k - 1];
    const r1 = rings[k];
    for (let s = 0; s < sides; s++) {
      const s1 = (s + 1) % sides;
      // Wound so the faces look outward (T × along-the-ring is inward).
      mb.triangle(r0[s], r1[s1], r1[s]);
      mb.triangle(r0[s], r0[s1], r1[s1]);
    }
  }
  if (!caps) return;
  for (const [k, sign] of [
    [0, -1],
    [pts.length - 1, 1],
  ] as const) {
    const t = tangents[k].clone().multiplyScalar(sign);
    const c = mb.vertex([pts[k].x, pts[k].y, pts[k].z], [t.x, t.y, t.z], colour);
    const ring = rings[k];
    for (let s = 0; s < sides; s++) {
      const s1 = (s + 1) % sides;
      if (sign > 0) mb.triangle(c, ring[s], ring[s1]);
      else mb.triangle(c, ring[s1], ring[s]);
    }
  }
}

const CABINET_LABEL: Partial<Record<UtilityKind, string>> = {
  telecom: 'Fiber dağıtım kutusu (sokak kabini)',
  power: 'Elektrik dağıtım kutusu (sokak kabini)',
  water: 'Su sayaç / vana kabini',
  gas: 'Doğalgaz regülatör kabini',
};

/** Glowing shell of a street cabinet (a little larger than the cabinet model). */
function cabinetShell(mb: MeshBuilder, at: P3, heading: number, colour: THREE.Color): void {
  const f: [number, number] = [Math.cos(heading), Math.sin(heading)];
  const r: [number, number] = [f[1], -f[0]];
  const w = 0.5;
  const d = 0.26;
  const h = 1.4;
  const corner = (sx: number, sy: number, sz: number): P3 => [
    at[0] + r[0] * sx * w + f[0] * sy * d,
    at[1] + r[1] * sx * w + f[1] * sy * d,
    at[2] + sz * h,
  ];
  // Faces as (outward normal, four corners); wound to face out (toThree keeps handedness).
  const faces: [P3, P3[]][] = [
    [
      [f[0], f[1], 0],
      [corner(-1, 1, 0), corner(1, 1, 0), corner(1, 1, 1), corner(-1, 1, 1)],
    ],
    [
      [-f[0], -f[1], 0],
      [corner(1, -1, 0), corner(-1, -1, 0), corner(-1, -1, 1), corner(1, -1, 1)],
    ],
    [
      [r[0], r[1], 0],
      [corner(1, 1, 0), corner(1, -1, 0), corner(1, -1, 1), corner(1, 1, 1)],
    ],
    [
      [-r[0], -r[1], 0],
      [corner(-1, -1, 0), corner(-1, 1, 0), corner(-1, 1, 1), corner(-1, -1, 1)],
    ],
    [
      [0, 0, 1],
      [corner(-1, -1, 1), corner(-1, 1, 1), corner(1, 1, 1), corner(1, -1, 1)],
    ],
  ];
  for (const [n, pts] of faces) {
    const nt = toThree(n[0], n[1], n[2]);
    const v = pts.map((p) => mb.vertex(toThree(p[0], p[1], p[2]), nt, colour));
    // Order by the actual winding so the face looks along n.
    const e1 = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1], pts[1][2] - pts[0][2]];
    const e2 = [pts[2][0] - pts[0][0], pts[2][1] - pts[0][1], pts[2][2] - pts[0][2]];
    const cross = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    if (cross[0] * n[0] + cross[1] * n[1] + cross[2] * n[2] >= 0) {
      mb.triangle(v[0], v[1], v[2]);
      mb.triangle(v[0], v[2], v[3]);
    } else {
      mb.triangle(v[0], v[2], v[1]);
      mb.triangle(v[0], v[3], v[2]);
    }
  }
}

const COVER = new THREE.Color('#3b3d40');
const COVER_RIM = new THREE.Color('#5a5c5f');

/** Cast-iron covers of manholes and valve boxes, flush with the street. */
function buildCovers(nodes: UtilityNode[], mats: DtMaterials): THREE.Mesh | null {
  if (!nodes.length) return null;
  const mb = new MeshBuilder();
  const up: P3 = [0, 1, 0];
  const ids: string[] = [];
  for (const n of nodes) {
    ids.push(
      `utility|${n.ref}|${UTILITY_LABEL[n.kind]} ${NODE_LABEL[n.type]} kapağı, ${n.depth.toFixed(1)} m`,
    );
    mb.setOwner(ids.length - 1);
    const r = n.type === 'manhole' ? 0.34 : 0.13;
    const [x, y, z] = n.position;
    const h = z + 0.035;
    const centre = mb.vertex(toThree(x, y, h), up, COVER);
    const sides = 20;
    const inner: number[] = [];
    const outer: number[] = [];
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      inner.push(mb.vertex(toThree(x + Math.cos(a) * r, y + Math.sin(a) * r, h), up, COVER));
      outer.push(
        mb.vertex(
          toThree(x + Math.cos(a) * (r + 0.06), y + Math.sin(a) * (r + 0.06), h),
          up,
          COVER_RIM,
        ),
      );
    }
    for (let s = 0; s < sides; s++) {
      const s1 = (s + 1) % sides;
      mb.triangle(centre, inner[s], inner[s1]);
      mb.triangle(inner[s], outer[s1], inner[s1]);
      mb.triangle(inner[s], outer[s], outer[s1]);
    }
  }
  const mesh = new THREE.Mesh(mb.build({ color: true }), mats.utilityCover);
  mesh.name = 'utility-covers';
  mesh.receiveShadow = true;
  mesh.userData.pick = { ids, owners: mb.triangleOwner };
  mesh.userData.role = 'ground:near';
  return mesh;
}
