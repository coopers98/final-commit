import type { PluginOptions } from 'claude-code'
import type { BandView, ChartingEntry, MoodState } from '../types'
import { COMPANION, GENERATION, PLANS, TIER_SPECS, type GenerationModel } from './config'
import { statusText } from './bridge/status'
import { sourceNames } from './detect/sources'
import type { PrivacyMode } from './puzzle/privacy-filter'
import { createRng, seedFromCrypto, type Rng } from './rng'
import type { Repo } from './store/repo'
import type { StarSystem } from './store/schema'

// Pure helpers shared by the wiring files. The engine's validator lets `$`
// reach only functions in the same file, so nothing here takes `$`: each
// wiring file adapts `$.store` and `$.model` itself and hands the result in.

export type Settings = { generationModel: GenerationModel; privacyMode: PrivacyMode; devMode: boolean; workSources: string[]; plansFolders: string[]; githubRepos: string[] }

export function readSettings(options: PluginOptions): Settings {
  const model = options.generationModel
  const privacy = options.privacyMode
  return {
    generationModel: model === 'sonnet' || model === 'haiku' || model === 'opus' ? model : GENERATION.defaultModel,
    // Strict unless the user chose otherwise: the safe direction for a privacy default.
    privacyMode: privacy === 'strict' || privacy === 'off' || privacy === 'standard' ? privacy : 'strict',
    devMode: options.devMode === true,
    workSources: sourceNames(options.workSources),
    plansFolders: folderList(options.plansFolders),
    githubRepos: (Array.isArray(options.githubRepos) ? options.githubRepos : []).filter((v): v is string => typeof v === 'string' && v.trim() !== ''),
  }
}

/**
 * SPEC 4.4 rule 3: the plan folders, trimmed, each once; the default when
 * none is set. Only folders inside the project: an absolute path, a home
 * path or a `..` segment is dropped, so a setting cannot aim the source at
 * files elsewhere.
 */
function folderList(value: unknown): string[] {
  const isInside = (p: string) => !/^([/\\~]|[A-Za-z]:)/.test(p) && !p.split(/[/\\]/).includes('..')
  const list = (Array.isArray(value) ? value : []).filter((v): v is string => typeof v === 'string').map(v => v.trim()).filter(v => v !== '' && isInside(v))
  return list.length > 0 ? [...new Set(list)] : [...PLANS.defaultFolders]
}

/**
 * The Rng for one game action. Play seeds from crypto; a numeric
 * FINAL_COMMIT_SEED environment variable (tests and reproducible playtests
 * only) seeds deterministically, `counter` making each action differ.
 */
export function rngFor(seed: string | undefined, counter: number): Rng {
  const base = seed !== undefined && /^\d+$/.test(seed) ? Number(seed) : undefined
  return createRng(base === undefined ? seedFromCrypto() : base + counter)
}

/** Host-local calendar date for the daily soft cap (SPEC 4.3 "host local time"). */
export function localDay(now: number): string {
  const d = new Date(now)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export const NO_MOOD: MoodState = { last: null, lastActivityAt: 0 }

/** SPEC 9.3: mood from the latest event, sleep after a quiet spell. */
export function moodOf(now: number, mood: MoodState): string {
  if (mood.last && now - mood.last.at < COMPANION.reactMs) return mood.last.event === 'fed' ? 'content' : 'startled'
  return now - mood.lastActivityAt >= COMPANION.sleepAfterMs ? 'asleep' : 'idle'
}

async function activeSystem(repo: Repo, epicKey: string | null | undefined): Promise<StarSystem | undefined> {
  if (!epicKey) return undefined
  for (const id of await repo.systemIds()) {
    const s = await repo.system(id)
    if (s?.epicKey === epicKey) return s
  }
  return undefined
}

/**
 * Charting markers with no charting behind them: the marker lives in session
 * state and outlives a hot reload, the generation itself does not.
 */
export function orphanedCharts(entries: ChartingEntry[], live: ReadonlySet<string>): ChartingEntry[] {
  return entries.filter(e => !live.has(e.key))
}

/** Everything the status line and the band show, read from the save. */
export async function snapshot(
  repo: Repo,
  mood: MoodState,
  now: number,
  charting: ChartingEntry[] = [],
  isAlert = false,
): Promise<{ status: string | undefined; band: BandView | null }> {
  const meta = await repo.meta()
  const mission = await repo.activeMission()
  const system = await activeSystem(repo, meta?.activeEpicKey)
  const first = charting[0]
  const status = statusText({
    system, mission, pending: await repo.pending(), isAlert,
    ...(first ? { charting: { key: first.key, elapsedMs: now - first.startedAt } } : {}),
  })

  let band: BandView | null = null
  const specimen = meta?.companionId ? (await repo.specimens()).find(s => s.id === meta.companionId) : undefined
  if (specimen) {
    const home = await repo.system(specimen.systemId)
    const species = home?.species.find(s => s.id === specimen.speciesId)
    band = {
      name: species?.name ?? 'Unknown',
      tier: `${TIER_SPECS[specimen.tier].glyph} ${TIER_SPECS[specimen.tier].label}`,
      tierName: specimen.tier,
      mood: moodOf(now, mood),
      sprite: species?.stages[specimen.stage]?.rows ?? species?.stages[0]?.rows ?? [],
      mission: mission?.issueKey ?? null,
      isBlinking: false,
    }
  }
  return { status, band }
}
