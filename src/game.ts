import { CELLS, ENCOUNTER, REWARDS, type Cell } from './config'
import { resolveAttempt, type AttemptOutcome } from './contain/resolve'
import type { BashSignals } from './detect/git'
import { issueKeyFromBranch } from './detect/git'
import { rollAttachment } from './encounter/attachments'
import { missionQuality } from './encounter/quality'
import { rollTier } from './encounter/rarity'
import { shouldEncounter } from './encounter/roll'
import type { PrivacyMode } from './puzzle/privacy-filter'
import type { Rng } from './rng'
import type { Repo } from './store/repo'
import type { CatalogEntry, Mission, PendingEncounter, SaveMeta, Species, StarSystem } from './store/schema'
import { type Complete, type EpicInput, generateSystem } from './world/generate'


// Game actions over the save. Pure apart from the Repo they are handed: the
// glue supplies the clock value, a seeded Rng and the model call.
//
// `text` is what a slash command prints. The model reads it, so it stays a
// short factual line (CLAUDE.md rule 1). Flavor goes in `toast`.

export type Outcome = { text: string; toast?: string }
/** `day` is the host-local calendar date (YYYY-MM-DD) for the daily soft cap (SPEC 4.3). */
export type GameDeps = { repo: Repo; now: number; rng: Rng; day?: string }

async function requireMeta(repo: Repo): Promise<SaveMeta> {
  const meta = await repo.meta()
  if (!meta) throw new Error('final-commit: save not migrated; migrate() must run at session start')
  return meta
}

async function activeSystem(repo: Repo, meta: SaveMeta): Promise<StarSystem | undefined> {
  if (!meta.activeEpicKey) return undefined
  for (const id of await repo.systemIds()) {
    const s = await repo.system(id)
    if (s?.epicKey === meta.activeEpicKey) return s
  }
  return undefined
}

async function findSystemByEpic(repo: Repo, epicKey: string): Promise<StarSystem | undefined> {
  for (const id of await repo.systemIds()) {
    const s = await repo.system(id)
    if (s?.epicKey === epicKey) return s
  }
  return undefined
}

const ISSUE_KEY = /^[A-Z][A-Z0-9]{1,9}-[1-9]\d*$/
const projectOf = (key: string) => key.slice(0, key.lastIndexOf('-'))

/**
 * `/epic <KEY>`: the key only. The title and description are typed into a
 * pane, because slash command arguments are recorded in the transcript the
 * model reads, and epic text must reach the model only through the filter.
 */
export function parseEpicKey(args: string): string | undefined {
  const key = args.trim().toUpperCase()
  return ISSUE_KEY.test(key) ? key : undefined
}

export async function startEpic(
  deps: GameDeps & { epic: EpicInput; complete: Complete; privacy: PrivacyMode },
): Promise<Outcome> {
  const { repo, now, rng, epic } = deps
  await requireMeta(repo)
  const existing = await findSystemByEpic(repo, epic.key)
  if (existing) {
    await repo.patchMeta(m => ({ ...m, activeEpicKey: epic.key }))
    return { text: `Epic ${epic.key} is already charted; it is now the active epic.` }
  }
  // Unique without counting: two charts in flight must never share an id.
  const systemId = `sys-${now.toString(36)}-${rng.int(1_000_000).toString(36)}`
  const { system, notes } = await generateSystem({ epic, systemId, privacy: deps.privacy, complete: deps.complete, rng, now })
  await repo.saveSystem(system)
  // Re-read meta: generation can take minutes and other actions may have saved since.
  await repo.patchMeta(m => ({ ...m, activeEpicKey: epic.key }))
  const fauna = system.species.filter(s => s.kind === 'fauna').length
  return {
    text: `Charted epic ${epic.key}.${notes.length > 0 ? ' Some content is procedural.' : ''}`,
    toast: `New system charted: ${system.name} (${system.starClass}), ${fauna} lifeforms detected`,
  }
}

function pickSpecies(system: StarSystem, tier: Species['tier'], rng: Rng): Species {
  const fauna = system.species.filter(s => s.kind === 'fauna')
  const ofTier = fauna.filter(s => s.tier === tier)
  return rng.pick(ofTier.length > 0 ? ofTier : fauna)
}

async function createEncounter(
  deps: GameDeps,
  system: StarSystem,
  quality: number,
  opts: { excludeCommon?: boolean } = {},
): Promise<PendingEncounter> {
  const { repo, now, rng } = deps
  const tier = rollTier(rng, quality, opts)
  const species = pickSpecies(system, tier, rng)
  const attachment = rollAttachment(rng)
  const pending: PendingEncounter = {
    id: `enc-${now}-${rng.int(1_000_000)}`,
    systemId: system.id,
    speciesId: species.id,
    tier: species.tier,
    ...(attachment ? { attachment } : {}),
    quality,
    attempts: 0,
    createdAt: now,
  }
  await repo.savePending(pending)
  await markCatalog(repo, { speciesId: species.id, tier: species.tier, ...(attachment ? { attachment: attachment.item } : {}), status: 'seen' })
  await repo.patchMeta(m => ({ ...m, lastEncounterAt: now }))
  return pending
}

