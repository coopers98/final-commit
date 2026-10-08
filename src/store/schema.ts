import type { AttachmentClass, Cell, Tier } from '../config'
import type { WorkStatus, WorkTransition } from '../detect/work-source'

// SPEC 10, extended for the slice. Times are epoch milliseconds from $.clock.

export type Versioned<T> = T & { schemaVersion: number }

export type Point = { x: number; y: number }
export type Anchors = { head: Point; neck: Point; hand: Point; orbit: Point }
export type Sprite = { rows: string[] }

export type Species = {
  id: string
  kind: 'fauna' | 'flora'
  tier: Tier
  name: string
  readout: string
  behavior: string
  stages: Sprite[]
  anchors: Anchors
  /** True when the art (or name) came from the procedural library. */
  isProcedural: boolean
}

export type Biome = { name: string; description: string }

export type StarSystem = {
  id: string
  epicKey: string
  name: string
  starClass: string
  lore: string
  biomes: Biome[]
  species: Species[]
  status: 'open' | 'surveyed'
  chartedAt: number
  surveyedAt?: number
}

export type Mission = {
  issueKey: string
  systemId: string
  startedAt: number
  completedAt?: number
  commits: number
  testRuns: number
  testsGreen: boolean
  /** The last lint or type-check verdict during the mission; null before one runs. */
  lint: 'pass' | 'fail' | null
  tacticalClean: boolean
  /**
   * What completing it gave, so `/mission reopen` takes back exactly that:
   * whether it counted as a completed mission, the Reinforced and Stasis
   * Cells it earned, and the flora samples it harvested (per species id). Set
   * on completed missions in the log; absent on the active one.
   */
  reward?: MissionReward
}

export type MissionReward = { counted: boolean; reinforced: number; stasis: number; flora: Record<string, number> }

export type Specimen = {
  id: string
  speciesId: string
  systemId: string
  tier: Tier
  attachment?: { class: AttachmentClass; item: string }
  level: number
  xp: number
  stage: 0 | 1 | 2
  containedAt: number
  nickname?: string
}

export type PendingEncounter = {
  id: string
  systemId: string
  speciesId: string
  tier: Tier
  attachment?: { class: AttachmentClass; item: string }
  quality: number
  attempts: number
  createdAt: number
}

export type Inventory = Record<Exclude<Cell, 'standard'>, number> & { flora: Record<string, number> }

export type CatalogEntry = {
  speciesId: string
  tier: Tier
  attachment?: string
  status: 'seen' | 'contained' | 'escaped'
}

export type SaveMeta = {
  createdAt: number
  firstTrackedAt: number | null
  lastEncounterAt: number | null
  completedMissions: number
  activeEpicKey: string | null
  companionId: string | null
  /** SPEC 4.3 soft cap: encounters rolled from missions on `day` (host local date, YYYY-MM-DD). */
  encountersToday: { day: string; count: number }
}

/** `salt` makes client keys unguessable from the values they hash (generated once per install). */
export type Calibration = { clients: Record<string, { offsetMs: number; measuredAt: number }>; salt: string }

/**
 * SPEC 4.2: where one work source's sync left off (one record per source,
 * SPEC 4.4). `lastSync` is null until that source's first sync, which starts
 * from that moment (nothing before it is awarded). `processed` holds
 * `<issueKey>:<transitionId>` for each applied transition.
 */
export type SyncState = { lastSync: number | null; processed: string[] }

/**
 * SPEC 4.4 rule 3: what the plan documents of one project last read as. A
 * task stays when it disappears from the files, so a file briefly missing
 * reports nothing when it returns. `log` keeps recent changes, newest last,
 * so a sync that waits (SPEC 4.2 rule 5) can read them again. `epoch`: when
 * the baseline was read, part of every transition id.
 */
export type PlansState = {
  epoch: number
  tasks: Record<string, { status: WorkStatus }>
  doneEpics: string[]
  log: WorkTransition[]
  seq: number
}

/** SPEC 9.2: one `/captains-log` entry. */
export type LogEntry = { at: number; stardate: string; lines: string[] }

/** SPEC 9.1: an officer's last report, kept so the Bridge can show it again. Stays on this machine. */
export type CrewReport = { role: 'engineering' | 'science' | 'tactical'; at: number; lines: string[] }
