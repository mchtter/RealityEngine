//! WebAssembly bindings (feature `wasm-bindgen`): the browser's tile worker
//! drapes polygons on a terrain kept in WASM memory (copied once per tile).

use wasm_bindgen::prelude::*;

use crate::drape::{Grid, Mesh, Piece, drape_on_terrain};
use crate::ground::{Layer, ground_chunk};

/// A tile's terrain grid, held in WASM memory.
#[wasm_bindgen]
pub struct Terrain {
    cols: usize,
    rows: usize,
    min_x: f64,
    min_y: f64,
    cell_size: f64,
    heights: Vec<f32>,
}

fn ring(flat: &[f64]) -> Vec<[f64; 2]> {
    flat.chunks_exact(2).map(|p| [p[0], p[1]]).collect()
}

#[wasm_bindgen]
impl Terrain {
    #[wasm_bindgen(constructor)]
    pub fn new(heights: &[f32], cols: u32, rows: u32, min_x: f64, min_y: f64, cell_size: f64) -> Terrain {
        Terrain { cols: cols as usize, rows: rows as usize, min_x, min_y, cell_size, heights: heights.to_vec() }
    }

    /// Drapes a polygon (geom.ts `drapeOnTerrain`). `outer`: x, y pairs;
    /// `holes`: every hole's x, y pairs in a row, `hole_starts`: the point
    /// index each hole starts at. Returns `[vertices, triangles, cells, x, y,
    /// z …, i0, i1, i2 …, ci, cj …]`: the cells are the grid cells covered
    /// whole (all as floats: exact below 2^24).
    pub fn drape(&self, outer: &[f64], holes: &[f64], hole_starts: &[u32], lift: f64, step: u32) -> Vec<f32> {
        let mut hs = Vec::with_capacity(hole_starts.len());
        let n = holes.len() / 2;
        for (k, &start) in hole_starts.iter().enumerate() {
            let end = hole_starts.get(k + 1).map(|&e| e as usize).unwrap_or(n);
            hs.push(ring(&holes[start as usize * 2..end * 2]));
        }
        let piece = Piece { outer: ring(outer), holes: hs };
        let grid = Grid {
            cols: self.cols,
            rows: self.rows,
            min_x: self.min_x,
            min_y: self.min_y,
            cell_size: self.cell_size,
            heights: &self.heights,
        };
        let mut mesh = Mesh::default();
        let mut cells: Vec<f32> = Vec::new();
        drape_on_terrain(&mut mesh, &piece, &grid, lift, step.max(1) as usize, &mut |i, j| {
            cells.push(i as f32);
            cells.push(j as f32);
        });
        let mut out = Vec::with_capacity(3 + mesh.positions.len() + mesh.indices.len() + cells.len());
        out.push(mesh.vertex_count() as f32);
        out.push(mesh.triangle_count() as f32);
        out.push((cells.len() / 2) as f32);
        out.extend_from_slice(&mesh.positions);
        out.extend(mesh.indices.iter().map(|&i| i as f32));
        out.extend_from_slice(&cells);
        out
    }

    /// One ground chunk (ground.rs `ground_chunk`). `cells`: [i0, j0, i1, j1).
    /// `layers`: per layer [lift, 0 / 1 deferred / 2 mask, polygon count], highest
    /// priority first. `polys`: every polygon in order as [outer length, hole
    /// count, hole lengths …, outer x, y …, holes' x, y …].
    /// Returns `[L, per layer: v, t, c, per contour: (n, hole 0 / 1), x, y, z …,
    /// i …, contour x, y …; bare: v, t, x, y, z …, i …; covered count, cells …;
    /// touched count, cells …]` (cells row-major `j * cols + i`).
    pub fn ground(&self, cells: &[u32], layers: &[f64], polys: &[f64]) -> Vec<f32> {
        let mut at = 0usize;
        let read_ring = |n: usize, at: &mut usize| -> Vec<[f64; 2]> {
            let r = polys[*at..*at + n * 2].chunks_exact(2).map(|p| [p[0], p[1]]).collect();
            *at += n * 2;
            r
        };
        let mut input = Vec::with_capacity(layers.len() / 3);
        for l in layers.chunks_exact(3) {
            let mut polygons = Vec::with_capacity(l[2] as usize);
            for _ in 0..l[2] as usize {
                let outer_n = polys[at] as usize;
                let holes_n = polys[at + 1] as usize;
                let lens: Vec<usize> = polys[at + 2..at + 2 + holes_n].iter().map(|&v| v as usize).collect();
                at += 2 + holes_n;
                let outer = read_ring(outer_n, &mut at);
                let holes = lens.iter().map(|&n| read_ring(n, &mut at)).collect();
                polygons.push(Piece { outer, holes });
            }
            input.push(Layer { polygons, lift: l[0], deferred: l[1] == 1.0, mask: l[1] == 2.0 });
        }
        let grid = Grid {
            cols: self.cols,
            rows: self.rows,
            min_x: self.min_x,
            min_y: self.min_y,
            cell_size: self.cell_size,
            heights: &self.heights,
        };
        let c = |k: usize| cells[k] as usize;
        let out = ground_chunk(&grid, [c(0), c(1), c(2), c(3)], &input);
        let mut v: Vec<f32> = Vec::new();
        let mesh = |v: &mut Vec<f32>, m: &Mesh| {
            v.extend_from_slice(&m.positions);
            v.extend(m.indices.iter().map(|&i| i as f32));
        };
        v.push(out.layers.len() as f32);
        for l in &out.layers {
            v.push(l.mesh.vertex_count() as f32);
            v.push(l.mesh.triangle_count() as f32);
            let rings: Vec<(&Vec<[f64; 2]>, bool)> = l
                .region
                .iter()
                .flat_map(|p| std::iter::once((&p.outer, false)).chain(p.holes.iter().map(|h| (h, true))))
                .collect();
            v.push(rings.len() as f32);
            for (r, hole) in &rings {
                v.push(r.len() as f32);
                v.push(*hole as u8 as f32);
            }
            mesh(&mut v, &l.mesh);
            for (r, _) in &rings {
                for p in r.iter() {
                    v.push(p[0] as f32);
                    v.push(p[1] as f32);
                }
            }
        }
        v.push(out.bare.vertex_count() as f32);
        v.push(out.bare.triangle_count() as f32);
        mesh(&mut v, &out.bare);
        v.push(out.covered.len() as f32);
        v.extend(out.covered.iter().map(|&k| k as f32));
        v.push(out.touched.len() as f32);
        v.extend(out.touched.iter().map(|&k| k as f32));
        v
    }
}
