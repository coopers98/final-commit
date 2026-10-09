import { COMPANION_XP } from './config'
import type { Species, Specimen } from './store/schema'

// SPEC 9.3: companion XP, levels and evolution. Pure: the game hands in the
// specimen and saves what comes back. A specimen stores its total `xp`; its
// level follows from it, and its stage only ever rises.

export type Stage = Specimen['stage']

/** XP to go from `level` to the next one. */
export function xpToNext(level: number): number {
  return COMPANION_XP.levelBase + COMPANION_XP.levelStep * (Math.max(1, level) - 1)
}

/** The level a total of `xp` reaches, from 1 up to the cap. */
export function levelForXp(xp: number): number {
  let level = 1
  let left = Math.max(0, xp)
  while (level < COMPANION_XP.maxLevel && left >= xpToNext(level)) {
    left -= xpToNext(level)
    level += 1
  }
  return level
}

/** Total XP that reaching `level` takes (0 for level 1). */
export function xpForLevel(level: number): number {
  let total = 0
  for (let l = 1; l < Math.min(level, COMPANION_XP.maxLevel); l += 1) total += xpToNext(l)
  return total
}

/** The stage `level` has reached by itself: one more for each evolution level reached. */
export function stageForLevel(level: number): Stage {
  return Math.min(2, COMPANION_XP.evolveAt.filter(at => level >= at).length) as Stage
}

/** XP a counted mission of quality `q` (0 to 1) gives. */
export function missionXp(quality: number): number {
  return COMPANION_XP.missionBase + Math.round(COMPANION_XP.missionQuality * Math.min(1, Math.max(0, quality)))
}

export type XpChange = { specimen: Specimen; xp: number; isLevelUp: boolean; isEvolved: boolean }

/** Gives `xp`: the level follows; the stage rises with it. */
export function grantXp(specimen: Specimen, xp: number): XpChange {
  const total = Math.max(0, specimen.xp) + Math.max(0, xp)
  const level = levelForXp(total)
  const stage = Math.max(specimen.stage, stageForLevel(level)) as Stage
  return { specimen: { ...specimen, xp: total, level, stage }, xp, isLevelUp: level > specimen.level, isEvolved: stage > specimen.stage }
}

/** Takes back up to `xp` (never below 0): the level follows; the stage stays. */
export function takeXp(specimen: Specimen, xp: number): { specimen: Specimen; taken: number } {
  const taken = Math.min(Math.max(0, xp), Math.max(0, specimen.xp))
  const total = specimen.xp - taken
  return { specimen: { ...specimen, xp: total, level: levelForXp(total) }, taken }
}

/**
 * The drawing of a specimen at `stage`: that stage, else the last stage
 * below it that has one, else none. Wild encounters, silhouettes and the
 * report of a new creature draw stage 0 directly.
 */
export function stageRows(species: Pick<Species, 'stages'> | undefined, stage: number): string[] {
  const stages = species?.stages ?? []
  for (let i = Math.min(stage, stages.length - 1); i >= 0; i -= 1) {
    const rows = stages[i]?.rows
    if (rows && rows.length > 0) return rows
  }
  return []
}
