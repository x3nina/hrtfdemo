export interface HRTFProfile {
  id: string
  name: string
  description: string
  available: boolean
}

// MIT KEMAR: browser built-in PannerNode HRTF (Chromium uses KEMAR-derived data)
// LISTEN profiles: require HRIR files loaded via loadListenProfile()
export const PROFILES: HRTFProfile[] = [
  {
    id: 'browser-kemar',
    name: 'MIT KEMAR',
    description: 'Browser built-in HRTF (KEMAR dummy head measurements)',
    available: true,
  },
  {
    id: 'listen-1002',
    name: 'LISTEN #1002',
    description: 'IRCAM LISTEN database – subject 1002',
    available: false,
  },
  {
    id: 'listen-1003',
    name: 'LISTEN #1003',
    description: 'IRCAM LISTEN database – subject 1003',
    available: false,
  },
  {
    id: 'listen-1004',
    name: 'LISTEN #1004',
    description: 'IRCAM LISTEN database – subject 1004',
    available: false,
  },
  {
    id: 'listen-1005',
    name: 'LISTEN #1005',
    description: 'IRCAM LISTEN database – subject 1005',
    available: false,
  },
]
