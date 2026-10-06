// $.state contract for The Final Commit: what the panes and the band draw.
// Saved game data lives in $.store (src/store); these are views of it.

export type LatticeView = {
  heading: string
  sprite: string[]
  bar: string
  locks: string
  hint: string[]
  message: string
  isOver: boolean
}

export type BandView = {
  name: string
  tier: string
  mood: string
  sprite: string[]
  mission: string | null
  isBlinking: boolean
}

export type CalibrationView = {
  isBeat: boolean
  pressed: number
  total: number
  message: string
  isOver: boolean
}

export type MoodState = {
  last: { event: 'fed' | 'startled'; at: number } | null
  lastActivityAt: number
}

export type EpicFormView = {
  key: string
  step: 'title' | 'description'
  title: string
}

declare module 'claude-code' {
  interface PluginState {
    'final-commit': {
      /** True once the save migrated this session; nothing touches the store before it. */
      ready: boolean
      epicForm: EpicFormView | null
      mood: MoodState
      lattice: LatticeView | null
      band: BandView | null
      calibration: CalibrationView | null
      bay: string[]
    }
  }
}
