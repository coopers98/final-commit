import { expect, test } from 'claude-code/testing'
import { ANTI_FARMING, SYNC } from '../src/config'
import { hasAttachedWork, syncWork, type SyncDeps } from '../src/detect/sync'
import type { WorkItem, WorkSource, WorkTransition } from '../src/detect/work-source'
import { recordBash, startEpic } from '../src/game'
import { classifyBash } from '../src/detect/git'
import { createRng } from '../src/rng'
import { migrate } from '../src/store/migrate'
import { createMemoryStore, createRepo, type Repo } from '../src/store/repo'
import type { Complete } from '../src/world/generate'

// Tracker sync against a scripted source. Everything here is invented (NOVA-).

const offline: Complete = async () => ({ ok: false, reason: 'offline' })
const MIN = 60_000

const EPIC: WorkItem = { key: 'NOVA-1', kind: 'epic', title: 'Billing export', description: 'Export invoices as files.' }
const OTHER_EPIC: WorkItem = { key: 'NOVA-50', kind: 'epic', title: 'Search', description: '' }
const issue = (n: number): WorkItem => ({ key: `NOVA-${n}`, kind: 'issue', title: `Task ${n}`, description: '' })

let ids = 0
function move(item: WorkItem, to: WorkTransition['to'], at: number, epic?: WorkItem): WorkTransition {
  ids += 1
  return { id: `t${ids}`, at, item, to, ...(epic ? { epic } : {}) }
}

/** A source that answers with whatever the test put in `log`, filtered by time, and records each query. */
function scripted(log: WorkTransition[]): WorkSource & { queries: number[] } {
  const queries: number[] = []
  return { name: 'scripted', queries, changedSince: async since => (queries.push(since), log.filter(t => t.at >= since)) }
}

type Harness = { repo: Repo; charted: string[]; charting: Set<string>; deps: (now: number, source: WorkSource) => SyncDeps }

async function harness(): Promise<Harness> {
  const store = createMemoryStore()
  await migrate(store, 0)
  const repo = createRepo(store)
  const charted: string[] = []
  const charting = new Set<string>()
  let n = 0
  return {
    repo, charted, charting,
    deps: (now, source) => ({
      repo, now, rng: createRng(7 + n++), day: '2026-01-01', source, charting,
      chart: epic => {
        charted.push(epic.key)
        charting.add(epic.key)
      },
    }),
  }
}

/** What the glue does when a chart finishes: it charts without activating (SyncDeps.chart). */
async function finishChart(h: Harness, epic: WorkItem, now: number) {
  await startEpic({ repo: h.repo, now, rng: createRng(1), epic, complete: offline, privacy: 'standard', activate: false })
  h.charting.delete(epic.key)
}

test('the first sync only records where it starts: nothing earlier is awarded', async () => {
  const h = await harness()
  const source = scripted([move(EPIC, 'in_progress', 10)])
  const r = await syncWork(h.deps(1_000 * MIN, source))
  expect(r.applied).toBe(0)
  expect(source.queries.length).toBe(0)
  expect((await h.repo.sync('scripted')).lastSync).toBe(1_000 * MIN)
  expect(h.charted).toEqual([])
})

test('an epic moving to In Progress is charted once, however often it is reported', async () => {
  const h = await harness()
  const log: WorkTransition[] = []
  const source = scripted(log)
  await syncWork(h.deps(0, source))
  log.push(move(EPIC, 'in_progress', 5 * MIN))
  await syncWork(h.deps(10 * MIN, source))
  // Still charting at the next poll, then charted: neither charts again.
  log.push(move(EPIC, 'in_progress', 11 * MIN))
  await syncWork(h.deps(12 * MIN, source))
  await finishChart(h, EPIC, 13 * MIN)
  log.push(move(EPIC, 'in_progress', 14 * MIN))
  await syncWork(h.deps(15 * MIN, source))
  expect(h.charted).toEqual(['NOVA-1'])
})

