# AI Agent Coding Guidelines & Operating Constraints (AGENTS.md) 🤖🛡️

This document defines strict operational rules, architectural boundaries, and safety constraints for all **AI Coding Agents** (including Google Antigravity, Cursor, Claude Code, GitHub Copilot, Codex, and automated bots) interacting with the **Reality Engine** repository.

Every AI agent working on this codebase **MUST strictly read and adhere** to all rules outlined below.

---

## 👤 1. Identity & Commit Attribution

1. **Repository Identity**:
   - Repository: `Reality Engine` (`https://github.com/mchtter/RealityEngine.git`).
   - Official Author & Maintainer: `mchtter <mchtter@gmail.com>`.
2. **Commit Author Enforcement**:
   - When committing directly to this repository or creating patches on behalf of the project owner, commits must strictly be authored as:
     ```bash
     git commit --author="mchtter <mchtter@gmail.com>" -m "<type>(<scope>): <message>"
     ```
   - **NEVER** attribute commits to third-party organizations, municipal bodies, or external enterprise accounts.
3. **No Accidental GitHub Mentions**:
   - **NEVER** use `@` prefixes (such as `@reality-engine` or `@maintainer`) in commit messages, PR descriptions, or release notes unless deliberately linking to a verified individual GitHub user profile. In GitHub, `@` creates unintended user pings and broken hyperlinks.

---

## 💻 2. Host Safety & Resource Governance (CRITICAL)

The host system's stability is paramount. Running unthrottled multi-threaded workloads can lock or freeze the developer's computer.

- **NEVER** run unconstrained monorepo test commands like `pnpm test` across all packages simultaneously without thread caps.
- **NEVER** start unmonitored background daemons, recursive watchers, or infinite test loops that consume 100% CPU or exhaust RAM.
- **Targeted Verification Only**:
  - Run tests on the specific package being edited:
    ```bash
    pnpm --filter reality-engine-core test
    ```
  - When running typecheck or build, rely on existing turbo/tsup caching:
    ```bash
    pnpm lint
    pnpm build
    ```

---

## 🏛️ 3. Non-Negotiable Architectural Invariants

### Invariant 1: Headless Core Purity (`packages/core`)
- `reality-engine-core` is a **pure algorithmic & geometric compiler**.
- **FORBIDDEN** in `packages/core`:
  - ❌ `import * as THREE from 'three'` (or any Three.js sub-module)
  - ❌ `import React from 'react'` (or any UI framework)
  - ❌ Direct DOM references (`window`, `document`, `HTMLCanvasElement`, `HTMLElement`)
  - ❌ WebGL/WebGPU context creation
- `packages/core` must execute cleanly in Node.js, Web Workers, or serverless environments with zero browser DOM dependencies.

### Invariant 2: Zero Authentication & Standalone Operation
- Reality Engine is an open, client-side procedural 3D synthesis engine.
- **NEVER** inject authentication guards, JWT validation, API secret requirements, or login modals.
- The engine consumes open geospatial standards (OpenStreetMap Overpass JSON, GeoJSON, raw coordinate tuples) and must function out of the box with zero external backend services.

### Invariant 3: No Proprietary or Municipal Leaks
- **NEVER** commit proprietary company names, confidential client project codes, municipal-specific dataset URLs, private API keys, or enterprise auth secrets.
- Reality Engine is generic, vendor-neutral open-source software.

### Invariant 4: Rust & WebAssembly Safety (`packages/geo`)
- Heavy spatial computations (polygon union/intersection clipping via `i_overlay`, triangulation via `earcut`, and terrain height draping) belong in `packages/geo`.
- Ensure Wasm binary artifacts and TypeScript bindings remain compatible across browser ESM and worker runtimes.

---

## ✍️ 4. Commit & Code Style Standards

1. **Conventional Commits**:
   - Format: `<type>(<scope>): <summary>`
   - Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`.
   - Valid scopes: `core`, `geo`, `viewer`, `playground`, `deps`.
2. **TypeScript Integrity**:
   - Maintain strict typing (`"strict": true`).
   - Do not use `any` unless absolutely required for low-level WebGPU buffer interop.
   - Do not leave unused imports, unreachable dead code, or temporary console logs in production builds.

---

## 📋 5. Pre-Commit Checklist for AI Agents

Before declaring any task completed or committing code, the agent MUST verify:

- [ ] Has the commit author been set to `mchtter <mchtter@gmail.com>`?
- [ ] Are all commit messages adhering to Conventional Commits without unintentional `@` mentions?
- [ ] Does `packages/core` remain 100% headless (no Three.js, no DOM, no React)?
- [ ] Did `pnpm lint` pass with 0 errors?
- [ ] Did `pnpm build` compile successfully?
- [ ] Are there zero proprietary secrets, tenant IDs, or private enterprise strings?
- [ ] Have all temporary background processes or scratch files been cleaned up?
