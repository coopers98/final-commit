// $.state contract for The Final Commit: what the panes and the band draw.
// Saved game data lives in $.store (src/store); these are views of it.

/** A rarity tier (src/config TIERS): views carry it so a drawing can color by it (SPEC 6.2). */
export type TierName = 'common' | 'uncommon' | 'rare' | 'exotic' | 'legendary' | 'anomaly'

export type LatticeView = {
  heading: string
  tier: TierName
  sprite: string[]
  bar: string
  locks: string
  hint: string[]
  message: string
  isOver: boolean
}

/** SPEC 8: the Analyze Specimen step before Seal the Lattice. `result` is set once answered. */
export type AnalyzeView = {
  heading: string
  tier: TierName
  /** The puzzle's language and type, as shown. */
  label: string
  question: string
  code: string[]
  choices: string[]
  result: { lines: string[] } | null
}

export type BandView = {
  name: string
  /** The tier's glyph and label, as shown. */
  tier: string
  tierName: TierName
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

/** The report a finished mission or survey shows until dismissed. */
export type ReportView = {
  title: string
  lines: string[]
  /** The creature that turned up, if one did. */
  encounter: { heading: string; sprite: string[]; tier: TierName } | null
  /** Cells usable after it (a Singularity Cell only with a Legendary flora sample to activate it), offered for containing from the report; absent with no encounter. */
  cells?: CellCounts
}

/** Special cells by kind (Standard Cells are unlimited). */
export type CellCounts = { reinforced: number; stasis: number; singularity: number }

/** `/mission complete` asking first: the mission's open items (tests, lint). */
export type ConfirmView = { issueKey: string; items: string[] }

/** A `/mission <KEY>` typed while its epic was being charted: started when the charting finishes. */
export type QueuedMission = { issueKey: string; epicKey: string; at: number }

/** One row of the /scan pane (SPEC 9.4); `isArt` rows are cut, never wrapped. */
export type ScanRow = { text: string; style?: 'bold' | 'dim'; isArt?: boolean; tier?: TierName }

/** One row of the Specimen Bay pane. */
export type BayRow = { text: string; tier?: TierName }

/** An epic whose star system is being generated right now. */
export type ChartingEntry = { key: string; startedAt: number }

/** Charts a work source started that failed, by epic key: failures in a row, and when one may be tried again. */
export type ChartFailures = Record<string, { count: number; retryAt: number }>

/** `/setup`'s answers (SPEC 4.6): the plugin's own settings as their `/config` text. */
export type SetupValues = { workSources: string; plansFolders: string; githubRepos: string; jiraSite: string; jiraEmail: string }

/** The `/setup` pane: the question being asked (or the review), the answers so far, the settings it started from. */
export type SetupView = {
  step: 'sources' | 'plans' | 'github' | 'jiraSite' | 'jiraEmail' | 'review' | 'saving' | 'done'
  values: SetupValues
  original: SetupValues
  /** What is wrong with the last answer; the pane stays on its question. */
  error: string | null
  /** After saving: one line per setting, saved or refused with the reason. */
  applied: string[]
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
      /** In session state, so it outlives a hot reload that kills the charting itself. */
      charting: ChartingEntry[]
      /** In session state, so a hot reload does not start the retries over. */
      chartFailures: ChartFailures
      epicForm: EpicFormView | null
      report: ReportView | null
      confirm: ConfirmView | null
      queuedMission: QueuedMission | null
      scan: ScanRow[]
      setup: SetupView | null
      mood: MoodState
      lattice: LatticeView | null
      analyze: AnalyzeView | null
      band: BandView | null
      /** SPEC 9.2 red alert: the status line flashes before `until`; toasts keep a cooldown from `lastToastAt`. */
      alert: { until: number; lastToastAt: number | null }
      /** SPEC 9.1 crew: running subagents by agent id, and each officer's last result. */
      crew: {
        running: Record<string, 'engineering' | 'science' | 'tactical'>
        last: Partial<Record<'engineering' | 'science' | 'tactical', { outcome: 'done' | 'clean' | 'issues' | 'stopped'; at: number }>>
        fromBridge: string[]
      }
      /** The Bridge pane's input: the Science question being typed, and a counter that clears the field. */
      bridgeInput: { isAsking: boolean; generation: number }
      /** True while the Bridge pane is open: the companion draws there and the band steps aside. */
      bridgeOpen: boolean
      /** SPEC 9 Bridge gauges for this session: test runs (hull) and the last lint verdict (shields). */
      gauges: { tests: { runs: number; passes: number }; lint: 'pass' | 'fail' | null }
      calibration: CalibrationView | null
      bay: BayRow[]
    }
  }
}