test('a child issue starting charts its epic, and the mission starts once the chart is done', async () => {
  const h = await harness()
  const log: WorkTransition[] = []
  const source = scripted(log)
  await syncWork(h.deps(0, source))
  log.push(move(issue(2), 'in_progress', 5 * MIN, EPIC))
  const first = await syncWork(h.deps(10 * MIN, source))
  expect(h.charted).toEqual(['NOVA-1'])
  expect(first.deferred).toBe(1)
  expect(await h.repo.activeMission()).toBe(undefined)
  // lastSync holds at the waiting transition so the next query still returns it.
  expect((await h.repo.sync('scripted')).lastSync).toBe(5 * MIN)

  await finishChart(h, EPIC, 11 * MIN)
  const second = await syncWork(h.deps(12 * MIN, source))
  expect(second.applied).toBe(1)
  expect((await h.repo.activeMission())?.issueKey).toBe('NOVA-2')
  expect(second.outcomes[0]?.toast).toBe('Mission NOVA-2 started.')
  expect((await h.repo.sync('scripted')).lastSync).toBe(12 * MIN)
})

test('a worked mission closed in the tracker completes with its encounter roll', async () => {
  const h = await harness()
  await finishChart(h, EPIC, 0)
  const log: WorkTransition[] = []
  const source = scripted(log)
  await syncWork(h.deps(0, source))
  log.push(move(issue(2), 'in_progress', 1 * MIN, EPIC))
  await syncWork(h.deps(2 * MIN, source))
  await recordBash({ repo: h.repo, now: 3 * MIN, rng: createRng(1), signals: classifyBash('git commit -m x'), commits: 1, isError: false })
  log.push(move(issue(2), 'done', 4 * MIN, EPIC))
  const r = await syncWork(h.deps(5 * MIN, source))
  expect(await h.repo.activeMission()).toBe(undefined)
  // The first completed mission is guaranteed an encounter (SPEC D10).
  expect(r.outcomes[0]?.text).toContain('Mission NOVA-2 complete')
  expect(await h.repo.pending()).not.toBe(undefined)
})

test('anti-farming: a tracker closure with no work attached rolls nothing and keeps the first-mission guarantee', async () => {
  const h = await harness()
  await finishChart(h, EPIC, 0)
  const log: WorkTransition[] = []
  const source = scripted(log)
  await syncWork(h.deps(0, source))
  log.push(move(issue(2), 'in_progress', 1 * MIN, EPIC), move(issue(2), 'done', 2 * MIN, EPIC))
  const r = await syncWork(h.deps(3 * MIN, source))
  expect(r.outcomes.map(o => o.text)).toEqual(['Mission NOVA-2 started.', 'Mission NOVA-2 complete.'])
  expect(r.outcomes[1]?.report?.lines).toContain('No encounter: no work was tracked on it.')
  expect(await h.repo.pending()).toBe(undefined)
  expect((await h.repo.meta())!.completedMissions).toBe(0)
})

test('hasAttachedWork: a commit counts at once; test runs alone need the minimum duration', async () => {
  const base = { issueKey: 'NOVA-2', systemId: 's', startedAt: 0, testsGreen: true, lint: null, tacticalClean: false }
  expect(hasAttachedWork({ ...base, commits: 1, testRuns: 0 }, 1)).toBe(true)
  expect(hasAttachedWork({ ...base, commits: 0, testRuns: 3 }, ANTI_FARMING.minMissionMs - 1)).toBe(false)
  expect(hasAttachedWork({ ...base, commits: 0, testRuns: 3 }, ANTI_FARMING.minMissionMs)).toBe(true)
  expect(hasAttachedWork({ ...base, commits: 0, testRuns: 0 }, 10 * ANTI_FARMING.minMissionMs)).toBe(false)
})

test('an issue closed without ever being the mission is logged, so its branch cannot start it later', async () => {
  const h = await harness()
  await finishChart(h, EPIC, 0)
  const log: WorkTransition[] = [move(issue(3), 'done', 2 * MIN, EPIC)]
  const source = scripted(log)
  await h.repo.saveSync('scripted', { lastSync: 0, processed: [] })
  const r = await syncWork(h.deps(3 * MIN, source))
  expect(r.outcomes).toEqual([])
  expect((await h.repo.missionLog()).map(m => m.issueKey)).toEqual(['NOVA-3'])
  log.push(move(issue(3), 'in_progress', 4 * MIN, EPIC))
  await syncWork(h.deps(5 * MIN, source))
  expect(await h.repo.activeMission()).toBe(undefined)
})

test('a second issue in progress is not tracked while a mission is active', async () => {
  const h = await harness()
  await finishChart(h, EPIC, 0)
  await h.repo.saveSync('scripted', { lastSync: 0, processed: [] })
  const source = scripted([move(issue(2), 'in_progress', 1 * MIN, EPIC), move(issue(4), 'in_progress', 2 * MIN, EPIC)])
  await syncWork(h.deps(3 * MIN, source))
  expect((await h.repo.activeMission())?.issueKey).toBe('NOVA-2')
})

