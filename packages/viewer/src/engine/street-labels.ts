import { uniform } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { toThree } from './geom';
import { textLabel, type TextLabelStyle } from './overview-map';
import { type StreetLine, straightRuns } from './street-lines';

/**
 * Street names written along the street (F3, the map look): each named
 * street piece of a tile gets its name on the straightest run of its
 * centreline, lying on the street (map-aligned, as on a map), turned to
 * read left to right. Letters keep a screen size; a name shows only where
 * its run is long enough for it, and names that would overlap on screen —
 * or repeat the same name too close — give way by street class.
 */

/** A name's text quad, drawn once per tile and shared by its places. */
export interface NameGlyph {
  name: string;
  art: { geometry: THREE.BufferGeometry; material: THREE.Material; aspect: number } | null;
}

/** A place for a street name in a tile, and its quad once first shown. */
export interface StreetLabel {
  glyph: NameGlyph;
  rank: number;
  /** Run middle and unit direction (tile-local three.js coords; direction follows the slope). */
  mid: THREE.Vector3;
  dir: THREE.Vector3;
  /** Run length (m): the name must fit in it. */
  room: number;
  mesh: THREE.Mesh | null;
}

/** A run shorter than this (m) holds no name at any scale. */
const MIN_ROOM = 30;

/** Every straight run of a tile's named streets long enough for a name, one glyph per name. */
export function streetLabels(lines: StreetLine[] | undefined): StreetLabel[] {
  const glyphs = new Map<string, NameGlyph>();
  const out: StreetLabel[] = [];
  for (const s of lines ?? []) {
    for (const run of straightRuns(s.path)) {
      if (run.length < MIN_ROOM) continue;
      let glyph = glyphs.get(s.name);
      if (!glyph) glyphs.set(s.name, (glyph = { name: s.name, art: null }));
      const a = new THREE.Vector3(...toThree(...run.a));
      const b = new THREE.Vector3(...toThree(...run.b));
      out.push({
        glyph,
        rank: s.rank,
        mid: a.clone().add(b).multiplyScalar(0.5),
        dir: b.sub(a).normalize(),
        room: run.length,
        mesh: null,
      });
    }
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
/**
 * By street rank: names are written within this distance (m) of the camera
 * and where a screen pixel covers at most this many metres — main roads
 * from high up, side streets close in.
 */
const RANGE: Record<number, { distance: number; mpp: number }> = {
  6: { distance: 7000, mpp: 4 },
  5: { distance: 6000, mpp: 3.5 },
  4: { distance: 4000, mpp: 2.4 },
  3: { distance: 2500, mpp: 1.5 },
  2: { distance: 1500, mpp: 0.9 },
  1: { distance: 900, mpp: 0.6 },
};
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
  /** Camera and tiles of the last placement: unchanged, the names stay where they are. */
  private readonly lastView = new THREE.Matrix4();
  private lastTiles: unknown[] = [];
  private lastSize = '';

  setEnabled(on: boolean, tiles: Iterable<{ labels: StreetLabel[] }>): void {
    this.on = on;
    this.lastTiles = [];
    if (!on) for (const t of tiles) for (const l of t.labels) if (l.mesh) l.mesh.visible = false;
  }

  update(
    tiles: Iterable<{ group: THREE.Group; labels: StreetLabel[] }>,
    camera: THREE.PerspectiveCamera,
    width: number,
    height: number,
    /** Place again even if nothing moved (measurement). */
    force = false,
  ): void {
    if (!this.on) return;
    const list = [...tiles];
    const size = `${width}x${height}`;
    if (
      !force &&
      list.length === this.lastTiles.length &&
      list.every((t, i) => t === this.lastTiles[i]) &&
      size === this.lastSize &&
      this.lastView.equals(camera.matrixWorld)
    )
      return;
    this.lastView.copy(camera.matrixWorld);
    this.lastTiles = list;
    this.lastSize = size;
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
    for (const t of list) {
      if (!t.group.visible) continue;
      for (const l of t.labels) {
        if (l.mesh) l.mesh.visible = false;
        this.world.copy(l.mid).add(t.group.position);
        const d = this.world.distanceTo(eye);
        const mpp = d * perPx;
        const range = RANGE[l.rank] ?? RANGE[1];
        if (d > range.distance || mpp > range.mpp) continue;
        // Off screen (with a margin for the name's length): not placed.
        this.corner.copy(this.world).project(camera);
        if (this.corner.z > 1 || Math.abs(this.corner.x) > 1.6 || Math.abs(this.corner.y) > 1.6)
          continue;
        const h = mpp * LETTER_PX;
        // Seen along the view ray v, a flat axis a keeps |a − (a·v) v| of its length.
        this.ahead.copy(this.world).sub(eye).normalize();
        const along = l.dir.dot(this.ahead);
        this.side.crossVectors(l.dir, this.up.set(0, 1, 0)).normalize();
        const across = this.side.dot(this.ahead);
        const fx = 1 / Math.max(Math.sqrt(1 - along * along), MIN_SLANT);
        const fz = 1 / Math.max(Math.sqrt(1 - across * across), MIN_SLANT);
        if (!l.mesh) this.build(l, t.group);
        if (l.glyph.art!.aspect * h * fx > l.room * FILL) continue;
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
      const halfW = (l.glyph.art!.aspect * h * fx) / 2;
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
      const same = named.get(l.glyph.name);
      if (same?.some(([x, y]) => Math.hypot(x - cx, y - cy) < REPEAT_PX)) continue;
      placed.push(r);
      if (same) same.push([cx, cy]);
      else named.set(l.glyph.name, [[cx, cy]]);
      // The matrix is world: the mesh hangs in the scene root's frame via its tile group.
      mesh.matrix.premultiply(this.basis.copy(c.group.matrixWorld).invert());
      mesh.matrixWorldNeedsUpdate = true;
      mesh.visible = true;
      this.shown++;
    }
  }

  private build(l: StreetLabel, group: THREE.Group): void {
    if (!l.glyph.art) {
      const text = textLabel(l.glyph.name, STYLE, this.fade);
      // textLabel lies flat with its letters' tops to −z; the basis maps its x along the run.
      const geometry = text.geometry as THREE.PlaneGeometry;
      const material = text.material as THREE.MeshBasicNodeMaterial;
      material.polygonOffset = true;
      material.polygonOffsetFactor = -2;
      material.polygonOffsetUnits = -4;
      l.glyph.art = { geometry, material, aspect: geometry.parameters.width / 1.5 };
    }
    const mesh = new THREE.Mesh(l.glyph.art.geometry, l.glyph.art.material);
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
  const glyphs = new Set<NameGlyph>();
  for (const l of labels) {
    l.mesh?.removeFromParent();
    l.mesh = null;
    glyphs.add(l.glyph);
  }
  for (const g of glyphs) {
    if (!g.art) continue;
    g.art.geometry.dispose();
    const mat = g.art.material as THREE.MeshBasicNodeMaterial;
    mat.map?.dispose();
    mat.dispose();
    g.art = null;
  }
}
