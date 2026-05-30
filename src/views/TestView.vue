<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import HeadScene from '@/components/HeadScene.vue'
import { useHRTFStore } from '@/stores/hrtf'
import { AUDIO_SOURCES, type AudioSourceId } from '@/audio/HRTFEngine'

const router = useRouter()
const hrtf = useHRTFStore()

const fileInputRef = ref<HTMLInputElement>()

const azDisplay = computed(() => Math.round(((hrtf.sourceAz % 360) + 360) % 360))
const elDisplay = computed(() => Math.round(hrtf.sourceEl))

function onSceneDrag(az: number, el: number) {
  hrtf.setSourcePosition(az, el)
}

async function togglePlay() {
  if (hrtf.playing) {
    hrtf.stopPlay()
  } else {
    await hrtf.startPlay()
  }
}

function selectSource(id: AudioSourceId) {
  if (id === 'file') {
    fileInputRef.value?.click()
    return
  }
  hrtf.setSource(id)
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

onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
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
            v-for="src in AUDIO_SOURCES"
            :key="src.id"
            class="source-list__item"
            :class="{ 'source-list__item--active': hrtf.currentSourceId === src.id }"
            @click="selectSource(src.id)"
          >
            {{ src.name }}
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
    <main class="main">
      <HeadScene
        :azimuth="hrtf.sourceAz"
        :elevation="hrtf.sourceEl"
        :interactive="true"
        @change="onSceneDrag"
      />

      <!-- Position readout overlay -->
      <div class="overlay overlay--pos">
        <span class="pos-label">Az</span>
        <span class="pos-val">{{ azDisplay }}°</span>
        <span class="pos-sep">·</span>
        <span class="pos-label">El</span>
        <span class="pos-val">{{ elDisplay }}°</span>
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
  background: #e8e8e8;
  font-family: inherit;
}

/* Sidebar */
.sidebar {
  width: 220px;
  min-width: 220px;
  background: #f0f0f0;
  padding: 1.5rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  border-right: 1px solid #d0d0d0;
  overflow-y: auto;
}

.back-btn {
  background: none;
  border: none;
  color: #666;
  font-size: 0.82rem;
  letter-spacing: 0.06em;
  cursor: pointer;
  padding: 0;
  text-align: left;
  font-family: inherit;
}
.back-btn:hover { color: #333; }

.sidebar__section { display: flex; flex-direction: column; gap: 0.5rem; }

.sidebar__heading {
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #999;
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
  color: #666;
  cursor: pointer;
  transition: background 0.1s, color 0.1s;
}
.source-list__item:hover { background: #e0e0e0; color: #333; }
.source-list__item--active {
  font-weight: 600;
  color: #5c6bc0;
  background: rgba(92, 107, 192, 0.08);
}

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
  color: #666;
  cursor: pointer;
  transition: background 0.1s, color 0.1s;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.profile-list__item:hover:not(.profile-list__item--locked) { background: #e0e0e0; color: #333; }
.profile-list__item--active { font-weight: 600; color: #5c6bc0; background: rgba(92, 107, 192, 0.08); }
.profile-list__item--locked { cursor: default; opacity: 0.5; }

.profile-list__badge {
  font-size: 0.65rem;
  letter-spacing: 0.06em;
  color: #aaa;
  background: #e0e0e0;
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
  color: #888;
}
.pos-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; }
.pos-val { font-weight: 600; color: #5c6bc0; font-variant-numeric: tabular-nums; min-width: 3.5ch; }
.pos-sep { color: #bbb; }

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
  color: #aaa;
  letter-spacing: 0.08em;
}

.overlay--title {
  bottom: 2rem;
  right: 1.5rem;
  font-size: 0.75rem;
  color: #aaa;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
</style>