test('a mission under another epic makes that epic active', async () => {
  const h = await harness()
  await finishChart(h, EPIC, 0)
  await finishChart(h, OTHER_EPIC, 1)
  await h.repo.saveSync('scripted', { lastSync: 0, processed: [] })
  await syncWork(h.deps(3 * MIN, scripted([move(issue(51), 'in_progress', 1 * MIN, OTHER_EPIC)])))
  expect((await h.repo.meta())!.activeEpicKey).toBe('NOVA-50')
  expect((await h.repo.activeMission())?.issueKey).toBe('NOVA-51')
})

test('an epic closed in the tracker is surveyed, and waits while an encounter holds the slot', async () => {
  const h = await harness()
  await finishChart(h, EPIC, 0)
  await finishChart(h, OTHER_EPIC, 1)
  await h.repo.saveSync('scripted', { lastSync: 0, processed: [] })
  await h.repo.savePending({ id: 'e', systemId: 'x', speciesId: 'y', tier: 'common', quality: 0, attempts: 0, createdAt: 0 })
  const log = [move(EPIC, 'done', 1 * MIN)]
  const source = scripted(log)
  const held = await syncWork(h.deps(2 * MIN, source))
  expect(held.deferred).toBe(1)
  expect((await h.repo.sync('scripted')).lastSync).toBe(1 * MIN)

  await h.repo.clearPending()
  await h.repo.patchMeta(m => ({ ...m, activeEpicKey: 'NOVA-50' }))
  const r = await syncWork(h.deps(3 * MIN, source))
  expect(r.outcomes[0]?.text).toBe('Surveyed epic NOVA-1. Encounter waiting.')
  // A different active epic is left alone when another one closes.
  expect((await h.repo.meta())!.activeEpicKey).toBe('NOVA-50')
})

test('a waiting epic holds back its own later changes, not other epics', async () => {
  const h = await harness()
  await finishChart(h, OTHER_EPIC, 1)
  await h.repo.saveSync('scripted', { lastSync: 0, processed: [] })
  // NOVA-2 waits for NOVA-1 to chart, so NOVA-2's Done must wait too, or it would be read as a closure.
  const log = [
    move(issue(2), 'in_progress', 1 * MIN, EPIC),
    move(issue(2), 'done', 2 * MIN, EPIC),
    move(issue(51), 'in_progress', 3 * MIN, OTHER_EPIC),
  ]
  const r = await syncWork(h.deps(4 * MIN, scripted(log)))
  expect(r.deferred).toBe(2)
  expect((await h.repo.activeMission())?.issueKey).toBe('NOVA-51')
  expect(await h.repo.missionLog()).toEqual([])
})

test('idempotency: a restart replaying the same transitions applies nothing twice', async () => {
  const h = await harness()
  await finishChart(h, EPIC, 0)
  await h.repo.saveSync('scripted', { lastSync: 0, processed: [] })
  const log = [move(issue(2), 'in_progress', 1 * MIN, EPIC), move(issue(2), 'done', 2 * MIN, EPIC)]
  await syncWork(h.deps(3 * MIN, scripted(log)))
  const before = (await h.repo.missionLog()).length
  // The same changes reported again (overlap window, a reload, a source that repeats itself).
  await h.repo.saveSync('scripted', { ...(await h.repo.sync('scripted')), lastSync: 0 })
  const again = await syncWork(h.deps(4 * MIN, scripted([...log, ...log])))
  expect(again.applied).toBe(0)
  expect((await h.repo.missionLog()).length).toBe(before)
})

test('each query reaches back by the overlap, and the processed list stays bounded', async () => {
  const h = await harness()
  await finishChart(h, EPIC, 0)
  await h.repo.saveSync('scripted', { lastSync: 100 * MIN, processed: Array.from({ length: SYNC.maxProcessed }, (_, i) => `NOVA-9:${i}`) })
  const source = scripted([move(EPIC, 'todo', 101 * MIN)])
  await syncWork(h.deps(102 * MIN, source))
  expect(source.queries).toEqual([100 * MIN - SYNC.overlapMs])
  const s = await h.repo.sync('scripted')
  expect(s.processed.length).toBe(SYNC.maxProcessed)
  expect(s.processed.at(-1)).toMatch(/^NOVA-1:/)
})

