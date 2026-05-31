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
  h5.FS.writeFile(fname, new Uint8Array(ab))

  const f = new h5.File(fname, 'r')

  // Read sample rate
  type DS = import('h5wasm').Dataset
  const srDataset = f.get('Data.SamplingRate') as DS
  const srVal = srDataset.value as Float64Array | number[]
  const sampleRate = typeof srVal === 'number' ? srVal : srVal[0]!

  // Read source positions [M, 3]
  const posDataset = f.get('SourcePosition') as DS
  const posFlat = posDataset.value as Float64Array
  const M = posDataset.shape[0]!

  // Read IRs [M, 2, N]
  const irDataset = f.get('Data.IR') as DS
  const irFlat = irDataset.value as Float64Array
  const N = irDataset.shape[2]!

  f.close()
  h5.FS.unlink(fname)

  const positions: SofaHRIRSet['positions'] = []
  const irs: SofaHRIRSet['irs'] = []

  for (let m = 0; m < M; m++) {
    const az = posFlat[m * 3]!
    const el = posFlat[m * 3 + 1]!

    // Convert to unit vector in our app's coordinate system
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

// Resampled IR cache — keyed by subjectId + measurement index + output sample rate.
// Avoids re-running OfflineAudioContext for the same measurement on every call.
const resampledCache = new Map<string, { left: Float32Array; right: Float32Array }>()

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

// Return the N nearest measurements with inverse-angular-distance weights.
// dot^k weighting (k=8): at the midpoint between two 15°-spaced measurements
// each gets ~50%; a measurement 30° away gets ~14% before normalisation.
export function findNearestN(
  set: SofaHRIRSet,
  ourAzDeg: number,
  ourElDeg: number,
  N: number,
): Array<{ idx: number; weight: number }> {
  const az = (ourAzDeg * Math.PI) / 180
  const el = (ourElDeg * Math.PI) / 180
  const qx = -Math.sin(az) * Math.cos(el)
  const qy = Math.sin(el)
  const qz = -Math.cos(az) * Math.cos(el)

  const scored: Array<{ idx: number; dot: number }> = []
  for (let i = 0; i < set.positions.length; i++) {
    const v = set.positions[i]!.vec
    scored.push({ idx: i, dot: Math.max(0, qx * v[0] + qy * v[1] + qz * v[2]) })
  }
  scored.sort((a, b) => b.dot - a.dot)
  const top = scored.slice(0, N)

  const k = 8
  const rawWeights = top.map(s => s.dot ** k)
  const total = rawWeights.reduce((a, b) => a + b, 0)
  if (total < 1e-10) return [{ idx: top[0]!.idx, weight: 1 }]
  return top.map((s, j) => ({ idx: s.idx, weight: rawWeights[j]! / total }))
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

// Return AudioBuffers for a single measured HRIR (with resampling + caching).
export async function getIRBuffers(
  ctx: AudioContext,
  set: SofaHRIRSet,
  subjectId: string,
  idx: number,
): Promise<{ left: AudioBuffer; right: AudioBuffer }> {
  const { left: resL, right: resR } = await getResampledIR(ctx, set, subjectId, idx)
  const leftBuf = ctx.createBuffer(1, resL.length, ctx.sampleRate)
  leftBuf.getChannelData(0).set(resL)
  const rightBuf = ctx.createBuffer(1, resR.length, ctx.sampleRate)
  rightBuf.getChannelData(0).set(resR)
  return { left: leftBuf, right: rightBuf }
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

// Returns a blended AudioBuffer pair if all N nearest IRs are already cached;
// returns null (without throwing) if the cache is not yet warm.
export function tryBlendedBuffersSync(
  ctx: AudioContext,
  set: SofaHRIRSet,
  subjectId: string,
  az: number,
  el: number,
  N: number,
): { left: AudioBuffer; right: AudioBuffer } | null {
  const nearest = findNearestN(set, az, el, N)
  const irs: Array<{ left: Float32Array; right: Float32Array; weight: number }> = []
  for (const { idx, weight } of nearest) {
    const cached = resampledCache.get(`${subjectId}_${idx}_${ctx.sampleRate}`)
    if (!cached) return null
    irs.push({ ...cached, weight })
  }
  const irLen = irs[0]!.left.length
  const blendL = new Float32Array(irLen)
  const blendR = new Float32Array(irLen)
  for (const { left, right, weight } of irs) {
    for (let n = 0; n < irLen; n++) {
      blendL[n] += weight * left[n]!
      blendR[n] += weight * right[n]!
    }
  }
  const leftBuf = ctx.createBuffer(1, irLen, ctx.sampleRate)
  leftBuf.getChannelData(0).set(blendL)
  const rightBuf = ctx.createBuffer(1, irLen, ctx.sampleRate)
  rightBuf.getChannelData(0).set(blendR)
  return { left: leftBuf, right: rightBuf }
}

export async function getSofaHRIR(
  ctx: AudioContext,
  subjectId: string,
  ourAzDeg: number,
  ourElDeg: number,
): Promise<{ left: AudioBuffer; right: AudioBuffer }> {
  const set = await loadSofaSet(subjectId)

  // Blend the 4 nearest measured HRIRs weighted by angular proximity.
  // This gives continuous IR morphing as the source moves rather than
  // snapping to the nearest measurement every ~15°.
  const nearest = findNearestN(set, ourAzDeg, ourElDeg, 4)

  const resampledIRs = await Promise.all(
    nearest.map(({ idx, weight }) =>
      getResampledIR(ctx, set, subjectId, idx).then(ir => ({ ...ir, weight })),
    ),
  )

  const irLen = resampledIRs[0]!.left.length
  const blendedL = new Float32Array(irLen)
  const blendedR = new Float32Array(irLen)
  for (const { left, right, weight } of resampledIRs) {
    for (let n = 0; n < irLen; n++) {
      blendedL[n] += weight * left[n]!
      blendedR[n] += weight * right[n]!
    }
  }

  const leftBuf = ctx.createBuffer(1, irLen, ctx.sampleRate)
  leftBuf.getChannelData(0).set(blendedL)
  const rightBuf = ctx.createBuffer(1, irLen, ctx.sampleRate)
  rightBuf.getChannelData(0).set(blendedR)
  return { left: leftBuf, right: rightBuf }
}
