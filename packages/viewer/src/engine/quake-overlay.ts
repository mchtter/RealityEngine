import {
  Fn,
  abs,
  attribute,
  cameraViewMatrix,
  float,
  fract,
  length,
  max,
  min,
  mrt,
  oneMinus,
  pow,
  positionLocal,
  smoothstep,
  time,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import { greatCircle, haversineKm, quakeZoneKm } from './overview-geo';
import { textLabel } from './overview-map';

// =============================================================================
// Earthquakes on the overview map (L0): every quake a dot sized and coloured
// by magnitude; the selected one with rings pulsing out from its epicentre to
// the edge of its zone (Dobrovolsky radius, overview-geo.ts), a great-circle
// arc to the city with dashes running towards it, and the distance written
// over the arc. Lives in the overview map's group (anchor metres).
// =============================================================================

export interface QuakeMark {
  key: string;
  lon: number;
  lat: number;
  magnitude: number | null;
}

/** The city the arc runs to: its name and point (lon/lat). */
export interface QuakeCity {
  name: string;
  at: [number, number];
}

const groundNormalMrt = () => mrt({ normal: cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz });
/** Arc height over its length at most, and at most this (m). */
const ARC_RISE = 0.18;
const ARC_RISE_MAX = 90_000;
/** Pulse rings reach at least this far on screen (px), whatever the zone's true size. */
const PULSE_MIN_PX = 70;

const magColour = (m: number | null) =>
  m === null ? '#f59e0b' : m >= 5 ? '#dc2626' : m >= 3 ? '#f97316' : '#eab308';

export class QuakeOverlay {
  readonly group = new THREE.Group();
  private readonly dots = new Map<string, { mesh: THREE.Mesh; magnitude: number | null }>();
  private readonly dotGeo = new THREE.CircleGeometry(1, 28).rotateX(-Math.PI / 2);
  private readonly dotMats = new Map<string, THREE.MeshBasicNodeMaterial>();
  /** The selected quake's pieces (rebuilt when the selection changes). */
  private chosen: {
    key: string;
    zoneM: number;
    pulse: THREE.Mesh;
    arc: THREE.Mesh | null;
    distance: THREE.Mesh | null;
    tag: THREE.Mesh;
  } | null = null;
  /** Pulse disc: its radius (m) and the zone's edge within it (0 … 1), the ring width (0 … 1). */
  private readonly pulseRadius = uniform(1);
  private readonly zoneEdge = uniform(1);
  private readonly ringWidth = uniform(0.02);

  constructor(
    private readonly project: (lon: number, lat: number) => [number, number],
    private readonly mpp: THREE.UniformNode<'float', number>,
    private readonly fade: THREE.UniformNode<'float', number>,
  ) {
    this.group.name = 'overview-quakes';
  }

  /** The quakes now in the feeds, the selected one's key, and the city its arc runs to. */
  update(quakes: QuakeMark[], selected: string | null, city: QuakeCity | null): void {
    const seen = new Set<string>();
    for (const q of quakes) {
      seen.add(q.key);
      let dot = this.dots.get(q.key);
      if (!dot) {
        const mesh = new THREE.Mesh(this.dotGeo, this.dotMat(magColour(q.magnitude)));
        mesh.frustumCulled = false;
        mesh.renderOrder = 26;
        this.group.add(mesh);
        dot = { mesh, magnitude: q.magnitude };
        this.dots.set(q.key, dot);
      }
      const [x, y] = this.project(q.lon, q.lat);
      dot.mesh.position.set(x, 0, -y);
    }
    for (const [key, dot] of this.dots)
      if (!seen.has(key)) {
        dot.mesh.removeFromParent();
        this.dots.delete(key);
      }
    const q = selected ? quakes.find((m) => m.key === selected) : undefined;
    if (!q) {
      this.dropChosen();
      return;
    }
    if (this.chosen?.key === q.key) return;
    this.dropChosen();
    this.chosen = this.buildChosen(q, city);
  }

  /** Per frame: dots and labels a steady size on screen; rings fitted to the zoom. */
  setScale(mpp: number, lift: number): void {
    for (const dot of this.dots.values()) {
      const px = 4 + 1.6 * Math.max(0, dot.magnitude ?? 1);
      dot.mesh.scale.setScalar(mpp * px);
      dot.mesh.position.y = lift * 2;
    }
    const c = this.chosen;
    if (!c) return;
    const radius = Math.max(c.zoneM, mpp * PULSE_MIN_PX);
    this.pulseRadius.value = radius;
    this.zoneEdge.value = c.zoneM / radius;
    this.ringWidth.value = (mpp * 2.5) / radius;
    c.pulse.scale.setScalar(radius);
    c.pulse.position.y = lift * 1.2;
    c.tag.scale.setScalar(mpp * 15);
    c.tag.position.y = lift * 3;
    if (c.distance) c.distance.scale.setScalar(mpp * 15);
    if (c.arc) (c.arc.material as THREE.MeshBasicNodeMaterial).userData.lift.value = lift;
  }

  dispose(): void {
    this.dropChosen();
    this.group.removeFromParent();
    this.dotGeo.dispose();
    for (const m of this.dotMats.values()) m.dispose();
  }

  // ─── building ─────────────────────────────────────────────────────────────

  private dotMat(colour: string): THREE.MeshBasicNodeMaterial {
    let mat = this.dotMats.get(colour);
    if (mat) return mat;
    mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    mat.fog = false;
    // A solid core with a pale rim, soft at the edge.
    const r = length(uv().sub(0.5).mul(2));
    const rim = smoothstep(0.62, 0.72, r);
    mat.colorNode = vec3(uniform(new THREE.Color(colour)))
      .mul(oneMinus(rim.mul(0.4)))
      .add(rim.mul(0.35));
    mat.opacityNode = oneMinus(smoothstep(0.86, 1, r))
      .mul(0.95)
      .mul(this.fade);
    mat.mrtNode = groundNormalMrt();
    this.dotMats.set(colour, mat);
    return mat;
  }

  private buildChosen(q: QuakeMark, city: QuakeCity | null): NonNullable<QuakeOverlay['chosen']> {
    const [x, y] = this.project(q.lon, q.lat);
    const zoneKm = q.magnitude !== null ? quakeZoneKm(q.magnitude) : 5;
    const pulse = this.pulseDisc();
    pulse.position.set(x, 0, -y);
    this.group.add(pulse);
    const mag = q.magnitude !== null ? `M${q.magnitude.toFixed(1)}` : 'M?';
    const tag = textLabel(
      `${mag} · ~${zoneKm < 10 ? zoneKm.toFixed(1) : Math.round(zoneKm)} km`,
      {
        font: '700 72px Georgia, "Times New Roman", serif',
        color: '#7f1d1d',
        halo: 'rgba(255,240,220,0.95)',
        spacing: '0.06em',
      },
      this.fade,
    );
    tag.position.set(x, 0, -y);
    // Under the epicentre, clear of the dot.
    tag.geometry.translate(0, 0, 2.6);
    tag.frustumCulled = false;
    tag.renderOrder = 28;
    this.group.add(tag);
    let arc: THREE.Mesh | null = null;
    let distance: THREE.Mesh | null = null;
    if (city) {
      const km = haversineKm([q.lon, q.lat], city.at);
      if (km > 1) {
        const path = greatCircle([q.lon, q.lat], city.at, 96).map(([lon, lat]) =>
          this.project(lon, lat),
        );
        arc = this.arcMesh(path, km * 1000);
        this.group.add(arc);
        const mid = path[48];
        const rise = Math.min(km * 1000 * ARC_RISE, ARC_RISE_MAX);
        distance = textLabel(
          `${km < 10 ? km.toFixed(1) : Math.round(km)} km → ${city.name.toLocaleUpperCase('tr')}`,
          {
            font: 'italic 700 72px Georgia, "Times New Roman", serif',
            color: '#4a3520',
            halo: 'rgba(250,238,210,0.95)',
            spacing: '0.08em',
          },
          this.fade,
        );
        distance.position.set(mid[0], rise, -mid[1]);
        // Along the arc, kept reading left to right.
        const [ax, ay] = path[40];
        const [bx, by] = path[56];
        let angle = Math.atan2(by - ay, bx - ax);
        if (angle > Math.PI / 2) angle -= Math.PI;
        if (angle < -Math.PI / 2) angle += Math.PI;
        distance.rotation.y = angle;
        distance.frustumCulled = false;
        distance.renderOrder = 28;
        this.group.add(distance);
      }
    }
    return { key: q.key, zoneM: zoneKm * 1000, pulse, arc, distance, tag };
  }

  /** Rings pulsing out from the centre and the zone's edge as a steady ring. */
  private pulseDisc(): THREE.Mesh {
    const g = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    mat.fog = false;
    const r = length(uv().sub(0.5).mul(2));
    const w = max(this.ringWidth, float(0.002));
    const edge = this.zoneEdge;
    const wave = (k: number) => {
      const p = fract(time.mul(0.28).add(k / 3));
      const band = oneMinus(smoothstep(float(0), w.mul(1.5), abs(r.sub(p))));
      return band.mul(pow(oneMinus(p), 1.3));
    };
    const pulses = wave(0).add(wave(1)).add(wave(2));
    const boundary = oneMinus(smoothstep(float(0), w, abs(r.sub(edge))));
    const inside = oneMinus(smoothstep(edge.sub(w), edge, r)).mul(0.1);
    mat.colorNode = Fn(() => vec3(0.86, 0.15, 0.1).mul(oneMinus(boundary.mul(0.25))))();
    mat.opacityNode = min(pulses.mul(0.75).add(boundary.mul(0.9)).add(inside), float(0.95))
      .mul(oneMinus(smoothstep(0.98, 1, r)))
      .mul(this.fade);
    mat.mrtNode = groundNormalMrt();
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 27;
    return mesh;
  }

  /**
   * The great-circle arc as a ribbon a few pixels wide, raised in the middle,
   * dashes running from the epicentre to the city.
   */
  private arcMesh(path: [number, number][], lengthM: number): THREE.Mesh {
    const rise = Math.min(lengthM * ARC_RISE, ARC_RISE_MAX);
    const positions: number[] = [];
    const offsets: number[] = [];
    const uvs: number[] = [];
    const index: number[] = [];
    let along = 0;
    const n = path.length;
    for (let i = 0; i < n; i++) {
      const [x, y] = path[i];
      if (i > 0) along += Math.hypot(x - path[i - 1][0], y - path[i - 1][1]);
      const [ax, ay] = path[Math.max(0, i - 1)];
      const [bx, by] = path[Math.min(n - 1, i + 1)];
      const dl = Math.hypot(bx - ax, by - ay) || 1;
      const nx = -(by - ay) / dl;
      const ny = (bx - ax) / dl;
      const h = Math.sin((Math.PI * i) / (n - 1)) * rise;
      for (const side of [1, -1]) {
        positions.push(x, h, -y);
        offsets.push(nx * side * 0.5, 0, -ny * side * 0.5);
        uvs.push(along, side === 1 ? 0 : 1);
      }
      if (i < n - 1) {
        const a = i * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('offset', new THREE.Float32BufferAttribute(offsets, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(index);
    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    mat.fog = false;
    const lift = uniform(10);
    mat.userData.lift = lift;
    const width = this.mpp.mul(3.5);
    mat.positionNode = positionLocal
      .add(attribute<'vec3'>('offset', 'vec3').mul(width))
      .add(vec3(0, lift, 0));
    // Dashes ~14 px long running towards the city, over a faint steady line.
    const dash = fract(uv().x.div(this.mpp.mul(22)).sub(time.mul(1.4)));
    const on = smoothstep(0.0, 0.08, dash).mul(oneMinus(smoothstep(0.55, 0.63, dash)));
    const across = oneMinus(abs(uv().y.mul(2).sub(1)));
    mat.colorNode = vec3(0.9, 0.22, 0.12).add(vec3(0.1, 0.2, 0.1).mul(on));
    mat.opacityNode = on
      .mul(0.75)
      .add(0.3)
      .mul(smoothstep(0, 0.4, across))
      .mul(this.fade);
    mat.mrtNode = groundNormalMrt();
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 27;
    return mesh;
  }

  private dropChosen(): void {
    const c = this.chosen;
    if (!c) return;
    for (const m of [c.pulse, c.arc, c.distance, c.tag]) {
      if (!m) continue;
      m.removeFromParent();
      m.geometry.dispose();
      const mat = m.material as THREE.MeshBasicNodeMaterial;
      mat.map?.dispose();
      mat.dispose();
    }
    this.chosen = null;
  }
}
