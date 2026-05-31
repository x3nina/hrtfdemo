import { getSofaHRIR } from './SofaLoader'

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

interface ConvSlot {
  convL: ConvolverNode
  convR: ConvolverNode
  merger: ChannelMergerNode
  gain: GainNode
}

const CROSSFADE_S = 0.05 // 50 ms

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

  // ConvolverNode path — two slots for crossfading
  private slots: [ConvSlot, ConvSlot] | null = null
  private convolverDistGain: GainNode | null = null  // inverse distance attenuation for convolver path
  private activeSlot: 0 | 1 = 0
  private fetchInFlight = false
  private pendingPosition: { az: number; el: number } | null = null
  private crossfadeEndTime = 0  // ctx time when the last scheduled crossfade finishes

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

    // Two convolver slots + shared distance-gain node
    const makeSlot = (): ConvSlot => {
      const convL = this.ctx!.createConvolver(); convL.normalize = false
      const convR = this.ctx!.createConvolver(); convR.normalize = false
      const merger = this.ctx!.createChannelMerger(2)
      const gain = this.ctx!.createGain()
      convL.connect(merger, 0, 0)
      convR.connect(merger, 0, 1)
      merger.connect(gain)
      return { convL, convR, merger, gain }
    }
    this.slots = [makeSlot(), makeSlot()]
    this.slots[0].gain.gain.value = 1
    this.slots[1].gain.gain.value = 0

    this.convolverDistGain = this.ctx.createGain()
    this.convolverDistGain.gain.value = 1
    // convolverDistGain is wired into the graph when convolver path is active:
    //   slots[*].gain → convolverDistGain → gainNode
    // Not connected yet — panner path is default.

    // Default: panner path active
    this.panner.connect(this.gainNode)

    const l = this.ctx.listener
    l.positionX.value = 0; l.positionY.value = 0; l.positionZ.value = 0
    l.forwardX.value = 0;  l.forwardY.value = 0;  l.forwardZ.value = -1
    l.upX.value = 0;       l.upY.value = 1;       l.upZ.value = 0
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
      await this.updateConvolverBuffers()
    }
  }

  private activatePannerPath() {
    if (this.mode === 'panner') return
    // Sync panner position in case it moved while in convolver mode
    const { x, y, z } = sphericalToCartesian(this.currentAz, this.currentEl, this.currentDistance)
    this.panner!.positionX.value = x
    this.panner!.positionY.value = y
    this.panner!.positionZ.value = z
    // Connect new path before tearing down old — no audio gap
    this.panner!.connect(this.gainNode!)
    if (this.source) this.source.connect(this.panner!)
    // Tear down convolver path
    this.convolverDistGain!.disconnect()
    this.slots![0].gain.disconnect()
    this.slots![1].gain.disconnect()
    if (this.source) {
      for (const slot of this.slots!) {
        try { this.source.disconnect(slot.convL) } catch {}
        try { this.source.disconnect(slot.convR) } catch {}
      }
    }
    this.mode = 'panner'
  }

  private activateConvolverPath() {
    if (this.mode === 'convolver') return
    // Apply distance attenuation: inverse model, no boost below refDistance=1
    this.convolverDistGain!.gain.value = 1 / Math.max(1, this.currentDistance)
    // Connect new path before tearing down old — no audio gap
    this.slots![0].gain.connect(this.convolverDistGain!)
    this.slots![1].gain.connect(this.convolverDistGain!)
    this.convolverDistGain!.connect(this.gainNode!)
    if (this.source) {
      for (const slot of this.slots!) {
        this.source.connect(slot.convL)
        this.source.connect(slot.convR)
      }
    }
    // Tear down panner path
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

  private async updateConvolverBuffers() {
    if (!this.ctx || this.mode !== 'convolver') return
    const { az, el } = this.relativeDir()

    if (this.fetchInFlight) {
      this.pendingPosition = { az, el }
      return
    }

    await this.doFetchAndCrossfade(az, el)
  }

  private async doFetchAndCrossfade(az: number, el: number) {
    if (!this.ctx || !this.slots) return
    this.fetchInFlight = true
    try {
      const { left, right } = await this.fetchHRIR(az, el)
      if (this.mode !== 'convolver') return

      // If a previous crossfade is still in progress, wait for it to finish.
      // This prevents swapping the buffer of a slot that still has audible gain.
      const waitMs = (this.crossfadeEndTime - this.ctx.currentTime) * 1000
      if (waitMs > 1) await new Promise<void>(r => setTimeout(r, waitMs))

      const t = this.ctx.currentTime
      const nextSlot = (1 - this.activeSlot) as 0 | 1
      const incoming = this.slots[nextSlot]
      const outgoing = this.slots[this.activeSlot]

      // Hard-zero incoming before swapping its buffer — even a tiny residual
      // gain causes an audible click when the ConvolverNode IR changes.
      incoming.gain.gain.cancelScheduledValues(t)
      incoming.gain.gain.setValueAtTime(0, t)

      incoming.convL.buffer = left
      incoming.convR.buffer = right

      outgoing.gain.gain.cancelScheduledValues(t)
      outgoing.gain.gain.setValueAtTime(outgoing.gain.gain.value, t)
      outgoing.gain.gain.linearRampToValueAtTime(0, t + CROSSFADE_S)
      incoming.gain.gain.linearRampToValueAtTime(1, t + CROSSFADE_S)

      this.crossfadeEndTime = t + CROSSFADE_S
      this.activeSlot = nextSlot
    } catch (e) {
      console.error('HRIR load failed:', e)
    } finally {
      this.fetchInFlight = false
      if (this.pendingPosition) {
        const pos = this.pendingPosition
        this.pendingPosition = null
        await this.doFetchAndCrossfade(pos.az, pos.el)
      }
    }
  }

  private async fetchHRIR(az: number, el: number) {
    const ctx = this.ctx!
    const match = this.profileId.match(/^listen-(\d+)$/)
    if (match) {
      return getSofaHRIR(ctx, match[1]!, az, el)
    }
    throw new Error(`Unknown profile: ${this.profileId}`)
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
      this.updateConvolverBuffers()
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
      this.updateConvolverBuffers()
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
      for (const slot of this.slots!) {
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
