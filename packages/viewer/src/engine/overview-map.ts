import { utmForward } from '@opentwin/city-core';
import {
  abs,
  attribute,
  cameraViewMatrix,
  float,
  fract,
  mrt,
  oneMinus,
  positionLocal,
  smoothstep,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import {
  type Polygon,
  type Ring,
  insidePolygon,
  overlaps,
  samplePoints,
  thinRing,
} from './overview-geo';

// =============================================================================
// L0 — the overview map: the country as a game-style parchment map lying on a
// plane (sea with rippled coasts, land, province borders, names written on
// the map). Shown by the engine above the city (the camera beyond ~10 km);
// provinces can be picked (hover highlight, a card, a click into the city).
// Data: Natural Earth (public domain), see tools/l0-map-data.mjs.
// Built in anchor-relative metres of the city's UTM zone (x east, y north);
// the engine places the group for the world origin and the map's height.
// =============================================================================

export interface OverviewProvince {
  code: number;
  name: string;
  capital: [number, number];
  label: [number, number];
  /** Degrees, counter-clockwise from east. */
  labelAngle: number;
  /** 0 … 1 among the provinces (by area). */
  labelSize: number;
  polygons: Polygon[];
}

export interface OverviewData {
  source: string;
  bbox: [number, number, number, number];
  provinces: OverviewProvince[];
  countries: { name: string; label: [number, number]; polygons: Polygon[] }[];
  lakes: { name: string | null; polygons: Polygon[] }[];
  /** `size`: 1 open sea … smaller for narrow ones. */
  seas: { name: string; label: [number, number]; angle: number; size?: number }[];
  towns: { name: string; at: [number, number]; pop: number }[];
}

/** A province under the pointer. */
export interface OverviewPick {
  code: number;
  name: string;
  /** The tenant's work area covers part of it. */
  hasData: boolean;
  polygons: Polygon[];
  capital: [number, number];
}

/** Map picture width (px): ~540 m a pixel over the map's extent; lines and names are geometry. */
const MAP_PX = 4096;
/** Parchment, sea and ink. */
const PAPER = '#f6e7c1';
const PAPER_DARK = '#e2cc9a';
const NEIGHBOUR = '#e6d4ab';
const SEA = '#b4c6ae';
const SEA_INK = '#6d8571';
const INK = '#4a3520';
const DATA_GREEN = new THREE.Color('#2fbf71');
const NO_DATA_RED = new THREE.Color('#e5484d');
/** Towns show once a pixel covers less than this (m). */
const TOWNS_BELOW_MPP = 260;

const groundNormalMrt = () => mrt({ normal: cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz });

interface Label {
  mesh: THREE.Mesh;
  /** Letter height (m) at the map's natural scale. */
  base: number;
  /** Screen letter height range (px). */
  minPx: number;
  maxPx: number;
  town: boolean;
}

export class OverviewMap {
  readonly group = new THREE.Group();
  readonly anchorE: number;
  readonly anchorN: number;
  private readonly project: (lon: number, lat: number) => [number, number];
  private readonly plane: THREE.Mesh;
  private readonly planeMat: THREE.MeshBasicNodeMaterial;
  private readonly labels: Label[] = [];
  private readonly lineMats: { mat: THREE.MeshBasicNodeMaterial; px: number }[] = [];
  /** Metres per screen pixel at the camera target (line widths, name sizes). */
  private readonly mpp = uniform(500);
  private readonly fade = uniform(1);
  private readonly highlightColor = uniform(new THREE.Color());
  private readonly fills = new Map<number, THREE.Mesh>();
  private readonly outlines = new Map<number, THREE.Mesh>();
  private hovered: number | null = null;
  private readonly hasData = new Map<number, boolean>();
  /** Map extent in anchor metres: west, south, east, north. */
  readonly extent: [number, number, number, number];

  constructor(
    readonly data: OverviewData,
    readonly zone: number,
    /** The tenant's work area (lon/lat outer rings with holes), null: none. */
    workArea: Polygon[] | null,
  ) {
    const [w, s, e, n] = data.bbox;
    const [cE, cN] = utmForward((w + e) / 2, (s + n) / 2, zone);
    this.anchorE = Math.round(cE / 1000) * 1000;
    this.anchorN = Math.round(cN / 1000) * 1000;
    this.project = (lon, lat) => {
      const [pe, pn] = utmForward(lon, lat, zone);
      return [pe - this.anchorE, pn - this.anchorN];
    };
    // Extent: the bbox's edges sampled (UTM bends them).
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let k = 0; k <= 40; k++) {
      const f = k / 40;
      for (const [lon, lat] of [
        [w + (e - w) * f, s],
        [w + (e - w) * f, n],
        [w, s + (n - s) * f],
        [e, s + (n - s) * f],
      ]) {
        const [x, y] = this.project(lon, lat);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    this.extent = [minX, minY, maxX, maxY];

    // The parchment picture on a plane.
    const texture = new THREE.CanvasTexture(this.paint());
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    const planeGeo = new THREE.PlaneGeometry(maxX - minX, maxY - minY);
    planeGeo.rotateX(-Math.PI / 2);
    this.planeMat = new THREE.MeshBasicNodeMaterial({ map: texture });
    this.planeMat.fog = false;
    this.planeMat.mrtNode = groundNormalMrt();
    this.planeMat.opacityNode = this.fade;
    this.plane = new THREE.Mesh(planeGeo, this.planeMat);
    this.plane.position.set((minX + maxX) / 2, 0, -(minY + maxY) / 2);
    this.plane.name = 'overview-plane';
    this.plane.renderOrder = 20;
    this.group.add(this.plane);
    // Paper beyond the map (the camera is kept over it; this only hides the void at the edges).
    const outer = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicNodeMaterial({ color: PAPER_DARK }),
    );
    (outer.material as THREE.MeshBasicNodeMaterial).fog = false;
    (outer.material as THREE.MeshBasicNodeMaterial).mrtNode = groundNormalMrt();
    outer.scale.set((maxX - minX) * 6, 1, (maxY - minY) * 6);
    outer.position.set((minX + maxX) / 2, -50, -(minY + maxY) / 2);
    outer.renderOrder = 19;
    outer.name = 'overview-outer';
    this.group.add(outer);
    this.setFade(1);

    // Ink: neighbours' and provinces' borders, lakes' shores.
    this.group.add(
      this.lines(
        data.countries.flatMap((c) => c.polygons.flat()),
        { px: 1.6, color: INK, opacity: 0.75 },
      ),
    );
    this.group.add(
      this.lines(
        data.provinces.flatMap((p) => p.polygons.flat()),
        { px: 1.3, color: INK, opacity: 0.6, dash: true },
      ),
    );
    this.group.add(
      this.lines(
        data.lakes.flatMap((l) => l.polygons.flat()),
        { px: 1, color: SEA_INK, opacity: 0.8 },
      ),
    );

    // Highlight fill and outline per province (shown on hover).
    for (const p of data.provinces) {
      const fill = this.fill(p.polygons);
      fill.visible = false;
      this.fills.set(p.code, fill);
      this.group.add(fill);
      const outline = this.lines(p.polygons.flat(), {
        px: 3,
        color: '#ffffff',
        opacity: 0.95,
        highlight: true,
      });
      outline.visible = false;
      this.outlines.set(p.code, outline);
      this.group.add(outline);
    }
    // The work area has tens of thousands of vertices: thinned for the point tests.
    const area = workArea?.map((poly) => poly.map((ring) => thinRing(ring, 0.003))) ?? null;
    const areaSamples = area ? samplePoints(area) : [];
    for (const p of data.provinces)
      this.hasData.set(p.code, !!area && overlaps(p.polygons, area, areaSamples));

    // Names written on the map.
    for (const p of data.provinces)
      this.label(p.name.toLocaleUpperCase('tr'), p.label, p.labelAngle, {
        base: 4500 + 9000 * p.labelSize,
        minPx: 10,
        maxPx: 30,
        font: '700 96px Georgia, "Times New Roman", serif',
        color: INK,
        halo: 'rgba(245,232,200,0.9)',
        spacing: '0.16em',
      });
    for (const c of data.countries)
      this.label(c.name.toLocaleUpperCase('tr'), c.label, 0, {
        base: 14000,
        minPx: 11,
        maxPx: 26,
        font: '600 96px Georgia, "Times New Roman", serif',
        color: 'rgba(74,53,32,0.55)',
        halo: 'rgba(240,226,190,0.6)',
        spacing: '0.3em',
      });
    for (const sea of data.seas)
      this.label(sea.name.toLocaleUpperCase('tr'), sea.label, sea.angle, {
        base: 26000 * (sea.size ?? 1),
        minPx: 8 + 4 * (sea.size ?? 1),
        maxPx: 40 * (sea.size ?? 1),
        font: 'italic 600 96px Georgia, "Times New Roman", serif',
        color: 'rgba(52,78,64,0.7)',
        halo: null,
        spacing: '0.45em',
      });
    for (const t of data.towns)
      this.label(t.name, t.at, 0, {
        base: 2200,
        minPx: 9,
        maxPx: 14,
        font: '600 80px Georgia, "Times New Roman", serif',
        color: 'rgba(74,53,32,0.85)',
        halo: 'rgba(245,232,200,0.85)',
        spacing: '0.04em',
        town: true,
        dot: true,
      });
  }

  /** Province code → whether the tenant's work area covers part of it. */
  provinceHasData(code: number): boolean {
    return this.hasData.get(code) ?? false;
  }

  /** The province at a point (lon/lat), with its data state; null over sea / abroad. */
  pick(lon: number, lat: number): OverviewPick | null {
    for (const p of this.data.provinces) {
      if (!p.polygons.some((poly) => insidePolygon(poly, lon, lat))) continue;
      return {
        code: p.code,
        name: p.name,
        hasData: this.provinceHasData(p.code),
        polygons: p.polygons,
        capital: p.capital,
      };
    }
    return null;
  }

  /** Highlights a province (green: data, red: none); null clears. */
  setHover(code: number | null): void {
    if (code === this.hovered) return;
    if (this.hovered !== null) {
      this.fills.get(this.hovered)!.visible = false;
      this.outlines.get(this.hovered)!.visible = false;
    }
    this.hovered = code;
    if (code === null) return;
    this.highlightColor.value.copy(this.provinceHasData(code) ? DATA_GREEN : NO_DATA_RED);
    this.fills.get(code)!.visible = true;
    this.outlines.get(code)!.visible = true;
  }

  /** 0 … 1: the map fading in over the city. Opaque at 1 (it then hides the city). */
  setFade(k: number): void {
    this.fade.value = k;
    const solid = k >= 0.999;
    if (this.planeMat.transparent === solid) {
      this.planeMat.transparent = !solid;
      this.planeMat.depthWrite = solid;
      this.planeMat.depthTest = solid;
      this.planeMat.needsUpdate = true;
    }
    this.group.visible = k > 0.001;
  }

  /**
   * Metres per screen pixel at the camera target: line widths and the size of
   * names follow it (names stay on the map, between a least and a largest
   * screen size); towns show only close in.
   */
  setScale(metresPerPixel: number, liftM: number): void {
    this.mpp.value = metresPerPixel;
    for (const m of this.lineMats) m.mat.userData.lift.value = liftM;
    for (const l of this.labels) {
      const h = THREE.MathUtils.clamp(l.base, metresPerPixel * l.minPx, metresPerPixel * l.maxPx);
      l.mesh.scale.setScalar(h);
      l.mesh.position.y = liftM * 1.5;
      if (l.town) l.mesh.visible = metresPerPixel < TOWNS_BELOW_MPP;
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      const mat = m.material as THREE.MeshBasicNodeMaterial;
      mat.map?.dispose();
      mat.dispose();
    });
  }

  // ─── building ─────────────────────────────────────────────────────────────

  /** The parchment: sea, rippled coasts, land (Turkey lighter), lakes, grain, darker edges. */
  private paint(): HTMLCanvasElement {
    const [minX, minY, maxX, maxY] = this.extent;
    const W = MAP_PX;
    const H = Math.round((W * (maxY - minY)) / (maxX - minX));
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d')!;
    const px = (x: number) => ((x - minX) / (maxX - minX)) * W;
    const py = (y: number) => ((maxY - y) / (maxY - minY)) * H;
    const path = (polys: Polygon[]) => {
      const p = new Path2D();
      for (const poly of polys)
        for (const ring of poly) {
          ring.forEach(([lon, lat], i) => {
            const [x, y] = this.project(lon, lat);
            if (i === 0) p.moveTo(px(x), py(y));
            else p.lineTo(px(x), py(y));
          });
          p.closePath();
        }
      return p;
    };
    const turkey = path(this.data.provinces.flatMap((p) => p.polygons));
    const abroad = path(this.data.countries.flatMap((c) => c.polygons));
    const lakes = path(this.data.lakes.flatMap((l) => l.polygons));

    ctx.fillStyle = SEA;
    ctx.fillRect(0, 0, W, H);
    // Ripples along the coasts: the land's outline stroked wider and fainter, under the land.
    ctx.lineJoin = 'round';
    for (const [width, alpha] of [
      [34, 0.06],
      [24, 0.09],
      [15, 0.13],
      [8, 0.2],
    ] as const) {
      ctx.strokeStyle = `rgba(80,104,86,${alpha})`;
      ctx.lineWidth = width;
      ctx.stroke(turkey);
      ctx.stroke(abroad);
    }
    ctx.fillStyle = NEIGHBOUR;
    ctx.fill(abroad, 'evenodd');
    ctx.fillStyle = PAPER;
    ctx.fill(turkey, 'nonzero');
    // Lakes with a ripple inside their shore.
    ctx.save();
    ctx.clip(lakes, 'evenodd');
    ctx.fillStyle = SEA;
    ctx.fill(lakes, 'evenodd');
    ctx.strokeStyle = 'rgba(80,104,86,0.25)';
    ctx.lineWidth = 6;
    ctx.stroke(lakes);
    ctx.restore();
    // Coast ink.
    ctx.strokeStyle = 'rgba(74,53,32,0.55)';
    ctx.lineWidth = 1.5;
    ctx.stroke(turkey);
    // Paper: soft stains and grain over everything.
    let seed = 7;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let k = 0; k < 90; k++) {
      const x = rand() * W;
      const y = rand() * H;
      const r = (0.04 + rand() * 0.16) * W;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const dark = rand() < 0.6;
      g.addColorStop(0, dark ? 'rgba(120,84,40,0.07)' : 'rgba(255,248,225,0.08)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    const grain = document.createElement('canvas');
    grain.width = grain.height = 256;
    const gctx = grain.getContext('2d')!;
    const img = gctx.createImageData(256, 256);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 110 + rand() * 120;
      img.data[i] = v;
      img.data[i + 1] = v * 0.85;
      img.data[i + 2] = v * 0.6;
      img.data[i + 3] = 22;
    }
    gctx.putImageData(img, 0, 0);
    ctx.fillStyle = ctx.createPattern(grain, 'repeat')!;
    ctx.fillRect(0, 0, W, H);
    // Edges burnt darker, like an old sheet.
    const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, W * 0.62);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(92,62,28,0.3)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
    return canvas;
  }

  /**
   * Rings as ribbons on the map, `px` screen pixels wide at any zoom (the
   * offset scaled by metres per pixel in the shader), optionally dashed.
   */
  private lines(
    rings: Ring[],
    o: { px: number; color: string; opacity: number; dash?: boolean; highlight?: boolean },
  ): THREE.Mesh {
    const positions: number[] = [];
    const offsets: number[] = [];
    const uvs: number[] = [];
    const index: number[] = [];
    for (const ring of rings) {
      const pts = ring.map(([lon, lat]) => this.project(lon, lat));
      const n = pts.length;
      if (n < 2) continue;
      const base = positions.length / 3;
      let along = 0;
      for (let i = 0; i <= n; i++) {
        const [x, y] = pts[i % n];
        if (i > 0) {
          const [px, py] = pts[i - 1];
          along += Math.hypot(x - px, y - py);
        }
        const [ax, ay] = pts[(i - 1 + n) % n];
        const [bx, by] = pts[(i + 1) % n];
        const n1 = leftNormal(x - ax, y - ay);
        const n2 = leftNormal(bx - x, by - y);
        let mx = n1[0] + n2[0];
        let my = n1[1] + n2[1];
        const ml = Math.hypot(mx, my);
        if (ml < 1e-6) [mx, my] = n2;
        else {
          mx /= ml;
          my /= ml;
        }
        const k = Math.min(2.5, 1 / Math.max(0.2, mx * n2[0] + my * n2[1]));
        for (const side of [1, -1]) {
          positions.push(x, 0, -y);
          offsets.push(mx * k * side * 0.5, 0, -my * k * side * 0.5);
          uvs.push(along, side === 1 ? 0 : 1);
        }
        if (i < n) {
          const a = base + i * 2;
          index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
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
    const width = this.mpp.mul(o.px);
    mat.positionNode = positionLocal
      .add(attribute<'vec3'>('offset', 'vec3').mul(width))
      .add(vec3(0, lift, 0));
    const color = o.highlight ? this.highlightColor : uniform(new THREE.Color(o.color));
    mat.colorNode = vec3(color);
    // Dashes ~8 px long, gaps ~5 px, at any zoom.
    const dash = o.dash
      ? oneMinus(smoothstep(0.58, 0.66, fract(uv().x.div(this.mpp.mul(13)))))
      : float(1);
    const alpha = float(o.opacity).mul(dash);
    // Soft edge across the ribbon.
    const across = oneMinus(abs(uv().y.mul(2).sub(1)));
    mat.opacityNode = alpha.mul(smoothstep(0, 0.35, across)).mul(this.fade);
    mat.mrtNode = groundNormalMrt();
    this.lineMats.push({ mat, px: o.px });
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = o.highlight ? 24 : 21;
    return mesh;
  }

  /** A province's area as a translucent fill in the highlight colour. */
  private fill(polygons: Polygon[]): THREE.Mesh {
    const positions: number[] = [];
    const index: number[] = [];
    for (const poly of polygons) {
      const [outer, ...holes] = poly.map((ring) =>
        ring.map(([lon, lat]) => new THREE.Vector2(...this.project(lon, lat))),
      );
      if (!outer || outer.length < 3) continue;
      const base = positions.length / 3;
      const all = [outer, ...holes].flat();
      for (const p of all) positions.push(p.x, 0, -p.y);
      for (const tri of THREE.ShapeUtils.triangulateShape(outer, holes))
        index.push(base + tri[0], base + tri[1], base + tri[2]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setIndex(index);
    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    mat.fog = false;
    mat.colorNode = vec3(this.highlightColor);
    mat.opacityNode = float(0.32).mul(this.fade);
    mat.mrtNode = groundNormalMrt();
    const lift = uniform(10);
    mat.userData.lift = lift;
    mat.positionNode = positionLocal.add(vec3(0, lift.mul(0.5), 0));
    this.lineMats.push({ mat, px: 0 });
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 22;
    return mesh;
  }

  /** A name lying on the map at `at` (lon/lat), turned `angleDeg` from east. */
  private label(
    text: string,
    at: [number, number],
    angleDeg: number,
    o: {
      base: number;
      minPx: number;
      maxPx: number;
      font: string;
      color: string;
      halo: string | null;
      spacing: string;
      town?: boolean;
      dot?: boolean;
    },
  ): void {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    ctx.font = o.font;
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = o.spacing;
    const metrics = ctx.measureText(text);
    const fontPx = Number(/(\d+)px/.exec(o.font)?.[1] ?? 96);
    const dot = o.dot ? fontPx * 0.9 : 0;
    const padX = fontPx * 0.4;
    canvas.width = Math.ceil(metrics.width + padX * 2 + dot);
    canvas.height = Math.ceil(fontPx * 1.5);
    ctx.font = o.font;
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = o.spacing;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const y = canvas.height / 2;
    if (o.dot) {
      ctx.fillStyle = o.color;
      ctx.beginPath();
      ctx.arc(padX * 0.6 + dot * 0.25, y, fontPx * 0.18, 0, Math.PI * 2);
      ctx.fill();
    }
    if (o.halo) {
      ctx.strokeStyle = o.halo;
      ctx.lineWidth = fontPx * 0.16;
      ctx.lineJoin = 'round';
      ctx.strokeText(text, padX + dot, y);
    }
    ctx.fillStyle = o.color;
    ctx.fillText(text, padX + dot, y);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    // Unit letter height: the quad is (width / height) × 1, scaled per frame.
    const aspect = canvas.width / canvas.height;
    const g = new THREE.PlaneGeometry(aspect * 1.5, 1.5);
    g.rotateX(-Math.PI / 2);
    // A town's dot sits on its point; other names are centred on theirs.
    if (o.dot) g.translate(aspect * 0.75 - ((padX * 0.6 + dot * 0.25) / canvas.height) * 1.5, 0, 0);
    const mat = new THREE.MeshBasicNodeMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
    });
    mat.fog = false;
    // The map's alpha is kept; this scales it.
    mat.opacityNode = this.fade;
    mat.mrtNode = groundNormalMrt();
    const mesh = new THREE.Mesh(g, mat);
    const [x, yN] = this.project(at[0], at[1]);
    mesh.position.set(x, 0, -yN);
    mesh.rotation.y = (angleDeg * Math.PI) / 180;
    mesh.frustumCulled = false;
    mesh.renderOrder = o.town ? 23 : 25;
    this.group.add(mesh);
    this.labels.push({ mesh, base: o.base, minPx: o.minPx, maxPx: o.maxPx, town: !!o.town });
  }
}

/** Unit normal to the left of a direction (x east, y north); zero for a zero direction. */
function leftNormal(dx: number, dy: number): [number, number] {
  const l = Math.hypot(dx, dy);
  return l < 1e-9 ? [0, 0] : [-dy / l, dx / l];
}