async function markCatalog(repo: Repo, entry: CatalogEntry): Promise<void> {
  const rank = { seen: 0, escaped: 1, contained: 2 } as const
  const all = await repo.catalog()
  const same = (e: CatalogEntry) => e.speciesId === entry.speciesId && e.tier === entry.tier && e.attachment === entry.attachment
  const found = all.find(same)
  if (found && rank[found.status] >= rank[entry.status]) return
  await repo.saveCatalog([...all.filter(e => !same(e)), entry])
}

export async function completeEpic(deps: GameDeps): Promise<Outcome> {
  const { repo, now } = deps
  const meta = await requireMeta(repo)
  const system = await activeSystem(repo, meta)
  if (!system) return { text: 'No active epic. Start one with /epic <KEY>.' }
  if (system.status === 'surveyed') return { text: `Epic ${system.epicKey} is already surveyed.` }
  // The survey's guaranteed encounter (SPEC 6.1) needs the encounter slot free; refusing keeps it from being lost.
  if (await repo.pending()) return { text: 'An encounter is already waiting. Resolve it with /contain, then complete the epic.' }
  await repo.saveSystem({ ...system, status: 'surveyed', surveyedAt: now })
  await repo.patchMeta(m => ({ ...m, activeEpicKey: null }))
  await createEncounter(deps, system, ENCOUNTER.surveyQuality, { excludeCommon: true })
  return { text: `Surveyed epic ${system.epicKey}. Encounter waiting.`, toast: `System surveyed: ${system.name}. Something rare stirs. /contain` }
}

export async function startMission(deps: GameDeps & { issueKey: string }): Promise<Outcome> {
  const { repo, now } = deps
  const key = deps.issueKey.toUpperCase()
  if (!ISSUE_KEY.test(key)) return { text: 'Usage: /mission <KEY>, for example /mission NOVA-12.' }
  const meta = await requireMeta(repo)
  const system = await activeSystem(repo, meta)
  if (!system) return { text: 'No active epic. Start one with /epic <KEY>.' }
  const active = await repo.activeMission()
  if (active) return { text: `Mission ${active.issueKey} is already active. Finish it with /mission complete.` }
  const mission: Mission = {
    issueKey: key, systemId: system.id, startedAt: now, commits: 0, testRuns: 0, testsGreen: false, tacticalClean: false,
  }
  await repo.saveActiveMission(mission)
  await repo.patchMeta(m => (m.firstTrackedAt === null ? { ...m, firstTrackedAt: now } : m))
  return { text: `Mission ${key} started.` }
}

export async function completeMission(deps: GameDeps): Promise<Outcome> {
  const { repo, now, rng } = deps
  const mission = await repo.activeMission()
  if (!mission) return { text: 'No active mission. Start one with /mission <KEY>.' }
  const meta = await requireMeta(repo)
  const done: Mission = { ...mission, completedAt: now }
  await repo.appendMission(done)
  await repo.clearActiveMission()

  const notes: string[] = []
  if (done.testsGreen) {
    const inv = await repo.inventory()
    await repo.saveInventory({ ...inv, reinforced: inv.reinforced + REWARDS.reinforcedForGreenTests })
    notes.push(`Reinforced Cells +${REWARDS.reinforcedForGreenTests}`)
  }

  const quality = missionQuality(done)
  const system = await repo.system(done.systemId)
  const day = deps.day ?? ''
  const today = meta.encountersToday.day === day ? meta.encountersToday.count : 0
  const ctx = {
    now, lastEncounterAt: meta.lastEncounterAt, firstTrackedAt: meta.firstTrackedAt ?? done.startedAt, completedMissions: meta.completedMissions,
  }
  await repo.patchMeta(m => ({ ...m, completedMissions: m.completedMissions + 1 }))

  const hasPending = (await repo.pending()) !== undefined
  const underCap = today < ENCOUNTER.dailySoftCap
  if (system && !hasPending && underCap && shouldEncounter(ctx, rng)) {
    const pending = await createEncounter(deps, system, quality)
    await repo.patchMeta(m => ({ ...m, encountersToday: { day, count: today + 1 } }))
    const species = system.species.find(s => s.id === pending.speciesId)!
    return {
      text: `Mission ${done.issueKey} complete.${notes.length ? ` ${notes.join(', ')}.` : ''} Encounter waiting.`,
      toast: `Encounter! ${species.name} (${pending.tier}) detected. /contain`,
    }
  }
  return { text: `Mission ${done.issueKey} complete.${notes.length ? ` ${notes.join(', ')}.` : ''}` }
}

/**
 * The branch changed (SPEC 4.1): a branch whose key belongs to the active
 * epic's project starts that mission, unless one is active or that key's
 * mission was already completed (so checkouts never pay out twice).
 */