test('a failing source changes nothing and reports why', async () => {
  const h = await harness()
  await h.repo.saveSync('down', { lastSync: 5, processed: [] })
  const r = await syncWork(h.deps(10, { name: 'down', changedSince: async () => { throw new Error('503') } }))
  expect(r.error).toBe('503')
  expect((await h.repo.sync('down')).lastSync).toBe(5)
})

test('a tracker-started mission runs from the tracker\'s start, not from the poll that saw it', async () => {
  const h = await harness()
  await finishChart(h, EPIC, 0)
  await h.repo.saveSync('scripted', { lastSync: 0, processed: [] })
  const log = [move(issue(2), 'in_progress', 1 * MIN, EPIC)]
  const source = scripted(log)
  await syncWork(h.deps(12 * MIN, source))
  expect((await h.repo.activeMission())?.startedAt).toBe(1 * MIN)
  // 25 minutes of work with one test run: past the minimum duration, so it is worked.
  await recordBash({ repo: h.repo, now: 20 * MIN, rng: createRng(1), signals: classifyBash('npm test'), commits: 0, isError: false })
  log.push(move(issue(2), 'done', 26 * MIN, EPIC))
  const r = await syncWork(h.deps(30 * MIN, source))
  expect(r.outcomes[0]?.report?.lines).not.toContain('No encounter: no work was tracked on it.')
})

test('an unworked closure earns no Reinforced Cell, even with green tests', async () => {
  const h = await harness()
  await finishChart(h, EPIC, 0)
  await h.repo.saveSync('scripted', { lastSync: 0, processed: [] })
  const log = [move(issue(2), 'in_progress', 1 * MIN, EPIC)]
  const source = scripted(log)
  await syncWork(h.deps(2 * MIN, source))
  await recordBash({ repo: h.repo, now: 3 * MIN, rng: createRng(1), signals: classifyBash('npm test'), commits: 0, isError: false })
  log.push(move(issue(2), 'done', 4 * MIN, EPIC))
  const r = await syncWork(h.deps(5 * MIN, source))
  expect(r.outcomes[0]?.text).toBe('Mission NOVA-2 complete.')
  expect((await h.repo.inventory()).reinforced).toBe(0)
})

test('charting for the tracker never moves the active epic away from a running mission', async () => {
  const h = await harness()
  await finishChart(h, OTHER_EPIC, 1)
  await h.repo.saveSync('scripted', { lastSync: 0, processed: [] })
  const log = [move(issue(51), 'in_progress', 1 * MIN, OTHER_EPIC), move(issue(5), 'in_progress', 2 * MIN, EPIC)]
  const source = scripted(log)
  await syncWork(h.deps(3 * MIN, source))
  expect(h.charted).toEqual(['NOVA-1'])
  await finishChart(h, EPIC, 4 * MIN)
  await syncWork(h.deps(5 * MIN, source))
  expect((await h.repo.meta())!.activeEpicKey).toBe('NOVA-50')
  expect((await h.repo.activeMission())?.issueKey).toBe('NOVA-51')
})

test('a start and a Done at the same instant apply start first, whatever order the source lists them', async () => {
  const h = await harness()
  await finishChart(h, EPIC, 0)
  await h.repo.saveSync('scripted', { lastSync: 0, processed: [] })
  const r = await syncWork(h.deps(3 * MIN, scripted([move(issue(2), 'done', 1 * MIN, EPIC), move(issue(2), 'in_progress', 1 * MIN, EPIC)])))
  expect(r.outcomes.map(o => o.text)).toEqual(['Mission NOVA-2 started.', 'Mission NOVA-2 complete.'])
})

test('a closure while its epic is still charting waits for the chart, so it is not lost', async () => {
  const h = await harness()
  await h.repo.saveSync('scripted', { lastSync: 0, processed: [] })
  const source = scripted([move(EPIC, 'in_progress', 1 * MIN), move(issue(3), 'done', 2 * MIN, EPIC)])
  const r = await syncWork(h.deps(3 * MIN, source))
  expect(r.deferred).toBe(1)
  await finishChart(h, EPIC, 4 * MIN)
  await syncWork(h.deps(5 * MIN, source))
  expect((await h.repo.missionLog()).map(m => m.issueKey)).toEqual(['NOVA-3'])
  expect(h.charted).toEqual(['NOVA-1'])
})
