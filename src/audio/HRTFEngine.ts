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

// Azimuth/elevation to Web Audio API Cartesian (right-hand, +Y up, -Z forward)
// Convention: az=0 front, az=90 left, az=180 back, az=270 right
// el=0 horizontal, el=90 up, el=-90 down
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
  private panner: PannerNode | null = null
  private gainNode: GainNode | null = null
  private source: AudioBufferSourceNode | null = null
  private fileBuffer: AudioBuffer | null = null
  private _playing = false

  async init() {
    if (this.ctx) return
    this.ctx = new AudioContext()
    this.gainNode = this.ctx.createGain()
    this.gainNode.gain.value = 0.8
    this.gainNode.connect(this.ctx.destination)

    this.panner = this.ctx.createPanner()
    this.panner.panningModel = 'HRTF'
    this.panner.distanceModel = 'inverse'
    this.panner.refDistance = 1
    this.panner.rolloffFactor = 1
    this.panner.coneInnerAngle = 360
    this.panner.coneOuterAngle = 0
    this.panner.coneOuterGain = 0
    this.panner.connect(this.gainNode)

    // Listener at origin facing forward (-Z)
    this.ctx.listener.positionX.value = 0
    this.ctx.listener.positionY.value = 0
    this.ctx.listener.positionZ.value = 0
    this.ctx.listener.forwardX.value = 0
    this.ctx.listener.forwardY.value = 0
    this.ctx.listener.forwardZ.value = -1
    this.ctx.listener.upX.value = 0
    this.ctx.listener.upY.value = 1
    this.ctx.listener.upZ.value = 0
  }

  async resume() {
    if (this.ctx?.state === 'suspended') await this.ctx.resume()
  }

  // --- source position ---

  setSourcePosition(azDeg: number, elDeg: number, distance = 1) {
    if (!this.panner) return
    const { x, y, z } = sphericalToCartesian(azDeg, elDeg, distance)
    this.panner.positionX.value = x
    this.panner.positionY.value = y
    this.panner.positionZ.value = z
  }

  // --- listener orientation (head rotation) ---

  setListenerOrientation(azDeg: number, elDeg: number) {
    if (!this.ctx) return
    const { x, y, z } = sphericalToCartesian(azDeg, elDeg)
    // forward = direction listener is looking
    this.ctx.listener.forwardX.value = -x  // negate: (az,el) → direction, flip for forward
    this.ctx.listener.forwardY.value = -y
    this.ctx.listener.forwardZ.value = -z
  }

  // More direct: set listener forward vector from head yaw (horizontal) + pitch (vertical)
  setListenerFromYawPitch(yawDeg: number, pitchDeg: number) {
    if (!this.ctx) return
    const yaw = (yawDeg * Math.PI) / 180
    const pitch = (pitchDeg * Math.PI) / 180
    // forward vector when facing -Z and rotating by yaw (right = positive yaw) and pitch (up = positive)
    const fx = Math.sin(yaw) * Math.cos(pitch)
    const fy = Math.sin(pitch)
    const fz = -Math.cos(yaw) * Math.cos(pitch)
    this.ctx.listener.forwardX.value = fx
    this.ctx.listener.forwardY.value = fy
    this.ctx.listener.forwardZ.value = fz

    // up vector: rotate up by pitch only (simplification, no roll)
    const ux = 0
    const uy = Math.cos(pitch)
    const uz = 0
    this.ctx.listener.upX.value = ux
    this.ctx.listener.upY.value = uy
    this.ctx.listener.upZ.value = uz
  }

  // --- playback ---

  play(sourceId: AudioSourceId) {
    if (!this.ctx || !this.panner) return
    this.stop()

    const buf = this.buildBuffer(sourceId)
    if (!buf) return

    this.source = this.ctx.createBufferSource()
    this.source.buffer = buf
    this.source.loop = true
    this.source.connect(this.panner)
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

  // --- buffer generation ---

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
