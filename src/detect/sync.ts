import { ANTI_FARMING, SYNC } from '../config'
import { completeEpic, completeMission, recordClosure, startMission, type GameDeps, type Outcome } from '../game'
import type { Repo } from '../store/repo'
import type { Mission, StarSystem, SyncState } from '../store/schema'
import { transitionKey, type WorkItem, type WorkSource, type WorkTransition } from './work-source'

// SPEC 4.1 and 4.2: tracker status changes in, game actions out. Pure apart
// from the Repo, the source and the `chart` callback it is handed.

export type SyncDeps = GameDeps & {
  source: WorkSource
  /**
   * Starts charting an epic in the background; the glue's own charting. It
   * must not make the epic active (`startEpic` with `activate: false`): an
   * issue's start does that, and a running mission keeps its epic. Returns
   * whether a chart started: a chart sitting out its retry wait does not.
   */
  chart: (epic: WorkItem) => boolean
  /** Epics being charted right now. */
  charting: ReadonlySet<string>
}

/** What applying needs: everything but the source, which was read already. */
export type ApplyDeps = Omit<SyncDeps, 'source'>

export type SyncResult = { outcomes: Outcome[]; applied: number; deferred: number; error?: string }

/**
 * SPEC 4.3 rules 1 and 2: a mission the tracker closed rolls an encounter
 * only with work attached. A commit is work and a non-empty diff; test runs
 * alone count once the mission ran the minimum duration.
 */
export function hasAttachedWork(mission: Mission, doneAt: number): boolean {
  if (mission.commits > 0) return true
  return mission.testRuns > 0 && doneAt - mission.startedAt >= ANTI_FARMING.minMissionMs
}

async function systemFor(repo: Repo, epicKey: string): Promise<StarSystem | undefined> {
  for (const id of await repo.systemIds()) {
    const s = await repo.system(id)
    if (s?.epicKey === epicKey) return s
  }
  return undefined
}

/** `isCharting`: it waits for a chart that is running, so later starts wait behind it (SPEC 4.2 rule 5). */
type Applied = { status: 'applied'; outcome?: Outcome } | { status: 'deferred'; isCharting?: boolean }
const APPLIED: Applied = { status: 'applied' }
const DEFERRED: Applied = { status: 'deferred' }

/** Charts `epic` unless it is charting already; true when it is charting after. */
function chartOnce(deps: ApplyDeps, epic: WorkItem, charting: Set<string>): boolean {
  if (charting.has(epic.key)) return true
  if (!deps.chart(epic)) return false
  charting.add(epic.key)
  return true
}

async function applyEpic(deps: ApplyDeps, t: WorkTransition, charting: Set<string>): Promise<Applied> {
  const { repo } = deps
  const key = t.item.key
  if (t.to === 'in_progress') {
    if (!(await systemFor(repo, key))) chartOnce(deps, t.item, charting)
    return APPLIED
  }
  if (t.to !== 'done') return APPLIED
  if (charting.has(key)) return DEFERRED
  const system = await systemFor(repo, key)
  if (!system || system.status === 'surveyed') return APPLIED
  // The survey's guaranteed encounter needs the slot free: wait for /contain rather than lose it.
  if (await repo.pending()) return DEFERRED
  return { status: 'applied', outcome: await completeEpic({ ...deps, epicKey: key }) }
}

async function applyIssue(deps: ApplyDeps, t: WorkTransition, charting: Set<string>): Promise<Applied> {
  const { repo } = deps
  const key = t.item.key
  const active = await repo.activeMission()
  if (t.to === 'done') {
    if (active?.issueKey === key) {
      return { status: 'applied', outcome: await completeMission({ ...deps, attachedWork: hasAttachedWork(active, t.at) }) }
    }
    // Its epic still charting: wait, or the closure would find no system and be lost.
    if (t.epic && charting.has(t.epic.key)) return DEFERRED
    const system = t.epic ? await systemFor(repo, t.epic.key) : undefined
    if (system) await recordClosure({ ...deps, issueKey: key, systemId: system.id })
    return APPLIED
  }
  // An issue outside any epic has no star system to belong to.
  if (t.to !== 'in_progress' || !t.epic) return APPLIED
  const epic = t.epic
  const system = await systemFor(repo, epic.key)
  if (!system) {
    // SPEC 4.1: a child issue starting charts its epic; the mission waits for the chart.
    return { status: 'deferred', isCharting: chartOnce(deps, epic, charting) }
  }
  // One mission at a time: a second issue in progress is not tracked.
  if (active || (await repo.missionLog()).some(m => m.issueKey === key)) return APPLIED
  await repo.patchMeta(m => ({ ...m, activeEpicKey: epic.key }))
  const out = await startMission({ ...deps, issueKey: key, startedAt: t.at })
  return { status: 'applied', outcome: { ...out, toast: out.toast ?? out.text } }
}

