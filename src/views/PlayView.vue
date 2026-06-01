<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useGameStore } from '@/stores/game'
import { useHRTFStore } from '@/stores/hrtf'
import { PROFILES } from '@/audio/profiles'
import HeadScene from '@/components/HeadScene.vue'

const router = useRouter()
const game = useGameStore()
const hrtf = useHRTFStore()
const sceneBg = '#1e1e28'

// Mouse tracking for head rotation
const isDragging = ref(false)
const startX = ref(0)
const startY = ref(0)
let accYaw = 0
let accPitch = 0
let rafPending = false

// Score display
const scoreMsg = computed(() => {
  const s = game.score
  if (s === null) return ''
  if (s < 5) return '★ Perfect!'
  if (s < 15) return 'Excellent'
  if (s < 30) return 'Good'
  if (s < 60) return 'Fair'
  return 'Keep practicing'
})

const errorColor = computed(() => {
  const s = game.score ?? 180
  if (s < 5) return '#2ecc71'
  if (s < 15) return '#82e0aa'
  if (s < 30) return '#f1c40f'
  if (s < 60) return '#e67e22'
  return '#e74c3c'
})

function startGame() {
  accYaw = 0
  accPitch = 0
  hrtf.unlockAudio()
  hrtf.setListenerOrientation(0, 0)
  game.startRound()
}

function submitGuess() {
  if (game.phase !== 'listening') return
  game.submitGuess(accYaw, accPitch)
  hrtf.stopPlay()
}

// Head rotation via mouse drag
function onMouseDown(e: MouseEvent) {
  if (game.phase !== 'listening') return
  isDragging.value = true
  startX.value = e.clientX
  startY.value = e.clientY
}

function onMouseMove(e: MouseEvent) {
  if (!isDragging.value || game.phase !== 'listening') return
  const dx = e.clientX - startX.value
  const dy = e.clientY - startY.value
  startX.value = e.clientX
  startY.value = e.clientY

  accYaw = (accYaw + dx * 0.45) % 360
  accPitch = Math.max(-80, Math.min(80, accPitch - dy * 0.3))
  if (!rafPending) {
    rafPending = true
    requestAnimationFrame(() => {
      hrtf.setListenerOrientation(accYaw, accPitch)
      rafPending = false
    })
  }
}

function onMouseUp() {
  isDragging.value = false
}

// Touch support
function onTouchStart(e: TouchEvent) {
  if (game.phase !== 'listening') return
  isDragging.value = true
  startX.value = e.touches[0]!.clientX
  startY.value = e.touches[0]!.clientY
}

function onTouchMove(e: TouchEvent) {
  if (!isDragging.value || game.phase !== 'listening') return
  e.preventDefault()
  const dx = e.touches[0]!.clientX - startX.value
  const dy = e.touches[0]!.clientY - startY.value
  startX.value = e.touches[0]!.clientX
  startY.value = e.touches[0]!.clientY
  accYaw = (accYaw + dx * 0.45) % 360
  accPitch = Math.max(-80, Math.min(80, accPitch - dy * 0.3))
  if (!rafPending) {
    rafPending = true
    requestAnimationFrame(() => {
      hrtf.setListenerOrientation(accYaw, accPitch)
      rafPending = false
    })
  }
}

function onTouchEnd() { isDragging.value = false }

function onKey(e: KeyboardEvent) {
  if (e.code === 'Enter' || e.code === 'Space') {
    e.preventDefault()
    if (game.phase === 'listening') submitGuess()
    else if (game.phase === 'menu') startGame()
    else if (game.phase === 'submitted') startGame()
  }
  if (e.code === 'Escape') {
    game.reset()
    router.push('/')
  }
}

onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  game.reset()
})
</script>

