import {
  attribute,
  clamp,
  float,
  luminance,
  min,
  mix,
  positionWorld,
  step,
  texture,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
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
/** Edge band (uv) over which a level fades into the next coarser one. */
const EDGE = 0.06;

/** Render layer the clipmap's camera sees (the twins of the ground meshes). */
export const CLIP_LAYER = 5;
/** A layer no camera sees: the markings, drawn into the clipmap by their twins only. */
export const HIDDEN_LAYER = 6;
const CLEAR = new THREE.Color(0.55, 0.53, 0.47);
/** `surf` value of the kerb faces (ground.ts SURF_KERB). */
const KERB = 6;

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
  /** The terrain's material: its colour from the clipmap. */
  readonly drape: THREE.MeshStandardNodeMaterial;
  /**
   * The street and yard surfaces' material: colour from the clipmap, the
   * ground material's relief (asphalt / sidewalk wear) and roughness, and
   * its own colour on the kerb faces (vertical: the picture has none there).
   */
  readonly drapeSurface: THREE.MeshStandardNodeMaterial;
  /** The map style's ground palette: saturation kept, brightness gain, tint. */
  readonly palette = {
    saturation: uniform(1),
    gain: uniform(1),
    tint: uniform(new THREE.Color(1, 1, 1)),
  };
  /** The level the last redraw drew and how long it took (ms). */
  readonly stats = { levels: 0, ms: 0 };

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    ground: THREE.MeshStandardNodeMaterial,
  ) {
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
    const raw = this.clipColour();
    const { saturation, gain, tint } = this.palette;
    const colour = mix(vec3(luminance(raw)), raw, saturation)
      .mul(gain)
      .mul(tint);
    this.drape = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
    this.drape.colorNode = colour;
    const surf = attribute<'float'>('surf', 'float');
    const kerb = step(KERB - 0.5, surf).mul(step(surf, KERB + 0.5));
    const s = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
    s.colorNode = mix(colour, vec3(ground.colorNode as never), kerb);
    if (ground.roughnessNode) s.roughnessNode = ground.roughnessNode;
    if (ground.normalNode) s.normalNode = ground.normalNode;
    s.polygonOffset = ground.polygonOffset;
    s.polygonOffsetFactor = ground.polygonOffsetFactor;
    s.polygonOffsetUnits = ground.polygonOffsetUnits;
    this.drapeSurface = s;
  }

  /** Size (m) of a level's square. */
  static size(k: number): number {
    return CLIP_BASE * 2 ** k;
  }

  /**
   * Colour from the finest level holding the point: each level's weight is
   * how far inside it the point lies (fading to 0 over its edge band, so the
   * next coarser level takes over smoothly) times what the finer ones left;
   * the rest is plain land.
   */
  private clipColour() {
    // World x east, z south. The level is drawn with north up, and a WebGPU
    // render target's rows run from the top: the picture's v runs south (+z).
    const xz = vec2(positionWorld.x, positionWorld.z);
    type FloatNode = ReturnType<typeof float>;
    type Vec3Node = ReturnType<typeof vec3>;
    let left = float(1) as FloatNode;
    const parts: Vec3Node[] = [];
    for (let k = 0; k < CLIP_LEVELS; k++) {
      const size = float(GroundClipmap.size(k));
      const uv = xz.sub(this.centres[k]).div(size).add(0.5);
      const edge = min(min(uv.x, uv.y), min(float(1).sub(uv.x), float(1).sub(uv.y)));
      const inside = clamp(edge.div(EDGE), 0, 1) as FloatNode;
      parts.push(vec3(texture(this.targets[k].texture, uv).rgb as never).mul(inside.mul(left)));
      left = left.mul(float(1).sub(inside)) as FloatNode;
    }
    parts.push(vec3(0.55, 0.53, 0.47).mul(left));
    return parts.reduce((x, y) => x.add(y));
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
   * The clipmap's own copy of a ground mesh: same geometry, its colour-only
   * material, on the clipmap's layer (no material swapping per draw — three.js
   * rebuilt its render state for every swap: 100–280 ms a redraw).
   */
  private twinOf(m: THREE.Mesh): THREE.Mesh {
    let t = m.userData.clipTwin as THREE.Mesh | undefined;
    if (!t) {
      const own = (m.userData.own as THREE.Material | undefined) ?? (m.material as THREE.Material);
      t = new THREE.Mesh(m.geometry, this.flatOf(own));
      t.name = 'clip-twin';
      t.layers.set(CLIP_LAYER);
      t.position.copy(m.position);
      t.quaternion.copy(m.quaternion);
      t.scale.copy(m.scale);
      m.parent?.add(t);
      m.userData.clipTwin = t;
    }
    return t;
  }

  private readonly dirty = Array.from({ length: CLIP_LEVELS }, () => true);
  private readonly wanted = Array.from({ length: CLIP_LEVELS }, () => new THREE.Vector2());

  /**
   * Keeps the levels on the focus: a level the focus has moved away from (or
   * every level, `force`, when the ground shown changed) is due a redraw; at
   * most one due level is drawn per call (the finest first), so a redraw
   * never stalls a frame. `meshes`: the tiles' flat ground meshes (each
   * gets its twin, shown as the mesh is). Returns the level drawn, or −1.
   */
  update(
    scene: THREE.Scene,
    focus: THREE.Vector3,
    meshes: THREE.Mesh[],
    top: number,
    force = false,
  ): number {
    for (const m of meshes) this.twinOf(m).visible = m.visible;
    for (let k = 0; k < CLIP_LEVELS; k++) {
      const size = GroundClipmap.size(k);
      const c = this.centres[k].value;
      const shift = size * RECENTRE;
      if (
        force ||
        !this.placed[k] ||
        Math.abs(focus.x - c.x) >= shift ||
        Math.abs(focus.z - c.y) >= shift
      ) {
        // Snapped to whole texels so a redrawn level does not shimmer.
        const texel = size / CLIP_RES;
        this.wanted[k].set(
          Math.round(focus.x / texel) * texel,
          Math.round(focus.z / texel) * texel,
        );
        this.dirty[k] = true;
      }
    }
    const k = this.dirty.indexOf(true);
    if (k < 0) return -1;
    const t0 = performance.now();
    this.centres[k].value.copy(this.wanted[k]);
    this.draw(k, scene, top);
    this.dirty[k] = false;
    this.placed[k] = true;
    this.stats.levels = k;
    this.stats.ms = performance.now() - t0;
    return k;
  }

  /** Draws level k: the twins alone (their layer), unlit, seen from straight above. */
  private draw(k: number, scene: THREE.Scene, top: number): void {
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
    const { background, fog, fogNode } = scene;
    scene.background = null;
    scene.fog = null;
    scene.fogNode = null;
    const prev = this.renderer.getRenderTarget();
    // (Its type wants a Color4, which three/webgpu does not export; a Color takes the r, g, b.)
    const clear = this.renderer.getClearColor(new THREE.Color() as never) as THREE.Color;
    const alpha = this.renderer.getClearAlpha();
    this.renderer.setRenderTarget(this.targets[k]);
    this.renderer.setClearColor(CLEAR, 1);
    this.renderer.clear();
    this.renderer.render(scene, cam);
    this.renderer.setRenderTarget(prev);
    this.renderer.setClearColor(clear, alpha);
    scene.background = background;
    scene.fog = fog;
    scene.fogNode = fogNode;
  }

  dispose(): void {
    for (const t of this.targets) t.dispose();
    for (const f of this.flat.values()) f.dispose();
    this.drape.dispose();
    this.drapeSurface.dispose();
  }
}
