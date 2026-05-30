import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { hrtfEngine, type AudioSourceId } from '@/audio/HRTFEngine'
import { PROFILES, type HRTFProfile } from '@/audio/profiles'

export const useHRTFStore = defineStore('hrtf', () => {
  const initialized = ref(false)
  const playing = ref(false)
  const currentProfileId = ref('mit-kemar')
  const currentSourceId = ref<AudioSourceId>('pink-noise')

  // Sound source spherical position (degrees)
  const sourceAz = ref(45)
  const sourceEl = ref(0)

  // Listener head orientation (yaw/pitch in degrees)
  const listenerYaw = ref(0)
  const listenerPitch = ref(0)

  const profiles = computed(() => PROFILES)
  const currentProfile = computed<HRTFProfile>(
    () => PROFILES.find((p) => p.id === currentProfileId.value) ?? PROFILES[0]!,
  )

  async function initialize() {
    await hrtfEngine.init()
    initialized.value = true
    await hrtfEngine.setProfile(currentProfileId.value)
    hrtfEngine.setSourcePosition(sourceAz.value, sourceEl.value)
  }

  async function startPlay() {
    if (!initialized.value) await initialize()
    await hrtfEngine.resume()
    hrtfEngine.play(currentSourceId.value)
    playing.value = true
  }

  function stopPlay() {
    hrtfEngine.stop()
    playing.value = false
  }

  function setSourcePosition(az: number, el: number) {
    sourceAz.value = az
    sourceEl.value = el
    hrtfEngine.setSourcePosition(az, el)
  }

  function setListenerOrientation(yaw: number, pitch: number) {
    listenerYaw.value = yaw
    listenerPitch.value = pitch
    hrtfEngine.setListenerFromYawPitch(yaw, pitch)
  }

  function resetListenerOrientation() {
    setListenerOrientation(0, 0)
  }

  async function setProfile(id: string) {
    const profile = PROFILES.find((p) => p.id === id)
    if (!profile?.available) return
    currentProfileId.value = id
    if (initialized.value) await hrtfEngine.setProfile(id)
  }

  async function setSource(id: AudioSourceId) {
    currentSourceId.value = id
    if (playing.value) {
      hrtfEngine.stop()
      hrtfEngine.play(id)
    }
  }

  async function loadFile(file: File) {
    if (!initialized.value) await initialize()
    await hrtfEngine.loadFile(file)
    await setSource('file')
  }

  return {
    initialized,
    playing,
    currentProfileId,
    currentSourceId,
    sourceAz,
    sourceEl,
    listenerYaw,
    listenerPitch,
    profiles,
    currentProfile,
    initialize,
    startPlay,
    stopPlay,
    setSourcePosition,
    setListenerOrientation,
    resetListenerOrientation,
    setProfile,
    setSource,
    loadFile,
  }
})
