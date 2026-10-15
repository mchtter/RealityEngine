//! One ground layer per chunk (master plan F1, docs/DECISIONS.md D-004):
//! the surfaces of a ground chunk made disjoint — each layer loses what the
//! layers above it cover — then draped on the terrain grid; the bare ground
//! (what no surface covers) is draped only in the cells a surface touches,
//! the terrain mesh drawing the cells no surface touches. No point of the
//! chunk is drawn twice (the old viewer layered surfaces and terrain with
//! centimetre lifts: ~38 % of a dense tile's area twice, 2026-10-15).

use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::single::SingleFloatOverlay;

use crate::drape::{CellFilter, Grid, Mesh, P2, Piece, drape_cells_filtered};

/// A surface layer, highest priority first in the input.
pub struct Layer {
    pub polygons: Vec<Piece>,
    /// Metres above the height source.
    pub lift: f64,
    /// Heights are left NaN for the caller (the street surface lives in JS).
    pub deferred: bool,
    /// Cuts the layers below and the bare ground (an underpass trench, a
    /// tunnel-mouth lid) but draws nothing itself.
    pub mask: bool,
}

pub struct LayerOut {
    pub mesh: Mesh,
    /// The layer's own region after the layers above it: polygons (outer + holes).
    pub region: Vec<Piece>,
}

pub struct GroundOut {
    pub layers: Vec<LayerOut>,
    /// Bare ground in the cells a surface touches but does not cover.
    pub bare: Mesh,
    /// Cells (row-major grid index) covered whole by a surface.
    pub covered: Vec<u32>,
    /// Cells a surface touches but does not cover (drawn by `bare`).
    pub touched: Vec<u32>,
}

fn oriented(r: &[P2], ccw: bool) -> Vec<P2> {
    let n = r.len();
    let mut s = 0.0;
    for k in 0..n {
        let p = r[k];
        let q = r[(k + 1) % n];
        s += p[0] * q[1] - q[0] * p[1];
    }
    let mut out = r.to_vec();
    if (s > 0.0) != ccw {
        out.reverse();
    }
    out
}

/// Contours of pieces for a non-zero overlay: outers counter-clockwise, holes clockwise.
fn contours(pieces: &[Piece]) -> Vec<Vec<P2>> {
    let mut out = Vec::new();
    for p in pieces {
        if p.outer.len() < 3 {
            continue;
        }
        out.push(oriented(&p.outer, true));
        for h in &p.holes {
            if h.len() >= 3 {
                out.push(oriented(h, false));
            }
        }
    }
    out
}

fn to_pieces(shapes: Vec<Vec<Vec<P2>>>) -> Vec<Piece> {
    shapes
        .into_iter()
        .filter(|s| !s.is_empty() && s[0].len() >= 3)
        .map(|mut s| {
            let outer = s.remove(0);
            Piece { outer, holes: s }
        })
        .collect()
}

