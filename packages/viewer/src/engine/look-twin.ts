import * as THREE from 'three/webgpu';
import { HIDDEN_LAYER } from './ground-clipmap';

/**
 * A mesh drawn with another material for a while (the map look's plain
 * walls, the draped ground) by a child sharing its geometry, swapped in by
 * layers: three's WebGPU renderer rebuilds a mesh's render state whenever its
 * material changes — a city's ground and shells at once stalled a frame
 * 0.6–1.2 s (measured 2026-10-17); a layer flip costs nothing. `material`
 * null: the mesh itself again.
 */
export function setLook(m: THREE.Mesh, key: string, material: THREE.Material | null): void {
  const looks = (m.userData.looks ??= {}) as Record<string, THREE.Mesh>;
  const own = (m.userData.ownLayers ??= m.layers.mask) as number;
  for (const t of Object.values(looks)) t.layers.set(HIDDEN_LAYER);
  if (!material) {
    m.layers.mask = own;
    return;
  }
  let t = looks[key];
  if (!t) {
    t = new THREE.Mesh(m.geometry, material);
    t.name = `${m.name}~${key}`;
    t.frustumCulled = m.frustumCulled;
    m.add(t);
    looks[key] = t;
  } else if (t.material !== material) t.material = material;
  t.layers.mask = own;
  t.castShadow = m.castShadow;
  t.receiveShadow = m.receiveShadow;
  t.renderOrder = m.renderOrder;
  m.layers.set(HIDDEN_LAYER);
}

/** A ray that tests meshes on every layer (a mesh in another look sits on the hidden one). */
export function allLayersRay(): THREE.Raycaster {
  const ray = new THREE.Raycaster();
  ray.layers.enableAll();
  return ray;
}
