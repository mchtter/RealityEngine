# Contributing to Reality Engine 🏙️✨

Thank you for your interest in contributing to **Reality Engine**! We welcome community contributions to build a state-of-the-art, open-source procedural 3D city generation and WebGPU rendering engine.

To maintain architectural integrity, high code quality, and a welcoming environment, all contributors (both human developers and AI coding agents) are required to follow these guidelines.

---

## 🏛️ 1. Project Philosophy & Architecture

Reality Engine is designed as a **modular, unopinionated, zero-authentication procedural engine**. It must remain completely independent of any external proprietary backend, database, or identity provider.

Our monorepo is divided into strictly isolated layers:

```text
reality-engine/
├── packages/
│   ├── core/           # reality-engine-core
│   │                   # Pure headless procedural city compiler (compileCity)
│   │                   # NO Three.js, NO DOM, NO React, NO browser canvas.
│   │
│   ├── geo/            # reality-engine-geo
│   │                   # Rust + WebAssembly geometry kernel
│   │                   # Polygon clipping (i_overlay), triangulation, terrain drape.
│   │
│   └── viewer/         # reality-engine-viewer
│                       # Three.js WebGPU / WebGL2 runtime engine
│                       # CameraRig, TileLoader, TSL shaders, Instanced city meshes.
│
└── apps/
    └── playground/     # Standalone, zero-auth interactive preview app
```

### Architectural Invariants:
1. **Headless Core (`reality-engine-core`)**: Must NEVER import Three.js, React, WebGL, or DOM APIs. It compiles OpenStreetMap/GeoJSON elements into abstract geometric buffers and scene graph descriptions. It must run seamlessly in Node.js, Web Workers, or headless server environments.
2. **WebGPU Viewer (`reality-engine-viewer`)**: Handles visual rendering, materials, TSL post-processing, camera interaction, and scene management. It must NOT contain proprietary UI frameworks or business domain logic.
3. **Zero-Authentication**: The engine is open and plug-and-play. It must never require authentication tokens, login flows, or vendor-locked APIs to generate or render procedural cities.
4. **No Proprietary Data**: Never commit customer secrets, municipal dataset credentials, internal company names, or sensitive geometry data to this repository.

---

## 🌿 2. Git & Branching Strategy

To keep the git history clean and traceable:

- **Direct commits to `main` are strictly forbidden.** All modifications must arrive through Pull Requests.
- **Branch Naming Convention**:
  - `feat/<short-description>`: New procedural generation features, render passes, shaders.
  - `fix/<short-description>`: Bug fixes and regressions.
  - `perf/<short-description>`: Rendering or compiler performance optimizations.
  - `docs/<short-description>`: Documentation additions or updates.
  - `refactor/<short-description>`: Code restructuring without feature change.

---

## ✍️ 3. Commit Message Standards

We enforce [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>(<scope>): <short description in present tense>

[optional body explaining WHY the change was made]

[optional footer(s)]
```

### Allowed Types:
- `feat`: A new feature for the engine or viewer.
- `fix`: A bug fix.
- `perf`: A performance improvement.
- `refactor`: Code change that neither fixes a bug nor adds a feature.
- `docs`: Documentation updates.
- `test`: Adding or correcting tests.
- `build`: Changes that affect the build system or external dependencies.
- `ci`: CI/CD workflow configuration changes.
- `chore`: Maintenance tasks, lockfiles, version bumps.

### Scopes:
- `core`, `geo`, `viewer`, `playground`, `deps`.

### Examples:
- `feat(viewer): implement cascade shadow maps for WebGPU sun light`
- `fix(core): prevent self-intersecting polygon extrusion on acute building corners`
- `perf(geo): accelerate earcut triangulation in WebAssembly polygon kernel`

---

## 🛡️ 4. Code Quality & Verification Before Submitting

Before opening a pull request or pushing changes, you must verify your work locally:

```bash
# 1. Typecheck & Lint
pnpm lint

# 2. Build all packages
pnpm build

# 3. Run unit tests
pnpm test
```

### Resource Caution:
To avoid exhausting host memory and CPU, never launch unthrottled parallel test runners or runaway watchers. Run targeted package tests when verifying specific changes (e.g. `pnpm --filter reality-engine-core test`).

---

## 📋 5. Pull Request Process

1. **Fork or create a dedicated feature branch** from latest `main`.
2. **Implement changes** adhering to the architecture boundaries outlined above.
3. **Ensure full pass** of `pnpm lint`, `pnpm build`, and tests.
4. **Open a Pull Request** using the provided PR template.
5. Provide a clear explanation of what was changed and attach visual screenshots or videos for any visual rendering changes.
6. A maintainer will review your PR. Address review feedback promptly and keep discussions constructive.

---

## 🤝 6. Code of Conduct

This project is governed by our [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code and foster an inclusive, respectful, and collaborative environment.

---

## 📬 Questions & Support

For discussions, ideas, or architectural proposals, open a GitHub Discussion or Issue.

Thank you for helping make Reality Engine the best open-source 3D procedural engine! 🚀
