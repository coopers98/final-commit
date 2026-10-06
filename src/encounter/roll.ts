import { ENCOUNTER } from '../config'
import type { Rng } from '../rng'

export const DAY_MS = 86_400_000

export type EncounterContext = {
  now: number
  lastEncounterAt: number | null
  firstTrackedAt: number
  /** Missions completed before this one. */
  completedMissions: number
}

/** SPEC 6.1: base chance plus a step per whole day since the last encounter. */
export function encounterChance(daysSinceLast: number): number {
  const days = Math.max(0, Math.floor(daysSinceLast))
  return Math.min(1, ENCOUNTER.baseChance + ENCOUNTER.perDayChance * days)
}

export function shouldEncounter(ctx: EncounterContext, rng: Rng): boolean {
  if (ENCOUNTER.firstMissionGuaranteed && ctx.completedMissions === 0) return true
  const since = ctx.lastEncounterAt ?? ctx.firstTrackedAt
  const days = Math.max(0, (ctx.now - since) / DAY_MS)
  if (days >= ENCOUNTER.guaranteedAfterDays) return true
  return rng.chance(encounterChance(days))
}
