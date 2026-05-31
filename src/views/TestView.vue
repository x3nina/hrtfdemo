<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import HeadScene from '@/components/HeadScene.vue'
import { useHRTFStore } from '@/stores/hrtf'
import { AUDIO_SOURCES } from '@/audio/HRTFEngine'

const router = useRouter()
const hrtf = useHRTFStore()
const sceneBg = '#1e1e28'

const fileInputRef = ref<HTMLInputElement>()

const azDisplay = computed(() => Math.round(((hrtf.sourceAz % 360) + 360) % 360))
const elDisplay = computed(() => Math.round(hrtf.sourceEl))
const distDisplay = computed(() => hrtf.sourceDistance.toFixed(1))

function onSceneDrag(az: number, el: number) {
  hrtf.setSourcePosition(az, el)
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  const next = Math.max(0.5, Math.min(5, hrtf.sourceDistance * Math.exp(-e.deltaY * 0.001)))
  hrtf.setSourcePosition(hrtf.sourceAz, hrtf.sourceEl, next)
}

async function togglePlay() {
  if (hrtf.playing) {
    hrtf.stopPlay()
  } else {
    await hrtf.startPlay()
  }
}

function selectSource(id: string) {
  hrtf.setSource(id as never)
}

function openFilePicker() {
  fileInputRef.value?.click()
}

async function onFileChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (file) await hrtf.loadFile(file)
}

// Keyboard shortcut: Space = toggle play
function onKey(e: KeyboardEvent) {
  if (e.code === 'Space') { e.preventDefault(); togglePlay() }
  if (e.code === 'Escape') router.push('/')
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  hrtf.stopPlay()
  hrtf.setListenerOrientation(0, 0)
  hrtf.setSourcePosition(180, 0)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  hrtf.stopPlay()
})
</script>

<template>
  <div class="test">
    <!-- Left sidebar -->
    <aside class="sidebar">
      <button class="back-btn" @click="router.push('/')">← Back</button>

      <section class="sidebar__section">
        <h3 class="sidebar__heading">Audio source</h3>
        <ul class="source-list">
          <li
            v-for="src in AUDIO_SOURCES.filter(s => s.generated)"
            :key="src.id"
            class="source-list__item"
            :class="{ 'source-list__item--active': hrtf.currentSourceId === src.id }"
            @click="selectSource(src.id)"
          >
            {{ src.name }}
          </li>
          <li
            v-for="f in hrtf.uploadedFiles"
            :key="f.id"
            class="source-list__item source-list__item--file"
            :class="{ 'source-list__item--active': hrtf.currentSourceId === f.id }"
            :title="f.name"
            @click="selectSource(f.id)"
          >
            <span class="file-name">{{ f.name }}</span>
            <button class="file-remove" title="Remove" @click.stop="hrtf.removeUploadedFile(f.id)">✕</button>
          </li>
          <li v-if="hrtf.uploadedFiles.length < 10" class="source-list__item source-list__item--load" @click="openFilePicker()">
            Load file…
          </li>
        </ul>
        <input ref="fileInputRef" type="file" accept="audio/*" hidden @change="onFileChange" />
      </section>

      <section class="sidebar__section">
        <h3 class="sidebar__heading">HRTF profile</h3>
        <ul class="profile-list">
          <li
            v-for="p in hrtf.profiles"
            :key="p.id"
            class="profile-list__item"
            :class="{
              'profile-list__item--active': hrtf.currentProfileId === p.id,
              'profile-list__item--locked': !p.available,
            }"
            @click="hrtf.setProfile(p.id)"
          >
            <span class="profile-list__name">{{ p.name }}</span>
            <span v-if="!p.available" class="profile-list__badge">requires HRIR</span>
          </li>
        </ul>
      </section>
    </aside>

    <!-- Main 3D area -->
    <main class="main" @wheel.prevent="onWheel">
      <HeadScene
        :azimuth="hrtf.sourceAz"
        :elevation="hrtf.sourceEl"
        :distance="hrtf.sourceDistance"
        :interactive="true"
        :bg-color="sceneBg"
        @change="onSceneDrag"
      />

      <!-- Position readout overlay -->
      <div class="overlay overlay--pos">
        <span class="pos-label">Az</span>
        <span class="pos-val">{{ azDisplay }}°</span>
        <span class="pos-sep">·</span>
        <span class="pos-label">El</span>
        <span class="pos-val">{{ elDisplay }}°</span>
        <span class="pos-sep">·</span>
        <span class="pos-label">Dist</span>
        <span class="pos-val">{{ distDisplay }}m</span>
      </div>

      <!-- Play / stop -->
      <div class="overlay overlay--play">
        <button class="play-btn" :class="{ 'play-btn--active': hrtf.playing }" @click="togglePlay">
          {{ hrtf.playing ? '■ Stop' : '▶ Play' }}
        </button>
        <span class="play-hint">Space</span>
      </div>

      <!-- Title -->
      <div class="overlay overlay--title">
        HRTF Test
      </div>
    </main>
  </div>
