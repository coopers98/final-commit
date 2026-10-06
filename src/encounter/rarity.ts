import { QUALITY, TIERS, TIER_SPECS, type Tier } from '../config'
import type { Rng } from '../rng'

/** Encounter odds per tier after the quality shift, normalized to sum to 1. */
export function tierWeights(quality: number, opts: { excludeCommon?: boolean } = {}): Record<Tier, number> {
  const q = Math.min(1, Math.max(0, quality))
  const boost = 1 + QUALITY.rarityShiftMax * q
  const raw = {} as Record<Tier, number>
  for (const t of TIERS) {
    if (t === 'common') raw[t] = opts.excludeCommon ? 0 : TIER_SPECS[t].encounterOdds
    else raw[t] = TIER_SPECS[t].encounterOdds * boost
  }
  const total = TIERS.reduce((s, t) => s + raw[t], 0)
  const out = {} as Record<Tier, number>
  for (const t of TIERS) out[t] = raw[t] / total
  return out
}

export function rollTier(rng: Rng, quality: number, opts: { excludeCommon?: boolean } = {}): Tier {
  return rng.weighted(tierWeights(quality, opts))
}
