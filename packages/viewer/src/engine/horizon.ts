import { type GeoTerrainGrid, utmForward } from '@opentwin/city-core';
import {
  Discard,
  abs,
  fract,
  min,
  mod,
  sin,
  fwidth,
  oneMinus,
  time,
  Fn,
  If,
  float,
  floor,
  int,
  ivec2,
  mix,
  positionWorld,
  smoothstep,
  step,
  textureLoad,
  uniform,
  vec3,
} from 'three/tsl';
import * as THREE from 'three/webgpu';

/** 1 km cells the tile mask covers per side (tiles loaded around the horizon's centre). */
const MASK = 160;

/**
 * The land and sea beyond the loaded tiles, out to the mountains (±50 km of
 * coarse DEM heights, see the twin-builder's horizon grid): one plain mesh,
 * drawn wherever no tile is — under a loaded tile its pixels are dropped
 * (a 1 km mask), so it never lies over the city's own ground, and a tile not
 * loaded yet shows land instead of a gap. Lit like the terrain, coloured by
 * height (open land, maquis on the slopes, the sea at 0 m); the height fog
 * keeps its peaks readable far off.
 */
export class HorizonLayer {
  readonly mesh: THREE.Mesh;
  private readonly mask = new THREE.DataTexture(
    new Uint8Array(MASK * MASK),
    MASK,
    MASK,
    THREE.RedFormat,
    THREE.UnsignedByteType,
  );
  /** UTM km of the mask's first cell, in the world's zone. */
  private readonly mask0: [number, number];
  /** World origin (UTM km) relative to the mask's first cell. */
  private readonly originKm = uniform(new THREE.Vector2());