</template>

<style scoped>
.test {
  height: 100%;
  display: flex;
  background: var(--bg-alt);
  font-family: inherit;
}

/* Sidebar */
.sidebar {
  width: 220px;
  min-width: 220px;
  background: var(--surface);
  padding: 1.5rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  border-right: 1px solid var(--border-solid);
  overflow-y: auto;
}

.back-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: 0.82rem;
  letter-spacing: 0.06em;
  cursor: pointer;
  padding: 0;
  text-align: left;
  font-family: inherit;
}
.back-btn:hover { color: var(--text-primary); }

.sidebar__section { display: flex; flex-direction: column; gap: 0.5rem; }

.sidebar__heading {
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-muted);
  margin: 0;
}

/* Source list */
.source-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.source-list__item {
  padding: 0.45rem 0.6rem;
  border-radius: 4px;
  font-size: 0.85rem;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.1s, color 0.1s;
}
.source-list__item:hover { background: var(--surface-hover); color: var(--text-primary); }
.source-list__item--active {
  font-weight: 600;
  color: #5c6bc0;
  background: rgba(92, 107, 192, 0.1);
}
.source-list__item--file {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
.file-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-remove {
  display: none;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0 0.1rem;
  font-size: 0.85rem;
  line-height: 1;
  flex-shrink: 0;
  font-family: inherit;
}
.source-list__item--file:hover .file-remove { display: block; }
.file-remove:hover { color: #c0392b; }
.source-list__item--load {
  font-style: italic;
  color: var(--text-muted);
  margin-top: 2px;
}
.source-list__item--load:hover { color: var(--text-secondary); }

/* Profile list */
.profile-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.profile-list__item {
  padding: 0.45rem 0.6rem;
  border-radius: 4px;
  font-size: 0.85rem;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.1s, color 0.1s;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.profile-list__item:hover:not(.profile-list__item--locked) { background: var(--surface-hover); color: var(--text-primary); }
.profile-list__item--active { font-weight: 600; color: #5c6bc0; background: rgba(92, 107, 192, 0.1); }
.profile-list__item--locked { cursor: default; opacity: 0.5; }

.profile-list__badge {
  font-size: 0.65rem;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  background: var(--surface-hover);
  padding: 0.1rem 0.35rem;
  border-radius: 3px;
}

/* Main canvas area */
.main {
  flex: 1;
  position: relative;
  overflow: hidden;
}

/* Overlays */
.overlay {
  position: absolute;
  pointer-events: none;
}

.overlay--pos {
  top: 1.2rem;
  right: 1.5rem;
  display: flex;
  align-items: baseline;
  gap: 0.35rem;
  font-size: 0.82rem;
  color: var(--text-secondary);
}
.pos-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; }
.pos-val { font-weight: 600; color: #5c6bc0; font-variant-numeric: tabular-nums; min-width: 3.5ch; }
.pos-sep { color: var(--text-faint); }

.overlay--play {
  bottom: 2rem;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 0.75rem;
  pointer-events: all;
}

.play-btn {
  padding: 0.6rem 2rem;
  border-radius: 6px;
  border: none;
  background: #5c6bc0;
  color: #fff;
  font-size: 0.9rem;
  letter-spacing: 0.08em;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s, transform 0.1s;
}
.play-btn:hover { background: #3f51b5; transform: scale(1.03); }
.play-btn--active { background: #c0392b; }
.play-btn--active:hover { background: #a93226; }

.play-hint {
  font-size: 0.72rem;
  color: var(--text-faint);
  letter-spacing: 0.08em;
}

.overlay--title {
  bottom: 2rem;
  right: 1.5rem;
  font-size: 0.75rem;
  color: var(--text-faint);
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
</style>
