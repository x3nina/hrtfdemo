# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Vite dev server with hot reload
npm run build        # Type-check + production bundle
npm run lint         # Run all linters (oxlint + eslint)
npm run format       # Prettier on src/
npm run preview      # Preview production build locally
```

No test suite exists in this project.

## Architecture

**Vue 3 + Vite + TypeScript** spatial audio localization app. Two modes: a game (PlayView) where the user guesses where a sound comes from, and an explorer (TestView) for freely positioning a source and experimenting with HRTF profiles.

### Audio Pipeline (`src/audio/`)

`HRTFEngine.ts` owns the Web Audio API graph. It has two processing paths:
- **PannerNode path** — browser built-in HRTF, no external data needed
- **ConvolverNode path** — custom HRTF profiles loaded from SOFA files; uses a single convolver slot with direct IR buffer swaps on position update. Adjacent positions have nearly identical IRs so the swap is inaudible; a 2-slot crossfade was intentionally avoided because overlapping slightly-different IRs at the 60Hz update rate causes comb filtering.

`SofaLoader.ts` loads IRCAM LISTEN SOFA files (`public/hrtf/listen/IRC_*.sofa`) via h5wasm. It finds the nearest measured position by maximum dot-product on the unit sphere. All IRs are pre-warmed into an `AudioBuffer` cache after profile load; once warm, every `setSourcePosition` call is fully synchronous with no async work.

### Coordinate Convention

Azimuth 0° = front (−Z), 90° = left (−X), 180° = back, 270° = right. Elevation 0° = horizontal, +90° = above, −90° = below. Both `HRTFEngine` and `SofaLoader` use this convention; the SOFA files use the same convention natively (no remapping needed).

### State → Audio Bridge (`src/stores/`)

`useHRTFStore` (`stores/hrtf.ts`) is the single bridge between Vue components and `HRTFEngine`. Components never call `HRTFEngine` directly — they call store actions (`setSourcePosition`, `setProfile`, `startPlay`, etc.) which delegate to the engine.

`useGameStore` (`stores/game.ts`) manages game phase (`menu → listening → submitted`), target/guess positions, and angular distance scoring. It calls into `useHRTFStore`, never into `HRTFEngine` directly.

### View Interaction Model

The two views handle drag differently:
- **TestView** — drag on `HeadScene` moves the *sound source* (az/el). Scroll wheel controls distance. Listener orientation is fixed at (0, 0).
- **PlayView** (listening phase) — drag on the *view itself* rotates the *listener's head* (yaw/pitch) while the source stays fixed at a random position. The guess is derived from the accumulated yaw/pitch at submit time.

### 3D Visualization (`src/components/HeadScene.vue`)

THREE.js scene with a procedural head model, a speaker indicator, and an orbit wireframe sphere (reference 1.55m radius). When `interactive=true`, pointer drag emits `change(az, el)` events — it does not write to the store directly. When `guessAzimuth` is defined (reveal phase), the speaker hides, a green target marker appears, and the head becomes semi-transparent.

### Styling

Dark theme defined via CSS variables in `App.vue` (`--bg`, `--surface`, `--text-primary`, etc.). Prettier config: no semicolons, single quotes, 100-char line width.