/** One source's read, ready to apply: its record and the changes found. */
export type SourceRead =
  | { kind: 'read'; name: string; state: SyncState; found: WorkTransition[] }
  /** The source's first sync: it took its baseline and recorded its start, so it has nothing to apply. */
  | { kind: 'first' }
  | { kind: 'error'; error: string }

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * Reads one source (SPEC 4.2): its record, then the changes since its
 * `lastSync`, reaching back by the overlap. A first sync only takes the
 * baseline and records where it starts: nothing earlier is awarded.
 */
export async function readSource(deps: Pick<GameDeps, 'repo' | 'now'>, source: WorkSource): Promise<SourceRead> {
  const { repo, now } = deps
  let name: string
  try {
    name = source.record ? await source.record() : source.name
  } catch (err) {
    return { kind: 'error', error: message(err) }
  }
  const state = await repo.sync(name)
  if (state.lastSync === null) {
    try {
      await source.start?.()
    } catch (err) {
      return { kind: 'error', error: message(err) }
    }
    await repo.saveSync(name, { lastSync: now, processed: [], waiting: [] })
    return { kind: 'first' }
  }
  try {
    return { kind: 'read', name, state, found: await source.changedSince(state.lastSync - SYNC.overlapMs) }
  } catch (err) {
    return { kind: 'error', error: message(err) }
  }
}

/** `errors`: per read, why applying one of its changes threw (that change and its later ones wait), else undefined. */
export type ApplyResult = { outcomes: Outcome[]; applied: number; deferred: number; errors: (string | undefined)[] }

/**
 * Applies the changes of every source read in this sync as one list (SPEC
 * 4.2 rule 5, 4.4), oldest first, so one source's later change never takes
 * what another's earlier one needed (an epic survey taking the encounter
 * slot a mission's roll needed). Each read's waiting changes are tried again
 * with it. Each record then saves what it applied and what still waits, and
 * `lastSync` moves to now: a change that waits is kept in the record, never
 * by holding `lastSync` back.
 *
 * A change that waits holds back later ones for the same epic, so an issue's
 * Done is never read before its start. An issue's start waiting on a chart
 * that is running holds back later starts in every epic, so the first issue
 * started becomes the mission.
 *
 * A change that throws while applying waits, with the later changes of its
 * source, and that source reports the error; every record is still saved,
 * so a change already applied is never applied again.
 */
export async function applyReads(deps: ApplyDeps, reads: readonly Extract<SourceRead, { kind: 'read' }>[]): Promise<ApplyResult> {
  const { repo, now } = deps
  // At one instant, a start goes before a Done: otherwise the issue would read as closed unworked.
  const rank = { todo: 0, in_progress: 1, done: 2 } as const
  const seen = reads.map(r => new Set(r.state.processed))
  const todo = reads
    .flatMap((r, i) => {
      // A source may report one change twice, or again while it waits.
      const fresh = new Map<string, WorkTransition>()
      for (const t of [...r.state.waiting, ...r.found]) if (!seen[i]!.has(transitionKey(t))) fresh.set(transitionKey(t), t)
      return [...fresh.values()].map(t => ({ t, i }))
    })
    .sort((a, b) => a.t.at - b.t.at || rank[a.t.to] - rank[b.t.to])
  const charting = new Set(deps.charting)
  const blocked = new Set<string>()
  let isStartHeld = false
  const outcomes: Outcome[] = []
  const applied = reads.map((): string[] => [])
  const waiting = reads.map((): WorkTransition[] => [])
  const errors = reads.map((): string | undefined => undefined)

  for (const { t, i } of todo) {
    const epicKey = t.item.kind === 'epic' ? t.item.key : t.epic?.key
    const isStart = t.item.kind === 'issue' && t.to === 'in_progress'
    let result: Applied
    try {
      result =
        errors[i] !== undefined || (epicKey !== undefined && blocked.has(epicKey)) || (isStart && isStartHeld)
          ? DEFERRED
          : t.item.kind === 'epic' ? await applyEpic(deps, t, charting) : await applyIssue(deps, t, charting)
    } catch (err) {
      errors[i] = message(err)
      result = DEFERRED
    }
    if (result.status === 'deferred') {
      waiting[i]!.push(t)
      if (epicKey !== undefined) blocked.add(epicKey)
      if (isStart && result.isCharting) isStartHeld = true
      continue
    }
    applied[i]!.push(transitionKey(t))
    if (result.outcome) outcomes.push(result.outcome)
  }

  for (const [i, r] of reads.entries()) {
    await repo.saveSync(r.name, {
      lastSync: now,
      processed: [...r.state.processed, ...applied[i]!].slice(-SYNC.maxProcessed),
      waiting: waiting[i]!.slice(-SYNC.maxWaiting),
    })
  }
  return { outcomes, applied: applied.flat().length, deferred: waiting.flat().length, errors }
}

/** One sync of one source (SPEC 4.2): read it, then apply what it found. */
export async function syncWork(deps: SyncDeps): Promise<SyncResult> {
  const read = await readSource(deps, deps.source)
  if (read.kind === 'error') return { outcomes: [], applied: 0, deferred: 0, error: read.error }
  if (read.kind === 'first') return { outcomes: [], applied: 0, deferred: 0 }
  const { errors, ...r } = await applyReads(deps, [read])
  return errors[0] === undefined ? r : { ...r, error: errors[0] }
}
