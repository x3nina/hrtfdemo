import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { useHRTFStore } from './hrtf'

export type GamePhase = 'menu' | 'listening' | 'submitted'

export const useGameStore = defineStore('game', () => {
  const hrtf = useHRTFStore()

  const phase = ref<GamePhase>('menu')
  const targetAz = ref(0)
  const targetEl = ref(0)
  const guessYaw = ref(0)
  const guessPitch = ref(0)

  // Angular error of the last guess (degrees)
  const angularError = ref<number | null>(null)
  const history = ref<{ error: number; targetAz: number; targetEl: number }[]>([])

  const avgScore = computed(() => {
    if (!history.value.length) return null
    const sum = history.value.reduce((a, b) => a + b.error, 0)
    return sum / history.value.length
  })

  function startRound() {
    // Random azimuth full 360°, elevation biased toward horizontal (-30 to +45)
    targetAz.value = Math.random() * 360
    targetEl.value = (Math.random() - 0.4) * 75

    hrtf.setSourcePosition(targetAz.value, targetEl.value)
    hrtf.resetListenerOrientation()
    phase.value = 'listening'
    angularError.value = null

    hrtf.startPlay()
  }

  function submitGuess() {
    if (phase.value !== 'listening') return

    guessYaw.value = hrtf.listenerYaw
    guessPitch.value = hrtf.listenerPitch
    phase.value = 'submitted'

    // Compute angular error between where they looked and where source is
    // Convert both to unit vectors then compute acos(dot)
    const toVec = (azDeg: number, elDeg: number) => {
      const az = (azDeg * Math.PI) / 180
      const el = (elDeg * Math.PI) / 180
      return {
        x: -Math.sin(az) * Math.cos(el),
        y: Math.sin(el),
        z: -Math.cos(az) * Math.cos(el),
      }
    }

    // Guess direction: where they were looking (yaw/pitch → forward vector)
    const yaw = (hrtf.listenerYaw * Math.PI) / 180
    const pitch = (hrtf.listenerPitch * Math.PI) / 180
    const gVec = {
      x: Math.sin(yaw) * Math.cos(pitch),
      y: Math.sin(pitch),
      z: -Math.cos(yaw) * Math.cos(pitch),
    }

    const tVec = toVec(targetAz.value, targetEl.value)
    const dot = Math.max(-1, Math.min(1, gVec.x * tVec.x + gVec.y * tVec.y + gVec.z * tVec.z))
    angularError.value = (Math.acos(dot) * 180) / Math.PI

    history.value.push({
      error: angularError.value,
      targetAz: targetAz.value,
      targetEl: targetEl.value,
    })
  }

  function reset() {
    hrtf.stopPlay()
    phase.value = 'menu'
    angularError.value = null
  }

  return {
    phase,
    targetAz,
    targetEl,
    guessYaw,
    guessPitch,
    angularError,
    history,
    avgScore,
    startRound,
    submitGuess,
    reset,
  }
})
