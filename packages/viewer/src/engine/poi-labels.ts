import * as THREE from 'three/webgpu';
import { toThree } from './geom';
import { DEFAULT_MAP_STYLE, type MapStyle, rangeOf } from './map-style';

/**
 * Points of interest on the map (F3, the map look): each point's icon — a
 * disc in its category's colour, the symbol from the host — and, closer in,
 * its name beside it; upright to the screen, a steady screen size, over
 * everything. They take the screen after the street names (sharing their
 * boxes) by rank: hospitals and universities from far off, shops only close
 * in. Colours, ranks and distances come from the map style (D-013).
 */

/** A point of interest, tile-local (x east, y north, z ground). */
export interface PoiPoint {
  kind: string;
  name?: string;
  position: [number, number, number];
}

/** Canvas pixels per screen pixel (crisp on high-density screens). */
const DPR = 2;
/** Gap before the name's pill and the margin round the pin (screen px). */
const GAP = 4;
const EDGE = 2;
/** The point sits this far (m) above the ground. */
const LIFT = 1.5;

/** A point of interest of a tile and its quads once shown. */
export interface PoiMark {
  kind: string;
  name?: string;
  /** Tile-local three.js position. */
  at: THREE.Vector3;
  mesh: THREE.Mesh | null;
  /** Its icon-and-name quad (made once the name first shows). */
  named: Art | null;
}

interface Art {
  material: THREE.MeshBasicNodeMaterial;
  /** Size (screen px), and the anchor — the stem's foot, on the point — from its top left. */
  width: number;
  height: number;
  ax: number;
  ay: number;
}