/// Builds one chunk's ground. `cells`: the chunk's grid cell range [i0, j0, i1, j1) of `grid`.
pub fn ground_chunk(grid: &Grid, cells: [usize; 4], layers: &[Layer]) -> GroundOut {
    let [i0, j0, i1, j1] = cells;
    let cs = grid.cell_size;
    let (x0, y0) = (grid.min_x + i0 as f64 * cs, grid.min_y + j0 as f64 * cs);
    let (x1, y1) = (grid.min_x + i1 as f64 * cs, grid.min_y + j1 as f64 * cs);
    let rect: Vec<Vec<P2>> = vec![vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]]];
    let cols = grid.cols;
    let mut covered = vec![false; cols * grid.rows];
    let mut touched = vec![false; cols * grid.rows];
    let in_chunk = |i: i64, j: i64| i >= i0 as i64 && j >= j0 as i64 && i < i1 as i64 && j < j1 as i64;

    let mut above: Vec<Vec<P2>> = Vec::new();
    let mut outs = Vec::with_capacity(layers.len());
    for layer in layers {
        let own = contours(&layer.polygons);
        let mut region = Vec::new();
        if !own.is_empty() {
            let clipped = own.overlay(&rect, OverlayRule::Intersect, FillRule::NonZero);
            region = if above.is_empty() {
                to_pieces(clipped)
            } else {
                let mine = contours(&to_pieces(clipped));
                to_pieces(mine.overlay(&above, OverlayRule::Difference, FillRule::NonZero))
            };
        }
        let mut mesh = Mesh::default();
        let mut scratch = Mesh::default();
        let lift = layer.lift;
        let deferred = layer.deferred;
        let height = |x: f64, y: f64| if deferred { f64::NAN } else { grid.height_at(x, y) + 0.0 };
        for piece in &region {
            drape_cells_filtered(
                if layer.mask { &mut scratch } else { &mut mesh },
                piece,
                (grid.min_x, grid.min_y),
                cs,
                &height,
                if deferred { 0.0 } else { lift },
                1,
                None,
                &mut |i, j| {
                    if in_chunk(i, j) {
                        covered[j as usize * cols + i as usize] = true;
                    }
                },
                &mut |i, j| {
                    if in_chunk(i, j) {
                        touched[j as usize * cols + i as usize] = true;
                    }
                },
            );
        }
        above.extend(contours(&region));
        outs.push(LayerOut { mesh, region });
    }

    // A cell covered whole by one layer and touched by another is still covered
    // whole by surfaces only if nothing bare is left in it — the bare drape
    // decides: touched cells keep the bare ground the surfaces leave.
    let partial: Vec<bool> = (0..covered.len()).map(|k| touched[k] && !covered[k]).collect();
    let filter = CellFilter::new(&partial, cols, grid.rows);
    let mut bare = Mesh::default();
    if !above.is_empty() {
        let bare_region = to_pieces(rect.overlay(&above, OverlayRule::Difference, FillRule::NonZero));
        let height = |x: f64, y: f64| grid.height_at(x, y);
        for piece in &bare_region {
            drape_cells_filtered(
                &mut bare,
                piece,
                (grid.min_x, grid.min_y),
                cs,
                &height,
                0.0,
                1,
                Some(&filter),
                &mut |_, _| {},
                &mut |_, _| {},
            );
        }
    }
    GroundOut {
        layers: outs,
        bare,
        covered: (0..covered.len()).filter(|&k| covered[k] && !partial[k]).map(|k| k as u32).collect(),
        touched: (0..partial.len()).filter(|&k| partial[k]).map(|k| k as u32).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sq(x0: f64, y0: f64, x1: f64, y1: f64) -> Piece {
        Piece { outer: vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]], holes: vec![] }
    }

    fn area(m: &Mesh) -> f64 {
        let mut a = 0.0;
        for t in m.indices.chunks(3) {
            let p = |i: u32| [m.positions[i as usize * 3] as f64, m.positions[i as usize * 3 + 1] as f64];
            let (x, y, z) = (p(t[0]), p(t[1]), p(t[2]));
            a += ((y[0] - x[0]) * (z[1] - x[1]) - (y[1] - x[1]) * (z[0] - x[0])).abs() / 2.0;
        }
        a
    }

    #[test]
    fn overlapping_layers_become_disjoint_and_the_bare_ground_fills_the_rest() {
        // 4 x 4 cells of 4 m (16 m square), flat.
        let h = vec![0.0f32; 25];
        let grid = Grid { cols: 5, rows: 5, min_x: 0.0, min_y: 0.0, cell_size: 4.0, heights: &h };
        let layers = [
            Layer { polygons: vec![sq(2.0, 2.0, 10.0, 10.0)], lift: 0.24, deferred: true, mask: false },
            Layer { polygons: vec![sq(6.0, 6.0, 14.0, 14.0)], lift: 0.05, deferred: false, mask: false },
        ];
        let out = ground_chunk(&grid, [0, 0, 4, 4], &layers);
        let top = area(&out.layers[0].mesh);
        let low = area(&out.layers[1].mesh);
        assert!((top - 64.0).abs() < 1e-6, "top {top}");
        // 64 m² minus the 16 m² the top layer covers.
        assert!((low - 48.0).abs() < 1e-6, "low {low}");
        // Bare ground only in touched cells; covered + touched cells + bare = the surfaces' cells.
        let touched_area = out.touched.len() as f64 * 16.0;
        let in_touched_surfaces = touched_area - area(&out.bare);
        assert!(in_touched_surfaces > 0.0);
        // Every cell is either covered, touched, or untouched (terrain mesh), never two.
        for c in &out.covered {
            assert!(!out.touched.contains(c));
        }
        // Deferred heights are NaN; the other layer sits on the terrain plus its lift.
        assert!(out.layers[0].mesh.positions.chunks(3).all(|p| p[2].is_nan()));
        assert!(out.layers[1].mesh.positions.chunks(3).all(|p| (p[2] - 0.05).abs() < 1e-6));
    }

    #[test]
    fn surfaces_plus_bare_ground_tile_the_touched_cells_exactly() {
        let h: Vec<f32> = (0..25).map(|k| (k % 5) as f32).collect();
        let grid = Grid { cols: 5, rows: 5, min_x: 0.0, min_y: 0.0, cell_size: 4.0, heights: &h };
        let tri = Piece { outer: vec![[1.0, 1.0], [13.0, 2.0], [3.0, 15.0]], holes: vec![] };
        let layers = [Layer { polygons: vec![tri], lift: 0.0, deferred: false, mask: false }];
        let out = ground_chunk(&grid, [0, 0, 4, 4], &layers);
        // In the touched cells the surface and the bare ground add up to the cells.
        let surface_in_touched = {
            let m = &out.layers[0].mesh;
            let mut a = 0.0;
            for t in m.indices.chunks(3) {
                let p = |i: u32| [m.positions[i as usize * 3] as f64, m.positions[i as usize * 3 + 1] as f64];
                let (x, y, z) = (p(t[0]), p(t[1]), p(t[2]));
                let cx = (x[0] + y[0] + z[0]) / 3.0;
                let cy = (x[1] + y[1] + z[1]) / 3.0;
                let cell = (cy / 4.0).floor() as u32 * 5 + (cx / 4.0).floor() as u32;
                if out.touched.contains(&cell) {
                    a += ((y[0] - x[0]) * (z[1] - x[1]) - (y[1] - x[1]) * (z[0] - x[0])).abs() / 2.0;
                }
            }
            a
        };
        let cells = out.touched.len() as f64 * 16.0;
        assert!((surface_in_touched + area(&out.bare) - cells).abs() < 1e-6);
    }

    #[test]
    fn a_mask_layer_cuts_what_lies_below_and_draws_nothing() {
        let h = vec![0.0f32; 25];
        let grid = Grid { cols: 5, rows: 5, min_x: 0.0, min_y: 0.0, cell_size: 4.0, heights: &h };
        let layers = [
            Layer { polygons: vec![sq(0.0, 6.0, 16.0, 10.0)], lift: 0.0, deferred: false, mask: true },
            Layer { polygons: vec![sq(2.0, 2.0, 14.0, 14.0)], lift: 0.0, deferred: false, mask: false },
        ];
        let out = ground_chunk(&grid, [0, 0, 4, 4], &layers);
        assert_eq!(out.layers[0].mesh.triangle_count(), 0);
        // 144 m² minus the 12 x 4 m strip the trench takes.
        assert!((area(&out.layers[1].mesh) - (144.0 - 48.0)).abs() < 1e-6);
        // Nothing bare inside the trench either.
        let bare_in_trench = out.bare.positions.chunks(3).any(|p| p[1] > 6.01 && p[1] < 9.99);
        assert!(!bare_in_trench);
    }
}
