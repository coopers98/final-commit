import type { AttachmentClass, Cell, Tier } from '../config'

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
  tacticalClean: boolean
}

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
