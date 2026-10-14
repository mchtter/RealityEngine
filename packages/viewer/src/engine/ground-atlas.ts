import * as THREE from 'three/webgpu';
import { GROUND_SIZE } from './landcover';

/** Slots per atlas side: GROUND_SIZE × GRID pixels square (16 × 256 = 4096). */
export const GROUND_GRID = 16;

/**
 * One texture holding the ground pictures of all loaded tiles (landcover.ts),
 * a slot each: a texture per tile would give each tile's terrain its own
 * material, and three.js compiles a shader per material node graph. A tile's
 * picture is uploaded small and copied into its slot on the GPU (the atlas
 * regenerates its mipmaps), so a new tile costs one 256² upload. The terrain
 * finds its slot in a `gslot` vertex attribute (−1: none, plain open land).
 */
export class GroundAtlas {
  readonly target: THREE.RenderTarget;
  private readonly free: number[] = [];

  constructor(private readonly renderer: THREE.WebGPURenderer) {
    const size = GROUND_SIZE * GROUND_GRID;
    this.target = new THREE.RenderTarget(size, size, {
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      colorSpace: THREE.SRGBColorSpace,
      depthBuffer: false,
    });
    this.target.texture.anisotropy = 4;
    renderer.initRenderTarget(this.target);
    for (let i = GROUND_GRID * GROUND_GRID - 1; i >= 0; i--) this.free.push(i);
  }

  get texture(): THREE.Texture {
    return this.target.texture;
  }

  /** A free slot with `pixels` in it, or −1 when the atlas is full. */
  add(pixels: Uint8Array): number {
    const slot = this.free.pop();
    if (slot === undefined) return -1;
    const tile = new THREE.DataTexture(pixels, GROUND_SIZE, GROUND_SIZE, THREE.RGBAFormat);
    tile.colorSpace = THREE.SRGBColorSpace;
    tile.needsUpdate = true;
    const x = (slot % GROUND_GRID) * GROUND_SIZE;
    const y = Math.floor(slot / GROUND_GRID) * GROUND_SIZE;
    this.renderer.copyTextureToTexture(tile, this.target.texture, null, new THREE.Vector2(x, y));
    tile.dispose();
    return slot;
  }

  release(slot: number): void {
    if (slot >= 0) this.free.push(slot);
  }

  dispose(): void {
    this.target.dispose();
  }
}
