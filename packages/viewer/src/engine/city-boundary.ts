import {
  Fn,
  abs,
  attribute,
  cameraViewMatrix,
  float,
  fract,
  fwidth,
  max,
  min,
  mix,
  mrt,
  oneMinus,
  positionLocal,
  pow,
  smoothstep,
  time,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import type { FlatRing } from './boundary-geo';

/** How far the curtain reaches below the ground (m): no gap where the terrain under it is coarse. */
export const WALL_SINK = 50;
/** Curtain height above the ground (m). */
export const WALL_RISE = 800;
const WALL_HEIGHT = WALL_SINK + WALL_RISE;
/** Distance along the wall (m) is wrapped at this (a whole number of stripes): float32 stays exact. */
const U_WRAP = 6000;
/** Stripe period along the wall (m). */
const STRIPE = 30;
/** Miter of the ground band at sharp corners: at most this many half-widths out. */
const MITER_LIMIT = 3;

/** The see-through boundary layers write the ground's up as their normal (see the wall). */
const groundNormalMrt = () => mrt({ normal: cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz });

/**
 * The city's boundary as a curtain of light: a vertical band along every
 * outer ring of the work area, red at the ground fading to orange and to
 * nothing upward, with diagonal stripes sliding along it and soft bands
 * rising. Unlit (same by day and night), translucent, seen from both sides;
 * one merged mesh for every ring. Built in anchor-relative metres (`x` east,
 * `y` north) — the engine places the mesh for the world origin. Its ground
 * line follows `setGround` (loaded tiles, the horizon's heights).
 *
 * Seen from above a wall is a hairline: a band on the ground along the same
 * rings (a child of the wall mesh) keeps the boundary readable, a few pixels
 * wide at any camera height.
 */
export class BoundaryWall {
  readonly mesh: THREE.Mesh;
  /** 1 close to the ground, down to ~0.3 when the camera is high (see `setCameraHeight`). */
  private readonly opacity = uniform(1);
  /** Per segment: the ring vertex index its two ends sample the ground at. */
  private readonly ends: Int32Array;
  /** Ring vertices (anchor metres), all rings in a row. */
  private readonly points: Float64Array;
  private readonly positions: Float32Array;
  /** The band on the ground (see the class note). */
  private readonly band: THREE.Mesh;
  /** Band vertices: per ring vertex (and each ring's first again, closing it) the point index. */
  private readonly bandPoints: Int32Array;
  private readonly bandPositions: Float32Array;
  /** Band half-width (m) and lift over the ground (m), both from the camera height. */
  private readonly bandWidth = uniform(8);
  private readonly bandLift = uniform(2);
  private readonly bandOpacity = uniform(0.5);

  constructor(rings: FlatRing[]) {
    let pointCount = 0;
    for (const r of rings) pointCount += r.length / 2;
    this.points = new Float64Array(pointCount * 2);
    // Each segment owns its 4 vertices (the wrapped distance never interpolates across a wrap).
    const segs = pointCount;
    this.ends = new Int32Array(segs * 2);
    this.positions = new Float32Array(segs * 4 * 3);
    const uvs = new Float32Array(segs * 4 * 2);
    const index = new Uint32Array(segs * 6);
    let p0 = 0;
    let s = 0;
    for (const r of rings) {
      const n = r.length / 2;
      this.points.set(r, p0 * 2);
      let along = 0;
      for (let i = 0; i < n; i++) {
        const a = p0 + i;
        const b = p0 + ((i + 1) % n);
        this.ends[2 * s] = a;
        this.ends[2 * s + 1] = b;
        const len = Math.hypot(
          this.points[2 * b] - this.points[2 * a],
          this.points[2 * b + 1] - this.points[2 * a + 1],
        );
        const u0 = along % U_WRAP;
        const v = s * 4;
        // a bottom, a top, b bottom, b top
        uvs.set([u0, 0, u0, 1, u0 + len, 0, u0 + len, 1], v * 2);
        index.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], s * 6);
        along += len;
        s++;
      }
      p0 += n;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    g.setIndex(new THREE.BufferAttribute(index, 1));

    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const v = uv().y;
    const along = uv().x;
    const up = v.mul(WALL_HEIGHT);
    // Diagonal stripes sliding along the wall. Edges a pixel wide; where a
    // stripe gets thinner than a few pixels (far off) it turns to its average
    // instead of flickering. fwidth floored so the smoothstep edges never meet
    // (equal or reversed edges are undefined on WebGPU: black quads).
    const diag = along.add(up).div(STRIPE).sub(time.mul(0.35));
    const fw = max(fwidth(diag), float(0.002));
    const tri = abs(fract(diag).sub(0.5)).mul(2);
    const bar = smoothstep(fw.negate().add(0.55), fw.add(0.55), tri);
    const far = smoothstep(0.08, 0.35, fw);
    const stripe = mix(bar, float(0.45), far);
    // Soft bands rising up the wall.
    const rise = fract(v.mul(2.5).sub(time.mul(0.12)));
    const band = oneMinus(smoothstep(0, 0.14, abs(rise.sub(0.5))));
    // A bright seam where the wall meets the ground (WALL_SINK up from its foot).
    const seamV = WALL_SINK / WALL_HEIGHT;
    const seamW = max(fwidth(v).mul(1.5), float(0.004));
    const seam = oneMinus(smoothstep(seamW.mul(0.25), seamW.add(0.01), abs(v.sub(seamV))));
    // Strongest at the ground, gone at the top.
    const fade = pow(oneMinus(smoothstep(seamV, 1, v)), 1.4);
    const opacity = this.opacity;
    mat.colorNode = Fn(() => {
      const base = mix(vec3(0.95, 0.1, 0.05), vec3(1.0, 0.5, 0.1), smoothstep(0, 1, v));
      return base
        .mul(stripe.mul(0.35).add(0.75))
        .add(vec3(1, 0.55, 0.25).mul(band.mul(0.25)))
        .add(vec3(1, 0.75, 0.45).mul(seam.mul(0.6)));
    })();
    mat.opacityNode = min(
      fade
        .mul(stripe.mul(0.3).add(band.mul(0.15)).add(0.28))
        .add(seam.mul(0.55))
        .mul(opacity),
      float(0.95),
    );
    // The scene pass also writes normals for the ambient occlusion, which
    // reads the ground's depth through the see-through wall: without normals
    // (or with a zero one) it went NaN and the wall drew black. The ground's
    // up, in view space, keeps the occlusion that of the ground behind.
    mat.mrtNode = groundNormalMrt();
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.name = 'city-boundary';
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // One mesh around the whole city: never culled as a whole (its sphere holds the camera anyway).
    this.mesh.frustumCulled = false;
    // Over the horizon and the tiles (it is see-through).
    this.mesh.renderOrder = 5;

    const ground = this.buildBand(rings);
    this.bandPoints = ground.points;
    this.bandPositions = ground.positions;
    this.band = ground.mesh;
    this.mesh.add(this.band);
  }

  /**
   * The ground band: two vertices per ring vertex, pushed out to either side
   * along the corner's miter in the shader (its width follows the camera).
   */
  private buildBand(rings: FlatRing[]): {
    mesh: THREE.Mesh;
    points: Int32Array;
    positions: Float32Array;
  } {
    let count = 0;
    for (const r of rings) count += r.length / 2 + 1;
    const points = new Int32Array(count);
    const positions = new Float32Array(count * 2 * 3);
    const offsets = new Float32Array(count * 2 * 3);
    const uvs = new Float32Array(count * 2 * 2);
    const index: number[] = [];
    let p0 = 0;
    let v = 0;
    for (const r of rings) {
      const n = r.length / 2;
      const at = (i: number): [number, number] => {
        const k = ((i % n) + n) % n;
        return [r[2 * k], r[2 * k + 1]];
      };
      let along = 0;
      for (let i = 0; i <= n; i++) {
        const [x, y] = at(i);
        if (i > 0) {
          const [px, py] = at(i - 1);
          along += Math.hypot(x - px, y - py);
        }
        // Left normals of the segments before and after this vertex; the miter between.
        const [ax, ay] = at(i - 1);
        const [bx, by] = at(i + 1);
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
        const k = Math.min(MITER_LIMIT, 1 / Math.max(1e-3, mx * n2[0] + my * n2[1]));
        points[v] = p0 + (i % n);
        for (const side of [1, -1]) {
          const o = (v * 2 + (side === 1 ? 0 : 1)) * 3;
          // three: x east, z south.
          offsets[o] = mx * k * side;
          offsets[o + 1] = 0;
          offsets[o + 2] = -my * k * side;
          uvs.set([along, side === 1 ? 0 : 1], (v * 2 + (side === 1 ? 0 : 1)) * 2);
        }
        if (i < n) {
          const a = v * 2;
          index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
        v++;
      }
      p0 += n;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('offset', new THREE.BufferAttribute(offsets, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    g.setIndex(index);

    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const width = this.bandWidth;
    mat.positionNode = positionLocal
      .add(attribute<'vec3'>('offset', 'vec3').mul(width))
      .add(vec3(0, this.bandLift, 0));
    // Across: 0 at the edges, 1 on the line itself.
    const centre = oneMinus(abs(uv().y.mul(2).sub(1)));
    const core = smoothstep(0.62, 0.9, centre);
    const body = smoothstep(0, 0.45, centre);
    // Dashes running along, their length tied to the width (same look at every height).
    const dash = smoothstep(
      0.35,
      0.5,
      abs(fract(uv().x.div(width.mul(10)).sub(time.mul(0.25))).sub(0.5)),
    );
    mat.colorNode = mix(vec3(1, 0.45, 0.1), vec3(1, 0.12, 0.05), core)
      .add(vec3(1, 0.7, 0.45).mul(core.mul(0.35)))
      .add(vec3(1, 0.6, 0.3).mul(dash.mul(body).mul(0.25)));
    mat.opacityNode = min(
      body.mul(0.45).add(core.mul(0.45)).add(dash.mul(body).mul(0.15)).mul(this.bandOpacity),
      float(0.95),
    );
    mat.mrtNode = groundNormalMrt();
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'city-boundary-band';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    return { mesh, points, positions };
  }

  /** Ring vertices (anchor metres) — the engine samples the ground at them. */
  get vertexCount(): number {
    return this.points.length / 2;
  }

  /**
   * The wall's foot follows the ground: `ground(x, y)` at every ring vertex
   * (anchor metres), WALL_SINK below it to WALL_RISE above.
   */
  setGround(ground: (x: number, y: number) => number): void {
    const n = this.points.length / 2;
    const h = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const g = ground(this.points[2 * i], this.points[2 * i + 1]);
      h[i] = Number.isFinite(g) ? g : 0;
    }
    const pos = this.positions;
    const segs = this.ends.length / 2;
    for (let s = 0; s < segs; s++) {
      for (let k = 0; k < 2; k++) {
        const p = this.ends[2 * s + k];
        const x = this.points[2 * p];
        const y = this.points[2 * p + 1];
        const foot = h[p] - WALL_SINK;
        // three: x east, y up, z south.
        const o = (s * 4 + k * 2) * 3;
        pos[o] = x;
        pos[o + 1] = foot;
        pos[o + 2] = -y;
        pos[o + 3] = x;
        pos[o + 4] = foot + WALL_HEIGHT;
        pos[o + 5] = -y;
      }
    }
    const attr = this.mesh.geometry.attributes.position as THREE.BufferAttribute;
    attr.needsUpdate = true;
    this.mesh.geometry.computeBoundingSphere();
    const bp = this.bandPositions;
    for (let k = 0; k < this.bandPoints.length; k++) {
      const p = this.bandPoints[k];
      for (let side = 0; side < 2; side++) {
        const o = (k * 2 + side) * 3;
        bp[o] = this.points[2 * p];
        bp[o + 1] = h[p];
        bp[o + 2] = -this.points[2 * p + 1];
      }
    }
    (this.band.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  /**
   * Camera height above the ground (m): a boundary on the map from high up,
   * not a wall into the sky — full under 2 km, ~30 % from 8 km.
   */
  setCameraHeight(height: number): void {
    const k = THREE.MathUtils.smoothstep(height, 2000, 8000);
    this.opacity.value = 1 - 0.7 * k;
    // The band: ~10 px wide whatever the height, lifted clear of the coarse
    // terrain under it, faint at street level (the wall's foot says it there).
    const h = Math.max(0, height);
    this.bandWidth.value = THREE.MathUtils.clamp(h * 0.007, 4, 3000);
    this.bandLift.value = THREE.MathUtils.clamp(h * 0.002, 1.5, 300);
    this.bandOpacity.value = 0.45 + 0.55 * THREE.MathUtils.smoothstep(h, 300, 3000);
  }

  dispose(): void {
    this.band.geometry.dispose();
    (this.band.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** Unit normal to the left of a direction (x east, y north); zero for a zero direction. */
function leftNormal(dx: number, dy: number): [number, number] {
  const l = Math.hypot(dx, dy);
  return l < 1e-9 ? [0, 0] : [-dy / l, dx / l];
}
