//! Times `drape_on_terrain` over a fixture of real calls captured from the
//! TypeScript viewer, and compares each call's triangle / vertex counts with
//! the TypeScript output recorded in the fixture.
//!
//!   cargo run --release -p kentos-geo --example drape_bench -- <fixture.json> [runs]

use std::time::Instant;

use kentos_geo::drape::{Grid, Mesh, Piece, drape_on_terrain};
use serde_json::Value;

fn ring(v: &Value) -> Vec<[f64; 2]> {
    v.as_array().unwrap().iter().map(|p| [p[0].as_f64().unwrap(), p[1].as_f64().unwrap()]).collect()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = &args[1];
    let runs: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(5);
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let terrains = fixture["terrains"].as_object().unwrap();
    let heights: std::collections::HashMap<String, (Vec<f32>, &Value)> = terrains
        .iter()
        .map(|(k, t)| {
            let h = t["heights"].as_array().unwrap().iter().map(|x| x.as_f64().unwrap() as f32).collect();
            (k.clone(), (h, t))
        })
        .collect();
    let calls: Vec<(String, Piece, f64, usize, u64, u64)> = fixture["calls"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            let p = &c["poly"];
            let piece = Piece {
                outer: ring(&p["outer"]),
                holes: p["holes"].as_array().map(|hs| hs.iter().map(ring).collect()).unwrap_or_default(),
            };
            (
                c["terrainId"].as_str().unwrap().to_string(),
                piece,
                c["lift"].as_f64().unwrap(),
                c["step"].as_u64().unwrap_or(1) as usize,
                c["tris"].as_u64().unwrap(),
                c["verts"].as_u64().unwrap(),
            )
        })
        .collect();

    let areas_out = args.get(3).cloned();
    let mut areas: Vec<f64> = Vec::new();
    let mut best = f64::INFINITY;
    let mut tris_total = 0usize;
    let mut mismatch = 0usize;
    let mut diff_tris: i64 = 0;
    for run in 0..runs {
        let t0 = Instant::now();
        let mut total = 0usize;
        let mut bad = 0usize;
        let mut dt: i64 = 0;
        for (tid, piece, lift, step, ts_tris, ts_verts) in &calls {
            let (h, t) = &heights[tid];
            let grid = Grid {
                cols: t["cols"].as_u64().unwrap() as usize,
                rows: t["rows"].as_u64().unwrap() as usize,
                min_x: t["minX"].as_f64().unwrap(),
                min_y: t["minY"].as_f64().unwrap(),
                cell_size: t["cellSize"].as_f64().unwrap(),
                heights: h,
            };
            let mut m = Mesh::default();
            drape_on_terrain(&mut m, piece, &grid, *lift, *step, &mut |_, _| {});
            total += m.triangle_count();
            if run == 0 && areas_out.is_some() {
                let mut a = 0.0;
                for t in m.indices.chunks(3) {
                    let p = |i: u32| [m.positions[i as usize * 3] as f64, m.positions[i as usize * 3 + 1] as f64];
                    let (x, y, z) = (p(t[0]), p(t[1]), p(t[2]));
                    a += ((y[0] - x[0]) * (z[1] - x[1]) - (y[1] - x[1]) * (z[0] - x[0])).abs() / 2.0;
                }
                areas.push(a);
            }
            if run == 0 && (m.triangle_count() as u64 != *ts_tris || m.vertex_count() as u64 != *ts_verts) {
                bad += 1;
                dt += m.triangle_count() as i64 - *ts_tris as i64;
            }
        }
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        best = best.min(ms);
        if run == 0 {
            tris_total = total;
            mismatch = bad;
            diff_tris = dt;
        }
    }
    if let Some(out) = areas_out {
        std::fs::write(out, serde_json::to_string(&areas).unwrap()).unwrap();
    }
    let ts_total: u64 = calls.iter().map(|c| c.4).sum();
    println!(
        "calls {} | rust best of {runs}: {best:.0} ms | tris rust {tris_total} ts {ts_total} | calls differing {mismatch} (tri diff {diff_tris})",
        calls.len()
    );
}
