// Every tuning number in the game. Values marked SPEC come from docs/SPEC.md;
// values marked DEFAULT are the v1 playtest defaults recorded in SPEC 16 and
// tuned by playing. Nothing else in src/ may hold a tuning number.

export const TIERS = ['common', 'uncommon', 'rare', 'exotic', 'legendary', 'anomaly'] as const
export type Tier = (typeof TIERS)[number]

export type TierSpec = {
  label: string
  glyph: string
  /** Terminal color name; 'cycle' means the renderer cycles colors. */
  color: string
  encounterOdds: number
  baseContainment: number
  fleeChance: number
}

// SPEC 6.2
export const TIER_SPECS: Record<Tier, TierSpec> = {
  common: { label: 'Common', glyph: '·', color: 'gray', encounterOdds: 0.5, baseContainment: 0.9, fleeChance: 0.1 },
  uncommon: { label: 'Uncommon', glyph: '◇', color: 'green', encounterOdds: 0.28, baseContainment: 0.7, fleeChance: 0.2 },
  rare: { label: 'Rare', glyph: '◆', color: 'blue', encounterOdds: 0.14, baseContainment: 0.45, fleeChance: 0.35 },
  exotic: { label: 'Exotic', glyph: '✦', color: 'magenta', encounterOdds: 0.06, baseContainment: 0.25, fleeChance: 0.5 },
  legendary: { label: 'Legendary', glyph: '★', color: 'yellow', encounterOdds: 0.018, baseContainment: 0.1, fleeChance: 0.65 },
  anomaly: { label: 'Anomaly', glyph: '✺', color: 'cycle', encounterOdds: 0.002, baseContainment: 0.05, fleeChance: 0.8 },
}

// SPEC 6.1, 4.3; firstMissionGuaranteed is DEFAULT
export const ENCOUNTER = {
  baseChance: 0.12,
  perDayChance: 0.12,
  guaranteedAfterDays: 5,
  dailySoftCap: 2,
  firstMissionGuaranteed: true,
  /** Quality an epic-completion encounter rolls with (the best a mission can reach in v1). */
  surveyQuality: 0.5,
} as const

// DEFAULT: rewards
export const REWARDS = { reinforcedForGreenTests: 1 } as const

// DEFAULT (SPEC 6.2 and 7.1 give direction and the +10% maximum)
export const QUALITY = {
  testsGreenWeight: 0.5,
  tacticalCleanWeight: 0.5,
  rarityShiftMax: 0.5,
  containmentBonusMax: 0.1,
} as const

// SPEC 6.3
export type AttachmentClass = 'minor' | 'major' | 'mythic'
export const ATTACHMENT_ODDS = { none: 0.85, minor: 0.11, major: 0.035, mythic: 0.005 } as const
export const ATTACHMENT_ITEMS: Record<AttachmentClass, readonly string[]> = {
  minor: ['scarf', 'antenna tag', 'goggles'],
  major: ['top hat', 'visor', 'cybernetic eye'],
  mythic: ['crown', 'halo', 'orbiting moonlet'],
}

// SPEC 7.2
export type Cell = 'standard' | 'reinforced' | 'stasis' | 'singularity'
export const CELLS: Record<Cell, { bonus: number; label: string }> = {
  standard: { bonus: 0, label: 'Standard' },
  reinforced: { bonus: 0.15, label: 'Reinforced' },
  stasis: { bonus: 0.3, label: 'Stasis' },
  singularity: { bonus: 0.5, label: 'Singularity' },
}

// SPEC 7.1
export const CONTAINMENT_CAP = 0.98

// SPEC 5.2
export const SPRITE = { cols: 14, rows: 7, maxArtRetries: 2, minSilhouetteCells: 8 } as const

// SPEC 7.3 (shape), DEFAULT (numbers)
export type LatticeTwist = 'none' | 'shift' | 'reverse' | 'break' | 'flicker'
export const LATTICE: Record<Tier, { locks: number; zone: number; sweepMs: number; twist: LatticeTwist }> = {
  common: { locks: 1, zone: 0.3, sweepMs: 2000, twist: 'none' },
  uncommon: { locks: 2, zone: 0.3, sweepMs: 1400, twist: 'none' },
  rare: { locks: 3, zone: 0.18, sweepMs: 1400, twist: 'shift' },
  exotic: { locks: 3, zone: 0.1, sweepMs: 900, twist: 'reverse' },
  legendary: { locks: 4, zone: 0.1, sweepMs: 900, twist: 'break' },
  anomaly: { locks: 5, zone: 0.06, sweepMs: 700, twist: 'flicker' },
}
export const LATTICE_SHARED = {
  barCells: 30,
  frameMs: 40,
  centerFraction: 0.3,
  lockBonusTotal: 0.2,
  centerHitBonus: 0.02,
  maxBonus: 0.25,
  reverseChancePerSecond: 0.6,
  flickerPeriodMs: 300,
  flickerVisibleFraction: 0.7,
  erraticJitter: 0.35,
  /** Each miss (including a press while the needle is still inside a zone it just sealed) costs this much bonus. */
  missPenalty: 0.03,
} as const

// DEFAULT
export const CALIBRATION = { beats: 8, beatIntervalMs: 750, maxAbsOffsetMs: 400 } as const

// SPEC 5.1 (slots), DEFAULT (model and limits)
export type GenerationModel = 'opus' | 'sonnet' | 'haiku'
export const GENERATION = {
  defaultModel: 'opus' as GenerationModel,
  maxTokens: 16_000,
  timeoutMs: 180_000,
  faunaSlots: { common: 6, uncommon: 4, rare: 3, exotic: 2, legendary: 1, anomaly: 1 } as Record<Tier, number>,
  floraSlots: { common: 4, uncommon: 3, rare: 2, exotic: 0, legendary: 1, anomaly: 0 } as Record<Tier, number>,
  faunaStages: 3,
  floraStages: 1,
  maxNameLength: 24,
  maxBiomes: 4,
  maxStarClassLength: 8,
  /** Chance a procedural name gets a second vowel group. */
  extraSyllableChance: 0.5,
} as const

// SPEC 10
export const STORE = { prefix: 'fc:', schemaVersion: 1 } as const

// DEFAULT: companion band (SPEC 9.3) and pane timings
export const COMPANION = { reactMs: 60_000, sleepAfterMs: 600_000, blinkEveryMs: 3_000, blinkMs: 200, spriteMinRows: 9 } as const
export const PANES = { closeAfterResultMs: 1_500, calibrationLeadInMs: 1_000, calibrationBeatGlowMs: 150, calibrationTickMs: 25 } as const

// DEFAULT: the status line shares 40 columns with the engine's own prefix (about 18 cells).
export const STATUS = { maxColumns: 22 } as const

// DEFAULT: the status line's charting indicator (a spinner frame per step).
export const CHARTING = { spinnerMs: 400, frames: ['|', '/', '-', '\\'] } as const

// DEFAULT: how long a git call from the Bash observer may take.
export const GIT = { timeoutMs: 5_000 } as const
