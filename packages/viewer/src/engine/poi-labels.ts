import * as THREE from 'three/webgpu';
import { toThree } from './geom';

/**
 * Points of interest on the map (F3, the map look): each point's icon — a
 * disc in its category's colour, the symbol from the host — and, closer in,
 * its name beside it; upright
 * to the screen, a steady screen size, over everything. They take the screen
 * after the street names (sharing their boxes) by rank: hospitals and
 * universities from far off, shops only close in.
 */

/** A point of interest, tile-local (x east, y north, z ground). */
export interface PoiPoint {
  kind: string;
  name?: string;
  position: [number, number, number];
}

interface Category {
  colour: string;
  /** Higher keeps its place when icons collide, and shows from further off. */
  rank: number;
}

const FOOD = '#e8833a';
const SHOP = '#3f86d4';
const HEALTH = '#e0474c';
const LEARN = '#9a7254';
const CULTURE = '#8e63c9';
const MONEY = '#2c9a8c';
const PUBLIC = '#5865b8';
const TRANSPORT = '#3a78b6';

const CATEGORY: Record<string, Category> = {
  restaurant: { colour: FOOD, rank: 2 },
  fast_food: { colour: FOOD, rank: 2 },
  cafe: { colour: FOOD, rank: 2 },
  bar: { colour: FOOD, rank: 2 },
  bakery: { colour: FOOD, rank: 2 },
  supermarket: { colour: SHOP, rank: 3 },
  mall: { colour: SHOP, rank: 4 },
  shop: { colour: SHOP, rank: 1 },
  pharmacy: { colour: HEALTH, rank: 3 },
  hospital: { colour: HEALTH, rank: 5 },
  clinic: { colour: HEALTH, rank: 2 },
  school: { colour: LEARN, rank: 4 },
  university: { colour: LEARN, rank: 5 },
  kindergarten: { colour: LEARN, rank: 2 },
  library: { colour: LEARN, rank: 3 },
  place_of_worship: { colour: '#6b7681', rank: 4 },
  museum: { colour: CULTURE, rank: 5 },
  culture: { colour: CULTURE, rank: 3 },
  hotel: { colour: '#cf4f93', rank: 4 },
  attraction: { colour: CULTURE, rank: 5 },
  bank: { colour: MONEY, rank: 3 },
  atm: { colour: MONEY, rank: 2 },
  post_office: { colour: PUBLIC, rank: 3 },
  police: { colour: PUBLIC, rank: 4 },
  fire_station: { colour: PUBLIC, rank: 4 },
  public_office: { colour: PUBLIC, rank: 4 },
  bus_station: { colour: TRANSPORT, rank: 5 },
  parking: { colour: TRANSPORT, rank: 2 },
};

/** By rank: shown within this distance (m) and where a pixel covers at most this many metres. */
const RANGE: Record<number, { distance: number; mpp: number }> = {
  5: { distance: 3500, mpp: 2.2 },
  4: { distance: 2200, mpp: 1.3 },
  3: { distance: 1400, mpp: 0.8 },
  2: { distance: 900, mpp: 0.55 },
  1: { distance: 600, mpp: 0.4 },
};
/** Names show beside the icons where a pixel covers at most this many metres. */
const NAME_MPP = 0.5;

/** Canvas pixels per screen pixel (crisp on high-density screens). */
const DPR = 2;
/** Icon disc diameter, gap before the name, name font (screen px). */
const DISC = 22;
/** The disc's centre from the quad's left edge (screen px). */
const CENTRE = DISC / 2 + 2;
const GAP = 4;
const FONT_PX = 12;
const HEIGHT = 26;
/** The point sits this far (m) above the ground. */
const LIFT = 1.5;

/** A point of interest of a tile and its quads once shown. */
export interface PoiMark {
  kind: string;
  name?: string;
  rank: number;
  /** Tile-local three.js position. */
  at: THREE.Vector3;
  mesh: THREE.Mesh | null;
  /** Its icon-and-name quad (made once the name first shows). */
  named: Art | null;
}

