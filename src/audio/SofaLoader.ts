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
  const srVal = srDataset.value as Float64Array | number[]
  const sampleRate = typeof srVal === 'number' ? srVal : srVal[0]!

  const posDataset = f.get('SourcePosition') as DS
  const posFlat = posDataset.value as Float64Array
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
    const azR = (az * Math.PI) / 180
    const elR = (el * Math.PI) / 180
    const vec: [number, number, number] = [
      -Math.sin(azR) * Math.cos(elR),
      Math.sin(elR),
      -Math.cos(azR) * Math.cos(elR),
    ]
    positions.push({ az, el, vec })

    const left = new Float32Array(N)
    const right = new Float32Array(N)
    const baseL = m * 2 * N
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

// Returns the index of the measurement whose unit vector has the highest dot product
// with the query direction — i.e. the nearest measured position on the sphere.
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

// Sync lookup — returns the nearest IR's AudioBuffers plus the measurement index.
// Returns null if the cache is not yet warm. After prewarmResampledIRs resolves,
// this always succeeds. Callers can use the returned idx to skip redundant swaps.
export function tryNearestBuffersSync(
  ctx: AudioContext,
  set: SofaHRIRSet,
  subjectId: string,
  az: number,
  el: number,
): { left: AudioBuffer; right: AudioBuffer; idx: number } | null {
  const idx = findNearest(set, az, el)
  const key = `${subjectId}_${idx}_${ctx.sampleRate}`

  const bufHit = audioBufferCache.get(key)
  if (bufHit) return { ...bufHit, idx }

  const floatHit = resampledCache.get(key)
  if (!floatHit) return null

  const leftBuf = ctx.createBuffer(1, floatHit.left.length, ctx.sampleRate)
  leftBuf.getChannelData(0).set(floatHit.left)
  const rightBuf = ctx.createBuffer(1, floatHit.right.length, ctx.sampleRate)
  rightBuf.getChannelData(0).set(floatHit.right)
  const result = { left: leftBuf, right: rightBuf }
  audioBufferCache.set(key, result)
  return { ...result, idx }
}