<template>
  <div
    class="play"
    :class="{ 'play--listening': game.phase === 'listening' }"
    @mousedown="onMouseDown"
    @mousemove="onMouseMove"
    @mouseup="onMouseUp"
    @mouseleave="onMouseUp"
    @touchstart.passive="onTouchStart"
    @touchmove.prevent="onTouchMove"
    @touchend="onTouchEnd"
  >
    <!-- ── MENU phase ── -->
    <Transition name="fade">
      <div v-if="game.phase === 'menu'" class="panel panel--start">
        <h1 class="panel__title">Sound Locator</h1>
        <p class="panel__body">
          A sound will play from somewhere in 3D space. Drag to rotate your head
          until you hear it directly in front of you, then press
          <kbd>Enter</kbd> to lock in your guess.
        </p>
        <div v-if="game.avgScore !== null" class="avg-score">
          Average distance: <strong>{{ Math.round(game.avgScore) }}</strong>
          ({{ game.history.length }} round{{ game.history.length > 1 ? 's' : '' }})
        </div>

        <!-- Profile selector -->
        <div class="profile-selector">
          <span class="profile-selector__label">HRTF profile</span>
          <div class="profile-selector__options">
            <button
              v-for="p in PROFILES"
              :key="p.id"
              class="profile-chip"
              :class="{
                'profile-chip--active': hrtf.currentProfileId === p.id,
                'profile-chip--locked': !p.available,
              }"
              :disabled="!p.available"
              @click="hrtf.setProfile(p.id)"
            >{{ p.name }}</button>
          </div>
        </div>

        <div class="panel__actions">
          <button class="btn btn--primary" @click="startGame">▶ Start</button>
          <button class="btn btn--ghost" @click="router.push('/')">← Menu</button>
        </div>
        <p class="panel__hint">Use headphones · Quiet environment recommended</p>
      </div>
    </Transition>

    <!-- ── LISTENING phase – black screen ── -->
    <Transition name="fade">
      <div v-if="game.phase === 'listening'" class="listening-ui">
        <!-- Crosshair -->
        <div class="crosshair">
          <div class="crosshair__h" />
          <div class="crosshair__v" />
        </div>

        <!-- Hint -->
        <div class="listen-hint">Drag to rotate · <kbd>Enter</kbd> to submit</div>

        <!-- Submit -->
        <button class="submit-btn" @click="submitGuess">Submit ↵</button>

        <!-- Back -->
        <button class="ghost-back" @click="() => { game.reset(); router.push('/') }">← Menu</button>
      </div>
    </Transition>

    <!-- ── SUBMITTED phase – reveal ── -->
    <Transition name="fade">
      <div v-if="game.phase === 'submitted'" class="reveal">
        <!-- 3D result scene -->
        <div class="reveal__scene">
          <HeadScene
            :azimuth="game.targetAz"
            :elevation="game.targetEl"
            :guess-azimuth="game.guessAz"
            :guess-elevation="game.guessEl"
            :interactive="false"
            :bg-color="sceneBg"
          />

          <!-- Guess marker on 2D overlay (approximate) -->
          <div class="reveal__markers">
            <div class="marker marker--target" title="Actual position">
              ● Actual
            </div>
            <div class="marker marker--guess" title="Your guess">
              ◉ Your guess
            </div>
          </div>
        </div>

        <!-- Score panel -->
        <div class="score-panel">
          <div class="score-error" :style="{ color: errorColor }">
            {{ Math.round(game.score ?? 0) }}
          </div>
          <div class="score-label">distance · lower is better</div>
          <div class="score-msg" :style="{ color: errorColor }">{{ scoreMsg }}</div>

          <table class="score-details">
            <tbody>
              <tr>
                <td>Target</td>
                <td>Az {{ Math.round(game.targetAz) }}° · El {{ Math.round(game.targetEl) }}°</td>
              </tr>
              <tr>
                <td>Guess</td>
                <td>Az {{ Math.round(game.guessAz) }}° · El {{ Math.round(game.guessEl) }}°</td>
              </tr>
            </tbody>
          </table>

          <div class="score-actions">
            <button class="btn btn--primary" @click="startGame">▶ Next round</button>
            <button class="btn btn--ghost" @click="() => { game.reset(); router.push('/') }">← Menu</button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.play {
  height: 100%;
  background: var(--bg-alt);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow-y: auto;
  overflow-x: hidden;
  color: var(--text-primary);
  font-family: inherit;
}

.play--listening {
  background: #05050a;
  cursor: crosshair;
  user-select: none;
  overflow: hidden;
}

/* ── Panels ── */
.panel {
  text-align: center;
  max-width: 480px;
  padding: 3rem 2rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.2rem;
}

.panel__title {
  font-size: 2.2rem;
  font-weight: 200;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  margin: 0;
  color: var(--text-primary);
}

.panel__body {
  font-size: 0.9rem;
  color: var(--text-secondary);
  line-height: 1.7;
  margin: 0;
}

kbd {
  background: var(--kbd-bg);
  padding: 0.1em 0.4em;
  border-radius: 3px;
  font-family: inherit;
  font-size: 0.9em;
  border: 1px solid var(--kbd-border);
}

.avg-score {
  font-size: 0.82rem;
  color: var(--text-secondary);
}

.profile-selector {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}

.profile-selector__label {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: #555;
}

.profile-selector__options {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  justify-content: center;
  max-height: 20rem;
  overflow-y: auto;
  padding: 0.2rem;
  scrollbar-width: thin;
  scrollbar-color: var(--border-solid) transparent;
}

