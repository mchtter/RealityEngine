import { uniform } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { toThree } from './geom';
import { textLabel, type TextLabelStyle } from './overview-map';
import { type StreetLine, straightestRun } from './street-lines';

/**
 * Street names written along the street (F3, the map look): each named
 * street piece of a tile gets its name on the straightest run of its
 * centreline, lying on the street (map-aligned, as on a map), turned to
 * read left to right. Letters keep a screen size; a name shows only where
 * its run is long enough for it, and names that would overlap on screen —
 * or repeat the same name too close — give way by street class.
 */

/** A street name of a tile: where it may lie, and its text quad once first shown. */
export interface StreetLabel {
  name: string;
  rank: number;
  /** Run middle and unit direction (tile-local three.js coords; direction follows the slope). */
  mid: THREE.Vector3;
  dir: THREE.Vector3;
  /** Run length (m): the name must fit in it. */
  room: number;
  mesh: THREE.Mesh | null;
  /** Quad width per unit letter height. */
  aspect: number;
}

export function streetLabels(lines: StreetLine[] | undefined): StreetLabel[] {
  const out: StreetLabel[] = [];
  for (const s of lines ?? []) {
    const run = straightestRun(s.path);
    if (!run || run.length < 20) continue;
    const a = new THREE.Vector3(...toThree(...run.a));
    const b = new THREE.Vector3(...toThree(...run.b));
    out.push({
      name: s.name,
      rank: s.rank,
      mid: a.clone().add(b).multiplyScalar(0.5),
      dir: b.sub(a).normalize(),
      room: run.length,
      mesh: null,
      aspect: 0,
    });
  }
  return out;
}

/** Text line height on screen (px; capitals come to about 0.7 of it). */
const LETTER_PX = 17;
/**
 * Least share of its length a flat name's axis may keep seen at a slant:
 * up to this, each axis is stretched back to its screen size (the name
 * reads the same from any pitch); beyond, it foreshortens like the street.
 */
const MIN_SLANT = 0.35;
/** Names are written within this distance (m) of the camera … */
const MAX_DISTANCE = 1500;
/** … and where a screen pixel covers at most this many metres. */
const MAX_MPP = 0.9;
/** A name's quad lies this far (m) above the street surface. */
const LIFT = 0.35;
/** The same name is not repeated within this screen distance (px). */
const REPEAT_PX = 260;
/** Share of its run a name may fill. */
const FILL = 0.85;

const STYLE: TextLabelStyle = {
  font: '600 64px Inter, system-ui, sans-serif',
  color: '#30343b',
  halo: 'rgba(255,255,255,0.92)',
  spacing: '0.5px',
};

/** Places the street names of the shown tiles each frame (the map look). */
export class StreetLabeller {
  private readonly fade = uniform(1);
  private on = false;
  private readonly world = new THREE.Vector3();
  private readonly ahead = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly side = new THREE.Vector3();
  private readonly corner = new THREE.Vector3();
  private readonly basis = new THREE.Matrix4();
  /** Names shown in the last update. */
  shown = 0;

  setEnabled(on: boolean, tiles: Iterable<{ labels: StreetLabel[] }>): void {
    this.on = on;
    if (!on) for (const t of tiles) for (const l of t.labels) if (l.mesh) l.mesh.visible = false;
  }

