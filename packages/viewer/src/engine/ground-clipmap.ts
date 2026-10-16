import { float, positionWorld, step, texture, uniform, vec2, vec3 } from 'three/tsl';
import * as THREE from 'three/webgpu';

/**
 * The ground as one picture (D-011): rings of textures centred on the camera
 * (a clipmap), level k covering BASE·2^k metres at RES² pixels — about 6 cm a
 * pixel next to the camera, 2 m at the outer ring. Each level is drawn from
 * the tiles' own ground meshes (terrain, surfaces, markings) seen straight
 * from above, unlit (their colour only); the ground in the main pass then
 * takes its colour from the finest level holding the point. One surface, one
 * material: no paint over asphalt to z-fight, no lifted far surfaces.
 */
export const CLIP_LEVELS = 6;
export const CLIP_BASE = 64;
export const CLIP_RES = 1024;
/** A level is redrawn when its centre would move this share of its size. */
const RECENTRE = 1 / 8;
/** Edge band (uv) a level hands over to the next coarser one across. */
const EDGE = 0.04;

/** Render layer the clipmap's camera sees (the ground meshes, while a level is drawn). */
export const CLIP_LAYER = 5;
const CLEAR = new THREE.Color(0.55, 0.53, 0.47);

/** The ground meshes a clipmap draws and drapes (flat ground; not decks, walls, lights). */
export const DRAPED = /^(terrain|surfaces|markings)/;

export class GroundClipmap {
  readonly targets: THREE.RenderTarget[] = [];
  /** World x / z of each level's centre (uniforms the drape shader reads). */
  private readonly centres = Array.from({ length: CLIP_LEVELS }, () =>
    uniform(new THREE.Vector2()),
  );
  private readonly placed = Array.from({ length: CLIP_LEVELS }, () => false);
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 4000);
  /** Unlit twins of the ground materials (their colour graph, no light). */
  private readonly flat = new Map<THREE.Material, THREE.Material>();
  readonly drape: THREE.MeshStandardNodeMaterial;

  constructor(private readonly renderer: THREE.WebGPURenderer) {
    for (let k = 0; k < CLIP_LEVELS; k++) {
      const t = new THREE.RenderTarget(CLIP_RES, CLIP_RES, {
        generateMipmaps: true,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
        colorSpace: THREE.SRGBColorSpace,
        depthBuffer: true,
      });
      t.texture.anisotropy = 8;
      renderer.initRenderTarget(t);
      this.targets.push(t);
    }
    this.camera.up.set(0, 0, -1);
    this.drape = this.buildDrape();
  }

  /** Size (m) of a level's square. */
  static size(k: number): number {
    return CLIP_BASE * 2 ** k;
  }

  private buildDrape(): THREE.MeshStandardNodeMaterial {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
    // World x east, z south. The level is drawn with north up, and a WebGPU
    // render target's rows run from the top: the picture's v runs south (+z).
    const xz = vec2(positionWorld.x, positionWorld.z);
    // The finest level holding the point wins: each level's weight is its
    // "inside" times what the finer ones left; the rest is plain land.
    type FloatNode = ReturnType<typeof float>;
    type Vec3Node = ReturnType<typeof vec3>;
    let left = float(1) as FloatNode;
    const parts: Vec3Node[] = [];
    for (let k = 0; k < CLIP_LEVELS; k++) {
      const size = float(GroundClipmap.size(k));
      const c = this.centres[k];
      const uv = xz.sub(c).div(size).add(0.5);
      const inside = step(EDGE, uv.x)
        .mul(step(EDGE, uv.y))
        .mul(step(uv.x, 1 - EDGE))
        .mul(step(uv.y, 1 - EDGE)) as FloatNode;
      parts.push(vec3(texture(this.targets[k].texture, uv).rgb as never).mul(inside.mul(left)));
      left = left.mul(float(1).sub(inside)) as FloatNode;
    }
    parts.push(vec3(0.55, 0.53, 0.47).mul(left));
    const colour = parts.reduce((x, y) => x.add(y));
    m.colorNode = colour;
    return m;
  }

  private flatOf(mat: THREE.Material): THREE.Material {
    let f = this.flat.get(mat);
    if (!f) {
      const src = mat as THREE.MeshStandardNodeMaterial;
      const basic = new THREE.MeshBasicNodeMaterial();
      if (src.colorNode) basic.colorNode = src.colorNode;
      else if (src.color) basic.color.copy(src.color);
      basic.vertexColors = src.vertexColors;
      // Seen from kilometres up, fog would cover it all: the picture is colour only.
      basic.fog = false;
      basic.side = THREE.DoubleSide;
      f = basic;
      this.flat.set(mat, f);
    }
    return f;
  }

  /**
   * Redraws the levels whose centre the focus has moved away from, from
   * `meshes` (the visible ground of the loaded tiles, drawn with their own
   * material from `userData.own`) in `scene`. Returns how many were drawn.
   */
  update(
    scene: THREE.Scene,
    focus: THREE.Vector3,
    meshes: THREE.Mesh[],
    top: number,
    force = false,
  ): number {
    let drawn = 0;
    for (let k = 0; k < CLIP_LEVELS; k++) {
      const size = GroundClipmap.size(k);
      const c = this.centres[k].value;
      const shift = size * RECENTRE;
      if (
        !force &&
        this.placed[k] &&
        Math.abs(focus.x - c.x) < shift &&
        Math.abs(focus.z - c.y) < shift
      )
        continue;
      // Snapped to whole texels so a redrawn level does not shimmer.
      const texel = size / CLIP_RES;
      c.set(Math.round(focus.x / texel) * texel, Math.round(focus.z / texel) * texel);
      this.draw(k, scene, meshes, top);
      this.placed[k] = true;
      drawn++;
    }
    return drawn;
  }

  /** Draws level k: the ground meshes alone (their layer), unlit, seen from straight above. */
  private draw(k: number, scene: THREE.Scene, meshes: THREE.Mesh[], top: number): void {
    const size = GroundClipmap.size(k);
    const c = this.centres[k].value;
    const cam = this.camera;
    cam.left = -size / 2;
    cam.right = size / 2;
    cam.top = size / 2;
    cam.bottom = -size / 2;
    cam.near = 1;
    cam.far = top + 2000;
    cam.position.set(c.x, top, c.y);
    cam.lookAt(c.x, top - 10000, c.y);
    cam.layers.set(CLIP_LAYER);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    const kept = meshes.map((m) => ({ m, mat: m.material, visible: m.visible }));
    for (const m of meshes) {
      const own = (m.userData.own as THREE.Material | undefined) ?? (m.material as THREE.Material);
      m.material = this.flatOf(own);
      m.visible = true;
      m.layers.enable(CLIP_LAYER);
    }
    const { background, fog, fogNode } = scene;
    scene.background = null;
    scene.fog = null;
    scene.fogNode = null;
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.targets[k]);
    this.renderer.setClearColor(CLEAR, 1);
    this.renderer.clear();
    this.renderer.render(scene, cam);
    this.renderer.setRenderTarget(prev);
    scene.background = background;
    scene.fog = fog;
    scene.fogNode = fogNode;
    for (const { m, mat, visible } of kept) {
      m.material = mat;
      m.visible = visible;
      // Markings live on the clipmap's layer alone (the main pass does not draw them).
      if (!/^markings/.test(m.name)) m.layers.disable(CLIP_LAYER);
    }
  }

  dispose(): void {
    for (const t of this.targets) t.dispose();
    for (const f of this.flat.values()) f.dispose();
    this.drape.dispose();
  }
}
