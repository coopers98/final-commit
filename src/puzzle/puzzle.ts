import { PUZZLE, type PuzzleType, type Tier } from '../config'
import type { Rng } from '../rng'
import type { PuzzleStat } from '../store/schema'
import type { Complete } from '../world/generate'
import { buildBugHunt } from './bug-hunt'
import { buildComplexityRead } from './complexity-read'
import { buildPatternId } from './pattern-id'
import type { TraceCapability } from './trace'
import type { Unit } from './units'

// SPEC 8: Analyze Specimen. A puzzle is built from the units of the mission
// that rolled the encounter, kept with the waiting encounter, and asked
// before containment. Pure apart from the model call it is handed.

export type Puzzle = {
  type: PuzzleType
  /** What it trains, for the accuracy record (SPEC 8.2). */
  category: string
  question: string
  /** The unit as shown: filtered code (SPEC 8.3). */
  lang: string
  code: string[]
  /** Four choices, and the index of the right one. */
  choices: string[]
  answer: number
  explanation: string
}

/**
 * The type `tier` asks for among `built`: its own if built, else the nearest
 * built one below it (SPEC 8), else the lowest built one above it.
 */
export function puzzleTypeFor(tier: Tier, built: readonly PuzzleType[]): PuzzleType | undefined {
  const order = PUZZLE.typeOrder
  const at = order.indexOf(PUZZLE.typeByTier[tier])
  for (let i = at; i >= 0; i -= 1) if (built.includes(order[i] as PuzzleType)) return order[i] as PuzzleType
  return order.find(t => built.includes(t as PuzzleType)) as PuzzleType | undefined
}

/**
 * SPEC 8.2, D4: spaced repetition. A category of `type` weighs 1 (an even
 * split), plus `PUZZLE.weakWeight` times its miss rate over its recent
 * answers; one never answered weighs 1.
 */
export function categoryWeights(stats: readonly PuzzleStat[], type: PuzzleType): (category: string) => number {
  return category => {
    const recent = stats.find(s => s.type === type && s.category === category)?.recent ?? []
    return 1 + (recent.length === 0 ? 0 : (PUZZLE.weakWeight * recent.filter(r => !r).length) / recent.length)
  }
}

/** SPEC 8: a right answer's bonus by tier, plus up to `fastBonusMax` falling to none at `fastWithinMs`. */
export function puzzleBonus(tier: Tier, isCorrect: boolean, elapsedMs: number): number {
  if (!isCorrect) return 0
  const fast = Math.max(0, 1 - Math.max(0, elapsedMs) / PUZZLE.fastWithinMs)
  return PUZZLE.bonusByTier[tier] + PUZZLE.fastBonusMax * fast
}

/**
 * A puzzle for `tier`. Pattern ID is made from `units` (what may go to a model), never `localUnits`;
 * Bug Hunt, Complexity Read and Trace read `localUnits` (the pane's own text, which never leaves the machine), else `units`. `complete` is the model call; without
 * one (puzzles set to local, or the strict filter) Pattern ID is not built,
 * and nothing is sent. `trace` runs a unit locally (SPEC 8.3 rule 3); it is
 * handed in only when a runner is available. A type that cannot be made
 * from these units, or whose answer the check does not confirm, gives way to
 * the others.
 */
export async function buildPuzzle(req: {
  units: readonly Unit[]
  /** The units as the pane alone shows them (puzzle view spec, section 4): Bug Hunt and Trace; `units` when absent. */
  localUnits?: readonly Unit[]
  tier: Tier
  rng: Rng
  complete?: Complete
  trace?: TraceCapability
  /** SPEC 8.2, D4: the accuracy record, so weak categories come up more often where the game picks one. */
  stats?: readonly PuzzleStat[]
}): Promise<Puzzle | undefined> {
  const local = req.localUnits ?? req.units
  if (req.units.length === 0 && local.length === 0) return undefined
  const built: PuzzleType[] = [...(req.complete && req.units.length > 0 ? ['pattern-id' as const] : []), 'complexity-read', ...(req.trace ? ['trace' as const] : []), 'bug-hunt']
  const first = puzzleTypeFor(req.tier, built)
  for (const type of [first, ...built.filter(t => t !== first)]) {
    if (type === 'complexity-read') {
      const p = buildComplexityRead(local, req.rng, req.stats ? categoryWeights(req.stats, 'complexity-read') : undefined)
      if (p) return p
    } else if (type === 'bug-hunt') {
      const p = buildBugHunt(local, req.rng, req.stats ? categoryWeights(req.stats, 'bug-hunt') : undefined)
      if (p) return p
    } else if (type === 'pattern-id' && req.complete) {
      const p = await buildPatternId(req.units, req.rng, req.complete)
      if (p) return p
    } else if (type === 'trace' && req.trace) {
      const p = await req.trace(local, req.rng)
      if (p) return p
    }
  }
  return undefined
}
