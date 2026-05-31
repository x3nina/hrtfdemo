import { findNearestN, loadSofaSet, getIRBuffers, type SofaHRIRSet } from './SofaLoader'

export type AudioSourceId = 'pink-noise' | 'white-noise' | 'tone-440' | 'tone-1k' | `file-${number}`

export interface AudioSource {
  id: AudioSourceId
  name: string
  generated: boolean
}

export const AUDIO_SOURCES: AudioSource[] = [
  { id: 'pink-noise', name: 'Pink Noise', generated: true },
  { id: 'white-noise', name: 'White Noise', generated: true },
  { id: 'tone-440', name: 'A4 (440 Hz)', generated: true },
  { id: 'tone-1k', name: '1 kHz Tone', generated: true },
]

interface InterpSlot {
  convL: ConvolverNode
  convR: ConvolverNode
  merger: ChannelMergerNode
  gain: GainNode
  measurementIdx: number | null  // currently loaded measurement; null = empty slot
}

// 15 ms ramp: smooth enough to be inaudible, fast enough for 60 fps drag updates.
const INTERP_RAMP_S = 0.015
const N_SLOTS = 4

function sphericalToCartesian(azDeg: number, elDeg: number, r = 1) {
  const az = (azDeg * Math.PI) / 180
  const el = (elDeg * Math.PI) / 180
  return {
    x: -Math.sin(az) * Math.cos(el) * r,
    y: Math.sin(el) * r,
    z: -Math.cos(az) * Math.cos(el) * r,
  }
}

export class HRTFEngine {
  private ctx: AudioContext | null = null
  private gainNode: GainNode | null = null

  // PannerNode path (browser built-in HRTF)
  private panner: PannerNode | null = null

  // ConvolverNode path — N_SLOTS parallel slots, one IR per nearest measurement.
  // Gains are updated synchronously on every position change; slots are swapped
  // asynchronously only when the nearest-neighbor set changes.
  private interpSlots: InterpSlot[] | null = null
  private convolverDistGain: GainNode | null = null

  private sofaSet: SofaHRIRSet | null = null
  private sofaSubjectId: string | null = null
  private sofaGeneration = 0  // incremented on profile switch to abort stale loads

  private slotUpdateInFlight = false
  private slotUpdatePending = false

  private source: AudioBufferSourceNode | null = null
  private fileBuffers = new Map<string, AudioBuffer>()
  private _playing = false

  private mode: 'panner' | 'convolver' = 'panner'
  private profileId = 'browser-hrtf'
  private currentAz = 0
  private currentEl = 0
  private currentDistance = 1
  private listenerYaw = 0
  private listenerPitch = 0

  async init() {
    if (this.ctx) return
    this.ctx = new AudioContext()

    this.gainNode = this.ctx.createGain()
    this.gainNode.gain.value = 0.8
    this.gainNode.connect(this.ctx.destination)

    // PannerNode path
    this.panner = this.ctx.createPanner()
    this.panner.panningModel = 'HRTF'
    this.panner.distanceModel = 'inverse'
    this.panner.refDistance = 1
    this.panner.rolloffFactor = 1
    this.panner.coneInnerAngle = 360
    this.panner.coneOuterAngle = 0
    this.panner.coneOuterGain = 0

    // N_SLOTS parallel convolver slots, all starting empty and silent
    const makeSlot = (): InterpSlot => {
      const convL = this.ctx!.createConvolver(); convL.normalize = false
      const convR = this.ctx!.createConvolver(); convR.normalize = false
      const merger = this.ctx!.createChannelMerger(2)
      const gain = this.ctx!.createGain()
      convL.connect(merger, 0, 0)
      convR.connect(merger, 0, 1)
      merger.connect(gain)
      gain.gain.value = 0
      return { convL, convR, merger, gain, measurementIdx: null }
    }
    this.interpSlots = Array.from({ length: N_SLOTS }, makeSlot)

    this.convolverDistGain = this.ctx.createGain()
    this.convolverDistGain.gain.value = 1

    // Default: panner path active
    this.panner.connect(this.gainNode)

    const l = this.ctx.listener
    l.positionX.value = 0; l.positionY.value = 0; l.positionZ.value = 0
    this.applyListenerOrientation(0, 0, -1, 1)
  }

