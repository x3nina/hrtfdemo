import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { useHRTFStore } from './hrtf'

export type GamePhase = 'menu' | 'listening' | 'submitted'

export const useGameStore = defineStore('game', () => {
  const hrtf = useHRTFStore()

  const phase = ref<GamePhase>('menu')
  const targetAz = ref(0)
  const targetEl = ref(0)
  const guessAz = ref(0)
  const guessEl = ref(0)

  // Angular distance between guess and target (degrees) — lower is better
  const score = ref<number | null>(null)
  const history = ref<{ score: number; targetAz: number; targetEl: number }[]>([])

  const avgScore = computed(() => {
    if (!history.value.length) return null
    const sum = history.value.reduce((a, b) => a + b.score, 0)
    return sum / history.value.length
  })

  function startRound() {
    targetAz.value = Math.random() * 360
    targetEl.value = (Math.random() - 0.4) * 75

    hrtf.setSourcePosition(targetAz.value, targetEl.value)
    hrtf.resetListenerOrientation()
    phase.value = 'listening'
    score.value = null

    hrtf.startPlay().catch((e: unknown) => console.error('[game] startPlay failed:', e))
  }

  function submitGuess(yaw: number, pitch: number) {
    if (phase.value !== 'listening') return
    phase.value = 'submitted'

    guessAz.value = ((-yaw) % 360 + 360) % 360
    guessEl.value = pitch

    // Angular distance: both vectors now use the same HRTF toVec convention.
    const toVec = (azDeg: number, elDeg: number) => {
      const az = (azDeg * Math.PI) / 180
      const el = (elDeg * Math.PI) / 180
      return [
        -Math.sin(az) * Math.cos(el),
        Math.sin(el),
        -Math.cos(az) * Math.cos(el),
      ] as const
    }

    const [gx, gy, gz] = toVec(guessAz.value, guessEl.value)
    const [tx, ty, tz] = toVec(targetAz.value, targetEl.value)
    const dot = Math.max(-1, Math.min(1, gx * tx + gy * ty + gz * tz))
    score.value = (Math.acos(dot) * 180) / Math.PI

    history.value.push({ score: score.value, targetAz: targetAz.value, targetEl: targetEl.value })
  }

  function reset() {
    hrtf.stopPlay()
    phase.value = 'menu'
    score.value = null
  }

  return {
    phase,
    targetAz,
    targetEl,
    guessAz,
    guessEl,
    score,
    history,
    avgScore,
    startRound,
    submitGuess,
    reset,
  }
})
