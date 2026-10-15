//! Cell-first draping of a polygon on the terrain grid — a port of
//! `drapeOnTerrain` / `drapeCells` (apps/web/src/components/dt/engine/geom.ts),
//! same algorithm and same output: a quadtree clips the polygon to ever
//! smaller squares; a square it covers whole is emitted as the grid's own
//! triangles (2 per cell, split along (i, j) → (i + 1, j + 1)), only cells on
//! its edge are cut to their two triangles. Every vertex lies on the terrain
//! mesh (`step`: every `step`-th grid node) plus `lift`.

use rustc_hash::FxHashMap;

use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::single::SingleFloatOverlay;

pub type P2 = [f64; 2];
pub type Ring = Vec<P2>;

/// A polygon: outer ring and holes (open rings, any winding).
#[derive(Clone, Debug, Default)]
pub struct Piece {
    pub outer: Ring,
    pub holes: Vec<Ring>,
}

/// The terrain grid (city-core `TerrainGrid`): heights row by row from (minX, minY).
pub struct Grid<'a> {
    pub cols: usize,
    pub rows: usize,
    pub min_x: f64,
    pub min_y: f64,
    pub cell_size: f64,
    pub heights: &'a [f32],
}

impl Grid<'_> {
    #[inline]
    fn h(&self, i: usize, j: usize) -> f64 {
        self.heights[j * self.cols + i] as f64
    }

    /// city-core `terrainHeightAt`: the full grid's triangles.
    pub fn height_at(&self, x: f64, y: f64) -> f64 {
        let fx = ((x - self.min_x) / self.cell_size).clamp(0.0, self.cols as f64 - 1.0001);
        let fy = ((y - self.min_y) / self.cell_size).clamp(0.0, self.rows as f64 - 1.0001);
        let i = fx.floor() as usize;
        let j = fy.floor() as usize;
        let u = fx - i as f64;
        let v = fy - j as f64;
        let h00 = self.h(i, j);
        let h11 = self.h(i + 1, j + 1);
        if u >= v {
            h00 + (self.h(i + 1, j) - h00) * u + (h11 - self.h(i + 1, j)) * v
        } else {
            h00 + (h11 - self.h(i, j + 1)) * u + (self.h(i, j + 1) - h00) * v
        }
    }

    /// geom.ts `gridHeightAt`: the mesh from every `step`-th node.
    pub fn height_at_step(&self, step: usize, x: f64, y: f64) -> f64 {
        if step == 1 {
            return self.height_at(x, y);
        }
        let cs = self.cell_size * step as f64;
        let nx = ((self.cols - 1) / step) as f64;
        let ny = ((self.rows - 1) / step) as f64;
        let fx = ((x - self.min_x) / cs).clamp(0.0, nx - 0.0001);
        let fy = ((y - self.min_y) / cs).clamp(0.0, ny - 0.0001);
        let i = fx.floor() as usize;
        let j = fy.floor() as usize;
        let u = fx - i as f64;
        let v = fy - j as f64;
        let h = |ii: usize, jj: usize| self.heights[jj * step * self.cols + ii * step] as f64;
        let h00 = h(i, j);
        let h11 = h(i + 1, j + 1);
        if u >= v {
            h00 + (h(i + 1, j) - h00) * u + (h11 - h(i + 1, j)) * v
        } else {
            h00 + (h11 - h(i, j + 1)) * u + (h(i, j + 1) - h00) * v
        }
    }
}

/// Triangles in model coordinates (x east, y north, z up), indexed.
#[derive(Default)]
pub struct Mesh {
    pub positions: Vec<f32>,
    pub indices: Vec<u32>,
}

impl Mesh {
    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }
    pub fn vertex_count(&self) -> usize {
        self.positions.len() / 3
    }
}

fn ring_area2(r: &[P2]) -> f64 {
    let n = r.len();
    let mut s = 0.0;
    for k in 0..n {
        let p = r[k];
        let q = r[(k + 1) % n];
        s += p[0] * q[1] - q[0] * p[1];
    }
    (s / 2.0).abs()
}

fn signed2(r: &[P2]) -> f64 {
    let n = r.len();
    let mut s = 0.0;
    for k in 0..n {
        let p = r[k];
        let q = r[(k + 1) % n];
        s += p[0] * q[1] - q[0] * p[1];
    }
    s
}

fn ccw(r: &[P2]) -> Ring {
    let mut out = r.to_vec();
    if signed2(r) < 0.0 {
        out.reverse();
    }
    out
}

