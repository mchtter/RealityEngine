import { defineConfig } from 'vitest/config';

// Compiler tests compile whole tiles (a grid of streets, terrain, buildings):
// seconds each on a CI runner — the 5 s default timed out "is deterministic"
// on main's scheduled run (2026-10-18).
export default defineConfig({
  test: { testTimeout: 60_000 },
});