  // Firefox doesn't support AudioListener.forwardX/upX AudioParams — fall back to setOrientation().
  private applyListenerOrientation(fx: number, fy: number, fz: number, upY: number) {
    if (!this.ctx) return
    const l = this.ctx.listener
    if (l.forwardX !== undefined) {
      l.forwardX.value = fx
      l.forwardY.value = fy
      l.forwardZ.value = fz
      l.upX.value = 0
      l.upY.value = upY
      l.upZ.value = 0
    } else {
      ;(l as any).setOrientation(fx, fy, fz, 0, upY, 0)
    }
  }

  unlock() {
    this.init()
    if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {})
  }

  async resume() {
    if (this.ctx?.state === 'suspended') await this.ctx.resume()
  }

  async setProfile(id: string) {
    if (!this.ctx) await this.init()
    this.profileId = id
    this.sofaGeneration++

    if (id === 'browser-hrtf') {
      this.sofaSet = null
      this.sofaSubjectId = null
      this.activatePannerPath()
    } else {
      const match = id.match(/^listen-(\d+)$/)
      if (match) {
        const subjectId = match[1]!
        this.sofaSet = await loadSofaSet(subjectId)
        this.sofaSubjectId = subjectId
      }
      this.activateConvolverPath()
      this.updateConvolverWeights()
    }
  }

  private activatePannerPath() {
    if (this.mode === 'panner') return
    const { x, y, z } = sphericalToCartesian(this.currentAz, this.currentEl, this.currentDistance)
    this.panner!.positionX.value = x
    this.panner!.positionY.value = y
    this.panner!.positionZ.value = z
    this.panner!.connect(this.gainNode!)
    if (this.source) this.source.connect(this.panner!)
    this.convolverDistGain!.disconnect()
    for (const slot of this.interpSlots!) slot.gain.disconnect()
    if (this.source) {
      for (const slot of this.interpSlots!) {
        try { this.source.disconnect(slot.convL) } catch {}
        try { this.source.disconnect(slot.convR) } catch {}
      }
    }
    this.mode = 'panner'
  }

  private activateConvolverPath() {
    if (this.mode === 'convolver') return
    this.convolverDistGain!.gain.value = 1 / Math.max(1, this.currentDistance)
    const t = this.ctx!.currentTime
    for (const slot of this.interpSlots!) {
      slot.measurementIdx = null
      slot.gain.gain.cancelScheduledValues(t)
      slot.gain.gain.setValueAtTime(0, t)
      slot.gain.connect(this.convolverDistGain!)
    }
    this.convolverDistGain!.connect(this.gainNode!)
    if (this.source) {
      for (const slot of this.interpSlots!) {
        this.source.connect(slot.convL)
        this.source.connect(slot.convR)
      }
    }
    this.panner!.disconnect()
    if (this.source) {
      try { this.source.disconnect(this.panner!) } catch {}
    }
    this.mode = 'convolver'
  }

  private relativeDir(): { az: number; el: number } {
    const sAzR = (this.currentAz * Math.PI) / 180
    const sElR = (this.currentEl * Math.PI) / 180
    const sx = -Math.sin(sAzR) * Math.cos(sElR)
    const sy = Math.sin(sElR)
    const sz = -Math.cos(sAzR) * Math.cos(sElR)

    const yaw = (this.listenerYaw * Math.PI) / 180
    const pitch = (this.listenerPitch * Math.PI) / 180
    const fx = Math.sin(yaw) * Math.cos(pitch)
    const fy = Math.sin(pitch)
    const fz = -Math.cos(yaw) * Math.cos(pitch)
    const cosPitch = Math.cos(pitch)
    const rx = cosPitch > 1e-4 ? -fz / cosPitch : Math.cos(yaw)
    const rz = cosPitch > 1e-4 ? fx / cosPitch : Math.sin(yaw)
    const ux = -rz * fy; const uy = rz * fx - rx * fz; const uz = rx * fy

    const hr = sx * rx + sz * rz
    const hu = sx * ux + sy * uy + sz * uz
    const hf = sx * fx + sy * fy + sz * fz

    const elDeg = (Math.asin(Math.max(-1, Math.min(1, hu))) * 180) / Math.PI
    const azRaw = (Math.atan2(-hr, hf) * 180) / Math.PI
    const azDeg = ((azRaw % 360) + 360) % 360
    return { az: azDeg, el: elDeg }
  }

  // Synchronously ramps each loaded slot's gain to its new interpolation weight.
  // For position changes within the same 4-neighbor zone this is all that's needed —
  // no async work, no latency. Triggers a background slot swap only when the
  // nearest-neighbor set has changed.
  private updateConvolverWeights() {
    if (!this.ctx || !this.sofaSet || !this.interpSlots || this.mode !== 'convolver') return
    const { az, el } = this.relativeDir()
    const neighbors = findNearestN(this.sofaSet, az, el, N_SLOTS)
    const t = this.ctx.currentTime

    for (const slot of this.interpSlots) {
      if (slot.measurementIdx === null) continue
      const neighbor = neighbors.find(n => n.idx === slot.measurementIdx)
      const targetWeight = neighbor?.weight ?? 0
      slot.gain.gain.cancelScheduledValues(t)
      slot.gain.gain.setValueAtTime(slot.gain.gain.value, t)
      slot.gain.gain.linearRampToValueAtTime(targetWeight, t + INTERP_RAMP_S)
    }

    this.scheduleSlotUpdate()
  }

  private scheduleSlotUpdate() {
    if (this.slotUpdateInFlight) {
      this.slotUpdatePending = true
      return
    }
    void this.doSlotUpdate()
  }

  private async doSlotUpdate() {
    this.slotUpdateInFlight = true
    try {
      await this.performSlotUpdates()
    } catch (e) {
      console.error('HRTF slot update failed:', e)
    } finally {
      this.slotUpdateInFlight = false
      if (this.slotUpdatePending) {
        this.slotUpdatePending = false
        void this.doSlotUpdate()
      }
    }
  }

  // Loads any new measurements into free or fading-out slots. Runs serially so
  // each slot assignment is committed before the next iteration looks for a free one.
  private async performSlotUpdates() {
    const gen = this.sofaGeneration
    if (!this.ctx || !this.sofaSet || !this.interpSlots || this.mode !== 'convolver') return
    const { az, el } = this.relativeDir()
    const neighbors = findNearestN(this.sofaSet, az, el, N_SLOTS)
    const newIdxSet = new Set(neighbors.map(n => n.idx))

    for (const { idx } of neighbors) {
      if (this.sofaGeneration !== gen) return
      if (this.interpSlots.some(s => s.measurementIdx === idx)) continue

      // Prefer a null (empty) slot; fall back to one that's fading out
      const targetSlot =
        this.interpSlots.find(s => s.measurementIdx === null) ??
        this.interpSlots.find(s => s.measurementIdx !== null && !newIdxSet.has(s.measurementIdx))
      if (!targetSlot) continue

      // If the slot still holds a departing measurement, wait for the gain ramp to finish
      if (targetSlot.measurementIdx !== null) {
        await new Promise<void>(r => setTimeout(r, INTERP_RAMP_S * 1000 + 5))
        if (this.sofaGeneration !== gen || this.mode !== 'convolver') return
      }

      const { left, right } = await getIRBuffers(this.ctx, this.sofaSet, this.sofaSubjectId!, idx)
      if (this.sofaGeneration !== gen || this.mode !== 'convolver') return

      // Swap buffer while gain is 0 — no click
      const now = this.ctx.currentTime
      targetSlot.gain.gain.cancelScheduledValues(now)
      targetSlot.gain.gain.setValueAtTime(0, now)
      targetSlot.convL.buffer = left
      targetSlot.convR.buffer = right
      targetSlot.measurementIdx = idx

      // Fade in to the current weight (position may have shifted since the load started)
      const { az: la, el: le } = this.relativeDir()
      const currentWeight = findNearestN(this.sofaSet, la, le, N_SLOTS).find(n => n.idx === idx)?.weight ?? 0
      if (currentWeight > 0.001) {
        targetSlot.gain.gain.linearRampToValueAtTime(currentWeight, now + INTERP_RAMP_S)
      }
    }
  }

  setSourcePosition(azDeg: number, elDeg: number, distance = 1) {
    this.currentAz = azDeg
    this.currentEl = elDeg
    this.currentDistance = distance

    if (this.mode === 'panner' && this.panner) {
      const { x, y, z } = sphericalToCartesian(azDeg, elDeg, distance)
      this.panner.positionX.value = x
      this.panner.positionY.value = y
      this.panner.positionZ.value = z
    } else if (this.mode === 'convolver') {
      if (this.convolverDistGain)
        this.convolverDistGain.gain.value = 1 / Math.max(1, distance)
      this.updateConvolverWeights()
    }
  }

  setListenerFromYawPitch(yawDeg: number, pitchDeg: number) {
    this.listenerYaw = yawDeg
    this.listenerPitch = pitchDeg

    if (this.ctx) {
      const yaw = (yawDeg * Math.PI) / 180
      const pitch = (pitchDeg * Math.PI) / 180
      const fx = Math.sin(yaw) * Math.cos(pitch)
      const fy = Math.sin(pitch)
      const fz = -Math.cos(yaw) * Math.cos(pitch)
      this.applyListenerOrientation(fx, fy, fz, Math.cos(pitch))
    }

    if (this.mode === 'convolver') {
      this.updateConvolverWeights()
    }
  }

  play(sourceId: AudioSourceId) {
    if (!this.ctx) return
    this.stop()

    const buf = this.buildBuffer(sourceId)
    if (!buf) return

    this.source = this.ctx.createBufferSource()
    this.source.buffer = buf
    this.source.loop = true

    if (this.mode === 'panner') {
      this.source.connect(this.panner!)
    } else {
      for (const slot of this.interpSlots!) {
        this.source.connect(slot.convL)
        this.source.connect(slot.convR)
      }
    }

    this.source.start()
    this._playing = true
    this.source.addEventListener('ended', () => { this._playing = false })
  }

  stop() {
    if (this.source) {
      try { this.source.stop() } catch {}
      this.source.disconnect()
      this.source = null
    }
    this._playing = false
  }

  get isPlaying() { return this._playing }

  async loadFile(file: File, id: string) {
    if (!this.ctx) await this.init()
    const ab = await file.arrayBuffer()
    this.fileBuffers.set(id, await this.ctx!.decodeAudioData(ab))
  }

  removeFile(id: string) {
    this.fileBuffers.delete(id)
  }

  setVolume(v: number) {
    if (this.gainNode) this.gainNode.gain.value = Math.max(0, Math.min(1, v))
  }

  private buildBuffer(id: AudioSourceId): AudioBuffer | null {
    if (!this.ctx) return null
    switch (id) {
      case 'pink-noise': return this.genPinkNoise(3)
      case 'white-noise': return this.genWhiteNoise(3)
      case 'tone-440': return this.genTone(440, 2)
      case 'tone-1k': return this.genTone(1000, 2)
      default: return this.fileBuffers.get(id) ?? null
    }
  }

  private genPinkNoise(duration: number): AudioBuffer {
    const sr = this.ctx!.sampleRate
    const len = sr * duration
    const buf = this.ctx!.createBuffer(1, len, sr)
    const data = buf.getChannelData(0)
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1
      b0 = 0.99886 * b0 + w * 0.0555179
      b1 = 0.99332 * b1 + w * 0.0750759
      b2 = 0.96900 * b2 + w * 0.1538520
      b3 = 0.86650 * b3 + w * 0.3104856
      b4 = 0.55000 * b4 + w * 0.5329522
      b5 = -0.7616 * b5 - w * 0.0168980
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11
      b6 = w * 0.115926
    }
    return buf
  }

  private genWhiteNoise(duration: number): AudioBuffer {
    const sr = this.ctx!.sampleRate
    const len = sr * duration
    const buf = this.ctx!.createBuffer(1, len, sr)
    const data = buf.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * 0.4
    return buf
  }

  private genTone(freq: number, duration: number): AudioBuffer {
    const sr = this.ctx!.sampleRate
    const len = sr * duration
    const buf = this.ctx!.createBuffer(1, len, sr)
    const data = buf.getChannelData(0)
    const fade = Math.floor(sr * 0.01)
    for (let i = 0; i < len; i++) {
      let amp = 0.4
      if (i < fade) amp *= i / fade
      if (i > len - fade) amp *= (len - i) / fade
      data[i] = Math.sin((2 * Math.PI * freq * i) / sr) * amp
    }
    return buf
  }
}

export const hrtfEngine = new HRTFEngine()
