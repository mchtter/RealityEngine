import type { MapControls } from 'three/addons/controls/MapControls.js';
import * as THREE from 'three/webgpu';

/**
 * Camera modes of the DT view, all driven by the keyboard as well:
 *  - orbit:     map-style orbit around a ground target (mouse) + WASD pan, Q/E turn, R/F zoom;
 *  - isometric: fixed 35.26° elevation, 90° turns (Q/E), WASD pan, R/F zoom. A narrow
 *               perspective (10°) from far away instead of an orthographic camera, so the
 *               post-processing, shadow and AO passes keep working unchanged;
 *  - street:    eye height above the terrain, WASD walk, drag to look;
 *  - fly:       free flight, WASD along the view, E / Space up, Q / C down, drag to look.
 * Shift moves three times faster everywhere.
 */
export type DtCameraMode = 'orbit' | 'isometric' | 'street' | 'fly';

const BASE_FOV = 42;
const ISO_FOV = 10;
/** Elevation of the classic isometric view (arctan(1/√2)). */
const ISO_ELEVATION = Math.atan(1 / Math.SQRT2);
const EYE = 1.7;
const WALK = 6;
const LOOK = 0.0032;
const DEG = Math.PI / 180;
/** How fast (1/s) the orbit target settles onto the ground under it. */
const TARGET_FOLLOW = 6;
/** Least height (m) of the orbit camera above the ground below it. */
const ORBIT_CLEARANCE = 2;

