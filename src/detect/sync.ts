import { ANTI_FARMING, SYNC } from '../config'
import { completeEpic, completeMission, recordClosure, startMission, type GameDeps, type Outcome } from '../game'
import type { Repo } from '../store/repo'
import type { Mission, StarSystem } from '../store/schema'
import { transitionKey, type WorkItem, type WorkSource, type WorkTransition } from './work-source'

// SPEC 4.1 and 4.2: tracker status changes in, game actions out. Pure apart
// from the Repo, the source and the `chart` callback it is handed.

export type SyncDeps = GameDeps & {
  source: WorkSource
  /**
   * Starts charting an epic in the background; the glue's own charting. It
   * must not make the epic active (`startEpic` with `activate: false`): an
   * issue's start does that, and a running mission keeps its epic.
   */
  chart: (epic: WorkItem) => void
  /** Epics being charted right now. */
  charting: ReadonlySet<string>
}

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

type Applied = { status: 'applied'; outcome?: Outcome } | { status: 'deferred' }
const APPLIED: Applied = { status: 'applied' }
const DEFERRED: Applied = { status: 'deferred' }

async function applyEpic(deps: SyncDeps, t: WorkTransition, charting: Set<string>): Promise<Applied> {
  const { repo } = deps
  const key = t.item.key
  if (t.to === 'in_progress') {
    if (!charting.has(key) && !(await systemFor(repo, key))) {
      charting.add(key)
      deps.chart(t.item)
    }
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

async function applyIssue(deps: SyncDeps, t: WorkTransition, charting: Set<string>): Promise<Applied> {
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
    if (!charting.has(epic.key)) {
      charting.add(epic.key)
      deps.chart(epic)
    }
    return DEFERRED
  }
  // One mission at a time: a second issue in progress is not tracked.
  if (active || (await repo.missionLog()).some(m => m.issueKey === key)) return APPLIED
  await repo.patchMeta(m => ({ ...m, activeEpicKey: epic.key }))
  const out = await startMission({ ...deps, issueKey: key, startedAt: t.at })
  return { status: 'applied', outcome: { ...out, toast: out.toast ?? out.text } }
}

/**
 * One sync (SPEC 4.2): the catch-up at session start and each poll. Applies
 * every transition not yet processed, oldest first, and records each one so
 * a reload or restart never applies it twice. A transition that must wait
 * (its epic still charting, an encounter in the survey's way) holds back the
 * later ones for the same epic and keeps `lastSync` from moving past it.
 */
export async function syncWork(deps: SyncDeps): Promise<SyncResult> {
  const { repo, now } = deps
  const name = deps.source.name
  const state = await repo.sync(name)
  if (state.lastSync === null) {
    await repo.saveSync(name, { lastSync: now, processed: [] })
    return { outcomes: [], applied: 0, deferred: 0 }
  }
  let found: WorkTransition[]
  try {
    found = await deps.source.changedSince(state.lastSync - SYNC.overlapMs)
  } catch (err) {
    return { outcomes: [], applied: 0, deferred: 0, error: err instanceof Error ? err.message : String(err) }
  }

  const seen = new Set(state.processed)
  // At one instant, a start goes before a Done: otherwise the issue would read as closed unworked.
  const rank = { todo: 0, in_progress: 1, done: 2 } as const
  const todo = found.filter(t => !seen.has(transitionKey(t))).sort((a, b) => a.at - b.at || rank[a.to] - rank[b.to])
  const charting = new Set(deps.charting)
  const blocked = new Set<string>()
  const outcomes: Outcome[] = []
  const applied: string[] = []
  let deferredAt: number | undefined
  let deferred = 0

  for (const t of todo) {
    // A source may report one change twice in a batch.
    if (seen.has(transitionKey(t))) continue
    const epicKey = t.item.kind === 'epic' ? t.item.key : t.epic?.key
    const result = epicKey !== undefined && blocked.has(epicKey)
      ? DEFERRED
      : t.item.kind === 'epic' ? await applyEpic(deps, t, charting) : await applyIssue(deps, t, charting)
    if (result.status === 'deferred') {
      deferred += 1
      deferredAt = Math.min(deferredAt ?? t.at, t.at)
      if (epicKey !== undefined) blocked.add(epicKey)
      continue
    }
    const key = transitionKey(t)
    applied.push(key)
    seen.add(key)
    if (result.outcome) outcomes.push(result.outcome)
  }

  await repo.saveSync(name, {
    lastSync: deferredAt === undefined ? now : Math.min(deferredAt, now),
    processed: [...state.processed, ...applied].slice(-SYNC.maxProcessed),
  })
  return { outcomes, applied: applied.length, deferred }
}
