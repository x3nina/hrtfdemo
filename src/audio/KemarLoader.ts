// MIT KEMAR compact database loader
// Files: public/hrtf/kemar/elev{N}/H{N}e{AAA}a.dat
// Format: 512 bytes, 128 int16 samples per ear, interleaved L[0],R[0],L[1],R[1],...
// KEMAR azimuth convention: 0=front, increases toward RIGHT, files cover 0-180°
// Left side (180-360°) obtained by mirroring: swap L/R channels

const KEMAR_SR = 44100
const KEMAR_SAMPLES = 128
// Raw KEMAR HRIRs have L2-norm ≈ 6.3 (after /32768), causing ~6x RMS amplification
// and clipping that masks all spatial cues. Scale to bring output to a comfortable level.
const KEMAR_GAIN = 0.15

// Exact measured positions [el, azimuths[]] in KEMAR convention
// el: degrees, azimuths: 0-180, increasing toward right
const MEASURED_POSITIONS: [number, number[]][] = [
  [-40, [0,6,13,19,26,32,39,45,51,58,64,71,77,84,90,96,103,109,116,122,129,135,141,148,154,161,167,174,180]],
  [-30, Array.from({length: 31}, (_, i) => i * 6)],
  [-20, Array.from({length: 37}, (_, i) => i * 5)],
  [-10, Array.from({length: 37}, (_, i) => i * 5)],
  [0,   Array.from({length: 37}, (_, i) => i * 5)],
  [10,  Array.from({length: 37}, (_, i) => i * 5)],
  [20,  Array.from({length: 37}, (_, i) => i * 5)],
  [30,  Array.from({length: 31}, (_, i) => i * 6)],
  [40,  [0,13,26,39,51,64,77,90,103,116,129,141,154,167,180]],
  [50,  Array.from({length: 23}, (_, i) => i * 8)],
  [60,  Array.from({length: 19}, (_, i) => i * 10)],
  [70,  Array.from({length: 13}, (_, i) => i * 15)],
  [80,  Array.from({length: 7},  (_, i) => i * 30)],
  [90,  [0]],
]

interface LookupEntry {
  el: number
  azFile: number   // filename azimuth (0-180)
  swapLR: boolean  // true = this entry is the mirrored (left-side) version
  vec: [number, number, number]  // unit vector in our app's coordinate system
}

// Build full-sphere lookup table (0-180° files + mirrored left side)
const LOOKUP: LookupEntry[] = (() => {
  const entries: LookupEntry[] = []
  for (const [el, azimuths] of MEASURED_POSITIONS) {
    const elR = (el * Math.PI) / 180
    for (const azFile of azimuths) {
      // KEMAR az 0=front,90=right → our convention: convert via our_az = 360-az_kemar
      // KEMAR az → our_az: kemar_right = our_270, so our_az = (360 - az_kemar) % 360
      const ourAz = ((360 - azFile) % 360) * (Math.PI / 180)
      const cx = -Math.sin(ourAz) * Math.cos(elR)
      const cy = Math.sin(elR)
      const cz = -Math.cos(ourAz) * Math.cos(elR)
      entries.push({ el, azFile, swapLR: false, vec: [cx, cy, cz] })

      // Mirror: left side (swap L/R), only for non-midplane positions
      if (azFile > 0 && azFile < 180) {
        const ourAzMirror = (azFile * Math.PI) / 180  // our_az = az_kemar directly for mirrored
        const mx = -Math.sin(ourAzMirror) * Math.cos(elR)
        const my = Math.sin(elR)
        const mz = -Math.cos(ourAzMirror) * Math.cos(elR)
        entries.push({ el, azFile, swapLR: true, vec: [mx, my, mz] })
      }
    }
  }
  return entries
})()

function findNearest(ourAzDeg: number, ourElDeg: number): LookupEntry {
  const az = (ourAzDeg * Math.PI) / 180
  const el = (ourElDeg * Math.PI) / 180
  const qx = -Math.sin(az) * Math.cos(el)
  const qy = Math.sin(el)
  const qz = -Math.cos(az) * Math.cos(el)

  let best = LOOKUP[0]!
  let bestDot = -Infinity
  for (const e of LOOKUP) {
    const dot = qx * e.vec[0] + qy * e.vec[1] + qz * e.vec[2]
    if (dot > bestDot) { bestDot = dot; best = e }
  }
  return best
}

function kemarUrl(el: number, azFile: number): string {
  const azStr = String(azFile).padStart(3, '0')
  return `/hrtf/kemar/elev${el}/H${el}e${azStr}a.dat`
}

const cache = new Map<string, [Float32Array, Float32Array]>()

async function loadRaw(el: number, azFile: number): Promise<[Float32Array, Float32Array]> {
  const key = `${el}_${azFile}`
  const cached = cache.get(key)
  if (cached) return cached

  const res = await fetch(kemarUrl(el, azFile))
  const ab = await res.arrayBuffer()
  const int16 = new Int16Array(ab)

  const left = new Float32Array(KEMAR_SAMPLES)
  const right = new Float32Array(KEMAR_SAMPLES)
  const scale = KEMAR_GAIN / 32768
  for (let i = 0; i < KEMAR_SAMPLES; i++) {
    left[i] = (int16[i * 2]!) * scale
    right[i] = (int16[i * 2 + 1]!) * scale
  }

  const pair: [Float32Array, Float32Array] = [left, right]
  cache.set(key, pair)
  return pair
}

async function resampleIfNeeded(ctx: AudioContext, data: Float32Array): Promise<Float32Array> {
  if (ctx.sampleRate === KEMAR_SR) return data
  const tmp = ctx.createBuffer(1, data.length, KEMAR_SR)
  tmp.getChannelData(0).set(data)
  const offline = new OfflineAudioContext(1, Math.ceil(tmp.duration * ctx.sampleRate), ctx.sampleRate)
  const src = offline.createBufferSource()
  src.buffer = tmp
  src.connect(offline.destination)
  src.start()
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0)
}

export async function getKemarHRIR(
  ctx: AudioContext,
  ourAzDeg: number,
  ourElDeg: number,
): Promise<{ left: AudioBuffer; right: AudioBuffer }> {
  const entry = findNearest(ourAzDeg, ourElDeg)
  const [rawL, rawR] = await loadRaw(entry.el, entry.azFile)

  const [srcL, srcR] = entry.swapLR ? [rawR, rawL] : [rawL, rawR]
  const [resL, resR] = await Promise.all([
    resampleIfNeeded(ctx, srcL),
    resampleIfNeeded(ctx, srcR),
  ])

  const left = ctx.createBuffer(1, resL.length, ctx.sampleRate)
  left.getChannelData(0).set(resL)
  const right = ctx.createBuffer(1, resR.length, ctx.sampleRate)
  right.getChannelData(0).set(resR)

  return { left, right }
}
