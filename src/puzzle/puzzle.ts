import { PUZZLE, type PuzzleType, type Tier } from '../config'
import type { Rng } from '../rng'
import type { Complete } from '../world/generate'
import { buildBugHunt } from './bug-hunt'
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

/** SPEC 8: a right answer's bonus by tier, plus up to `fastBonusMax` falling to none at `fastWithinMs`. */
export function puzzleBonus(tier: Tier, isCorrect: boolean, elapsedMs: number): number {
  if (!isCorrect) return 0
  const fast = Math.max(0, 1 - Math.max(0, elapsedMs) / PUZZLE.fastWithinMs)
  return PUZZLE.bonusByTier[tier] + PUZZLE.fastBonusMax * fast
}

/**
 * A puzzle for `tier` from `units`. `complete` is the model call; without
 * one (puzzles set to local, or the strict filter) Pattern ID is not built,
 * and nothing is sent. `trace` runs a unit locally (SPEC 8.3 rule 3); it is
 * handed in only when a runner is available. A type that cannot be made
 * from these units, or whose answer the check does not confirm, gives way to
 * the others.
 */
export async function buildPuzzle(req: { units: readonly Unit[]; tier: Tier; rng: Rng; complete?: Complete; trace?: TraceCapability }): Promise<Puzzle | undefined> {
  if (req.units.length === 0) return undefined
  const built: PuzzleType[] = [...(req.complete ? ['pattern-id' as const] : []), ...(req.trace ? ['trace' as const] : []), 'bug-hunt']
  const first = puzzleTypeFor(req.tier, built)
  for (const type of [first, ...built.filter(t => t !== first)]) {
    if (type === 'bug-hunt') {
      const p = buildBugHunt(req.units, req.rng)
      if (p) return p
    } else if (type === 'pattern-id' && req.complete) {
      const p = await buildPatternId(req.units, req.rng, req.complete)
      if (p) return p
    } else if (type === 'trace' && req.trace) {
      const p = await req.trace(req.units, req.rng)
      if (p) return p
    }
  }
  return undefined
}
