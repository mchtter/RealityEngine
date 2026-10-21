import { type Building, type CityModel, terrainHeightAt } from '@kavra/core';
import * as THREE from 'three/webgpu';
import { type BuildingLayer, buildBuildingLayer } from './buildings';
import { buildFences } from './fences';
import { toThree } from './geom';
import { buildGround } from './ground';
import { groundRaster } from './landcover';
import type { DtMaterials } from './materials';
import { buildOverhead } from './overhead';
import { buildFixOverlay } from './overlays';
import { buildPropGroup } from './props';
import { buildRails } from './rails';
import {
  type MeshPayload,
  type TilePayload,
  isEmptyTile,
  serializeMeshes,
  summarize,
} from './tile-payload';
import { buildUnderground } from './underground';
import { buildUtilities } from './utilities';

/**
 * Building shells (walls, roofs, cornices) are one mesh per tile: draw calls,
 * not triangles, bound the frame on the CPU (measured 2026-10-01). Their 3D
 * detail (windows, balconies, roof clutter) is cut into DETAIL_CELL cells and
 * drawn only near the camera.
 */
export const DETAIL_CELL = 500;

/**
 * Material stand-in for the worker: builders assign `mats.wall` etc. to
 * meshes; here that is just the key, resolved to the real (GPU) material on
 * the main thread.
 */
const MATERIAL_KEYS = new Proxy({} as DtMaterials, { get: (_t, key) => key });

const isObserved = (b: Building) => b.source !== 'synthetic';

function tag(o: THREE.Object3D | null, role: string): void {
  if (o) o.userData.role = role;
}

/**
 * Builds the render content of one compiled tile and serializes it (runs in
 * the tile worker). Roles: `ground`, `fix`, `props:showcase`, `props:data`,
 * `tile:obs|synShell(Near|Far)?`, `sub:<i>:obsShell|obsDetail|synShell|synDetail|obsProps|synProps`; with
 * `utilities` also `util:<kind>`. The buried networks are left out by default:
 * they show only in the underground view and were the larger part of the
 * meshing (2.4 s of 3.9 s on a dense CoastCity tile) — `buildUtilityPayload`
 * builds them when that view opens. Their statistics stay in the summary.
 */
