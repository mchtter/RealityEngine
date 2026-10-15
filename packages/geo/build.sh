#!/usr/bin/env bash
# Builds the WebAssembly kernel from crates/kentos-geo into ./pkg (committed:
# the web app builds without a Rust toolchain). Needs rustup (wasm32 target)
# and wasm-bindgen-cli of the crate's wasm-bindgen version.
set -euo pipefail
cd "$(dirname "$0")/../.."
cargo build --release --target wasm32-unknown-unknown -p kentos-geo --features wasm-bindgen
wasm-bindgen --target web --out-dir packages/kentos-geo/pkg --no-typescript \
  target/wasm32-unknown-unknown/release/kentos_geo.wasm
