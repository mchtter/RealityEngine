import type { CityModel } from '@kavra/core';
import * as THREE from 'three/webgpu';
import { toThree } from './geom';

/**
 * Station name boards over the platforms (F5b): hung from the ceiling, both
 * faces, the station's name over the lines that stop there — all from the
 * data (the concourse's name, the names of the tracks beside the platform).
 */

/** A board: its middle (tile-local model coordinates), the direction it faces (plan), its two lines. */
export interface StationSign {
  at: [number, number, number];
  facing: [number, number];
  title: string;
  lines: string;
}

/** Boards hang this high over the platform floor (m) and this far apart along it. */
const SIGN_HEIGHT = 3.2;
const SIGN_SPACING = 24;
/** A track counts as beside a platform within this distance of its outline's middle (m). */
const BESIDE = 30;

/** "M1 Line 2" → "M1", "Rapid Transit 1" → "RapidTransit". */
const lineName = (name: string) => name.replace(/\s+(Line|Hat(t[ıi])?)\s*\d+$/i, '').trim();

/** The boards of a compiled tile's platforms (pure: the tile worker builds them). */
export function stationSigns(model: CityModel): StationSign[] {
  const ug = model.underground;
  if (!ug) return [];
  const out: StationSign[] = [];
  const halls = ug.structures.filter((s) => s.kind !== 'platform' && s.name);
  for (const p of ug.structures) {
    if (p.kind !== 'platform') continue;
    const ring = p.footprint.outer;
    const c: [number, number] = [
      ring.reduce((a, q) => a + q[0], 0) / ring.length,
      ring.reduce((a, q) => a + q[1], 0) / ring.length,
    ];
    // The station: the nearest named concourse, else the platform's own name.
    let title = p.name ?? '';
    let best = Infinity;
    for (const h of halls) {
      const hr = h.footprint.outer;
      const hc = [
        hr.reduce((a, q) => a + q[0], 0) / hr.length,
        hr.reduce((a, q) => a + q[1], 0) / hr.length,
      ];
      const d = Math.hypot(hc[0] - c[0], hc[1] - c[1]);
      if (d < best && d < 200) [best, title] = [d, h.name!];
    }
    const lines = new Set<string>();
    for (const t of ug.tracks ?? []) {
      if (!t.name) continue;
      // Beside it and at its level (rail height at the nearest point: a city's ground slopes).
      const near = nearPath(t.path, c);
      if (near.d < BESIDE && Math.abs(near.z - (p.floorZ - 1.1)) < 2.5) lines.add(lineName(t.name));
    }
    if (!title && !lines.size) continue;
    // Along the platform's long side, facing across it.
    let axis: [number, number] = [1, 0];
    let len = 0;
    for (let k = 1; k < ring.length; k++) {
      const dx = ring[k][0] - ring[k - 1][0];
      const dy = ring[k][1] - ring[k - 1][1];
      const l = Math.hypot(dx, dy);
      if (l > len) [len, axis] = [l, [dx / l, dy / l]];
    }
    const n = Math.max(1, Math.floor(len / SIGN_SPACING));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n - 0.5;
      out.push({
        at: [c[0] + axis[0] * len * t, c[1] + axis[1] * len * t, p.floorZ + SIGN_HEIGHT],
        facing: [-axis[1], axis[0]],
        title: title || 'İstasyon',
        lines: [...lines].sort().join(' · '),
      });
    }
  }
  return out;
}

/** Board height on the platform (m); its width follows the text. */
const BOARD_HEIGHT = 0.9;

/** The boards' meshes (canvas text, both faces) for a tile's group; dispose with disposeStationSigns. */
export function buildStationSigns(
  signs: StationSign[] | undefined,
  group: THREE.Group,
): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  for (const s of signs ?? []) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    const titleFont = '600 56px Inter, system-ui, sans-serif';
    const lineFont = '500 40px Inter, system-ui, sans-serif';
    ctx.font = titleFont;
    const w1 = ctx.measureText(s.title).width;
    ctx.font = lineFont;
    const w2 = s.lines ? ctx.measureText(s.lines).width : 0;
    canvas.width = Math.ceil(Math.max(w1, w2) + 80);
    canvas.height = 140;
    ctx.fillStyle = '#123a6b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.font = titleFont;
    ctx.fillText(s.title, 40, s.lines ? 48 : 70);
    if (s.lines) {
      ctx.font = lineFont;
      ctx.fillStyle = '#ffd34d';
      ctx.fillText(s.lines, 40, 108);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const width = (BOARD_HEIGHT * canvas.width) / canvas.height;
    const geometry = new THREE.PlaneGeometry(width, BOARD_HEIGHT);
    const material = new THREE.MeshBasicNodeMaterial({ map: texture });
    // The plane faces +z (three): turn it to face across the platform. Both
    // faces read left to right (a double-sided plane would mirror the back).
    const [fx, fy] = s.facing;
    for (const turn of [0, Math.PI]) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(...toThree(s.at[0], s.at[1], s.at[2]));
      mesh.rotation.y = Math.atan2(fx, -fy) + turn;
      mesh.name = 'station-sign';
      group.add(mesh);
      out.push(mesh);
    }
  }
  return out;
}

export function disposeStationSigns(meshes: THREE.Mesh[]): void {
  for (const m of meshes) {
    m.removeFromParent();
    // The two faces of a board share geometry and material (disposing twice is harmless).
    m.geometry.dispose();
    const mat = m.material as THREE.MeshBasicNodeMaterial;
    mat.map?.dispose();
    mat.dispose();
  }
}

/** Plan distance from a point to a polyline, and the line's height at its nearest point. */
function nearPath(path: number[][], p: [number, number]): { d: number; z: number } {
  let best = { d: Infinity, z: path[0][2] };
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1];
    const b = path[k];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
    const d = Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]);
    if (d < best.d) best = { d, z: a[2] + (b[2] - a[2]) * t };
  }
  return best;
}