fn pieces_area(ps: &[Piece]) -> f64 {
    ps.iter()
        .map(|p| ring_area2(&p.outer) - p.holes.iter().map(|h| ring_area2(h)).sum::<f64>())
        .sum()
}

fn ring_box(r: &[P2]) -> [f64; 4] {
    let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for p in r {
        b[0] = b[0].min(p[0]);
        b[1] = b[1].min(p[1]);
        b[2] = b[2].max(p[0]);
        b[3] = b[3].max(p[1]);
    }
    b
}

fn is_convex(r: &[P2]) -> bool {
    let n = r.len();
    let mut sign = 0.0f64;
    for k in 0..n {
        let a = r[k];
        let b = r[(k + 1) % n];
        let c = r[(k + 2) % n];
        let cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
        if cross.abs() < 1e-9 {
            continue;
        }
        if sign == 0.0 {
            sign = cross.signum();
        } else if cross.signum() != sign {
            return false;
        }
    }
    true
}

/// Sutherland–Hodgman: a ring clipped to a convex counter-clockwise window.
fn clip_ring_convex(ring: &[P2], win: &[P2]) -> Ring {
    let mut out: Ring = ring.to_vec();
    let mut input: Ring = Vec::with_capacity(ring.len() + 4);
    for e in 0..win.len() {
        if out.is_empty() {
            break;
        }
        let a = win[e];
        let b = win[(e + 1) % win.len()];
        let side = |p: P2| (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
        std::mem::swap(&mut input, &mut out);
        out.clear();
        let n = input.len();
        for k in 0..n {
            let p = input[k];
            let q = input[(k + 1) % n];
            let sp = side(p);
            let sq = side(q);
            if sp >= 0.0 {
                out.push(p);
            }
            if (sp >= 0.0) != (sq >= 0.0) {
                let t = sp / (sp - sq);
                out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
            }
        }
    }
    out
}

/// Exact boolean intersection of a piece with a convex window (geom.ts
/// `clipPolygons`): holes crossing the window edge become part of the outline.
fn clip_exact(p: &Piece, holes: &[Ring], win: &[P2]) -> Vec<Piece> {
    let mut subject: Vec<Vec<P2>> = Vec::with_capacity(holes.len() + 1);
    subject.push(p.outer.clone());
    subject.extend(holes.iter().cloned());
    let clip: Vec<Vec<P2>> = vec![win.to_vec()];
    let shapes = subject.overlay(&clip, OverlayRule::Intersect, FillRule::EvenOdd);
    shapes
        .into_iter()
        .filter(|s| !s.is_empty())
        .map(|s| Piece {
            outer: ccw(&s[0]),
            holes: s[1..].iter().map(|h| ccw(h)).collect(),
        })
        .collect()
}

/// geom.ts `clipPieces`.
fn clip_pieces(pieces: &[Piece], win: &[P2], wb: [f64; 4], rect_window: bool) -> Vec<Piece> {
    let inside =
        |b: [f64; 4]| rect_window && b[0] >= wb[0] && b[1] >= wb[1] && b[2] <= wb[2] && b[3] <= wb[3];
    let outside = |b: [f64; 4]| b[2] <= wb[0] || b[0] >= wb[2] || b[3] <= wb[1] || b[1] >= wb[3];
    let mut out = Vec::new();
    for p in pieces {
        let ob = ring_box(&p.outer);
        if outside(ob) {
            continue;
        }
        if inside(ob) {
            out.push(p.clone());
            continue;
        }
        let holes: Vec<Ring> = p.holes.iter().filter(|h| !outside(ring_box(h))).cloned().collect();
        if holes.iter().any(|h| !inside(ring_box(h))) || (!rect_window && !is_convex(&p.outer)) {
            out.extend(clip_exact(p, &holes, win));
            continue;
        }
        let o = clip_ring_convex(&p.outer, win);
        if o.len() >= 3 && ring_area2(&o) > 1e-6 {
            out.push(Piece { outer: o, holes });
        }
    }
    out
}

/// One drape call's output state (vertices shared within the call only, as in geom.ts).
struct Emitter<'m, 'g, F: Fn(f64, f64) -> f64> {
    mesh: &'m mut Mesh,
    height_at: &'g F,
    lift: f64,
    cache: FxHashMap<(i64, i64), u32>,
}

impl<F: Fn(f64, f64) -> f64> Emitter<'_, '_, F> {
    fn vtx(&mut self, p: P2) -> u32 {
        let key = ((p[0] * 100.0).round() as i64, (p[1] * 100.0).round() as i64);
        if let Some(&id) = self.cache.get(&key) {
            return id;
        }
        let id = (self.mesh.positions.len() / 3) as u32;
        let z = (self.height_at)(p[0], p[1]) + self.lift;
        self.mesh.positions.extend_from_slice(&[p[0] as f32, p[1] as f32, z as f32]);
        self.cache.insert(key, id);
        id
    }

    fn emit(&mut self, a: P2, b: P2, d: P2) {
        let ia = self.vtx(a);
        let ib = self.vtx(b);
        let id = self.vtx(d);
        if ia != ib && ib != id && ia != id {
            self.mesh.indices.extend_from_slice(&[ia, ib, id]);
        }
    }

    fn triangulate_pieces(&mut self, pieces: &[Piece]) {
        for p in pieces {
            let mut flat: Vec<f64> = Vec::with_capacity(
                2 * (p.outer.len() + p.holes.iter().map(|h| h.len()).sum::<usize>()),
            );
            let mut hole_idx = Vec::with_capacity(p.holes.len());
            for q in &p.outer {
                flat.extend_from_slice(q);
            }
            for h in &p.holes {
                hole_idx.push(flat.len() / 2);
                for q in h {
                    flat.extend_from_slice(q);
                }
            }
            let Ok(ix) = earcutr::earcut(&flat, &hole_idx, 2) else { continue };
            for t in ix.chunks_exact(3) {
                let pt = |k: usize| [flat[k * 2], flat[k * 2 + 1]];
                let a = pt(t[0]);
                let mut b = pt(t[1]);
                let mut d = pt(t[2]);
                let cross = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]);
                if cross.abs() < 1e-9 {
                    continue;
                }
                // Upward facing (CCW from above); earcut's winding is not guaranteed.
                if cross < 0.0 {
                    std::mem::swap(&mut b, &mut d);
                }
                self.emit(a, b, d);
            }
        }
    }
}