export function poiMarks(points: PoiPoint[] | undefined): PoiMark[] {
  const out: PoiMark[] = [];
  for (const p of points ?? []) {
    out.push({
      kind: p.kind,
      name: p.name,
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

/** The point-of-interest kinds the default style draws (their icons come from the host). */
export const POI_ICON_KINDS: readonly string[] = Object.keys(DEFAULT_MAP_STYLE.pois.categories);

/** Unit quad centred on the icon: x right, y up; scaled per frame to screen px. */
const QUAD = new THREE.PlaneGeometry(1, 1);

export class PoiLabeller {
  /**
   * The pins' own scene (world coordinates): the engine draws it apart and
   * lays it over the finished frame — in the main pass the post effects (AO,
   * tone mapping) darkened the quads round them and greyed their names.
   */
  readonly scene = new THREE.Scene();
  private on = false;
  private style = DEFAULT_MAP_STYLE.pois;
  private readonly icons = new Map<string, HTMLImageElement>();
  private readonly iconArt = new Map<string, Art>();
  /** An icon finished loading: place again. */
  private dirty = false;
  private readonly world = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  /** Icons shown in the last update. */
  shown = 0;

  setEnabled(on: boolean, tiles: Iterable<{ pois: PoiMark[] }>): void {
    this.on = on;
    this.dirty = true;
    if (!on) for (const t of tiles) for (const m of t.pois) if (m.mesh) m.mesh.visible = false;
  }

  /** A new style: icon and name quads are drawn again in it. */
  setStyle(style: MapStyle, tiles: Iterable<{ pois: PoiMark[] }>): void {
    this.style = style.pois;
    this.dispose();
    for (const t of tiles) disposePoiMarks(t.pois);
    this.dirty = true;
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
    /** The camera's height over the ground (m): the icons' reach grows with it. */
    cameraHeight: number,
  ): void {
    if (!this.on || (!changed && !this.dirty)) return;
    this.dirty = false;
    const perPx = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / height;
    const eye = camera.position;
    const reach = Math.max(this.style.reach.near, cameraHeight * this.style.reach.perHeight);
    type Candidate = { m: PoiMark; rank: number; group: THREE.Group; d: number; mpp: number };
    const candidates: Candidate[] = [];
    for (const t of tiles) {
      if (!t.group.visible) continue;
      for (const m of t.pois) {
        if (m.mesh) m.mesh.visible = false;
        const cat = this.style.categories[m.kind];
        if (!cat || !this.icons.has(m.kind)) continue;
        this.world.copy(m.at).add(t.group.position);
        const d = this.world.distanceTo(eye);
        const mpp = d * perPx;
        const range = rangeOf(this.style.ranges, cat.rank);
        if (d > Math.min(range.distance, reach) || mpp > range.mpp) continue;
        this.p.copy(this.world).project(camera);
        if (this.p.z > 1 || Math.abs(this.p.x) > 1.1 || Math.abs(this.p.y) > 1.1) continue;
        candidates.push({ m, rank: cat.rank, group: t.group, d, mpp });
      }
    }
    candidates.sort((a, b) => b.rank - a.rank || a.d - b.d);
    this.shown = 0;
    for (const c of candidates) {
      const { m, mpp } = c;
      const art = mpp <= this.style.nameMpp && m.name ? this.namedArt(m) : this.icon(m.kind);
      this.world.copy(m.at).add(c.group.position);
      this.p.copy(this.world).project(camera);
      const sx = ((this.p.x + 1) / 2) * width;
      const sy = ((1 - this.p.y) / 2) * height;
      // The stem's foot on the point; the pin stands above it, a name to its right.
      const r: [number, number, number, number] = [
        sx - art.ax,
        sy - art.ay,
        sx - art.ax + art.width,
        sy - art.ay + art.height,
      ];
      if (placed.some((q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1])) continue;
      placed.push(r);
      const mesh = (m.mesh ??= this.mesh());
      mesh.material = art.material;
      // Upright to the screen: the camera's orientation, sized in pixels at its distance.
      this.scale.set(art.width * mpp, art.height * mpp, 1);
      this.offset
        .set((art.width / 2 - art.ax) * mpp, (art.ay - art.height / 2) * mpp, 0)
        .applyQuaternion(camera.quaternion);
      mesh.matrix.compose(this.world.add(this.offset), camera.quaternion, this.scale);
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

  private mesh(): THREE.Mesh {
    const mesh = new THREE.Mesh(QUAD);
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 901;
    mesh.name = 'poi';
    this.scene.add(mesh);
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

  /**
   * The pin on a canvas: the rounded square in the category's colour with
   * the icon, its stem down to the point, and the name's pill beside it.
   */
  private draw(kind: string, name?: string): Art {
    const { tilePx: tile, stemPx: stem, fontPx } = this.style;
    const cat = this.style.categories[kind];
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    const font = (px: number) => `600 ${px}px Inter, system-ui, sans-serif`;
    ctx.font = font(fontPx * DPR);
    const padX = 6;
    const pillW = name ? ctx.measureText(name).width / DPR + padX * 2 : 0;
    const pillH = fontPx + 9;
    const width = Math.ceil(EDGE + tile + (name ? GAP + pillW : 0) + EDGE);
    const height = Math.ceil(EDGE + tile + stem + 3);
    canvas.width = width * DPR;
    canvas.height = height * DPR;
    ctx.scale(DPR, DPR);
    const x0 = EDGE;
    const y0 = EDGE;
    const cx = x0 + tile / 2;
    // Stem and its foot (the point).
    ctx.fillStyle = this.style.border;
    ctx.fillRect(cx - 1, y0 + tile, 2, stem);
    ctx.beginPath();
    ctx.arc(cx, y0 + tile + stem, 2.2, 0, Math.PI * 2);
    ctx.fillStyle = cat.colour;
    ctx.fill();
    // The square.
    roundRect(ctx, x0, y0, tile, tile, 6);
    ctx.fillStyle = cat.colour;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = this.style.border;
    ctx.stroke();
    const img = this.icons.get(kind);
    const s = tile * 0.62;
    if (img) ctx.drawImage(img, cx - s / 2, y0 + tile / 2 - s / 2, s, s);
    if (name) {
      const px = x0 + tile + GAP;
      const py = y0 + (tile - pillH) / 2;
      roundRect(ctx, px, py, pillW, pillH, 6);
      ctx.fillStyle = this.style.pill;
      ctx.fill();
      ctx.font = font(fontPx);
      ctx.textBaseline = 'middle';
      ctx.fillStyle = this.style.nameColor;
      ctx.fillText(name, px + padX, py + pillH / 2 + 0.5);
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
    material.alphaTest = 0.04;
    return { material, width, height, ax: cx, ay: y0 + tile + stem };
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
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
