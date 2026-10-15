//! KentOS geometry kernels (docs/DECISIONS.md D-008): heavy, self-contained
//! geometry shared by the twin-builder (Node addon) and the browser
//! (WebAssembly). Plain arrays in and out.

pub mod drape;

#[cfg(feature = "wasm-bindgen")]
pub mod wasm;
pub mod ground;