.profile-chip {
  padding: 0.3rem 0.8rem;
  border-radius: 20px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-secondary);
  font-size: 0.78rem;
  font-family: inherit;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
}

.profile-chip:not(:disabled):hover {
  border-color: rgba(92,107,192,0.5);
  color: var(--text-primary);
}

.profile-chip--active {
  border-color: #5c6bc0;
  color: #8c9eff;
  background: rgba(92,107,192,0.12);
}

.profile-chip--locked {
  opacity: 0.35;
  cursor: default;
}

.panel__actions {
  display: flex;
  gap: 1rem;
  align-items: center;
}

.panel__hint {
  font-size: 0.75rem;
  color: var(--text-faint);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  margin: 0;
}

/* ── Buttons ── */
.btn {
  padding: 0.65rem 1.8rem;
  border-radius: 6px;
  font-size: 0.9rem;
  letter-spacing: 0.06em;
  font-family: inherit;
  cursor: pointer;
  border: none;
  transition: background 0.15s, transform 0.1s;
}
.btn:hover { transform: scale(1.04); }

.btn--primary { background: #5c6bc0; color: #fff; }
.btn--primary:hover { background: #3f51b5; }

.btn--ghost {
  background: transparent;
  color: #666;
  border: 1px solid rgba(255,255,255,0.1);
}
.btn--ghost:hover { background: rgba(255,255,255,0.05); color: #aaa; }

/* ── Listening UI ── */
.listening-ui {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.crosshair {
  position: relative;
  width: 40px;
  height: 40px;
}
.crosshair__h, .crosshair__v {
  position: absolute;
  background: rgba(255,255,255,0.35);
  border-radius: 2px;
}
.crosshair__h { width: 40px; height: 1px; top: 50%; left: 0; }
.crosshair__v { width: 1px; height: 40px; top: 0; left: 50%; }

.listen-hint {
  position: absolute;
  bottom: 5rem;
  left: 50%;
  transform: translateX(-50%);
  font-size: 0.75rem;
  color: #555;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  white-space: nowrap;
}

.submit-btn {
  position: absolute;
  bottom: 2rem;
  left: 50%;
  transform: translateX(-50%);
  padding: 0.65rem 2.5rem;
  background: #5c6bc0;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 0.9rem;
  letter-spacing: 0.08em;
  font-family: inherit;
  cursor: pointer;
  pointer-events: all;
  transition: background 0.15s, transform 0.1s;
}
.submit-btn:hover { background: #3f51b5; transform: translateX(-50%) scale(1.04); }

.ghost-back {
  position: absolute;
  top: 1.5rem;
  left: 1.5rem;
  background: none;
  border: none;
  color: #333;
  font-size: 0.82rem;
  letter-spacing: 0.06em;
  cursor: pointer;
  font-family: inherit;
  pointer-events: all;
}
.ghost-back:hover { color: #666; }

/* ── Reveal ── */
.reveal {
  position: absolute;
  inset: 0;
  display: flex;
  background: var(--bg-alt);
  color: var(--text-primary);
}

.reveal__scene {
  flex: 1;
  position: relative;
}

.reveal__markers {
  position: absolute;
  top: 1.5rem;
  left: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.marker {
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  padding: 0.25rem 0.6rem;
  border-radius: 4px;
  backdrop-filter: blur(4px);
}
.marker--target { color: #27ae60; background: rgba(39,174,96,0.12); }
.marker--guess { color: #5c6bc0; background: rgba(92,107,192,0.12); }

/* Score panel */
.score-panel {
  width: 280px;
  min-width: 280px;
  background: var(--surface);
  border-left: 1px solid var(--border-solid);
  padding: 2.5rem 1.8rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  text-align: center;
}

.score-error {
  font-size: 4rem;
  font-weight: 100;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.score-label {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--text-muted);
}
.score-msg {
  font-size: 1.1rem;
  font-weight: 500;
  letter-spacing: 0.06em;
  margin: 0.25rem 0;
}

.score-details {
  width: 100%;
  font-size: 0.8rem;
  color: var(--text-secondary);
  border-collapse: collapse;
  margin: 0.5rem 0;
}
.score-details td { padding: 0.3rem 0.4rem; }
.score-details td:first-child { color: var(--text-faint); text-align: right; white-space: nowrap; }

.score-actions {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  width: 100%;
  margin-top: 0.5rem;
}
.score-actions .btn { width: 100%; }
.score-actions .btn--ghost { color: var(--text-muted); border-color: var(--border-solid); }
.score-actions .btn--ghost:hover { background: var(--surface-hover); }

/* Transitions */
.fade-enter-active, .fade-leave-active { transition: opacity 0.3s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
