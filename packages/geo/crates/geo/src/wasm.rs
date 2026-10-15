//! WebAssembly bindings (feature `wasm-bindgen`): the browser's tile worker
//! drapes polygons on a terrain kept in WASM memory (copied once per tile).

use wasm_bindgen::prelude::*;

use crate::drape::{Grid, Mesh, Piece, drape_on_terrain};

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
}
