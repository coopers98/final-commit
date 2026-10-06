import { CELLS, CONTAINMENT_CAP, LATTICE_SHARED, QUALITY, TIER_SPECS, type Cell, type Tier } from '../config'
import type { Rng } from '../rng'

export type AttemptInput = { tier: Tier; cell: Cell; latticeBonus: number; quality: number; puzzleBonus?: number }
export type AttemptOutcome = 'contained' | 'broke-free' | 'fled'

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

/** SPEC 7.1 step 5. */
export function containmentChance(a: AttemptInput): number {
  const chance =
    TIER_SPECS[a.tier].baseContainment +
    CELLS[a.cell].bonus +
    clamp(a.puzzleBonus ?? 0, 0, 1) +
    clamp(a.latticeBonus, 0, LATTICE_SHARED.maxBonus) +
    QUALITY.containmentBonusMax * clamp(a.quality, 0, 1)
  return Math.min(CONTAINMENT_CAP, chance)
}

/** SPEC 7.1 step 6: on failure, a flee roll decides between broke free and fled. */
export function resolveAttempt(a: AttemptInput, rng: Rng): AttemptOutcome {
  if (rng.chance(containmentChance(a))) return 'contained'
  return rng.chance(TIER_SPECS[a.tier].fleeChance) ? 'fled' : 'broke-free'
}
