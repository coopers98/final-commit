import { expect, test } from 'claude-code/testing'
import { createSyncGate, resolveSources, sourceNames, syncSources, type SourcesDeps } from '../src/detect/sources'
import type { WorkItem, WorkSource, WorkTransition } from '../src/detect/work-source'
import { createRng } from '../src/rng'
import { migrate } from '../src/store/migrate'
import { createMemoryStore, createRepo, type Repo } from '../src/store/repo'

// Several work sources at once (SPEC 4.4), against scripted sources. Everything here is invented (NOVA-).

const MIN = 60_000
const EPIC: WorkItem = { key: 'NOVA-1', kind: 'epic', title: 'Billing export', description: '' }

function scripted(name: string, log: WorkTransition[]): WorkSource & { queries: number[] } {
  const queries: number[] = []
  return { name, queries, changedSince: async since => (queries.push(since), log.filter(t => t.at >= since)) }
}

function broken(name: string, reason = 'token expired'): WorkSource & { calls: number } {
  const s = { name, calls: 0, changedSince: async () => { s.calls += 1; throw new Error(reason) } }
  return s
}

async function harness(): Promise<{ repo: Repo; charted: string[]; deps: (now: number, sources: WorkSource[], failing?: Set<string>) => SourcesDeps }> {
  const store = createMemoryStore()
  await migrate(store, 0)
  const repo = createRepo(store)
  const charted: string[] = []
  let n = 0
  return {
    repo, charted,
    deps: (now, sources, failing = new Set()) => ({
      repo, now, rng: createRng(3 + n++), day: '2026-01-01', sources, failing, charting: new Set(),
      chart: epic => void charted.push(epic.key),
    }),
  }
}

test('the setting is read as names: trimmed, lower case, each once', () => {
  expect(sourceNames([' Plans', 'github', 'plans', ''])).toEqual(['plans', 'github'])
  expect(sourceNames('jira, linear')).toEqual(['jira', 'linear'])
  expect(sourceNames(undefined)).toEqual([])
  expect(sourceNames(3)).toEqual([])
})

test('names resolve to the backends this build has; the rest are reported', () => {
  const plans = scripted('plans', [])
  const r = resolveSources(['plans', 'jira', 'linear', 'Bad Name', 'constructor'], {
    plans: () => plans,
    linear: () => undefined,
  })
  expect(r.sources).toEqual([plans])
  expect(r.unknown).toEqual(['jira', 'Bad Name', 'constructor'])
  expect(r.incomplete).toEqual(['linear'])
})

test('each source keeps its own sync record: first syncs record their start, then each reads from its own', async () => {
  const h = await harness()
  const a = scripted('plans', [])
  const b = scripted('github', [])
  await syncSources(h.deps(10 * MIN, [a]))
  await syncSources(h.deps(20 * MIN, [a, b]))
  // `github` joined later: its first sync only records where it starts.
  expect(b.queries).toEqual([])
  expect((await h.repo.sync('plans')).lastSync).toBe(20 * MIN)
  expect((await h.repo.sync('github')).lastSync).toBe(20 * MIN)
  await syncSources(h.deps(30 * MIN, [a, b]))
  expect(a.queries.length).toBe(2)
  expect(b.queries.length).toBe(1)
})

test('the same transition key from two sources is applied by each, recorded under each', async () => {
  const h = await harness()
  const t: WorkTransition = { id: 'x1', at: 5 * MIN, item: EPIC, to: 'in_progress' }
  const a = scripted('plans', [t])
  const b = scripted('jira', [t])
  await syncSources(h.deps(0, [a, b]))
  await syncSources(h.deps(10 * MIN, [a, b]))
  expect((await h.repo.sync('plans')).processed).toEqual(['NOVA-1:x1'])
  expect((await h.repo.sync('jira')).processed).toEqual(['NOVA-1:x1'])
})

test('an epic two sources start in one sync is charted once', async () => {
  const h = await harness()
  const a = scripted('plans', [{ id: 'a1', at: 5 * MIN, item: EPIC, to: 'in_progress' }])
  const b = scripted('jira', [{ id: 'b1', at: 6 * MIN, item: EPIC, to: 'in_progress' }])
  await syncSources(h.deps(0, [a, b]))
  await syncSources(h.deps(10 * MIN, [a, b]))
  expect(h.charted).toEqual(['NOVA-1'])
})

