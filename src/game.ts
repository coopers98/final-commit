import type { CellCounts, ReportView } from '../types'
import { unresolvedSignals } from './bridge/scan'
import { CELLS, CRAFT, ENCOUNTER, REWARDS, SINGULARITY_ACTIVATION, TIER_SPECS, type Cell, type Tier } from './config'
import { resolveAttempt, type AttemptOutcome } from './contain/resolve'
import { puzzleBonus } from './puzzle/puzzle'
import { lintVerdict, testRunPassed, type BashSignals } from './detect/git'
import { issueKeyFromBranch } from './detect/git'
import { rollAttachment } from './encounter/attachments'
import { missionQuality } from './encounter/quality'
import { rollTier } from './encounter/rarity'
import { shouldEncounter } from './encounter/roll'
import type { PrivacyMode } from './puzzle/privacy-filter'
import type { Rng } from './rng'
import type { Repo } from './store/repo'
import type { CatalogEntry, Inventory, Mission, MissionReward, PendingEncounter, SaveMeta, Species, StarSystem } from './store/schema'
import { addFlora, CELL_FLORA_TIERS, floraTiers, harvest, harvestCount, heldOfTier, spendFlora } from './world/flora'
import { type Complete, type EpicInput, generateSystem } from './world/generate'


// Game actions over the save. Pure apart from the Repo they are handed: the
// glue supplies the clock value, a seeded Rng and the model call.
//
// `text` is what a slash command prints. The model reads it, so it stays a
// short factual line (CLAUDE.md rule 1). Flavor goes in `toast`.

/**
 * `report` is the pane a finished mission or survey shows until dismissed
 * (game flavor is fine there: panes never reach the model).
 */
export type Outcome = { text: string; toast?: string; report?: ReportView }

function encounterHeading(species: Species | undefined, pending: PendingEncounter): { heading: string; sprite: string[]; tier: Tier } {
  const spec = TIER_SPECS[pending.tier]
  return {
    heading: `${spec.glyph} ${species?.name ?? 'Something'} (${spec.label})${pending.attachment ? ` +${pending.attachment.item}` : ''}`,
    sprite: species?.stages[0]?.rows ?? [],
    tier: pending.tier,
  }
}
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

async function allSystems(repo: Repo): Promise<StarSystem[]> {
  const systems: StarSystem[] = []
  for (const id of await repo.systemIds()) {
    const s = await repo.system(id)
    if (s) systems.push(s)
  }
  return systems
}

/** Special cells usable now: a Singularity Cell only with a Legendary flora sample to activate it (SPEC 7.2). */
export function usableCells(inv: Inventory, systems: readonly StarSystem[]): CellCounts {
  const legendary = heldOfTier(inv.flora, floraTiers(systems), SINGULARITY_ACTIVATION.tier)
  return {
    reinforced: inv.reinforced,
    stasis: inv.stasis,
    singularity: Math.min(inv.singularity, Math.floor(legendary / SINGULARITY_ACTIVATION.samples)),
  }
}

