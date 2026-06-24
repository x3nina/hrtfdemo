export interface HRTFProfile {
  id: string
  name: string
  description: string
  available: boolean
}

const LISTEN_SUBJECTS = [
  1002, 1003
]

export const PROFILES: HRTFProfile[] = [
  {
    id: 'browser-hrtf',
    name: 'Browser HRTF',
    description: 'Browser built-in HRTF (PannerNode, no files)',
    available: true,
  },
  ...LISTEN_SUBJECTS.map((id) => ({
    id: `listen-${id}`,
    name: `LISTEN #${id}`,
    description: `IRCAM LISTEN database – subject ${id}`,
    available: true,
  })),
]

function listenSofaUrl(id: string): string {
  return `/hrtf/listen/IRC_${id}_R_44100.sofa`
}

// Drops any LISTEN profile whose .sofa file has been deleted from public/hrtf/listen,
// so removed profiles disappear from the picker instead of just failing to load.
// Vite's dev/preview server SPA-fallbacks unmatched paths to index.html with a 200,
// so a missing file looks "ok" too — the html content-type is what gives it away.
export async function detectAvailableProfiles(): Promise<HRTFProfile[]> {
  const checks = await Promise.all(
    PROFILES.map(async (p) => {
      const subjectId = p.id.match(/^listen-(\d+)$/)?.[1]
      if (!subjectId) return p
      try {
        const res = await fetch(listenSofaUrl(subjectId), { method: 'HEAD' })
        const contentType = res.headers.get('content-type') ?? ''
        return res.ok && !contentType.includes('html') ? p : null
      } catch {
        return null
      }
    }),
  )
  return checks.filter((p): p is HRTFProfile => p !== null)
}
