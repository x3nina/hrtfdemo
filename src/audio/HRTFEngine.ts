import {
  getSofaHRIR,
  prewarmResampledIRs,
  tryNearestBuffersSync,
  loadSofaSet,
  type SofaHRIRSet,
} from './SofaLoader'

export type AudioSourceId = 'pink-noise' | 'meow' | 'rain-and-thunder' | 'the-housebuilding-song' | `file-${number}`

export interface AudioSource {
  id: AudioSourceId
  name: string
  generated: boolean
}

export const AUDIO_SOURCES: AudioSource[] = [
  { id: 'pink-noise', name: 'Pink Noise', generated: true },
  { id: 'meow', name: 'Meow', generated: true },
  { id: 'rain-and-thunder', name: 'Rain and Thunder', generated: true },
  { id: 'the-housebuilding-song', name: 'The Housebuilding Song', generated: true },
]

interface ConvSlot {
  convL: ConvolverNode
  convR: ConvolverNode
  merger: ChannelMergerNode
  gain: GainNode
}


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

  // ConvolverNode path — single slot, direct IR swap per position update.
  // Adjacent positions have nearly identical IRs so the buffer swap is inaudible.
  // A 2-slot crossfade would overlap two convolvers with slightly different IRs,
  // creating comb filtering at the frame-update rate (60Hz buzz).
  private convSlot: ConvSlot | null = null
  private convolverDistGain: GainNode | null = null
  private cacheWarm = false

  private sofaSet: SofaHRIRSet | null = null
  private sofaSubjectId: string | null = null
  private sofaGeneration = 0
  private currentConvIdx = -1

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

    // ConvolverNode path — single slot, direct IR swap
    const makeSlot = (): ConvSlot => {
      const convL = this.ctx!.createConvolver(); convL.normalize = false
      const convR = this.ctx!.createConvolver(); convR.normalize = false
      const merger = this.ctx!.createChannelMerger(2)
      const gain = this.ctx!.createGain()
      convL.connect(merger, 0, 0)
      convR.connect(merger, 0, 1)
      merger.connect(gain)
      gain.gain.value = 0
      return { convL, convR, merger, gain }
    }
    this.convSlot = makeSlot()

    this.convolverDistGain = this.ctx.createGain()
    this.convolverDistGain.gain.value = 1

    // Default: panner path active
    this.panner.connect(this.gainNode)

    const l = this.ctx.listener
    if (l.positionX !== undefined) {
      l.positionX.value = 0; l.positionY.value = 0; l.positionZ.value = 0
    } else {
      ;(l as { setPosition(x: number, y: number, z: number): void }).setPosition(0, 0, 0)
    }
    this.applyListenerOrientation(0, 0, -1, 1)
    await this.loadUrlSources()
  }

  // Firefox doesn't support AudioListener.forwardX/upX AudioParams — fall back to setOrientation().
  private applyListenerOrientation(fx: number, fy: number, fz: number, upY: number) {
    if (!this.ctx) return
    const l = this.ctx.listener
    if (l.forwardX !== undefined) {
      l.forwardX.value = fx; l.forwardY.value = fy; l.forwardZ.value = fz
      l.upX.value = 0; l.upY.value = upY; l.upZ.value = 0
    } else {
      ;(l as { setOrientation(x: number, y: number, z: number, xUp: number, yUp: number, zUp: number): void }).setOrientation(fx, fy, fz, 0, upY, 0)
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
      return
    }

    const match = id.match(/^listen-(\d+)$/)
    if (!match) return
    const gen = this.sofaGeneration
    const subjectId = match[1]!

    this.sofaSet = await loadSofaSet(subjectId)
    this.sofaSubjectId = subjectId
    if (this.sofaGeneration !== gen) return

    await this.activateConvolverPath(gen)
  }

  private activatePannerPath() {
    this.cacheWarm = false
    this.currentConvIdx = -1

    if (this.mode === 'panner') return

    const { x, y, z } = sphericalToCartesian(this.currentAz, this.currentEl, this.currentDistance)
    this.panner!.positionX.value = x
    this.panner!.positionY.value = y
    this.panner!.positionZ.value = z
    this.panner!.connect(this.gainNode!)
    if (this.source) this.source.connect(this.panner!)

    try { this.convolverDistGain!.disconnect() } catch {}
    try { this.convSlot!.gain.disconnect() } catch {}
    if (this.source) {
      try { this.source.disconnect(this.convSlot!.convL) } catch {}
      try { this.source.disconnect(this.convSlot!.convR) } catch {}
    }
    this.mode = 'panner'
  }

  private async activateConvolverPath(gen: number) {
    if (!this.ctx || !this.sofaSet || !this.sofaSubjectId) return
    this.cacheWarm = false
    this.currentConvIdx = -1

    // Silence the slot immediately
    const t = this.ctx.currentTime
    this.convSlot!.gain.gain.cancelScheduledValues(t)
    this.convSlot!.gain.gain.setValueAtTime(0, t)
    this.convSlot!.convL.buffer = null
    this.convSlot!.convR.buffer = null

    if (this.mode !== 'convolver') {
      try { this.panner!.disconnect() } catch {}
      if (this.source) { try { this.source.disconnect(this.panner!) } catch {} }
      this.convSlot!.gain.connect(this.convolverDistGain!)
      this.convolverDistGain!.connect(this.gainNode!)
      if (this.source) {
        this.source.connect(this.convSlot!.convL)
        this.source.connect(this.convSlot!.convR)
      }
      this.mode = 'convolver'
    }

    // Load the nearest measured IR for the current position before the cache is warm.
    const { az, el } = this.relativeDir()
    const initial = await getSofaHRIR(this.ctx, this.sofaSubjectId, az, el)
    if (this.sofaGeneration !== gen || this.mode !== 'convolver') return

    this.convSlot!.convL.buffer = initial.left
    this.convSlot!.convR.buffer = initial.right
    const now = this.ctx.currentTime
    this.convSlot!.gain.gain.cancelScheduledValues(now)
    this.convSlot!.gain.gain.setValueAtTime(1, now)

    // Pre-warm all IRs. At 44100Hz (matching LISTEN sample rate) this resolves in
    // a few microtask ticks since resampleIfNeeded is a no-op. Once warm, every
    // position update becomes a synchronous IR blend with no async work.
    const ctx = this.ctx, set = this.sofaSet, subjectId = this.sofaSubjectId
    void prewarmResampledIRs(ctx, set, subjectId).then(() => {
      if (this.sofaGeneration !== gen || this.mode !== 'convolver') return
      this.cacheWarm = true
    })
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

  private schedulePositionUpdate() {
    if (!this.ctx || !this.sofaSet || !this.sofaSubjectId || this.mode !== 'convolver' || !this.cacheWarm || !this.convSlot) return
    const { az, el } = this.relativeDir()
    const result = tryNearestBuffersSync(this.ctx, this.sofaSet, this.sofaSubjectId, az, el)
    if (!result || result.idx === this.currentConvIdx) return
    this.currentConvIdx = result.idx
    this.convSlot.convL.buffer = result.left
    this.convSlot.convR.buffer = result.right
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
      this.schedulePositionUpdate()
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

    if (this.mode === 'convolver') this.schedulePositionUpdate()
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
      this.source.connect(this.convSlot!.convL)
      this.source.connect(this.convSlot!.convR)
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

  private async loadUrlSources() {
    const sources: [AudioSourceId, string][] = [
      ['meow', '/audio/Meow.mp3'],
      ['rain-and-thunder', '/audio/Rain and Thunder.mp3'],
      ['the-housebuilding-song', '/audio/The Housebuilding Song.mp3'],
    ]
    await Promise.all(
      sources.map(async ([id, path]) => {
        const res = await fetch(encodeURI(path))
        const ab = await res.arrayBuffer()
        this.fileBuffers.set(id, await this.ctx!.decodeAudioData(ab))
      }),
    )
  }
}

export const hrtfEngine = new HRTFEngine()
