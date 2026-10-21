import type { LiveObjectView } from './live-kinds';
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { type LivePlacement, LiveObjectLayer } from './live-objects';

/** World = lon / lat × 1000 m (a flat test frame); terrain at 50 m. */
const place: LivePlacement = {
  worldOf: (lon, lat) => (lon < 0 ? null : [lon * 1000, lat * 1000]),
  heightAt: () => 50,
  surfaceAt: () => 50.5,
};

const obj = (
  id: string,
  classId: string,
  lon: number,
  lat: number,
  extra: Partial<LiveObjectView> = {},
) => ({ id, classId, lon, lat, at: new Date().toISOString(), ...extra }) as LiveObjectView;

/** Camera 400 m south of the origin, 300 m up, looking at the origin. */
function camera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(45, 1, 1, 50_000);
  cam.position.set(0, 300, 400);
  cam.lookAt(0, 50, 0);
  cam.updateMatrixWorld();
  return cam;
}

const instances = (layer: LiveObjectLayer, name: string) => {
  const mesh = layer.group.getObjectByName(name) as THREE.Mesh;
  return mesh.visible ? (mesh.geometry as THREE.InstancedBufferGeometry).instanceCount : 0;
};

const screenOf = (cam: THREE.PerspectiveCamera, x: number, y: number, z: number) => {
  const v = new THREE.Vector3(x, z, -y).project(cam);
  return [((v.x + 1) / 2) * 1000, ((1 - v.y) / 2) * 1000] as const;
};

describe('LiveObjectLayer', () => {
  it('draws one instance per object in its kind, skipping objects outside the world frame', () => {
    const layer = new LiveObjectLayer();
    layer.apply(
      {
        pluginId: 'p',
        feedId: 'f',
        upsert: [
          obj('a1', 'aviation.aircraft', 0, 0, { alt: 900 }),
          obj('a2', 'aviation.aircraft', 0.1, 0, { alt: 900 }),
          obj('b', 'transit.bus', 0.05, 0.05),
          obj('cam', 'safety.cctv', 0.02, 0.02),
          obj('q', 'hazard.earthquake', 0.03, 0.03, { attrs: { magnitude: 4.2 } }),
          obj('out', 'transit.bus', -1, 0),
        ],
        remove: [],
      },
      120_000,
    );
    layer.tick(0.016, camera(), 1000, 1000, place);
    expect(instances(layer, 'live-aircraft')).toBe(2);
    expect(instances(layer, 'live-bus')).toBe(1); // 'out' has no world position
    expect(instances(layer, 'live-cctv')).toBe(1);
    expect(instances(layer, 'live-cctv-cones')).toBe(1);
    expect(instances(layer, 'live-marker')).toBe(1);
    expect(instances(layer, 'live-vessel')).toBe(0);
    layer.dispose();
  });

  it('flies aircraft at their altitude and puts ground objects on the drawn surface', () => {
    const layer = new LiveObjectLayer();
    layer.apply(
      {
        pluginId: 'p',
        feedId: 'f',
        upsert: [
          obj('a', 'aviation.aircraft', 0, 0, { alt: 900 }),
          obj('low', 'aviation.aircraft', 0.1, 0, { alt: 10 }),
          obj('b', 'transit.bus', 0.05, 0.05),
        ],
        remove: [],
      },
      120_000,
    );
    layer.tick(0.016, camera(), 1000, 1000, place);
    const y = (id: string) => layer.stateOf({ pluginId: 'p', feedId: 'f', objectId: id })!.pos.y;
    expect(y('a')).toBe(900);
    expect(y('low')).toBe(52); // terrain 50 + 2 m clearance
    expect(y('b')).toBe(50.5);
    expect(layer.stateOf({ pluginId: 'p', feedId: 'f', objectId: 'a' })!.airborne).toBe(true);
    layer.dispose();
  });

  it('applies replace / remove changes per feed', () => {
    const layer = new LiveObjectLayer();
    const ref = (feedId: string, objectId: string) => ({ pluginId: 'p', feedId, objectId });
    layer.apply(
      {
        pluginId: 'p',
        feedId: 'f',
        upsert: [obj('a', 'transit.bus', 0, 0), obj('b', 'transit.bus', 0, 0)],
        remove: [],
      },
      120_000,
    );
    layer.apply(
      { pluginId: 'p', feedId: 'g', upsert: [obj('a', 'transit.bus', 0, 0)], remove: [] },
      120_000,
    );
    layer.apply(
      {
        pluginId: 'p',
        feedId: 'f',
        upsert: [obj('c', 'transit.bus', 0, 0)],
        remove: [],
        replace: true,
      },
      120_000,
    );
    expect(layer.has(ref('f', 'a'))).toBe(false);
    expect(layer.has(ref('f', 'b'))).toBe(false);
    expect(layer.has(ref('f', 'c'))).toBe(true);
    expect(layer.has(ref('g', 'a'))).toBe(true);
    layer.apply({ pluginId: 'p', feedId: 'g', upsert: [], remove: ['a'] }, 120_000);
    expect(layer.has(ref('g', 'a'))).toBe(false);
    layer.dispose();
  });

  it('picks the object drawn nearest to a click within ~12 px', () => {
    const layer = new LiveObjectLayer();
    layer.apply(
      {
        pluginId: 'p',
        feedId: 'f',
        upsert: [obj('bus', 'transit.bus', 0, 0), obj('far', 'transit.bus', 0.15, 0.15)],
        remove: [],
      },
      120_000,
    );
    const cam = camera();
    layer.tick(0.016, cam, 1000, 1000, place);
    // The bus's middle: 1.6 m above the surface.
    const [sx, sy] = screenOf(cam, 0, 0, 50.5 + 1.6);
    expect(layer.pick(cam, 1000, 1000, sx + 5, sy - 4)).toEqual({
      pluginId: 'p',
      feedId: 'f',
      objectId: 'bus',
    });
    expect(layer.pick(cam, 1000, 1000, sx + 200, sy)).toBeNull();
    layer.dispose();
  });

  it('reports the selected object’s label anchor on the screen', () => {
    const layer = new LiveObjectLayer();
    layer.apply(
      { pluginId: 'p', feedId: 'f', upsert: [obj('bus', 'transit.bus', 0, 0)], remove: [] },
      120_000,
    );
    const seen: ({ x: number; y: number } | null)[] = [];
    layer.onScreen((p) => seen.push(p));
    layer.select({ pluginId: 'p', feedId: 'f', objectId: 'bus' });
    const cam = camera();
    layer.tick(0.016, cam, 1000, 1000, place);
    const last = seen.at(-1)!;
    const [sx, sy] = screenOf(cam, 0, 0, 50.5 + 3.6);
    expect(last.x).toBeCloseTo(sx, 0);
    expect(last.y).toBeCloseTo(sy, 0);
    layer.select(null);
    layer.tick(0.016, cam, 1000, 1000, place);
    expect(seen.at(-1)).toBeNull();
    layer.dispose();
  });
});
