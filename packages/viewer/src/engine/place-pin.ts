import * as THREE from 'three/webgpu';
import { toThree } from './geom';

/** A place to pin: where (world model metres) and how tall the mast stands. */
export interface PlacePinSpot {
  x: number;
  y: number;
  height: number;
}

/** Screen position (px, from the canvas' top left) of the mast's top; null when behind the camera. */
export type PinScreen = { x: number; y: number } | null;

/**
 * A pinned place: a thin white line from the ground up, drawn over everything
 * so it shows through buildings from any angle. The label on its top is the
 * page's (HTML): `tick` tells where the top lands on the screen each frame.
 */
export class PlacePin {
  private readonly line: THREE.Line;
  private readonly positions = new Float32Array(6);
  private spot: PlacePinSpot | null = null;
  private ground = Number.NaN;
  private readonly top = new THREE.Vector3();
  private last: PinScreen = null;

  constructor(private readonly scene: THREE.Scene) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.line = new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.line.renderOrder = 1001;
    this.line.frustumCulled = false;
    this.line.visible = false;
    scene.add(this.line);
  }

  isSet(): boolean {
    return !!this.spot;
  }

  set(spot: PlacePinSpot | null): void {
    this.spot = spot;
    this.ground = Number.NaN;
    this.line.visible = !!spot;
  }

  /**
   * Follows the ground under the pin (tiles arrive after the fly-to) and
   * reports the top's screen position when it moved (0.5 px) or hid.
   */
  tick(
    groundAt: (x: number, y: number) => number,
    camera: THREE.PerspectiveCamera,
    width: number,
    height: number,
    report: (p: PinScreen) => void,
  ): void {
    if (!this.spot) {
      if (this.last) report((this.last = null));
      return;
    }
    const { x, y, height: h } = this.spot;
    const ground = groundAt(x, y);
    if (Math.abs(ground - this.ground) > 0.05 || Number.isNaN(this.ground)) {
      this.ground = ground;
      this.positions.set([...toThree(x, y, ground), ...toThree(x, y, ground + h)]);
      this.line.geometry.attributes.position.needsUpdate = true;
      this.line.geometry.computeBoundingSphere();
    }
    this.top.set(...toThree(x, y, ground + h)).project(camera);
    const visible = this.top.z < 1 && Math.abs(this.top.x) < 1.2 && Math.abs(this.top.y) < 1.2;
    const next: PinScreen = visible
      ? { x: ((this.top.x + 1) / 2) * width, y: ((1 - this.top.y) / 2) * height }
      : null;
    const moved =
      !next || !this.last || Math.abs(next.x - this.last.x) + Math.abs(next.y - this.last.y) > 0.5;
    if ((next === null) !== (this.last === null) || (next && moved)) report((this.last = next));
  }

  dispose(): void {
    this.scene.remove(this.line);
    this.line.geometry.dispose();
    (this.line.material as THREE.Material).dispose();
  }
}
