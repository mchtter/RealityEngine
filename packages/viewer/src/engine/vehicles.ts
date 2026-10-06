import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { sin, time, vec3 } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { paint, toThree } from './geom';

/** A vehicle to draw: where it is (lon / lat), its course (degrees, 0 north) and whether its fix is fresh. */
export interface VehicleState {
  id: string;
  lon: number;
  lat: number;
  heading?: number;
  stale: boolean;
}

export interface VehiclePlacement {
  worldOf(lon: number, lat: number): [number, number] | null;
  heightAt(x: number, y: number): number;
}

/** Fix older than this is shown faded (ms). */
export const STALE_MS = 5 * 60 * 1000;

const box = (w: number, h: number, d: number, c: string, x: number, y: number, z: number) =>
  paint(new THREE.BoxGeometry(w, h, d).translate(x, y, z), new THREE.Color(c));

let shared: THREE.BufferGeometry | null = null;

/** Service van along +z: white body, team stripe, dark windows, wheels; light bar on the roof. */
function vanGeometry(): THREE.BufferGeometry {
  if (shared) return shared;
  const parts = [
    box(2.0, 1.9, 4.6, '#f2f2ef', 0, 1.25, -0.2),
    box(2.0, 1.4, 1.1, '#f2f2ef', 0, 1.0, 2.55),
    box(2.02, 0.32, 4.6, '#f08c00', 0, 1.0, -0.2),
    box(1.9, 0.55, 0.06, '#1e2a33', 0, 1.6, 3.1),
    box(2.04, 0.5, 0.9, '#1e2a33', 0, 1.75, 2.3),
    ...[-1.5, 1.6].flatMap((z) =>
      [-1.0, 1.0].map((x) =>
        paint(
          new THREE.CylinderGeometry(0.38, 0.38, 0.3, 12)
            .rotateZ(Math.PI / 2)
            .translate(x, 0.38, z),
          new THREE.Color('#1a1a1a'),
        ),
      ),
    ),
  ].map((g) => (g.index ? g.toNonIndexed() : g));
  for (const g of parts) g.deleteAttribute('uv');
  shared = mergeGeometries(parts);
  return shared;
}

/**
 * Live vehicles in the scene: a van per vehicle with a flashing light bar and
 * a pin above it seen through buildings, eased to each new fix (no jumps) and
 * turned to its course; a stale fix fades the van and greys the pin.
 */
export class VehicleLayer {
  readonly group = new THREE.Group();
  private readonly body = new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0.1 });
  private readonly faded = new THREE.MeshStandardNodeMaterial({
    roughness: 0.55,
    metalness: 0.1,
    transparent: true,
    opacity: 0.35,
  });
  private readonly light = new THREE.MeshBasicNodeMaterial();
  /** Pins above the vans, seen through buildings: fresh green, stale grey. */
  private readonly pinFresh = new THREE.MeshBasicNodeMaterial({
    depthTest: false,
    transparent: true,
  });
  private readonly pinStale = new THREE.MeshBasicNodeMaterial({
    depthTest: false,
    transparent: true,
  });
  private readonly pinGeometry = (() => {
    const g = mergeGeometries([
      new THREE.ConeGeometry(1.1, 2.6, 16).rotateX(Math.PI).translate(0, 1.3, 0).toNonIndexed(),
      new THREE.SphereGeometry(1.5, 16, 10).translate(0, 3.3, 0).toNonIndexed(),
    ]);
    g.translate(0, 9, 0);
    return g;
  })();
  private readonly cars = new Map<
    string,
    {
      van: THREE.Mesh;
      beacon: THREE.Mesh;
      pin: THREE.Mesh;
      target: THREE.Vector3;
      yaw: number;
      targetYaw: number;
      last?: [number, number];
    }
  >();

  constructor() {
    this.group.name = 'vehicles';
    this.body.vertexColors = true;
    this.faded.vertexColors = true;
    // Amber / blue light bar flashing twice a second.
    this.light.colorNode = vec3(1.0, 0.55, 0.05).mul(sin(time.mul(12)).mul(0.5).add(0.5).mul(3));
    this.pinFresh.colorNode = vec3(0.13, 0.8, 0.4);
    this.pinStale.colorNode = vec3(0.55, 0.58, 0.6);
  }

  update(list: VehicleState[], at: VehiclePlacement): void {
    const seen = new Set<string>();
    for (const v of list) {
      const xy = at.worldOf(v.lon, v.lat);
      if (!xy) continue;
      seen.add(v.id);
      const target = new THREE.Vector3(...toThree(xy[0], xy[1], at.heightAt(xy[0], xy[1]) + 0.15));
      let car = this.cars.get(v.id);
      if (!car) {
        const van = new THREE.Mesh(vanGeometry(), this.body);
        van.castShadow = true;
        const beacon = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.22, 0.35), this.light);
        beacon.position.set(0, 2.32, 0.4);
        van.add(beacon);
        // The pin keeps upright (not turned with the van): a child of the group.
        const pin = new THREE.Mesh(this.pinGeometry, this.pinFresh);
        pin.renderOrder = 998;
        pin.name = `vehicle-${v.id}`;
        this.group.add(pin);
        van.position.copy(target);
        pin.position.copy(target);
        van.name = `vehicle-${v.id}`;
        this.group.add(van);
        car = { van, beacon, pin, target, yaw: 0, targetYaw: 0 };
        this.cars.set(v.id, car);
      }
      // Course: reported, else from the move since the last fix.
      let yaw = car.targetYaw;
      if (v.heading !== undefined && Number.isFinite(v.heading)) {
        const h = (v.heading * Math.PI) / 180;
        yaw = Math.atan2(Math.sin(h), -Math.cos(h));
      } else if (car.last) {
        const dx = xy[0] - car.last[0];
        const dy = xy[1] - car.last[1];
        if (Math.hypot(dx, dy) > 1) yaw = Math.atan2(dx, -dy);
      }
      car.last = xy;
      car.target = target;
      car.targetYaw = yaw;
      car.van.material = v.stale ? this.faded : this.body;
      car.beacon.visible = !v.stale;
      car.pin.material = v.stale ? this.pinStale : this.pinFresh;
    }
    for (const [id, car] of this.cars) {
      if (seen.has(id)) continue;
      car.van.removeFromParent();
      car.pin.removeFromParent();
      car.beacon.geometry.dispose();
      this.cars.delete(id);
    }
  }

  /** Eases every van towards its last fix (called each frame). */
  tick(dt: number): void {
    const k = 1 - Math.exp(-dt * 2.5);
    for (const car of this.cars.values()) {
      car.van.position.lerp(car.target, k);
      car.pin.position.copy(car.van.position);
      let d = car.targetYaw - car.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      car.yaw += d * k;
      car.van.rotation.y = car.yaw;
    }
  }

  /** World position (model x, y) of a vehicle, for the camera. */
  positionOf(id: string): [number, number] | null {
    const car = this.cars.get(id);
    return car ? [car.van.position.x, -car.van.position.z] : null;
  }

  /** Scene position (three.js) of a vehicle's van, for camera following. */
  scenePositionOf(id: string): THREE.Vector3 | null {
    return this.cars.get(id)?.van.position ?? null;
  }

  dispose(): void {
    for (const car of this.cars.values()) car.beacon.geometry.dispose();
    this.cars.clear();
    this.body.dispose();
    this.faded.dispose();
    this.light.dispose();
    this.pinFresh.dispose();
    this.pinStale.dispose();
    this.pinGeometry.dispose();
    this.group.removeFromParent();
  }
}