test('a failing source is reported once per outage and retried; the others keep running', async () => {
  const h = await harness()
  const bad = broken('jira')
  const good = scripted('plans', [{ id: 'g1', at: 5 * MIN, item: EPIC, to: 'in_progress' }])
  await syncSources(h.deps(0, [bad, good]))
  // jira's first sync only records its start, so it fails from the second on.
  const first = await syncSources(h.deps(10 * MIN, [bad, good]))
  expect(first.toasts).toEqual(['Work source jira failed (token expired); retrying at the next poll.'])
  expect([...first.failing]).toEqual(['jira'])
  expect(h.charted).toEqual(['NOVA-1'])
  const second = await syncSources(h.deps(22 * MIN, [bad, good], first.failing))
  expect(second.toasts).toEqual([])
  expect(bad.calls).toBe(2)
  expect((await h.repo.sync('jira')).lastSync).toBe(0)
})

test('a source that recovers and fails again is reported again', async () => {
  const h = await harness()
  let isDown = true
  const flaky: WorkSource = { name: 'linear', changedSince: async () => { if (isDown) throw new Error('offline'); return [] } }
  await syncSources(h.deps(0, [flaky]))
  const down = await syncSources(h.deps(10 * MIN, [flaky]))
  isDown = false
  const up = await syncSources(h.deps(20 * MIN, [flaky], down.failing))
  expect(up.failing.size).toBe(0)
  isDown = true
  const again = await syncSources(h.deps(30 * MIN, [flaky], up.failing))
  expect(again.toasts.length).toBe(1)
})

test('a source whose sync throws while applying is reported and does not stop the next one', async () => {
  const h = await harness()
  const throwing: WorkSource = { name: 'github', changedSince: async () => [{ id: 'z', at: 5 * MIN, item: EPIC, to: 'in_progress' }] }
  const good = scripted('plans', [{ id: 'g1', at: 5 * MIN, item: EPIC, to: 'in_progress' }])
  await syncSources(h.deps(0, [throwing, good]))
  const deps = h.deps(10 * MIN, [throwing, good])
  let calls = 0
  const r = await syncSources({ ...deps, chart: epic => { calls += 1; if (calls === 1) throw new Error('chart refused'); h.charted.push(epic.key) } })
  expect(r.toasts).toEqual(['Work source github failed (chart refused); retrying at the next poll.'])
  expect(h.charted).toEqual(['NOVA-1'])
})

/** A run the test finishes by hand, counting how many started. */
function manualRun() {
  const ends: (() => void)[] = []
  let started = 0
  const run = () => new Promise<void>(resolve => { started += 1; ends.push(resolve) })
  return { run, started: () => started, end: async () => { ends.shift()?.(); for (let i = 0; i < 5; i++) await Promise.resolve() } }
}

test('the sync gate runs one sync at a time: a request while one runs is dropped', async () => {
  const m = manualRun()
  const gate = createSyncGate(m.run)
  gate.request()
  gate.request()
  gate.request()
  expect(m.started()).toBe(1)
  await m.end()
  expect(m.started()).toBe(1)
  gate.request()
  expect(m.started()).toBe(2)
})

test('a request to sync again while one runs runs once more after it, however often asked', async () => {
  const m = manualRun()
  const gate = createSyncGate(m.run)
  gate.request()
  gate.request({ again: true })
  gate.request({ again: true })
  expect(m.started()).toBe(1)
  await m.end()
  expect(m.started()).toBe(2)
  await m.end()
  expect(m.started()).toBe(2)
})

test('a sync that rejects frees the gate', async () => {
  let calls = 0
  const gate = createSyncGate(async () => { calls += 1; throw new Error('boom') })
  gate.request()
  for (let i = 0; i < 5; i++) await Promise.resolve()
  gate.request()
  expect(calls).toBe(2)
})

test('sources failing alike in one sync are told in one toast; a different failure gets its own', async () => {
  const h = await harness()
  const a = broken('github:example/nova', 'gh: not logged in')
  const b = broken('github:example/atlas', 'gh: not logged in')
  const c = broken('plans', 'unreadable')
  await syncSources(h.deps(0, [a, b, c]))
  const r = await syncSources(h.deps(10 * MIN, [a, b, c]))
  expect(r.toasts).toEqual([
    'Work sources github:example/nova, github:example/atlas failed (gh: not logged in); retrying at the next poll.',
    'Work source plans failed (unreadable); retrying at the next poll.',
  ])
  expect([...r.failing]).toEqual(['github:example/nova', 'github:example/atlas', 'plans'])
})