export async function onBranch(deps: GameDeps & { branch: string }): Promise<Outcome | undefined> {
  const key = issueKeyFromBranch(deps.branch)
  if (!key || !ISSUE_KEY.test(key) || (await deps.repo.activeMission())) return undefined
  const meta = await requireMeta(deps.repo)
  if (!meta.activeEpicKey || projectOf(meta.activeEpicKey) !== projectOf(key)) return undefined
  if (!(await activeSystem(deps.repo, meta))) return undefined
  if ((await deps.repo.missionLog()).some(m => m.issueKey === key)) return undefined
  return startMission({ ...deps, issueKey: key })
}

/**
 * Records Bash activity on the active mission. `isError` is the tool result's
 * error flag; a test run whose exit status the result cannot show (piped,
 * `|| true`, backgrounded) can turn testsGreen off but never on.
 */
export async function recordBash(deps: GameDeps & { signals: BashSignals; commits: number; isError: boolean }): Promise<void> {
  const mission = await deps.repo.activeMission()
  const { signals } = deps
  if (!mission || (deps.commits === 0 && !signals.isTestRun)) return
  const passed = signals.isTestRun && !deps.isError && signals.isTestStatusReliable
  await deps.repo.saveActiveMission({
    ...mission,
    commits: mission.commits + deps.commits,
    testRuns: mission.testRuns + (signals.isTestRun ? 1 : 0),
    testsGreen: signals.isTestRun ? passed : mission.testsGreen,
  })
}

export async function forceEncounter(deps: GameDeps): Promise<Outcome> {
  const meta = await requireMeta(deps.repo)
  const system = await activeSystem(deps.repo, meta)
  if (!system) return { text: 'No active epic. Start one with /epic <KEY>.' }
  if (await deps.repo.pending()) return { text: 'An encounter is already waiting: /contain.' }
  const pending = await createEncounter(deps, system, 0)
  const species = system.species.find(s => s.id === pending.speciesId)
  return { text: 'Forced an encounter (developer mode).', toast: `Encounter! ${species?.name ?? 'Something'} (${pending.tier}) detected. /contain` }
}

export type ContainResult = { outcome: AttemptOutcome; text: string; toast: string }

/** Resolves one containment attempt for the pending encounter (SPEC 7.1 steps 5 and 6). */
export async function attemptContainment(deps: GameDeps & { cell: Cell; latticeBonus: number }): Promise<ContainResult | Outcome> {
  const { repo, now, rng } = deps
  const pending = await repo.pending()
  if (!pending) return { text: 'Nothing to contain right now.' }
  const inv = await repo.inventory()
  const cell: Cell = deps.cell !== 'standard' && inv[deps.cell] <= 0 ? 'standard' : deps.cell
  if (cell !== 'standard') await repo.saveInventory({ ...inv, [cell]: inv[cell] - 1 })

  const system = await repo.system(pending.systemId)
  const species = system?.species.find(s => s.id === pending.speciesId)
  const name = species?.name ?? 'The specimen'
  const outcome = resolveAttempt({ tier: pending.tier, cell, latticeBonus: deps.latticeBonus, quality: pending.quality }, rng)

  if (outcome === 'contained') {
    const id = `spec-${now}-${rng.int(1_000_000)}`
    await repo.addSpecimen({
      id, speciesId: pending.speciesId, systemId: pending.systemId, tier: pending.tier,
      ...(pending.attachment ? { attachment: pending.attachment } : {}),
      level: 1, xp: 0, stage: 0, containedAt: now,
    })
    await markCatalog(repo, { speciesId: pending.speciesId, tier: pending.tier, ...(pending.attachment ? { attachment: pending.attachment.item } : {}), status: 'contained' })
    await repo.clearPending()
    await repo.patchMeta(m => (m.companionId === null ? { ...m, companionId: id } : m))
    return { outcome, text: `Contained (${CELLS[cell].label} Cell).`, toast: `${name} contained!` }
  }
  if (outcome === 'fled') {
    await markCatalog(repo, { speciesId: pending.speciesId, tier: pending.tier, ...(pending.attachment ? { attachment: pending.attachment.item } : {}), status: 'escaped' })
    await repo.clearPending()
    return { outcome, text: 'The specimen fled.', toast: `${name} escaped into the dark.` }
  }
  await repo.savePending({ ...pending, attempts: pending.attempts + 1 })
  return { outcome, text: 'It broke free. Try again with /contain.', toast: `${name} broke free! Try another cell.` }
}

export async function setCompanion(deps: GameDeps & { specimenId: string }): Promise<Outcome> {
  const specimens = await deps.repo.specimens()
  const found = specimens.find(s => s.id === deps.specimenId || s.id.endsWith(deps.specimenId))
  if (!found) return { text: 'No such specimen. /bay lists them.' }
  await deps.repo.patchMeta(m => ({ ...m, companionId: found.id }))
  return { text: 'Companion set.' }
}
