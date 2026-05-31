<script setup lang="ts">
import { RouterView } from 'vue-router'
</script>

<template>
  <RouterView />
</template>

<style>
:root {
  --bg:            #0f0f14;
  --bg-alt:        #0a0a0f;
  --surface:       #1a1a22;
  --surface-hover: rgba(255,255,255,0.055);
  --border:        rgba(255,255,255,0.08);
  --border-solid:  #2a2a36;
  --text-primary:  #e0e0e0;
  --text-secondary:#888;
  --text-muted:    #555;
  --text-faint:    #444;
  --kbd-bg:        rgba(255,255,255,0.1);
  --kbd-border:    rgba(255,255,255,0.15);
  --scene-bg:      #1e1e28;
}

*, *::before, *::after {
  box-sizing: border-box;
}

html, body, #app {
  margin: 0;
  padding: 0;
  height: 100%;
  width: 100%;
  overflow: hidden;
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
  -webkit-font-smoothing: antialiased;
  background: var(--bg);
  color: var(--text-primary);
}
</style>