export async function cellsOf(repo: Repo): Promise<CellCounts> {
  return usableCells(await repo.inventory(), await allSystems(repo))
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

/** A charted system's key: an issue key, or a key a work source gives an epic that is not an issue (`NOVA-M3`, `NOVA-BACKLOG`, SPEC 4.4 rule 6). */
const SYSTEM_KEY = /^[A-Z][A-Z0-9]{1,9}-(?:[1-9]\d*|M[1-9]\d*|BACKLOG)$/

/** `/scan <KEY>`: any key a system can be charted under. */
export function parseSystemKey(args: string): string | undefined {
  const key = args.trim().toUpperCase()
  return SYSTEM_KEY.test(key) ? key : undefined
}

/**
 * `activate: false` charts without making the epic active: a chart the tracker
 * started must not move play away from a running mission (its issue's start
 * activates it, SPEC 4.2).
 */
export async function startEpic(
  deps: GameDeps & { epic: EpicInput; complete: Complete; privacy: PrivacyMode; activate?: boolean },
): Promise<Outcome> {
  const { repo, now, rng, epic } = deps
  await requireMeta(repo)
  const existing = await findSystemByEpic(repo, epic.key)
  const activate = deps.activate ?? true
  if (existing) {
    if (!activate) return { text: `Epic ${epic.key} is already charted.` }
    await repo.patchMeta(m => ({ ...m, activeEpicKey: epic.key }))
    return { text: `Epic ${epic.key} is already charted; it is now the active epic.` }
  }
  // Unique without counting: two charts in flight must never share an id.
  const systemId = `sys-${now.toString(36)}-${rng.int(1_000_000).toString(36)}`
  const { system, notes } = await generateSystem({ epic, systemId, privacy: deps.privacy, complete: deps.complete, rng, now })
  await repo.saveSystem(system)
  // Re-read meta: generation can take minutes and other actions may have saved since.
  if (activate) await repo.patchMeta(m => ({ ...m, activeEpicKey: epic.key }))
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
  opts: { excludeCommon?: boolean; missionKey?: string } = {},
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
    ...(opts.missionKey ? { missionKey: opts.missionKey } : {}),
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

/**
 * SPEC 9.4: the sensors resolve hidden signals of `system` into silhouettes,
 * lowest tier first. Returns the species resolved.
 */
async function resolveSignals(repo: Repo, system: StarSystem, count: number): Promise<Species[]> {
  const resolved = await repo.resolved()
  const picked = unresolvedSignals(system, await repo.catalog(), resolved).slice(0, count)
  if (picked.length > 0) await repo.saveResolved([...resolved, ...picked.map(s => s.id)])
  return picked
}

const signalLine = (picked: Species[]) =>
  picked.length === 1
    ? `Sensors resolved a ${TIER_SPECS[picked[0]!.tier].label} signal's shape. /scan`
    : `Sensors resolved ${picked.length} hidden signals' shapes. /scan`

/** Surveys the active epic, or `epicKey` when the tracker closed a particular one (SPEC 4.1). */
export async function completeEpic(deps: GameDeps & { epicKey?: string }): Promise<Outcome> {
  const { repo, now } = deps
  const meta = await requireMeta(repo)
  const system = deps.epicKey ? await findSystemByEpic(repo, deps.epicKey) : await activeSystem(repo, meta)
  if (!system) return { text: deps.epicKey ? `Epic ${deps.epicKey} is not charted.` : 'No active epic. Start one with /epic <KEY>.' }
  if (system.status === 'surveyed') return { text: `Epic ${system.epicKey} is already surveyed.` }
  // The survey's guaranteed encounter (SPEC 6.1) needs the encounter slot free; refusing keeps it from being lost.
  if (await repo.pending()) return { text: 'An encounter is already waiting. Resolve it with /contain, then complete the epic.' }
  await repo.saveSystem({ ...system, status: 'surveyed', surveyedAt: now })
  await repo.patchMeta(m => (m.activeEpicKey === system.epicKey ? { ...m, activeEpicKey: null } : m))
  const inv = await repo.inventory()
  await repo.saveInventory({ ...inv, singularity: inv.singularity + REWARDS.singularityForSurvey })
  const cells = await cellsOf(repo)
  // Usable counts only those with flora to activate them, so the held total says whether one waits for it.
  const singularityLine = `Singularity Cell +${REWARDS.singularityForSurvey}${cells.singularity < inv.singularity + REWARDS.singularityForSurvey ? ' (activates with a Legendary flora sample)' : ''}`
  const pending = await createEncounter(deps, system, ENCOUNTER.surveyQuality, { excludeCommon: true })
  const species = system.species.find(s => s.id === pending.speciesId)
  // The survey resolves every hidden signal left, after the encounter so its creature is not among them.
  const picked = await resolveSignals(repo, system, Number.MAX_SAFE_INTEGER)
  return {
    text: `Surveyed epic ${system.epicKey}. Singularity Cell +${REWARDS.singularityForSurvey}. Encounter waiting.`,
    toast: `System surveyed: ${system.name}. Something rare stirs. /contain`,
    report: {
      title: `System surveyed: ${system.name}`,
      lines: [`Epic ${system.epicKey} complete.`, singularityLine, ...(picked.length > 0 ? [signalLine(picked)] : []), 'Something rare stirs.'],
      encounter: encounterHeading(species, pending),
      cells,
    },
  }
}

/**
 * The epic a `/mission <KEY>` waits for while epics are being charted: the
 * latest one of the key's project, else the latest of all. The mission starts
 * on that epic (`startMission`'s `epicKey`) when it is charted, whether or not
 * the chart itself made it active (a source's chart does not).
 */
export function queueTarget(issueKey: string, charting: readonly { key: string; startedAt: number }[]): string | undefined {
  const latest = (list: readonly { key: string; startedAt: number }[]) =>
    list.reduce<{ key: string; startedAt: number } | undefined>((a, c) => (!a || c.startedAt >= a.startedAt ? c : a), undefined)?.key
  const key = issueKey.toUpperCase()
  return latest(charting.filter(c => projectOf(c.key) === projectOf(key))) ?? latest(charting)
}

/**
 * `startedAt`: when the work started, if earlier than now (a tracker start
 * seen at the next poll). `epicKey`: the epic the mission belongs to, made
 * active first when it is charted and no mission is running.
 */
export async function startMission(deps: GameDeps & { issueKey: string; startedAt?: number; epicKey?: string }): Promise<Outcome> {
  const { repo, now, epicKey } = deps
  const key = deps.issueKey.toUpperCase()
  if (!ISSUE_KEY.test(key)) return { text: 'Usage: /mission <KEY>, for example /mission NOVA-12.' }
  if (epicKey && !(await repo.activeMission()) && (await findSystemByEpic(repo, epicKey))) {
    await repo.patchMeta(m => ({ ...m, activeEpicKey: epicKey }))
  }
  const meta = await requireMeta(repo)
  const system = await activeSystem(repo, meta)
  if (!system) return { text: 'No active epic. Start one with /epic <KEY>.' }
  const active = await repo.activeMission()
  if (active) return { text: `Mission ${active.issueKey} is already active. Finish it with /mission complete.` }
  const mission: Mission = {
    issueKey: key, systemId: system.id, startedAt: Math.min(deps.startedAt ?? now, now), commits: 0, testRuns: 0, testsGreen: false, lint: null, tacticalClean: false,
  }
  await repo.saveActiveMission(mission)
  await repo.patchMeta(m => (m.firstTrackedAt === null ? { ...m, firstTrackedAt: mission.startedAt } : m))
  return { text: `Mission ${key} started.` }
}

/**
 * What the active mission leaves undone: tests not run or not green, lint not
 * run or failing. `/mission complete` asks before completing a mission with
 * any (a tracker's Done does not ask).
 */
export function openItems(m: Mission): string[] {
  const items: string[] = []
  if (m.testRuns === 0) items.push('No test run yet')
  else if (!m.testsGreen) items.push('Tests not green (the last run failed)')
  if (m.lint === null) items.push('No lint or type check yet')
  else if (m.lint === 'fail') items.push('Lint failing (the last run failed)')
  return items
}

/**
 * `attachedWork: false` (a tracker closure with no tracked work, SPEC 4.3)
 * completes the mission without rewards (no encounter, no cells), and
 * without using up the first mission's guaranteed encounter.
 */
export async function completeMission(deps: GameDeps & { attachedWork?: boolean }): Promise<Outcome> {
  const { repo, now, rng } = deps
  const attachedWork = deps.attachedWork ?? true
  const mission = await repo.activeMission()
  if (!mission) return { text: 'No active mission. Start one with /mission <KEY>.' }
  const meta = await requireMeta(repo)
  const system = await repo.system(mission.systemId)
  const quality = missionQuality(mission)
  const reinforced = mission.testsGreen && attachedWork ? REWARDS.reinforcedForGreenTests : 0
  const stasis = mission.tacticalClean && attachedWork ? REWARDS.stasisForCleanReview : 0
  // SPEC 6.4: flora never flee, so a mission with work always harvests.
  const flora = system && attachedWork ? harvest(system, harvestCount(quality), rng) : {}
  const reward: MissionReward = { counted: attachedWork, reinforced, stasis, flora }
  const done: Mission = { ...mission, completedAt: now, reward }
  await repo.appendMission(done)
  await repo.clearActiveMission()

  const notes: string[] = []
  const inv = await repo.inventory()
  await repo.saveInventory({ ...inv, reinforced: inv.reinforced + reinforced, stasis: inv.stasis + stasis, flora: addFlora(inv.flora, flora) })
  if (reinforced > 0) notes.push(`Reinforced Cells +${reinforced}`)
  if (stasis > 0) notes.push(`Stasis Cells +${stasis}`)
  const samples = Object.values(flora).reduce((a, b) => a + b, 0)
  // The command's text names no species (the model reads it); the report does.
  const said = [...notes, ...(samples > 0 ? [`Flora samples +${samples}`] : [])]
  // Harvested flora are met: /scan names them.
  for (const id of Object.keys(flora)) {
    const s = system?.species.find(sp => sp.id === id)
    if (s) await markCatalog(repo, { speciesId: s.id, tier: s.tier, status: 'seen' })
  }
  const harvested = Object.entries(flora).map(([id, n]) => {
    const s = system?.species.find(sp => sp.id === id)
    return `${n} ${s?.name ?? 'sample'}${s ? ` ${TIER_SPECS[s.tier].glyph}` : ''}`
  })

  const day = deps.day ?? ''
  const today = meta.encountersToday.day === day ? meta.encountersToday.count : 0
  const ctx = {
    now, lastEncounterAt: meta.lastEncounterAt, firstTrackedAt: meta.firstTrackedAt ?? done.startedAt, completedMissions: meta.completedMissions,
  }
  if (attachedWork) await repo.patchMeta(m => ({ ...m, completedMissions: m.completedMissions + 1 }))

  const hasPending = (await repo.pending()) !== undefined
  const underCap = today < ENCOUNTER.dailySoftCap
  const cells = await cellsOf(repo)
  const lines = [
    `Commits ${done.commits} · Test runs ${done.testRuns}${done.testRuns > 0 ? (done.testsGreen ? ' · green' : ' · not green') : ''}`,
    ...(done.tacticalClean ? ['Tactical review: all clear'] : []),
    ...notes,
    ...(harvested.length > 0 ? [`Harvested: ${harvested.join(', ')}`] : []),
  ]
  if (system && attachedWork && !hasPending && underCap && shouldEncounter(ctx, rng)) {
    const pending = await createEncounter(deps, system, quality, { missionKey: done.issueKey })
    await repo.patchMeta(m => ({ ...m, encountersToday: { day, count: today + 1 } }))
    const species = system.species.find(s => s.id === pending.speciesId)
    return {
      text: `Mission ${done.issueKey} complete.${said.length ? ` ${said.join(', ')}.` : ''} Encounter waiting.`,
      toast: `Encounter! ${species?.name ?? 'Something'} (${pending.tier}) detected. /contain`,
      report: { title: `Mission ${done.issueKey} complete`, lines: [...lines, 'Encounter!'], encounter: encounterHeading(species, pending), cells },
    }
  }
  // No encounter, but the mission still teaches something about the system.
  const picked = system && attachedWork ? await resolveSignals(repo, system, 1) : []
  const why = !attachedWork
    ? 'No encounter: no work was tracked on it.'
    : hasPending ? 'An encounter is already waiting: /contain.' : !underCap ? 'No more encounters today.' : 'No encounter this time.'
  return {
    text: `Mission ${done.issueKey} complete.${said.length ? ` ${said.join(', ')}.` : ''}`,
    report: { title: `Mission ${done.issueKey} complete`, lines: [...lines, why, ...(picked.length > 0 ? [signalLine(picked)] : [])], encounter: null },
  }
}

/**
 * `/mission reopen <KEY>` (SPEC 4.5): undoes the latest completion of KEY,
 * for one completed by mistake. Its log entry goes, so it can be started
 * again; what the completion recorded giving is taken back (the completed
 * count, and Reinforced Cells as far as they are still held). The count never
 * returns to zero once an encounter has happened, so the first mission's
 * guaranteed encounter cannot be had twice. An encounter it led to and scan
 * signals it resolved stay. It does not start the mission.
 */
export async function reopenMission(deps: GameDeps & { issueKey: string }): Promise<Outcome> {
  const { repo } = deps
  const key = deps.issueKey.trim().toUpperCase()
  if (!ISSUE_KEY.test(key)) return { text: 'Usage: /mission reopen <KEY>, for example /mission reopen NOVA-12.' }
  await requireMeta(repo)
  if ((await repo.activeMission())?.issueKey === key) return { text: `Mission ${key} is active, not completed.` }
  const log = await repo.missionLog()
  const at = log.map(m => m.issueKey).lastIndexOf(key)
  const entry = log[at]
  if (!entry) return { text: `Mission ${key} is not in the log of completed missions.` }
  await repo.saveMissionLog(log.filter((_, i) => i !== at))
  const reward = entry.reward ?? { counted: true, reinforced: 0, stasis: 0, flora: {} }
  // Never back to zero once an encounter has happened: zero completed missions guarantees one (SPEC 6.1), already spent.
  let isUncounted = false
  if (reward.counted) {
    await repo.patchMeta(m => {
      const count = Math.max(m.lastEncounterAt === null ? 0 : 1, m.completedMissions - 1)
      isUncounted = count < m.completedMissions
      return { ...m, completedMissions: count }
    })
  }
  const inv = await repo.inventory()
  const taken = Math.min(reward.reinforced, inv.reinforced)
  const takenStasis = Math.min(reward.stasis, inv.stasis)
  const flora = addFlora(inv.flora, reward.flora, -1)
  const count = (f: Record<string, number>) => Object.values(f).reduce((a, b) => a + b, 0)
  const harvested = count(reward.flora)
  const takenFlora = count(inv.flora) - count(flora)
  await repo.saveInventory({ ...inv, reinforced: inv.reinforced - taken, stasis: inv.stasis - takenStasis, flora })
  const kept = (gave: number, took: number, what: string) => (gave > took ? [`${gave - took} ${what} already spent, kept`] : [])
  const parts = [
    ...(isUncounted ? ['1 fewer completed mission'] : []),
    ...(taken > 0 ? [`Reinforced Cells -${taken}`] : []),
    ...kept(reward.reinforced, taken, 'Reinforced Cell'),
    ...(takenStasis > 0 ? [`Stasis Cells -${takenStasis}`] : []),
    ...kept(reward.stasis, takenStasis, 'Stasis Cell'),
    ...(takenFlora > 0 ? [`Flora samples -${takenFlora}`] : []),
    ...kept(harvested, takenFlora, 'flora sample'),
  ]
  return { text: `Mission ${key} reopened: removed from the log${parts.length > 0 ? `; ${parts.join(', ')}` : ''}. Encounters and scan signals it gave stay. Start it again with /mission ${key}.` }
}

/**
 * The tracker closed an issue that was never the active mission (SPEC 4.3:
 * an administrative closure). Logged so a later checkout of its branch
 * cannot start it; no rewards.
 */
export async function recordClosure(deps: GameDeps & { issueKey: string; systemId: string }): Promise<void> {
  if ((await deps.repo.missionLog()).some(m => m.issueKey === deps.issueKey)) return
  await deps.repo.appendMission({
    issueKey: deps.issueKey, systemId: deps.systemId, startedAt: deps.now, completedAt: deps.now,
    commits: 0, testRuns: 0, testsGreen: false, lint: null, tacticalClean: false, reward: { counted: false, reinforced: 0, stasis: 0, flora: {} },
  })
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
 * error flag. A plain test run is judged by its exit status. One whose exit
 * status may not be the runner's (piped, `|| true`, backgrounded) is judged
 * by the runner's summary in `output`; with no summary visible it counts as
 * not passing, so it can turn testsGreen off but never on. A lint or type
 * check whose exit status is its own sets the mission's lint verdict.
 */
export async function recordBash(
  deps: GameDeps & { signals: BashSignals; commits: number; isError: boolean; output?: string },
): Promise<void> {
  const mission = await deps.repo.activeMission()
  const { signals } = deps
  const lint = lintVerdict(signals, deps.isError)
  if (!mission || (deps.commits === 0 && !signals.isTestRun && lint === undefined)) return
  const passed = testRunPassed(signals, deps.isError, deps.output ?? '')
  await deps.repo.saveActiveMission({
    ...mission,
    commits: mission.commits + deps.commits,
    testRuns: mission.testRuns + (signals.isTestRun ? 1 : 0),
    testsGreen: signals.isTestRun ? passed : mission.testsGreen,
    lint: lint ?? mission.lint,
    // A commit after a Tactical review is code nobody reviewed.
    tacticalClean: deps.commits > 0 ? false : mission.tacticalClean,
  })
}

/**
 * A Tactical review finished during the mission (SPEC 9.1). A clean verdict
 * counts toward quality only once the mission has a commit to review; any
 * later commit clears it again (recordBash).
 */
export async function recordTactical(deps: { repo: Repo; verdict: 'clean' | 'issues' }): Promise<{ counted: boolean }> {
  const mission = await deps.repo.activeMission()
  if (!mission) return { counted: false }
  const clean = deps.verdict === 'clean' && mission.commits > 0
  await deps.repo.saveActiveMission({ ...mission, tacticalClean: clean })
  return { counted: clean }
}

/**
 * An Engineering lint run's verdict (its `LINT:` line, SPEC 9.1) is the
 * active mission's lint verdict, as a lint command's exit status is.
 */
export async function recordLint(deps: { repo: Repo; verdict: 'pass' | 'fail' }): Promise<void> {
  const mission = await deps.repo.activeMission()
  if (mission) await deps.repo.saveActiveMission({ ...mission, lint: deps.verdict })
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
  const systems = await allSystems(repo)
  const cell: Cell = deps.cell !== 'standard' && usableCells(inv, systems)[deps.cell] <= 0 ? 'standard' : deps.cell
  if (cell === 'singularity') {
    // usableCells guarantees the flora is held.
    const flora = spendFlora(inv.flora, floraTiers(systems), SINGULARITY_ACTIVATION.tier, SINGULARITY_ACTIVATION.samples) ?? inv.flora
    await repo.saveInventory({ ...inv, singularity: inv.singularity - 1, flora })
  } else if (cell !== 'standard') await repo.saveInventory({ ...inv, [cell]: inv[cell] - 1 })

  const system = await repo.system(pending.systemId)
  const species = system?.species.find(s => s.id === pending.speciesId)
  const name = species?.name ?? 'The specimen'
  const outcome = resolveAttempt({ tier: pending.tier, cell, latticeBonus: deps.latticeBonus, quality: pending.quality, puzzleBonus: pending.analysis?.bonus ?? 0 }, rng)

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

/** The key that picks each special cell on the report pane, and as `/contain`'s argument. */
export const CELL_KEYS: Record<keyof CellCounts, string> = { reinforced: 'r', stasis: 's', singularity: 'x' }

/** `/contain` arguments: nothing for a Standard Cell, else a cell by name or its key; undefined when not a cell. */
export function parseCell(args: string): Cell | undefined {
  const a = args.trim().toLowerCase()
  if (a === '' || a === 'standard') return 'standard'
  return (Object.keys(CELL_KEYS) as (keyof CellCounts)[]).find(c => a === c || a === CELL_KEYS[c])
}

export type CraftableCell = keyof typeof CRAFT

/** `/craft` arguments: a craftable cell by name or its first letter. */
export function parseCraftCell(args: string): CraftableCell | undefined {
  const a = args.trim().toLowerCase()
  return (Object.keys(CRAFT) as CraftableCell[]).find(c => a === c || (a.length === 1 && c.startsWith(a)))
}

const recipeText = (c: CraftableCell) => `${CELLS[c].label}: ${CRAFT[c].samples} ${TIER_SPECS[CRAFT[c].tier].label}`

/** SPEC 7.2: `/craft <cell>` spends flora on a cell; with no cell, says what each costs and what is held. */
export async function craftCell(deps: GameDeps & { cell?: CraftableCell }): Promise<Outcome> {
  const { repo } = deps
  await requireMeta(repo)
  const inv = await repo.inventory()
  const tiers = floraTiers(await allSystems(repo))
  const held = (t: Tier) => `${heldOfTier(inv.flora, tiers, t)} ${TIER_SPECS[t].label}`
  const recipes = (Object.keys(CRAFT) as CraftableCell[]).map(recipeText).join(', ')
  const holding = `Flora held: ${CELL_FLORA_TIERS.map(held).join(', ')}.`
  if (!deps.cell) return { text: `Recipes (flora samples): ${recipes}. ${holding} Usage: /craft ${Object.keys(CRAFT).join('|')}.` }
  const recipe = CRAFT[deps.cell]
  const flora = spendFlora(inv.flora, tiers, recipe.tier, recipe.samples)
  if (!flora) return { text: `A ${CELLS[deps.cell].label} Cell needs ${recipe.samples} ${TIER_SPECS[recipe.tier].label} flora samples. ${holding}` }
  await repo.saveInventory({ ...inv, flora, [deps.cell]: inv[deps.cell] + 1 })
  return { text: `Crafted a ${CELLS[deps.cell].label} Cell (${inv[deps.cell] + 1} held).` }
}

/**
 * SPEC 8: the answer to the waiting encounter's puzzle (`choice` an index,
 * or undefined to skip it). Kept with the encounter, so its bonus counts for
 * every attempt; an answer is recorded once, in the accuracy record too.
 */
export async function answerPuzzle(deps: GameDeps & { choice: number | undefined; elapsedMs: number }): Promise<PendingEncounter['analysis']> {
  const { repo, now } = deps
  const pending = await repo.pending()
  const puzzle = pending?.puzzle
  if (!pending || !puzzle) return undefined
  if (pending.analysis) return pending.analysis
  const isSkipped = deps.choice === undefined
  const isCorrect = deps.choice === puzzle.answer
  const analysis = { isSkipped, isCorrect, bonus: puzzleBonus(pending.tier, isCorrect, deps.elapsedMs) }
  await repo.savePending({ ...pending, analysis })
  if (!isSkipped) {
    const stats = await repo.puzzleStats()
    const was = stats.find(s => s.category === puzzle.category && s.type === puzzle.type)
    const next = { category: puzzle.category, type: puzzle.type, attempts: (was?.attempts ?? 0) + 1, correct: (was?.correct ?? 0) + (isCorrect ? 1 : 0), lastSeen: now }
    await repo.savePuzzleStats([...stats.filter(s => s !== was), next])
  }
  return analysis
}

export async function setCompanion(deps: GameDeps & { specimenId: string }): Promise<Outcome> {
  const specimens = await deps.repo.specimens()
  const found = specimens.find(s => s.id === deps.specimenId || s.id.endsWith(deps.specimenId))
  if (!found) return { text: 'No such specimen. /bay lists them.' }
  await deps.repo.patchMeta(m => ({ ...m, companionId: found.id }))
  return { text: 'Companion set.' }
}
