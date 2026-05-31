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
- **ConvolverNode path** — custom HRTF profiles loaded from files; uses dual convolver slots with 50ms crossfade to prevent clicks during IR morphing as the source position moves

`SofaLoader.ts` loads IRCAM LISTEN SOFA files (`public/hrtf/listen/IRC_*.sofa`) via h5wasm. It implements 4-neighbor blending with inverse-angular-distance weighting (dot^8 kernel) for smooth spatial interpolation between measured positions.

`KemarLoader.ts` loads MIT KEMAR compact binary files (`public/hrtf/kemar/elev{N}/H{N}e{AAA}a.dat`) — 128 int16 samples per ear, interleaved L/R, resampled to match the AudioContext rate at runtime.

### Coordinate Convention

Azimuth 0° = front (−Z), 90° = left (−X), 180° = back, 270° = right. Elevation 0° = horizontal, +90° = above, −90° = below. Both loaders normalize to this convention.

### State → Audio Bridge (`src/stores/`)

`useHRTFStore` (`stores/hrtf.ts`) is the single bridge between Vue components and `HRTFEngine`. Components never call HRTFEngine directly — they call store actions (`setSourcePosition`, `setProfile`, `startPlay`, etc.) which delegate to the engine.

`useGameStore` (`stores/game.ts`) manages game phase (menu → listening → submitted), target/guess positions, and angular distance scoring.

### 3D Visualization (`src/components/HeadScene.vue`)

THREE.js scene with a procedural head model, a speaker indicator, and an orbit wireframe sphere (reference 1.55m). In interactive mode, mouse drag changes azimuth/elevation; scroll wheel changes distance. The component emits `change(az, el)` events — it does not write to the store directly.

### Styling

Dark theme defined via CSS variables in `App.vue` (`--bg`, `--surface`, `--text-primary`, etc.). Prettier config: no semicolons, single quotes, 100-char line width.
