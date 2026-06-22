import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { hrtfEngine, type AudioSourceId } from '@/audio/HRTFEngine'
import { PROFILES, detectAvailableProfiles, type HRTFProfile } from '@/audio/profiles'

export const useHRTFStore = defineStore('hrtf', () => {
  const initialized = ref(false)
  const playing = ref(false)
  const currentProfileId = ref('browser-hrtf')
  const currentSourceId = ref<AudioSourceId>('pink-noise')
  const uploadedFiles = ref<Array<{ id: string; name: string }>>([])
  let fileIdCounter = 0

  const sourceAz = ref(45)
  const sourceEl = ref(0)
  const sourceDistance = ref(1)

  const listenerYaw = ref(0)
  const listenerPitch = ref(0)

  const profiles = ref<HRTFProfile[]>(PROFILES)
  const currentProfile = computed<HRTFProfile>(
    () => profiles.value.find((p) => p.id === currentProfileId.value) ?? profiles.value[0]!,
  )

  detectAvailableProfiles().then((available) => {
    profiles.value = available
    if (!available.some((p) => p.id === currentProfileId.value)) {
      currentProfileId.value = 'browser-hrtf'
    }
  })

  async function initialize() {
    await hrtfEngine.init()
    initialized.value = true
    await hrtfEngine.setProfile(currentProfileId.value)
    hrtfEngine.setSourcePosition(sourceAz.value, sourceEl.value, sourceDistance.value)
  }

  function unlockAudio() {
    hrtfEngine.unlock()
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

  function setSourcePosition(az: number, el: number, distance?: number) {
    sourceAz.value = az
    sourceEl.value = el
    if (distance !== undefined) sourceDistance.value = distance
    hrtfEngine.setSourcePosition(az, el, sourceDistance.value)
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
    const profile = profiles.value.find((p) => p.id === id)
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
    const id = `file-${fileIdCounter++}` as AudioSourceId
    await hrtfEngine.loadFile(file, id)
    uploadedFiles.value.push({ id, name: file.name })
    await setSource(id)
  }

  function removeUploadedFile(id: string) {
    hrtfEngine.removeFile(id)
    uploadedFiles.value = uploadedFiles.value.filter(f => f.id !== id)
    if (currentSourceId.value === id) setSource('pink-noise')
  }

  return {
    initialized,
    playing,
    currentProfileId,
    currentSourceId,
    uploadedFiles,
    sourceAz,
    sourceEl,
    sourceDistance,
    listenerYaw,
    listenerPitch,
    profiles,
    currentProfile,
    initialize,
    unlockAudio,
    startPlay,
    stopPlay,
    setSourcePosition,
    setListenerOrientation,
    resetListenerOrientation,
    setProfile,
    setSource,
    loadFile,
    removeUploadedFile,
  }
})
