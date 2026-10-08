import { CRAFT, HARVEST, SINGULARITY_ACTIVATION, TIERS, TIER_SPECS, type Tier } from '../config'
import type { Rng } from '../rng'
import type { Inventory, StarSystem } from '../store/schema'

// Flora (SPEC 6.4): harvested on completed missions, spent on cells (7.2).
// Pure: the game hands in the systems and the inventory.

type Flora = Inventory['flora']

/** The flora tiers cells use (recipes and Singularity activation), lowest first. */
export const CELL_FLORA_TIERS: readonly Tier[] = TIERS.filter(t => Object.values(CRAFT).some(r => r.tier === t) || SINGULARITY_ACTIVATION.tier === t)

/** Samples a mission of `quality` (0 to 1) harvests. */
export function harvestCount(quality: number): number {
  const q = Math.min(1, Math.max(0, quality))
  return Math.round(HARVEST.minSamples + (HARVEST.maxSamples - HARVEST.minSamples) * q)
}

/**
 * `count` samples from `system`'s flora: each picks a tier by its encounter
 * odds among the tiers the system has, then a species of that tier. Returns
 * samples per species id; empty when the system has no flora.
 */
export function harvest(system: StarSystem, count: number, rng: Rng): Flora {
  const flora = system.species.filter(s => s.kind === 'flora')
  const out: Flora = {}
  if (flora.length === 0) return out
  const weights = {} as Record<Tier, number>
  for (const t of TIERS) weights[t] = flora.some(s => s.tier === t) ? TIER_SPECS[t].encounterOdds : 0
  for (let i = 0; i < count; i += 1) {
    const tier = rng.weighted(weights)
    const species = rng.pick(flora.filter(s => s.tier === tier))
    out[species.id] = (out[species.id] ?? 0) + 1
  }
  return out
}

/** Each flora species' tier, over every system charted. */
export function floraTiers(systems: readonly StarSystem[]): Map<string, Tier> {
  const tiers = new Map<string, Tier>()
  for (const sys of systems) for (const s of sys.species) if (s.kind === 'flora') tiers.set(s.id, s.tier)
  return tiers
}

/** Samples held of `tier`. A species no charted system holds counts for no tier. */
export function heldOfTier(flora: Flora, tiers: ReadonlyMap<string, Tier>, tier: Tier): number {
  return Object.entries(flora).reduce((sum, [id, n]) => sum + (tiers.get(id) === tier ? n : 0), 0)
}

/**
 * `flora` less `samples` of `tier`, taken from the largest piles first (ties
 * by id, so it is deterministic); undefined when too few are held.
 */
export function spendFlora(flora: Flora, tiers: ReadonlyMap<string, Tier>, tier: Tier, samples: number): Flora | undefined {
  if (heldOfTier(flora, tiers, tier) < samples) return undefined
  const next = { ...flora }
  let left = samples
  const piles = Object.keys(next)
    .filter(id => tiers.get(id) === tier && (next[id] ?? 0) > 0)
    .sort((a, b) => next[b]! - next[a]! || (a < b ? -1 : 1))
  for (const id of piles) {
    const take = Math.min(left, next[id]!)
    next[id] = next[id]! - take
    if (next[id] === 0) delete next[id]
    left -= take
    if (left === 0) break
  }
  return next
}

/** `flora` plus `gained`, or less `gained` as far as held (`sign` -1), dropping empty piles. */
export function addFlora(flora: Flora, gained: Flora, sign: 1 | -1 = 1): Flora {
  const next = { ...flora }
  for (const [id, n] of Object.entries(gained)) {
    const v = Math.max(0, (next[id] ?? 0) + sign * n)
    if (v === 0) delete next[id]
    else next[id] = v
  }
  return next
}
