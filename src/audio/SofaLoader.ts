// IRCAM LISTEN SOFA loader
// Files: public/hrtf/listen/IRC_XXXX_R_44100.sofa (HDF5/SOFA format)
// SOFA SimpleFreeFieldHRIR convention:
//   Data.IR: Float64, shape [M, 2, N] — M measurements, 2 ears (0=L,1=R), N samples
//   SourcePosition: Float64, shape [M, 3] — [az°, el°, distance_m]
//   az: 0=front, CCW from above (so 90=LEFT) — matches our app convention exactly

export interface SofaHRIRSet {
  positions: Array<{ az: number; el: number; vec: [number, number, number] }>
  irs: Array<{ left: Float32Array; right: Float32Array }>
  sampleRate: number
}

const loadedSets = new Map<string, SofaHRIRSet>()
let h5module: typeof import('h5wasm') | null = null

async function ensureH5() {
  if (!h5module) {
    h5module = await import('h5wasm')
    await h5module.ready
  }
}

export async function loadSofaSet(subjectId: string): Promise<SofaHRIRSet> {
  const cached = loadedSets.get(subjectId)
  if (cached) return cached

  await ensureH5()

  const url = `/hrtf/listen/IRC_${subjectId}_R_44100.sofa`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch SOFA: ${url}`)
  const ab = await res.arrayBuffer()

  const h5 = h5module! as typeof import('h5wasm')
  const fname = `${subjectId}.sofa`
  h5.FS!.writeFile(fname, new Uint8Array(ab))

  const f = new h5.File(fname, 'r')

  type DS = import('h5wasm').Dataset
  const srDataset = f.get('Data.SamplingRate') as DS
  const srVal = srDataset.value as Float64Array | number[] // 44100 | [44100]
  const sampleRate = typeof srVal === 'number' ? srVal : srVal[0]!

  const posDataset = f.get('SourcePosition') as DS
  const posFlat = posDataset.value as Float64Array // [azimuth, elevation, distance]
  const M = posDataset.shape![0]!

  const irDataset = f.get('Data.IR') as DS
  const irFlat = irDataset.value as Float64Array
  const N = irDataset.shape![2]!

  f.close()
  h5.FS!.unlink(fname)

  const positions: SofaHRIRSet['positions'] = []
  const irs: SofaHRIRSet['irs'] = []

  for (let m = 0; m < M; m++) {
    const az = posFlat[m * 3]!
    const el = posFlat[m * 3 + 1]!
    const azR = (az * Math.PI) / 180 // deg -> rad
    const elR = (el * Math.PI) / 180
    const vec: [number, number, number] = [ // sphere -> cartesian
      -Math.sin(azR) * Math.cos(elR),
      Math.sin(elR),
      Math.cos(azR) * Math.cos(elR),
    ]
    positions.push({ az, el, vec })

    // hdf5 hrani IR v 3D arrayu [M, 2, N]
    const left = new Float32Array(N)
    const right = new Float32Array(N)
    const baseL = m * 2 * N // 3D array -> 1D array
    const baseR = m * 2 * N + N
    for (let n = 0; n < N; n++) {
      left[n] = irFlat[baseL + n]!
      right[n] = irFlat[baseR + n]!
    }
    irs.push({ left, right })
  }

  const set: SofaHRIRSet = { positions, irs, sampleRate }
  loadedSets.set(subjectId, set)
  return set
}

// Float32Array cache — keyed by subjectId + measurement index + output sample rate.
const resampledCache = new Map<string, { left: Float32Array; right: Float32Array }>()

// AudioBuffer cache — same key, avoids re-allocating buffers on every 60fps position update.
const audioBufferCache = new Map<string, { left: AudioBuffer; right: AudioBuffer }>()

// --- Spectral blending utilities ---

function nextPow2(n: number): number {
  let p = 1
  while (p < n) p <<= 1
  return p
}

// In-place radix-2 Cooley-Tukey FFT.
// forward=true → DFT: X[k] = Σ x[n] e^{-j2πkn/N}
// forward=false → unnormalized IDFT: Σ X[k] e^{+j2πkn/N}  (divide output by N to recover x[n])
function fftInPlace(re: Float64Array, im: Float64Array, forward: boolean): void {
  const N = re.length
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]!; re[i] = re[j]!; re[j] = t
      t = im[i]!; im[i] = im[j]!; im[j] = t
    }
  }
  const sign = forward ? -1 : 1
  for (let len = 2; len <= N; len <<= 1) {
    const half = len >> 1
    const ang = (sign * 2 * Math.PI) / len
    const wRe = Math.cos(ang), wIm = Math.sin(ang)
    for (let i = 0; i < N; i += len) {
      let uRe = 1, uIm = 0
      for (let j = 0; j < half; j++) {
        const aRe = re[i + j]!, aIm = im[i + j]!
        const bRe = re[i + j + half]!, bIm = im[i + j + half]!
        const tRe = uRe * bRe - uIm * bIm, tIm = uRe * bIm + uIm * bRe
        re[i + j] = aRe + tRe; im[i + j] = aIm + tIm
        re[i + j + half] = aRe - tRe; im[i + j + half] = aIm - tIm
        const nu = uRe * wRe - uIm * wIm; uIm = uRe * wIm + uIm * wRe; uRe = nu
      }
    }
  }
}

// Returns |X[k]| for k=0..fftSize-1 for a real input IR.
function realMagnitudeSpectrum(ir: Float32Array, fftSize: number): Float64Array {
  const re = new Float64Array(fftSize)
  const im = new Float64Array(fftSize)
  for (let i = 0; i < ir.length; i++) re[i] = ir[i]!
  fftInPlace(re, im, true)
  const mag = new Float64Array(fftSize)
  for (let i = 0; i < fftSize; i++) mag[i] = Math.sqrt(re[i]! * re[i]! + im[i]! * im[i]!)
  return mag
}

// Reconstruct a minimum-phase IR from an interpolated magnitude spectrum via real cepstrum:
// log(mag) → IFFT → causal cepstral window → FFT → exp() → IFFT
function minimumPhaseFromMagnitude(mag: Float64Array, irLen: number): Float32Array {
  const N = mag.length
  const EPS = 1e-10
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  for (let i = 0; i < N; i++) re[i] = Math.log(Math.max(mag[i]!, EPS))
  fftInPlace(re, im, false) // → re[n] = N·c[n]  (real cepstrum × N, unnormalized)
  // Causal lifter (÷N): n=0 → 1/N, 1≤n<N/2 → 2/N (fold conjugate half), n=N/2 → 1/N, rest → 0
  re[0] = re[0]! / N; im[0] = 0
  for (let n = 1; n < N / 2; n++) { re[n] = 2 * re[n]! / N; im[n] = 0 }
  re[N / 2] = re[N / 2]! / N; im[N / 2] = 0
  for (let n = N / 2 + 1; n < N; n++) { re[n] = 0; im[n] = 0 }
  fftInPlace(re, im, true) // → log|H_min[k]| + j·φ_min[k]
  for (let i = 0; i < N; i++) {
    const amp = Math.exp(re[i]!)
    re[i] = amp * Math.cos(im[i]!); im[i] = amp * Math.sin(im[i]!)
  }
  fftInPlace(re, im, false) // → N·h_min[n]
  const result = new Float32Array(irLen)
  for (let i = 0; i < irLen; i++) result[i] = re[i]! / N
  return result
}

// Keyed by subjectId_idx_sampleRate — stores pre-computed FFT magnitude spectrum per measured IR.
const magnitudeSpectraCache = new Map<string, { left: Float64Array; right: Float64Array }>()

function getOrComputeMagnitudeSpectra(
  subjectId: string,
  idx: number,
  sampleRate: number,
  fftSize: number,
): { left: Float64Array; right: Float64Array } | null {
  const key = `${subjectId}_${idx}_${sampleRate}`
  const hit = magnitudeSpectraCache.get(key)
  if (hit) return hit
  const ir = resampledCache.get(key)
  if (!ir) return null
  const result = {
    left: realMagnitudeSpectrum(ir.left, fftSize),
    right: realMagnitudeSpectrum(ir.right, fftSize),
  }
  magnitudeSpectraCache.set(key, result)
  return result
}

async function getResampledIR(
  ctx: AudioContext,
  set: SofaHRIRSet,
  subjectId: string,
  idx: number,
): Promise<{ left: Float32Array; right: Float32Array }> {
  const key = `${subjectId}_${idx}_${ctx.sampleRate}`
  const hit = resampledCache.get(key)
  if (hit) return hit

  const ir = set.irs[idx]!
  const [resL, resR] = await Promise.all([
    resampleIfNeeded(ctx, ir.left, set.sampleRate),
    resampleIfNeeded(ctx, ir.right, set.sampleRate),
  ])
  const result = { left: resL, right: resR }
  resampledCache.set(key, result)
  return result
}

// vecji kot je skalarni produkt med vekt., manjsi je kot med njima
export function findNearest(set: SofaHRIRSet, azDeg: number, elDeg: number): number {
  const az = (azDeg * Math.PI) / 180
  const el = (elDeg * Math.PI) / 180
  const qx = -Math.sin(az) * Math.cos(el)
  const qy = Math.sin(el)
  const qz = -Math.cos(az) * Math.cos(el)

  let bestIdx = 0
  let bestDot = -Infinity
  for (let i = 0; i < set.positions.length; i++) {
    const v = set.positions[i]!.vec
    const dot = qx * v[0] + qy * v[1] + qz * v[2]
    if (dot > bestDot) { bestDot = dot; bestIdx = i }
  }
  return bestIdx
}

async function resampleIfNeeded(
  ctx: AudioContext,
  data: Float32Array,
  srcRate: number,
): Promise<Float32Array> {
  if (ctx.sampleRate === srcRate) return data
  const tmp = ctx.createBuffer(1, data.length, srcRate)
  tmp.getChannelData(0).set(data)
  const dur = tmp.duration
  const offline = new OfflineAudioContext(1, Math.ceil(dur * ctx.sampleRate), ctx.sampleRate)
  const src = offline.createBufferSource()
  src.buffer = tmp
  src.connect(offline.destination)
  src.start()
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0)
}

// Pre-loads every measurement's resampled IR into the cache. At matching sample
// rates (44100→44100) this resolves in a few microtask ticks (no OfflineAudioContext
// needed). Position updates become fully synchronous once this resolves.
export async function prewarmResampledIRs(
  ctx: AudioContext,
  set: SofaHRIRSet,
  subjectId: string,
): Promise<void> {
  await Promise.all(
    Array.from({ length: set.positions.length }, (_, idx) =>
      getResampledIR(ctx, set, subjectId, idx),
    ),
  )
  // Pre-compute FFT magnitude spectra so the first position update has no extra cost.
  const firstIR = resampledCache.get(`${subjectId}_0_${ctx.sampleRate}`)
  if (firstIR) {
    const fftSize = nextPow2(firstIR.left.length)
    for (let idx = 0; idx < set.positions.length; idx++) {
      getOrComputeMagnitudeSpectra(subjectId, idx, ctx.sampleRate, fftSize)
    }
  }
}

async function getAudioBuffers(
  ctx: AudioContext,
  set: SofaHRIRSet,
  subjectId: string,
  idx: number,
): Promise<{ left: AudioBuffer; right: AudioBuffer }> {
  const key = `${subjectId}_${idx}_${ctx.sampleRate}`
  const hit = audioBufferCache.get(key)
  if (hit) return hit
  const { left: resL, right: resR } = await getResampledIR(ctx, set, subjectId, idx)
  const leftBuf = ctx.createBuffer(1, resL.length, ctx.sampleRate)
  leftBuf.getChannelData(0).set(resL)
  const rightBuf = ctx.createBuffer(1, resR.length, ctx.sampleRate)
  rightBuf.getChannelData(0).set(resR)
  const result = { left: leftBuf, right: rightBuf }
  audioBufferCache.set(key, result)
  return result
}

// Returns AudioBuffers for the nearest measured HRIR. Works before the cache is warm.
export async function getSofaHRIR(
  ctx: AudioContext,
  subjectId: string,
  azDeg: number,
  elDeg: number,
): Promise<{ left: AudioBuffer; right: AudioBuffer }> {
  const set = await loadSofaSet(subjectId)
  const idx = findNearest(set, azDeg, elDeg)
  return getAudioBuffers(ctx, set, subjectId, idx)
}

// Find k nearest measured positions, weighted by dot^8, normalized to sum to 1.
export function findNeighbors(
  set: SofaHRIRSet,
  azDeg: number,
  elDeg: number,
  k = 4,
): Array<{ idx: number; weight: number }> {
  const az = (azDeg * Math.PI) / 180
  const el = (elDeg * Math.PI) / 180
  const qx = -Math.sin(az) * Math.cos(el)
  const qy = Math.sin(el)
  const qz = -Math.cos(az) * Math.cos(el)

  const scored: Array<{ idx: number; dot: number }> = Array.from(
    { length: set.positions.length },
    (_, i) => {
      const v = set.positions[i]!.vec
      return { idx: i, dot: qx * v[0] + qy * v[1] + qz * v[2] }
    },
  )
  scored.sort((a, b) => b.dot - a.dot)
  const top = scored.slice(0, k)

  let sum = 0
  const raw = top.map(({ dot }) => {
    const w = Math.pow(Math.max(0, dot), 8)
    sum += w
    return w
  })
  if (sum === 0) return top.map(({ idx }) => ({ idx, weight: 1 / k }))
  return top.map(({ idx }, i) => ({ idx, weight: raw[i]! / sum }))
}

// Sync blended lookup — interpolates magnitude spectra of k nearest IRs then reconstructs
// a minimum-phase IR. Returns null if the resampled cache is not yet warm for any neighbor.
export function tryBlendedBuffersSync(
  ctx: AudioContext,
  set: SofaHRIRSet,
  subjectId: string,
  az: number,
  el: number,
): { left: AudioBuffer; right: AudioBuffer } | null {
  const neighbors = findNeighbors(set, az, el, 4)

  const firstIR = resampledCache.get(`${subjectId}_${neighbors[0]!.idx}_${ctx.sampleRate}`)
  if (!firstIR) return null
  const irLen = firstIR.left.length
  const fftSize = nextPow2(irLen)

  const blendedMagL = new Float64Array(fftSize)
  const blendedMagR = new Float64Array(fftSize)
  for (const { idx, weight } of neighbors) {
    const spectra = getOrComputeMagnitudeSpectra(subjectId, idx, ctx.sampleRate, fftSize)
    if (!spectra) return null
    for (let i = 0; i < fftSize; i++) {
      blendedMagL[i] = blendedMagL[i]! + weight * spectra.left[i]!
      blendedMagR[i] = blendedMagR[i]! + weight * spectra.right[i]!
    }
  }

  const bL = minimumPhaseFromMagnitude(blendedMagL, irLen)
  const bR = minimumPhaseFromMagnitude(blendedMagR, irLen)
  const leftBuf = ctx.createBuffer(1, irLen, ctx.sampleRate)
  leftBuf.getChannelData(0).set(bL)
  const rightBuf = ctx.createBuffer(1, irLen, ctx.sampleRate)
  rightBuf.getChannelData(0).set(bR)
  return { left: leftBuf, right: rightBuf }
}