interface Art {
  material: THREE.MeshBasicNodeMaterial;
  /** Size (screen px). */
  width: number;
  height: number;
}

export function poiMarks(points: PoiPoint[] | undefined): PoiMark[] {
  const out: PoiMark[] = [];
  for (const p of points ?? []) {
    const cat = CATEGORY[p.kind];
    if (!cat) continue;
    out.push({
      kind: p.kind,
      name: p.name,
      rank: cat.rank,
      at: new THREE.Vector3(...toThree(p.position[0], p.position[1], p.position[2] + LIFT)),
      mesh: null,
      named: null,
    });
  }
  return out;
}

/** An SVG (markup) as an image. */
function svgImage(svg: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return img.decode().then(() => img);
}

/** The point-of-interest kinds the map draws (their icons come from the host). */
export const POI_ICON_KINDS: readonly string[] = Object.keys(CATEGORY);

/** Unit quad centred on the icon: x right, y up; scaled per frame to screen px. */
const QUAD = new THREE.PlaneGeometry(1, 1);

export class PoiLabeller {
  private on = false;
  private readonly icons = new Map<string, HTMLImageElement>();
  private readonly iconArt = new Map<string, Art>();
  /** An icon finished loading: place again. */
  private dirty = false;
  private readonly world = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly inverse = new THREE.Matrix4();
  /** Icons shown in the last update. */
  shown = 0;

  setEnabled(on: boolean, tiles: Iterable<{ pois: PoiMark[] }>): void {
    this.on = on;
    this.dirty = true;
    if (!on) for (const t of tiles) for (const m of t.pois) if (m.mesh) m.mesh.visible = false;
  }

  /**
   * The icons, as SVG markup by kind (white strokes on a transparent ground,
   * drawn on the category's disc); the host draws them (the engine knows no
   * icon set). A kind without one is not shown.
   */
  setIcons(svgs: Record<string, string>): void {
    for (const [kind, svg] of Object.entries(svgs))
      void svgImage(svg)
        .then((img) => {
          this.icons.set(kind, img);
          const old = this.iconArt.get(kind);
          old?.material.map?.dispose();
          old?.material.dispose();
          this.iconArt.delete(kind);
          this.dirty = true;
        })
        .catch(() => undefined);
  }

  /**
   * Places the icons of the shown tiles. `placed`: screen boxes already
   * taken (the street names); `changed`: the camera or the tiles moved since
   * the last call (else only a newly loaded icon places again).
   */
  update(
    tiles: Iterable<{ group: THREE.Group; pois: PoiMark[] }>,
    camera: THREE.PerspectiveCamera,
    width: number,
    height: number,
    placed: [number, number, number, number][],
    changed: boolean,
  ): void {
    if (!this.on || (!changed && !this.dirty)) return;
    this.dirty = false;
    const perPx = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / height;
    const eye = camera.position;
    type Candidate = { m: PoiMark; group: THREE.Group; d: number; mpp: number };
    const candidates: Candidate[] = [];
    for (const t of tiles) {
      if (!t.group.visible) continue;
      for (const m of t.pois) {
        if (m.mesh) m.mesh.visible = false;
        if (!this.icons.has(m.kind)) continue;
        this.world.copy(m.at).add(t.group.position);
        const d = this.world.distanceTo(eye);
        const mpp = d * perPx;
        const range = RANGE[m.rank] ?? RANGE[1];
        if (d > range.distance || mpp > range.mpp) continue;
        this.p.copy(this.world).project(camera);
        if (this.p.z > 1 || Math.abs(this.p.x) > 1.1 || Math.abs(this.p.y) > 1.1) continue;
        candidates.push({ m, group: t.group, d, mpp });
      }
    }
    candidates.sort((a, b) => b.m.rank - a.m.rank || a.d - b.d);
    this.shown = 0;
    for (const c of candidates) {
      const { m, mpp } = c;
      const art = mpp <= NAME_MPP && m.name ? this.namedArt(m) : this.icon(m.kind);
      this.world.copy(m.at).add(c.group.position);
      this.p.copy(this.world).project(camera);
      const sx = ((this.p.x + 1) / 2) * width;
      const sy = ((1 - this.p.y) / 2) * height;
      // The icon's centre on the point; a name runs to its right.
      const r: [number, number, number, number] = [
        sx - CENTRE,
        sy - art.height / 2,
        sx - CENTRE + art.width,
        sy + art.height / 2,
      ];
      if (placed.some((q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1])) continue;
      placed.push(r);
      const mesh = (m.mesh ??= this.mesh(c.group));
      mesh.material = art.material;
      // Upright to the screen: the camera's orientation, sized in pixels at its distance.
      this.scale.set(art.width * mpp, art.height * mpp, 1);
      this.offset.set((art.width / 2 - CENTRE) * mpp, 0, 0).applyQuaternion(camera.quaternion);
      mesh.matrix.compose(this.world.add(this.offset), camera.quaternion, this.scale);
      mesh.matrix.premultiply(this.inverse.copy(c.group.matrixWorld).invert());
      mesh.matrixWorldNeedsUpdate = true;
      mesh.visible = true;
      this.shown++;
    }
  }

