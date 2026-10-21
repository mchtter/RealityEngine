# Kavra 3D City Engine 🏙️✨

A high-performance, web-based procedural 3D city generation and rendering engine powered by **Three.js (WebGPU with WebGL2 fallback)** and **OpenStreetMap (OSM)** data.

---

## 🌟 Highlights

- **Zero Authentication Required:** Fully standalone, plug-and-play. Direct client-side generation from OSM bounding boxes or GeoJSON.
- **Procedural City Synthesis:**
  - Street networks, road classes, lanes, sidewalks, crossings, zebra markings, traffic lights.
  - Multi-tiered building extrusions, pitched/flat roof archetypes, facades with window and door patterns, balconies, and storefronts.
  - Ground clipmapping with elevation draping, water bodies, parks, and landcover.
  - Instanced city props: street lights, trees, benches, bus stops, rooftop HVAC/antennas.
- **WebGPU Modern Graphics:**
  - Dynamic sun and time-of-day shadow cascades (CSM).
  - TSL (Three Shading Language) post-processing (SSAO/GTAO, Bloom, FXAA, Tone Mapping).
  - Multi-level Level of Detail (LOD) and frustum-culled tile streaming.
- **Rust + WebAssembly Geometry Kernel:** High-speed polygon overlay, polygon clipping, and triangulation.

---

## 📦 Package Architecture

```text
kavra-city-engine/
├── packages/
│   ├── core/           # @kavra/core: Pure TypeScript procedural city compiler (compileCity)
│   ├── geo/            # @kavra/geo: Rust + WebAssembly geometry kernel (earcut, i_overlay, drape)
│   └── viewer/         # @kavra/viewer: Three.js WebGPU runtime engine (KavraEngine, CameraRig, TileLoader)
├── apps/
│   └── playground/     # Interactive, standalone demo app (Vite + WebGPU)
├── scripts/
│   └── rename-brand.sh # 1-command brand/product rename script
└── tools/              # OSM data preprocessing and tile tools
```

---

## 🚀 Quick Start (Playground)

Run the zero-auth interactive playground:

```bash
# Install dependencies
pnpm install

# Start local dev playground
pnpm dev
```

Open `http://localhost:3000` to interact with real-time 3D procedural cities generated directly from OpenStreetMap!

---

## 💻 Programmatic Usage

### 1. Compile OSM Data into a 3D City Model (`@kavra/core`)

```typescript
import { compileCity, type OsmElement } from '@kavra/core';

// Pass raw OSM elements (from Overpass API or local files)
const cityModel = compileCity({
  osm: osmElements,
  origin: { lon: 28.9784, lat: 41.0082 }, // Coordinates of city origin
});
```

### 2. Render in Browser via WebGPU (`@kavra/viewer`)

```typescript
import { KavraEngine } from '@kavra/viewer';

const container = document.getElementById('map');

const engine = new KavraEngine({
  container,
  center: [28.9784, 41.0082],
  zoom: 16,
  pitch: 55,
  bearing: 30,
  theme: 'realistic',
});
```

---

## 🏷️ Renaming the Brand / Product Name

To change the working name `Kavra` to your final choice (e.g. `City 7D`, `Seven Days`, `City7D`):

```bash
./scripts/rename-brand.sh "City 7D" "city7d" "city7d"
```

This single command automatically updates all package names (`@city7d/core`, `@city7d/viewer`), classes (`City7DEngine`), WASM bindings, and configuration files in seconds.

---

## 📄 License

MIT License - Copyright (c) 2025-2026 mchtter <mchtter@gmail.com>