/// geom.ts `drapeCells` with a height function.
pub fn drape_cells<F: Fn(f64, f64) -> f64>(
    mesh: &mut Mesh,
    poly: &Piece,
    origin: (f64, f64),
    cell_size: f64,
    height_at: &F,
    lift: f64,
    step: usize,
    on_full_cell: &mut dyn FnMut(i64, i64),
) {
    let cs = cell_size * step as f64;
    let (ox, oy) = origin;
    let mut em = Emitter { mesh, height_at, lift, cache: FxHashMap::default() };
    let b = ring_box(&poly.outer);
    if !b[0].is_finite() {
        return;
    }
    let i0 = ((b[0] - ox) / cs).floor() as i64;
    let j0 = ((b[1] - oy) / cs).floor() as i64;
    let mut n: i64 = 1;
    while ox + ((i0 + n) as f64) * cs < b[2] || oy + ((j0 + n) as f64) * cs < b[3] {
        n *= 2;
    }
    let root = vec![Piece { outer: ccw(&poly.outer), holes: poly.holes.iter().map(|h| ccw(h)).collect() }];
    visit(&mut em, &root, i0, j0, n, ox, oy, cs, on_full_cell);
}

#[allow(clippy::too_many_arguments)]
fn visit<F: Fn(f64, f64) -> f64>(
    em: &mut Emitter<'_, '_, F>,
    pieces: &[Piece],
    i0: i64,
    j0: i64,
    n: i64,
    ox: f64,
    oy: f64,
    cs: f64,
    on_full_cell: &mut dyn FnMut(i64, i64),
) {
    if pieces.is_empty() {
        return;
    }
    let x0 = ox + i0 as f64 * cs;
    let y0 = oy + j0 as f64 * cs;
    let side = n as f64 * cs;
    if pieces_area(pieces) >= side * side * (1.0 - 1e-6) {
        for j in j0..j0 + n {
            for i in i0..i0 + n {
                let a = ox + i as f64 * cs;
                let b = oy + j as f64 * cs;
                em.emit([a, b], [a + cs, b], [a + cs, b + cs]);
                em.emit([a, b], [a + cs, b + cs], [a, b + cs]);
                on_full_cell(i, j);
            }
        }
        return;
    }
    if n == 1 {
        let x1 = x0 + cs;
        let y1 = y0 + cs;
        let wb = [x0, y0, x1, y1];
        let lower = clip_pieces(pieces, &[[x0, y0], [x1, y0], [x1, y1]], wb, false);
        em.triangulate_pieces(&lower);
        let upper = clip_pieces(pieces, &[[x0, y0], [x1, y1], [x0, y1]], wb, false);
        em.triangulate_pieces(&upper);
        return;
    }
    let h = n >> 1;
    for (di, dj) in [(0, 0), (h, 0), (0, h), (h, h)] {
        let sx = x0 + di as f64 * cs;
        let sy = y0 + dj as f64 * cs;
        let ex = sx + h as f64 * cs;
        let ey = sy + h as f64 * cs;
        let sub = clip_pieces(pieces, &[[sx, sy], [ex, sy], [ex, ey], [sx, ey]], [sx, sy, ex, ey], true);
        visit(em, &sub, i0 + di, j0 + dj, h, ox, oy, cs, on_full_cell);
    }
}

