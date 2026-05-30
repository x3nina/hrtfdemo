<script setup lang="ts">
import { RouterView, useRoute } from 'vue-router'
import { useThemeStore } from '@/stores/theme'

const themeStore = useThemeStore()
const route = useRoute()
</script>

<template>
  <RouterView />
  <button v-if="route.path !== '/test'" class="theme-toggle" :title="themeStore.theme === 'dark' ? 'Light mode' : 'Dark mode'" @click="themeStore.toggle()">
    <svg v-if="themeStore.theme === 'dark'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="4"/>
      <line x1="12" y1="2" x2="12" y2="5"/>
      <line x1="12" y1="19" x2="12" y2="22"/>
      <line x1="4.22" y1="4.22" x2="6.34" y2="6.34"/>
      <line x1="17.66" y1="17.66" x2="19.78" y2="19.78"/>
      <line x1="2" y1="12" x2="5" y2="12"/>
      <line x1="19" y1="12" x2="22" y2="12"/>
      <line x1="4.22" y1="19.78" x2="6.34" y2="17.66"/>
      <line x1="17.66" y1="6.34" x2="19.78" y2="4.22"/>
    </svg>
    <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
    </svg>
  </button>
</template>

<style>
:root, [data-theme="dark"] {
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

[data-theme="light"] {
  --bg:            #f0f0f5;
  --bg-alt:        #e8e8ee;
  --surface:       #ffffff;
  --surface-hover: #eaeaee;
  --border:        rgba(0,0,0,0.10);
  --border-solid:  #d0d0d8;
  --text-primary:  #1a1a1a;
  --text-secondary:#666;
  --text-muted:    #999;
  --text-faint:    #bbb;
  --kbd-bg:        rgba(0,0,0,0.06);
  --kbd-border:    rgba(0,0,0,0.12);
  --scene-bg:      #e8e8ee;
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

<style scoped>
.theme-toggle {
  position: fixed;
  top: 0.85rem;
  right: 0.85rem;
  z-index: 9999;
  transform: translateZ(0);
  width: 2.1rem;
  height: 2.1rem;
  border-radius: 50%;
  border: 1px solid var(--border-solid);
  background: var(--surface);
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s;
}
.theme-toggle:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}
.theme-toggle svg {
  width: 1rem;
  height: 1rem;
  flex-shrink: 0;
}
</style>