  /** Frees the icon quads shared by kind (each tile frees its name quads). */
  dispose(): void {
    for (const art of this.iconArt.values()) {
      art.material.map?.dispose();
      art.material.dispose();
    }
    this.iconArt.clear();
  }

  private mesh(group: THREE.Group): THREE.Mesh {
    const mesh = new THREE.Mesh(QUAD);
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 901;
    mesh.name = 'poi';
    group.add(mesh);
    return mesh;
  }

  private icon(kind: string): Art {
    let art = this.iconArt.get(kind);
    if (!art) {
      art = this.draw(kind);
      this.iconArt.set(kind, art);
    }
    return art;
  }

  private namedArt(m: PoiMark): Art {
    return (m.named ??= this.draw(m.kind, m.name));
  }

  /** The icon disc (and the name beside it) on a canvas. */
  private draw(kind: string, name?: string): Art {
    const cat = CATEGORY[kind];
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    const font = `600 ${FONT_PX * DPR}px Inter, system-ui, sans-serif`;
    ctx.font = font;
    const textW = name ? ctx.measureText(name).width / DPR + GAP + 4 : 0;
    const width = Math.ceil(DISC + 4 + textW);
    canvas.width = width * DPR;
    canvas.height = HEIGHT * DPR;
    ctx.scale(DPR, DPR);
    const cx = CENTRE;
    const cy = HEIGHT / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, DISC / 2, 0, Math.PI * 2);
    ctx.fillStyle = cat.colour;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.stroke();
    const img = this.icons.get(kind);
    const s = DISC * 0.6;
    if (img) ctx.drawImage(img, cx - s / 2, cy - s / 2, s, s);
    if (name) {
      ctx.font = font.replace(`${FONT_PX * DPR}px`, `${FONT_PX}px`);
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      const x = DISC + 2 + GAP;
      ctx.strokeText(name, x, cy);
      ctx.fillStyle = shade(cat.colour);
      ctx.fillText(name, x, cy);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicNodeMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    material.fog = false;
    return { material, width, height: HEIGHT };
  }
}

/** A category colour darkened for its names (readable on light ground). */
function shade(hex: string): string {
  const c = new THREE.Color(hex);
  c.multiplyScalar(0.62);
  return `#${c.getHexString()}`;
}

/** Frees a tile's name quads (icon quads are shared by kind). */
export function disposePoiMarks(marks: PoiMark[]): void {
  for (const m of marks) {
    m.mesh?.removeFromParent();
    m.mesh = null;
    if (m.named) {
      m.named.material.map?.dispose();
      m.named.material.dispose();
      m.named = null;
    }
  }
}