export function buildTilePayload(
  model: CityModel,
  /** far: only what a `far` CityTile keeps (no near ground, furniture, building detail). */
  options: { utilities?: boolean; far?: boolean } = {},
): {
  payload: TilePayload;
  transfer: ArrayBuffer[];
} {
  const mats = MATERIAL_KEYS;
  const root = new THREE.Group();
  // Sea only where the tile reaches down to it (the scene backdrop is ground).
  const t = model.terrain;
  const coastal = t.heights.some((h) => h <= t.seaLevel + 0.5);
  const far = !!options.far;
  root.add(buildGround(model, mats, { sea: coastal, empty: isEmptyTile(model), far }));
  if (!far) {
    const fences = buildFences(model, mats);
    if (fences) root.add(fences);
    const overhead = buildOverhead(model, mats);
    if (overhead) root.add(overhead);
    const rails = buildRails(model, mats);
    if (rails) root.add(rails);
    // Metro entrances on the street; stations below (shown in the underground view).
    const underground = buildUnderground(model, mats);
    if (underground) root.add(underground);
    // Manhole / valve covers lie on the street and always show; the networks below
    // (tubes, shafts, glowing cabinets) only with `utilities`.
    const utilities = buildUtilities(model, mats, { networks: !!options.utilities, covers: true });
    if (utilities) root.add(utilities);

    const street = model.props.filter((p) => !p.buildingId);
    const showcase = buildPropGroup(street, mats, 'showcase', 'props-showcase');
    tag(showcase, 'props:showcase');
    // Street furniture not in the data shown as holograms in the data view.
    const data = buildPropGroup(street, mats, 'data', 'props-data');
    tag(data, 'props:data');
    root.add(showcase, data);

    const fix = buildFixOverlay(model, mats).group;
    tag(fix, 'fix');
    root.add(fix);
  }

  const cellKey = (b: Building) => {
    const [x, y] = b.footprint.outer[0];
    return `${Math.floor(x / DETAIL_CELL)},${Math.floor(y / DETAIL_CELL)}`;
  };
  const obs = model.buildings.filter(isObserved);
  const syn = model.buildings.filter((b) => !isObserved(b));
  const observed = obs.length ? buildBuildingLayer(model, mats, obs, 'bo', cellKey, far) : null;
  const synthetic = syn.length ? buildBuildingLayer(model, mats, syn, 'bs', cellKey, far) : null;

  const detailProps = new Map<string, typeof model.props>();
  for (const p of model.props) {
    if (!p.buildingId) continue;
    const list = detailProps.get(p.buildingId) ?? [];
    list.push(p);
    detailProps.set(p.buildingId, list);
  }
  const cellIndex = new Map<string, number>();
  const subTiles: TilePayload['subTiles'] = [];
  const indexOf = (key: string) => {
    let i = cellIndex.get(key);
    if (i === undefined) {
      i = subTiles.length;
      cellIndex.set(key, i);
      const [tx, ty] = key.split(',').map(Number);
      const cx = (tx + 0.5) * DETAIL_CELL;
      const cy = (ty + 0.5) * DETAIL_CELL;
      subTiles.push({
        center: toThree(cx, cy, terrainHeightAt(model.terrain, cx, cy)),
        radius: DETAIL_CELL * 0.72,
      });
    }
    return i;
  };
  const tagLayer = (layer: BuildingLayer | null, kind: 'obs' | 'syn') => {
    if (!layer) return;
    for (const shell of layer.shells) tag(shell, `tile:${kind}Shell`);
    // Walls: bay-by-bay near the camera, one quad per edge beyond (CityTile switches).
    tag(layer.shells[0], `tile:${kind}ShellNear`);
    tag(layer.farWalls, `tile:${kind}ShellFar`);
    tag(layer.trim, `tile:${kind}Trim`);
    for (const [cell, objects] of layer.detailCells) {
      for (const o of objects) tag(o, `sub:${indexOf(cell)}:${kind}Detail`);
    }
    for (const p of layer.pickables) {
      p.mesh.userData.pick = { ids: layer.buildings.map((b) => b.id), owners: p.owners };
    }
    root.add(layer.group);
  };
  tagLayer(observed, 'obs');
  tagLayer(synthetic, 'syn');

  // Roof / wall clutter of buildings, per detail cell.
  for (const [kind, list] of far
    ? []
    : ([
        ['obs', obs],
        ['syn', syn],
      ] as const)) {
    const byCell = new Map<string, Building[]>();
    for (const b of list) {
      const key = cellKey(b);
      byCell.set(key, [...(byCell.get(key) ?? []), b]);
    }
    for (const [key, cellBuildings] of byCell) {
      const props = cellBuildings.flatMap((b) => detailProps.get(b.id) ?? []);
      if (!props.length) continue;
      const g = buildPropGroup(props, mats, 'showcase', `p${kind}-${key}`);
      tag(g, `sub:${indexOf(key)}:${kind}Props`);
      root.add(g);
    }
  }

  const { meshes, transfer } = serializeMeshes(root);
  const slots = {
    obs: observed?.buildings.map((b) => b.id) ?? [],
    syn: synthetic?.buildings.map((b) => b.id) ?? [],
  };
  // The open ground's colours, parcel by parcel (landcover.ts); the engine
  // copies it into the ground atlas the terrain samples.
  const ground = isEmptyTile(model) ? undefined : groundRaster(model, model.frame?.size ?? 1000);
  if (ground) transfer.push(ground.buffer as ArrayBuffer);
  return { payload: { summary: summarize(model), meshes, subTiles, slots, ground }, transfer };
}

/** The buried networks of a tile alone (`util:<kind>` meshes), for the underground view. */
export function buildUtilityPayload(model: CityModel): {
  meshes: MeshPayload[];
  transfer: ArrayBuffer[];
} {
  const root = new THREE.Group();
  const utilities = buildUtilities(model, MATERIAL_KEYS, { networks: true, covers: false });
  if (utilities) root.add(utilities);
  return serializeMeshes(root);
}