  constructor(
    grid: GeoTerrainGrid,
    readonly world: { zone: number; originE: number; originN: number },
    openLand: THREE.UniformNode<'color', THREE.Color>,
  ) {
    const { cols, rows, heights } = grid;
    const positions = new Float32Array(cols * rows * 3);
    for (let j = 0; j < rows; j++) {
      const lat = grid.north - (j / Math.max(1, rows - 1)) * (grid.north - grid.south);
      for (let i = 0; i < cols; i++) {
        const lon = grid.west + (i / Math.max(1, cols - 1)) * (grid.east - grid.west);
        const [e, n] = utmForward(lon, lat, world.zone);
        const k = (j * cols + i) * 3;
        positions[k] = e - world.originE;
        positions[k + 1] = Math.max(-1, heights[j * cols + i]);
        positions[k + 2] = -(n - world.originN);
      }
    }
    const index: number[] = [];
    for (let j = 0; j < rows - 1; j++)
      for (let i = 0; i < cols - 1; i++) {
        const a = j * cols + i;
        index.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setIndex(index);
    g.computeVertexNormals();
    g.computeBoundingSphere();

    const centre = utmForward(
      (grid.west + grid.east) / 2,
      (grid.north + grid.south) / 2,
      world.zone,
    );
    this.mask0 = [Math.floor(centre[0] / 1000) - MASK / 2, Math.floor(centre[1] / 1000) - MASK / 2];
    this.originKm.value.set(
      world.originE / 1000 - this.mask0[0],
      world.originN / 1000 - this.mask0[1],
    );
    this.mask.magFilter = THREE.NearestFilter;
    this.mask.minFilter = THREE.NearestFilter;
    this.mask.needsUpdate = true;

    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
    const y = positionWorld.y;
    const slopes = mix(vec3(openLand), vec3(0.2, 0.22, 0.14), smoothstep(80, 500, y));
    // Matched to the tiles' water seen from afar (blue, glossy: it mirrors the sky).
    const sea = vec3(0.05, 0.15, 0.26);
    const isSea = step(y, float(0.5));
    mat.roughnessNode = mix(float(0.95), float(0.12), isSea);
    const mask = this.mask;
    const originKm = this.originKm;
    // The 1 km cell under the pixel (mask coordinates) and where in it.
    const gx = positionWorld.x.div(1000).add(originKm.x);
    const gy = positionWorld.z.negate().div(1000).add(originKm.y);
    const cellX = floor(gx);
    const cellY = floor(gy);
    // Mask per cell: 1 = a tile is drawn there (dropped here), 0.5 = its tile
    // is being compiled / meshed (a loading pattern over the land's shape).
    const cellState = Fn(() => {
      const cx = int(cellX);
      const cy = int(cellY);
      const inside = cx
        .greaterThanEqual(0)
        .and(cy.greaterThanEqual(0))
        .and(cx.lessThan(MASK))
        .and(cy.lessThan(MASK));
      const v = float(0).toVar();
      If(inside, () => {
        v.assign(textureLoad(mask, ivec2(cx, cy)).r);
      });
      return v;
    });
    const state = cellState();
    const loading = step(0.25, state).mul(step(state, 0.75));
    // Loading cells read as tiles, like a checkerboard of placeholders: dark and
    // light in turn, stripes leaning one way then the other, each cell's sweep
    // at its own time (not one endless hatch running across the land).
    const parity = mod(cellX.add(cellY), 2);
    const seed = fract(sin(cellX.mul(12.9898).add(cellY.mul(78.233))).mul(43758.5453));
    const lean = mix(
      positionWorld.x.sub(positionWorld.z),
      positionWorld.x.add(positionWorld.z),
      parity,
    );
    const diag = lean.div(18).sub(time.mul(0.6));
    // Edges as wide as a pixel (no stair-steps); where a stripe gets thinner
    // than ~3 px (far off) it fades to its average tint instead of flickering.
    const f = fract(diag);
    const fw = fwidth(diag);
    const bar = smoothstep(fw.negate().add(0.7), fw.add(0.7), f).mul(
      oneMinus(smoothstep(fw.negate().add(0.9), fw.add(0.9), f)),
    );
    const far = smoothstep(0.08, 0.3, fw);
    const line = mix(bar, float(0.2), far);
    // A soft bright band crossing the cell every few seconds.
    const lx = fract(gx);
    const ly = fract(gy);
    const sweep = fract(lx.add(ly).mul(0.5).sub(time.mul(0.18)).add(seed));
    const band = oneMinus(smoothstep(0, 0.09, abs(sweep.sub(0.5)))).mul(oneMinus(far.mul(0.6)));
    // The cell's outline, ~5 m wide.
    const edgeM = min(min(lx, oneMinus(lx)), min(ly, oneMinus(ly))).mul(1000);
    const efw = fwidth(edgeM);
    const outline = oneMinus(smoothstep(efw.negate().add(5), efw.add(5), edgeM));
    const base = mix(vec3(0.09, 0.2, 0.4), vec3(0.17, 0.33, 0.58), parity);
    const pattern = mix(base, vec3(0.42, 0.66, 0.98), line.mul(0.45))
      .add(vec3(0.45, 0.7, 1).mul(band).mul(0.45))
      .add(vec3(0.5, 0.72, 1).mul(outline).mul(0.6));
    mat.colorNode = Fn(() => {
      If(state.greaterThan(0.75), () => {
        Discard();
      });
      const land = mix(slopes, sea, isSea);
      // Close by the pattern covers the land; far off only tints it, so the
      // horizon does not turn one solid colour.
      return mix(land, pattern, loading.mul(mix(float(0.88), float(0.45), far)));
    })();
    mat.emissiveNode = vec3(0.3, 0.55, 1)
      .mul(line.mul(0.35).add(band.mul(0.6)).add(outline.mul(0.4)))
      .mul(loading)
      .mul(oneMinus(far.mul(0.5)));
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.name = 'horizon';
    this.mesh.receiveShadow = false;
    this.mesh.castShadow = false;
    // Drawn after the tiles: most of it lies behind them.
    this.mesh.renderOrder = 1;
  }

  /**
   * A tile's (`utm<zone>/<eKm>/<nKm>`) state here: `loaded` — the horizon steps
   * aside under it; `pending` — it is being compiled / meshed (hatched); `none`.
   */
  setTile(key: string, state: 'loaded' | 'pending' | 'none'): void {
    const m = /^utm(\d+)\/(\d+)\/(\d+)$/.exec(key);
    if (!m || Number(m[1]) !== this.world.zone) return;
    const i = Number(m[2]) - this.mask0[0];
    const j = Number(m[3]) - this.mask0[1];
    if (i < 0 || j < 0 || i >= MASK || j >= MASK) return;
    const data = this.mask.image.data as Uint8Array;
    const v = state === 'loaded' ? 255 : state === 'pending' ? 128 : 0;
    if (data[j * MASK + i] === v) return;
    data[j * MASK + i] = v;
    this.mask.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mask.dispose();
  }
}