  update(
    tiles: Iterable<{ group: THREE.Group; labels: StreetLabel[] }>,
    camera: THREE.PerspectiveCamera,
    width: number,
    height: number,
  ): void {
    if (!this.on) return;
    const perPx = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / height;
    const eye = camera.position;
    type Candidate = {
      l: StreetLabel;
      group: THREE.Group;
      d: number;
      h: number;
      /** Stretch along / across the name against foreshortening. */
      fx: number;
      fz: number;
    };
    const candidates: Candidate[] = [];
    for (const t of tiles) {
      if (!t.group.visible) continue;
      for (const l of t.labels) {
        if (l.mesh) l.mesh.visible = false;
        this.world.copy(l.mid).add(t.group.position);
        const d = this.world.distanceTo(eye);
        const mpp = d * perPx;
        if (d > MAX_DISTANCE || mpp > MAX_MPP) continue;
        const h = mpp * LETTER_PX;
        // Seen along the view ray v, a flat axis a keeps |a − (a·v) v| of its length.
        this.ahead.copy(this.world).sub(eye).normalize();
        const along = l.dir.dot(this.ahead);
        this.side.crossVectors(l.dir, this.up.set(0, 1, 0)).normalize();
        const across = this.side.dot(this.ahead);
        const fx = 1 / Math.max(Math.sqrt(1 - along * along), MIN_SLANT);
        const fz = 1 / Math.max(Math.sqrt(1 - across * across), MIN_SLANT);
        if (!l.mesh) this.build(l, t.group);
        if (l.aspect * h * fx > l.room * FILL) continue;
        candidates.push({ l, group: t.group, d, h, fx, fz });
      }
    }
    candidates.sort((x, y) => y.l.rank - x.l.rank || x.d - y.d);
    const placed: [number, number, number, number][] = [];
    const named = new Map<string, [number, number][]>();
    this.shown = 0;
    for (const c of candidates) {
      const { l, h, fx, fz } = c;
      const mesh = l.mesh!;
      this.world.copy(l.mid).add(c.group.position);
      // Read left to right: the direction that runs rightwards on screen.
      const p0 = this.corner.copy(this.world).project(camera);
      const x0 = p0.x;
      if (p0.z > 1) continue;
      const p1 = this.ahead.copy(this.world).add(l.dir).project(camera);
      const sign = p1.x >= x0 ? 1 : -1;
      this.ahead.copy(l.dir).multiplyScalar(sign);
      // Up: square to the run (it follows the slope), towards the sky.
      this.up.set(0, 1, 0).addScaledVector(this.ahead, -this.ahead.y).normalize();
      this.side.crossVectors(this.ahead, this.up);
      this.basis.makeBasis(this.ahead, this.up, this.side);
      mesh.matrix.copy(this.basis).scale(this.corner.set(h * fx, h, h * fz));
      mesh.matrix.setPosition(
        this.world.copy(l.mid).addScaledVector(this.up, LIFT).add(c.group.position),
      );
      // Screen box of the quad (its corners).
      let bx0 = Infinity;
      let by0 = Infinity;
      let bx1 = -Infinity;
      let by1 = -Infinity;
      const halfW = (l.aspect * h * fx) / 2;
      const halfH = 0.75 * h * fz;
      for (const [u, v] of [
        [-halfW, -halfH],
        [halfW, -halfH],
        [-halfW, halfH],
        [halfW, halfH],
      ]) {
        this.corner
          .copy(this.world)
          .addScaledVector(this.ahead, u)
          .addScaledVector(this.side, v)
          .project(camera);
        const sx = ((this.corner.x + 1) / 2) * width;
        const sy = ((1 - this.corner.y) / 2) * height;
        bx0 = Math.min(bx0, sx);
        bx1 = Math.max(bx1, sx);
        by0 = Math.min(by0, sy);
        by1 = Math.max(by1, sy);
      }
      if (bx1 < 0 || bx0 > width || by1 < 0 || by0 > height) continue;
      // The halo and padding fill the quad's edges: a little slack.
      const r: [number, number, number, number] = [bx0 + 2, by0 + 2, bx1 - 2, by1 - 2];
      if (placed.some((q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1])) continue;
      const cx = (bx0 + bx1) / 2;
      const cy = (by0 + by1) / 2;
      const same = named.get(l.name);
      if (same?.some(([x, y]) => Math.hypot(x - cx, y - cy) < REPEAT_PX)) continue;
      placed.push(r);
      if (same) same.push([cx, cy]);
      else named.set(l.name, [[cx, cy]]);
      // The matrix is world: the mesh hangs in the scene root's frame via its tile group.
      mesh.matrix.premultiply(this.basis.copy(c.group.matrixWorld).invert());
      mesh.matrixWorldNeedsUpdate = true;
      mesh.visible = true;
      this.shown++;
    }
  }

  private build(l: StreetLabel, group: THREE.Group): void {
    const mesh = textLabel(l.name, STYLE, this.fade);
    // textLabel lies flat with its letters' tops to −z; the basis maps its x along the run.
    const g = mesh.geometry as THREE.PlaneGeometry;
    l.aspect = g.parameters.width / 1.5;
    const mat = mesh.material as THREE.MeshBasicNodeMaterial;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    mat.polygonOffsetUnits = -4;
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 20;
    mesh.visible = false;
    mesh.name = 'street-label';
    group.add(mesh);
    l.mesh = mesh;
  }
}

/** Frees the text quads of a tile's names. */
export function disposeStreetLabels(labels: StreetLabel[]): void {
  for (const l of labels) {
    if (!l.mesh) continue;
    l.mesh.removeFromParent();
    l.mesh.geometry.dispose();
    const mat = l.mesh.material as THREE.MeshBasicNodeMaterial;
    mat.map?.dispose();
    mat.dispose();
    l.mesh = null;
  }
}
