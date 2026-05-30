import { getKemarHRIR } from './KemarLoader'
import { getSofaHRIR } from './SofaLoader'

export type AudioSourceId = 'pink-noise' | 'white-noise' | 'tone-440' | 'tone-1k' | 'file'

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
  { id: 'file', name: 'Load file…', generated: false },
]

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

  // ConvolverNode path (custom HRTF)
  private convL: ConvolverNode | null = null
  private convR: ConvolverNode | null = null
  private merger: ChannelMergerNode | null = null

  private source: AudioBufferSourceNode | null = null
  private fileBuffer: AudioBuffer | null = null
  private _playing = false

  private mode: 'panner' | 'convolver' = 'panner'
  private profileId = 'browser-hrtf'
  private currentAz = 0
  private currentEl = 0
  private listenerYaw = 0
  private listenerPitch = 0

  // Debounce convolver updates to avoid rapid refetches during dragging
  private convolverUpdateTimer: ReturnType<typeof setTimeout> | null = null

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

    // ConvolverNode path
    this.merger = this.ctx.createChannelMerger(2)
    this.convL = this.ctx.createConvolver()
    this.convL.normalize = false
    this.convR = this.ctx.createConvolver()
    this.convR.normalize = false
    this.convL.connect(this.merger, 0, 0)
    this.convR.connect(this.merger, 0, 1)

    // Default: panner path active
    this.panner.connect(this.gainNode)

    // Listener at origin facing forward (-Z)
    const l = this.ctx.listener
    l.positionX.value = 0
    l.positionY.value = 0
    l.positionZ.value = 0
    l.forwardX.value = 0
    l.forwardY.value = 0
    l.forwardZ.value = -1
    l.upX.value = 0
    l.upY.value = 1
    l.upZ.value = 0
  }

  async resume() {
    if (this.ctx?.state === 'suspended') await this.ctx.resume()
  }

  async setProfile(id: string) {
    if (!this.ctx) await this.init()
    this.profileId = id

    if (id === 'browser-hrtf') {
      this.activatePannerPath()
    } else {
      this.activateConvolverPath()
      // Load HRIR for current position under new profile
      await this.updateConvolverBuffers()
    }
  }

  private activatePannerPath() {
    if (this.mode === 'panner') return
    this.merger?.disconnect()
    this.panner?.connect(this.gainNode!)
    this.mode = 'panner'
  }

  private activateConvolverPath() {
    if (this.mode === 'convolver') return
    this.panner?.disconnect()
    this.merger?.connect(this.gainNode!)
    this.mode = 'convolver'
  }

  // Compute source direction relative to listener's head orientation.
  // PannerNode does this automatically; for ConvolverNode we do it manually.
  private relativeDir(): { az: number; el: number } {
    const sAzR = (this.currentAz * Math.PI) / 180
    const sElR = (this.currentEl * Math.PI) / 180
    const sx = -Math.sin(sAzR) * Math.cos(sElR)
    const sy = Math.sin(sElR)
    const sz = -Math.cos(sAzR) * Math.cos(sElR)

    const yaw = (this.listenerYaw * Math.PI) / 180
    const pitch = (this.listenerPitch * Math.PI) / 180

    // Listener forward vector
    const fx = Math.sin(yaw) * Math.cos(pitch)
    const fy = Math.sin(pitch)
    const fz = -Math.cos(yaw) * Math.cos(pitch)

    // Right = cross(forward, worldUp=(0,1,0)) / cos(pitch)
    const cosPitch = Math.cos(pitch)
    const rx = cosPitch > 1e-4 ? -fz / cosPitch : Math.cos(yaw)
    const rz = cosPitch > 1e-4 ? fx / cosPitch : Math.sin(yaw)

    // Up = cross(right, forward)
    const ux = -rz * fy
    const uy = rz * fx - rx * fz
    const uz = rx * fy

    // Project source onto head frame
    const hr = sx * rx + sz * rz          // head-right component
    const hu = sx * ux + sy * uy + sz * uz // head-up component
    const hf = sx * fx + sy * fy + sz * fz // head-forward component

    // Back to our spherical: az = atan2(-hr, hf), el = asin(hu)
    const elDeg = (Math.asin(Math.max(-1, Math.min(1, hu))) * 180) / Math.PI
    const azRaw = (Math.atan2(-hr, hf) * 180) / Math.PI
    const azDeg = ((azRaw % 360) + 360) % 360

    return { az: azDeg, el: elDeg }
  }

  private async updateConvolverBuffers() {
    if (!this.ctx || this.mode !== 'convolver') return
    const { az, el } = this.relativeDir()
    try {
      const { left, right } = await this.fetchHRIR(az, el)
      if (this.convL) this.convL.buffer = left
      if (this.convR) this.convR.buffer = right
    } catch (e) {
      console.error('HRIR load failed:', e)
    }
  }

  private async fetchHRIR(az: number, el: number) {
    const ctx = this.ctx!
    if (this.profileId === 'mit-kemar') {
      return getKemarHRIR(ctx, az, el)
    }
    // listen-XXXX profiles
    const match = this.profileId.match(/^listen-(\d+)$/)
    if (match) {
      return getSofaHRIR(ctx, match[1]!, az, el)
    }
    throw new Error(`Unknown profile: ${this.profileId}`)
  }

  setSourcePosition(azDeg: number, elDeg: number, distance = 1) {
    this.currentAz = azDeg
    this.currentEl = elDeg

    if (this.mode === 'panner' && this.panner) {
      const { x, y, z } = sphericalToCartesian(azDeg, elDeg, distance)
      this.panner.positionX.value = x
      this.panner.positionY.value = y
      this.panner.positionZ.value = z
    } else if (this.mode === 'convolver') {
      // Debounce: wait 80ms after last drag event before fetching
      if (this.convolverUpdateTimer) clearTimeout(this.convolverUpdateTimer)
      this.convolverUpdateTimer = setTimeout(() => {
        this.updateConvolverBuffers()
        this.convolverUpdateTimer = null
      }, 80)
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
      this.ctx.listener.forwardX.value = fx
      this.ctx.listener.forwardY.value = fy
      this.ctx.listener.forwardZ.value = fz
      this.ctx.listener.upX.value = 0
      this.ctx.listener.upY.value = Math.cos(pitch)
      this.ctx.listener.upZ.value = 0
    }

    if (this.mode === 'convolver') {
      if (this.convolverUpdateTimer) clearTimeout(this.convolverUpdateTimer)
      this.convolverUpdateTimer = setTimeout(() => {
        this.updateConvolverBuffers()
        this.convolverUpdateTimer = null
      }, 80)
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
      this.source.connect(this.convL!)
      this.source.connect(this.convR!)
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

  async loadFile(file: File) {
    if (!this.ctx) await this.init()
    const ab = await file.arrayBuffer()
    this.fileBuffer = await this.ctx!.decodeAudioData(ab)
  }

  hasFileLoaded() { return this.fileBuffer !== null }

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
      case 'file': return this.fileBuffer
      default: return null
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
