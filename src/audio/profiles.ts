export interface HRTFProfile {
  id: string
  name: string
  description: string
  available: boolean
}

const LISTEN_SUBJECTS = [
  1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009,
  1012, 1013, 1014, 1015, 1016, 1017, 1018,
  1020, 1021, 1022, 1023, 1025, 1026, 1028, 1029,
  1030, 1031, 1032, 1033, 1037, 1038, 1039,
  1040, 1041, 1042, 1043, 1044, 1045, 1046, 1047, 1048, 1049,
  1050, 1051, 1052, 1053, 1054, 1055, 1056, 1057, 1058, 1059,
]

export const PROFILES: HRTFProfile[] = [
  {
    id: 'mit-kemar',
    name: 'MIT KEMAR',
    description: 'MIT KEMAR dummy head – real HRIR files, ConvolverNode',
    available: true,
  },
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