const MOVE_KEYS: Record<string, [number, number]> = {
  KeyW: [0, 1],
  ArrowUp: [0, 1],
  KeyS: [0, -1],
  ArrowDown: [0, -1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
};

export class CameraRig {
  mode: DtCameraMode = 'orbit';
  /** Keys the camera leaves alone (W / E / R switch the transform gizmo while it is shown). */
  blockedKeys: ReadonlySet<string> = new Set();
  private readonly keys = new Set<string>();
  private yaw = 0;
  private pitch = 0;
  private drag: { x: number; y: number } | null = null;
  /** Remaining isometric turn (radians), animated. */
  private isoTurn = 0;
  private readonly baseLimits: { min: number; max: number; minPolar: number; maxPolar: number };
  private readonly baseFog: { near: number; far: number } | null;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly controls: MapControls,
    private readonly dom: HTMLElement,
    private readonly scene: THREE.Scene,
    private readonly heightAt: (x: number, y: number) => number,
    private readonly changed: () => void,
    /** Surface under feet at `foot` height: terrain, bridge deck or tunnel road. */
    private readonly standAt: (x: number, y: number, foot: number) => number = (x, y) =>
      heightAt(x, y),
    /** Ground height where a loaded tile has it; null elsewhere (the orbit then holds). */
    private readonly groundAt: (x: number, y: number) => number | null = (x, y) => heightAt(x, y),
  ) {
    this.baseLimits = {
      min: controls.minDistance,
      max: controls.maxDistance,
      minPolar: controls.minPolarAngle,
      maxPolar: controls.maxPolarAngle,
    };
    const fog = scene.fog as THREE.Fog | null;
    this.baseFog = fog ? { near: fog.near, far: fog.far } : null;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    dom.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.dom.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
  }

  /** Orbit distance ÷ this = the distance the base field of view would need for the same framing. */
  get distanceScale(): number {
    return this.mode === 'isometric'
      ? Math.tan((BASE_FOV / 2) * DEG) / Math.tan((ISO_FOV / 2) * DEG)
      : 1;
  }

  /** Where level-of-detail should measure from (isometric: as if seen at the base field of view). */
  lodEye(out: THREE.Vector3): THREE.Vector3 {
    out.copy(this.camera.position);
    if (this.mode === 'isometric') {
      const t = this.controls.target;
      out.sub(t).divideScalar(this.distanceScale).add(t);
    }
    return out;
  }

  /** Lowest useful near plane (street level looks at walls a metre away). */
  get minNear(): number {
    return this.mode === 'street' ? 0.15 : 1;
  }

  setMode(mode: DtCameraMode): void {
    if (mode === this.mode) return;
    const from = this.mode;
    if (from === 'isometric') this.leaveIsometric();
    if (from === 'street' || from === 'fly') this.retarget(from === 'street' ? 40 : null);
    this.mode = mode;
    this.keys.clear();
    this.controls.enabled = mode === 'orbit' || mode === 'isometric';
    if (mode === 'isometric') this.enterIsometric();
    if (mode === 'street' || mode === 'fly') {
      const dir = this.camera.getWorldDirection(new THREE.Vector3());
      this.yaw = Math.atan2(-dir.x, -dir.z);
      this.pitch = mode === 'street' ? 0 : Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
      if (mode === 'street') {
        const t = this.controls.target;
        this.camera.position.set(t.x, this.heightAt(t.x, -t.z) + EYE, t.z);
      }
      this.applyLook();
    } else {
      this.controls.update();
    }
    this.changed();
  }

  /**
   * Places a street / fly camera at a ground point looking towards `headingDeg`
   * (compass): used when the view is set from outside (split view, fly-tos).
   */
  placeAt(x: number, z: number, headingDeg: number, height: number | null): void {
    this.camera.position.set(x, height ?? this.heightAt(x, -z) + EYE, z);
    this.yaw = -headingDeg * DEG;
    this.applyLook();
    this.retarget(40);
  }

  /**
   * Per-frame movement. Returns false when the map controls must not update
   * (street / fly own the camera).
   */
  update(dt: number): boolean {
    const step = Math.min(dt, 0.1);
    const fast = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 3 : 1;
    let mx = 0;
    let my = 0;
    for (const k of this.keys) {
      const m = MOVE_KEYS[k];
      if (m) {
        mx += m[0];
        my += m[1];
      }
    }
    const moving = mx !== 0 || my !== 0;

    if (this.mode === 'orbit' || this.mode === 'isometric') {
      const t = this.controls.target;
      const offset = this.camera.position.clone().sub(t);
      const dist = offset.length();
      if (moving) {
        // Pan along the ground, relative to where the camera looks.
        const fwd = new THREE.Vector3(-offset.x, 0, -offset.z).normalize();
        const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
        const speed = (dist / this.distanceScale) * 0.9 * fast * step;
        const d = fwd.multiplyScalar(my * speed).add(right.multiplyScalar(mx * speed));
        t.add(d);
        this.camera.position.add(d);
      }
      // Zoom with R / F (the wheel keeps working through the controls).
      const zoom = (this.keys.has('KeyF') ? 1 : 0) - (this.keys.has('KeyR') ? 1 : 0);
      if (zoom) {
        const scaled = offset.multiplyScalar(1 + zoom * 1.2 * step);
        const len = THREE.MathUtils.clamp(
          scaled.length(),
          this.controls.minDistance,
          this.controls.maxDistance,
        );
        this.camera.position.copy(t).add(scaled.setLength(len));
      }
      if (this.mode === 'orbit') {
        const turn = (this.keys.has('KeyE') ? 1 : 0) - (this.keys.has('KeyQ') ? 1 : 0);
        if (turn) this.rotateAround(turn * 70 * DEG * step);
      } else if (this.isoTurn !== 0) {
        const a = Math.sign(this.isoTurn) * Math.min(Math.abs(this.isoTurn), 240 * DEG * step);
        this.isoTurn -= a;
        this.rotateAround(a);
      }
      // Keep the orbit on the city, not under it: the target rides the ground
      // (eased, so panning over hills does not jump) and the camera stays above
      // it. Panning moves the target in a flat plane, which used to leave it at
      // the height where the pan started — under the hills, with the camera.
      const ground = this.groundAt(t.x, -t.z);
      const dy = ground === null ? 0 : ground - t.y;
      let followed = false;
      if (Math.abs(dy) > 0.05) {
        const shift = dy * Math.min(1, step * TARGET_FOLLOW);
        t.y += shift;
        this.camera.position.y += shift;
        followed = true;
      }
      const p = this.camera.position;
      const below = this.groundAt(p.x, -p.z);
      const under = below === null ? 0 : below + ORBIT_CLEARANCE - p.y;
      if (under > 0) {
        p.y += under;
        followed = true;
      }
      if (moving || zoom || followed) this.changed();
      return true;
    }

    // Street / fly: the rig owns the camera.
    const cp = Math.cos(this.pitch);
    const fwd =
      this.mode === 'fly'
        ? new THREE.Vector3(
            -Math.sin(this.yaw) * cp,
            Math.sin(this.pitch),
            -Math.cos(this.yaw) * cp,
          )
        : new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const p = this.camera.position;
    const ground = this.standAt(p.x, -p.z, p.y - EYE);
    let moved = moving;
    if (this.mode === 'street') {
      const speed = WALK * fast * step;
      const foot = p.y - EYE;
      p.addScaledVector(fwd, my * speed).addScaledVector(right, mx * speed);
      p.y = this.standAt(p.x, -p.z, foot) + EYE;
    } else {
      const speed = THREE.MathUtils.clamp(p.y - ground, 10, 300) * fast * step;
      p.addScaledVector(fwd, my * speed).addScaledVector(right, mx * speed);
      const up =
        (this.keys.has('KeyE') || this.keys.has('Space') ? 1 : 0) -
        (this.keys.has('KeyQ') || this.keys.has('KeyC') ? 1 : 0);
      if (up) {
        p.y += up * speed;
        moved = true;
      }
      p.y = Math.max(p.y, this.standAt(p.x, -p.z, p.y) + 2);
    }
    if (moved) {
      this.retarget(this.mode === 'street' ? 40 : null);
      this.changed();
    }
    return false;
  }

  // ─── internals ──────────────────────────────────────────────────────────

  private applyLook(): void {
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  /** Keeps the controls' target in front of a street / fly camera (2D sync, back to orbit). */
  private retarget(ahead: number | null): void {
    const p = this.camera.position;
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    let d = ahead ?? 60;
    if (ahead === null && dir.y < -0.05) {
      // Fly: where the view meets the ground (a few refinement steps over the terrain).
      for (let k = 0; k < 4; k++) {
        const q = p.clone().addScaledVector(dir, d);
        d = Math.max(5, (p.y - this.heightAt(q.x, -q.z)) / -dir.y);
      }
      d = Math.min(d, 2000);
    }
    const flat = new THREE.Vector3(dir.x, 0, dir.z).normalize();
    const t = p.clone().addScaledVector(ahead === null ? dir : flat, d);
    t.y = this.heightAt(t.x, -t.z);
    this.controls.target.copy(t);
  }

  private rotateAround(angle: number): void {
    const t = this.controls.target;
    const offset = this.camera.position.clone().sub(t);
    offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
    this.camera.position.copy(t).add(offset);
    this.camera.lookAt(t);
    this.changed();
  }

  private enterIsometric(): void {
    const t = this.controls.target;
    const offset = this.camera.position.clone().sub(t);
    const scale = Math.tan((BASE_FOV / 2) * DEG) / Math.tan((ISO_FOV / 2) * DEG);
    // Snap the azimuth to a diagonal, as isometric views look along one.
    const az = Math.atan2(offset.x, offset.z);
    const snapped = Math.round((az - Math.PI / 4) / (Math.PI / 2)) * (Math.PI / 2) + Math.PI / 4;
    const dist = offset.length() * scale;
    const polar = Math.PI / 2 - ISO_ELEVATION;
    this.camera.position.set(
      t.x + dist * Math.sin(polar) * Math.sin(snapped),
      t.y + dist * Math.cos(polar),
      t.z + dist * Math.sin(polar) * Math.cos(snapped),
    );
    this.camera.fov = ISO_FOV;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = this.baseLimits.min * scale;
    this.controls.maxDistance = this.baseLimits.max * scale;
    this.controls.minPolarAngle = polar;
    this.controls.maxPolarAngle = polar;
    this.controls.enableRotate = false;
    const fog = this.scene.fog as THREE.Fog | null;
    if (fog && this.baseFog) {
      fog.near = this.baseFog.near * scale;
      fog.far = this.baseFog.far * scale;
    }
  }

  private leaveIsometric(): void {
    const t = this.controls.target;
    const scale = this.distanceScale;
    const offset = this.camera.position.clone().sub(t).divideScalar(scale);
    this.camera.position.copy(t).add(offset);
    this.camera.fov = BASE_FOV;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = this.baseLimits.min;
    this.controls.maxDistance = this.baseLimits.max;
    this.controls.minPolarAngle = this.baseLimits.minPolar;
    this.controls.maxPolarAngle = this.baseLimits.maxPolar;
    this.controls.enableRotate = true;
    this.isoTurn = 0;
    const fog = this.scene.fog as THREE.Fog | null;
    if (fog && this.baseFog) {
      fog.near = this.baseFog.near;
      fog.far = this.baseFog.far;
    }
  }

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey || this.blockedKeys.has(e.code)) return;
    if (this.mode === 'isometric' && !e.repeat && (e.code === 'KeyQ' || e.code === 'KeyE')) {
      this.isoTurn += (e.code === 'KeyE' ? 1 : -1) * (Math.PI / 2);
    }
    this.keys.add(e.code);
    // Arrows and space would scroll the page.
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private readonly onBlur = () => this.keys.clear();

  private readonly onPointerDown = (e: PointerEvent) => {
    if (this.mode !== 'street' && this.mode !== 'fly') return;
    this.drag = { x: e.clientX, y: e.clientY };
  };

  private readonly onPointerMove = (e: PointerEvent) => {
    if (!this.drag) return;
    this.yaw -= (e.clientX - this.drag.x) * LOOK;
    this.pitch = THREE.MathUtils.clamp(this.pitch - (e.clientY - this.drag.y) * LOOK, -1.4, 1.4);
    this.drag = { x: e.clientX, y: e.clientY };
    this.applyLook();
    this.retarget(this.mode === 'street' ? 40 : null);
    this.changed();
  };

  private readonly onPointerUp = () => {
    this.drag = null;
  };
}