/// geom.ts `drapeOnTerrain`: heights from the terrain mesh of every `step`-th node.
/// `on_full_cell`: every grid cell (i, j) the polygon covers whole.
pub fn drape_on_terrain(
    mesh: &mut Mesh,
    poly: &Piece,
    grid: &Grid,
    lift: f64,
    step: usize,
    on_full_cell: &mut dyn FnMut(i64, i64),
) {
    let height = |x: f64, y: f64| grid.height_at_step(step, x, y);
    drape_cells(mesh, poly, (grid.min_x, grid.min_y), grid.cell_size, &height, lift, step, on_full_cell);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat_grid(heights: &[f32]) -> Grid<'_> {
        Grid { cols: 5, rows: 5, min_x: 0.0, min_y: 0.0, cell_size: 4.0, heights }
    }

    #[test]
    fn a_whole_cell_is_two_grid_triangles() {
        let h = vec![10.0f32; 25];
        let g = flat_grid(&h);
        let mut m = Mesh::default();
        let sq = Piece { outer: vec![[4.0, 4.0], [8.0, 4.0], [8.0, 8.0], [4.0, 8.0]], holes: vec![] };
        drape_on_terrain(&mut m, &sq, &g, 0.5, 1, &mut |_, _| {});
        assert_eq!(m.triangle_count(), 2);
        assert_eq!(m.vertex_count(), 4);
        assert!(m.positions.chunks(3).all(|p| (p[2] - 10.5).abs() < 1e-6));
    }

    #[test]
    fn a_part_cell_keeps_its_area_and_follows_the_slope() {
        // Heights rise 1 m per metre eastwards.
        let h: Vec<f32> = (0..25).map(|k| ((k % 5) * 4) as f32).collect();
        let g = flat_grid(&h);
        let mut m = Mesh::default();
        let tri = Piece { outer: vec![[1.0, 1.0], [7.0, 1.0], [1.0, 7.0]], holes: vec![] };
        drape_on_terrain(&mut m, &tri, &g, 0.0, 1, &mut |_, _| {});
        let mut area = 0.0;
        for t in m.indices.chunks(3) {
            let p = |i: u32| [m.positions[i as usize * 3] as f64, m.positions[i as usize * 3 + 1] as f64];
            let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
            area += ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2.0;
        }
        assert!((area - 18.0).abs() < 1e-6, "area {area}");
        for p in m.positions.chunks(3) {
            assert!((p[2] as f64 - p[0] as f64).abs() < 1e-4, "z follows x");
        }
    }

    #[test]
    fn a_hole_is_left_out() {
        let h = vec![0.0f32; 25];
        let g = flat_grid(&h);
        let mut m = Mesh::default();
        let ring = Piece {
            outer: vec![[0.0, 0.0], [16.0, 0.0], [16.0, 16.0], [0.0, 16.0]],
            holes: vec![vec![[5.0, 5.0], [11.0, 5.0], [11.0, 11.0], [5.0, 11.0]]],
        };
        let mut full = 0;
        drape_on_terrain(&mut m, &ring, &g, 0.0, 1, &mut |_, _| full += 1);
        let mut area = 0.0;
        for t in m.indices.chunks(3) {
            let p = |i: u32| [m.positions[i as usize * 3] as f64, m.positions[i as usize * 3 + 1] as f64];
            let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
            area += ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2.0;
        }
        assert!((area - (256.0 - 36.0)).abs() < 1e-6, "area {area}");
        // 4 x 4 cells of 4 m; the hole (5 … 11 m) cuts the middle 2 x 2: 12 covered whole.
        assert_eq!(full, 12);
    }
}
