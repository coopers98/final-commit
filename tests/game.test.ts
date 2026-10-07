import { expect, test } from 'claude-code/testing'
import { GENERATION } from '../src/config'
import {
  attemptContainment, completeEpic, completeMission, forceEncounter, onBranch, openItems, parseEpicKey, queueTarget, recordBash,
  recordClosure, reopenMission, setCompanion, startEpic, startMission,
} from '../src/game'
import { classifyBash } from '../src/detect/git'
import { DAY_MS } from '../src/encounter/roll'
import { createRng } from '../src/rng'
import { migrate } from '../src/store/migrate'
import { createMemoryStore, createRepo } from '../src/store/repo'
import type { Complete } from '../src/world/generate'
import { ENCOUNTER } from '../src/config'

const offline: Complete = async () => ({ ok: false, reason: 'offline' })

async function fresh(now = 0) {
  const store = createMemoryStore()
  await migrate(store, now)
  return { store, repo: createRepo(store) }
}

async function withEpic(seed = 1) {
  const { store, repo } = await fresh()
  const deps = { repo, now: 0, rng: createRng(seed) }
  await startEpic({ ...deps, epic: { key: 'NOVA-1', title: 'Billing export', description: '' }, complete: offline, privacy: 'standard' })
  return { store, repo, deps }
}

test('parseEpicKey takes a key and nothing else', async () => {
  expect(parseEpicKey('NOVA-1')).toBe('NOVA-1')
  expect(parseEpicKey(' nova-2 ')).toBe('NOVA-2')
  for (const bad of ['', 'complete', 'NOVA', 'NOVA-1 Billing export', 'NOVA-01']) expect(parseEpicKey(bad)).toBe(undefined)
})

test('starting an epic charts a system and makes it active', async () => {
  const { repo } = await withEpic()
  const ids = await repo.systemIds()
  expect(ids.length).toBe(1)
  const system = (await repo.system(ids[0]!))!
  expect(system.epicKey).toBe('NOVA-1')
  expect(system.species.filter(s => s.kind === 'fauna').length).toBe(Object.values(GENERATION.faunaSlots).reduce((a, b) => a + b, 0))
  expect((await repo.meta())!.activeEpicKey).toBe('NOVA-1')
})

test('starting the same epic again does not chart a second system', async () => {
  const { repo, deps } = await withEpic()
  const out = await startEpic({ ...deps, epic: { key: 'NOVA-1', title: 'x', description: '' }, complete: offline, privacy: 'standard' })
  expect(out.text).toContain('already charted')
  expect((await repo.systemIds()).length).toBe(1)
})

test('out-of-order commands explain themselves and change nothing', async () => {
  const { store, repo } = await fresh()
  const deps = { repo, now: 0, rng: createRng(1) }
  const before = JSON.stringify(store.dump())
  expect((await startMission({ ...deps, issueKey: 'NOVA-2' })).text).toContain('No active epic')
  expect((await completeMission(deps)).text).toContain('No active mission')
  expect((await completeEpic(deps)).text).toContain('No active epic')
  expect((await attemptContainment({ ...deps, cell: 'standard', latticeBonus: 0 })).text).toContain('Nothing to contain')
  expect((await forceEncounter(deps)).text).toContain('No active epic')
  expect(JSON.stringify(store.dump())).toBe(before)
})

test('a second mission while one is active is refused', async () => {
  const { deps } = await withEpic()
  await startMission({ ...deps, issueKey: 'NOVA-2' })
  expect((await startMission({ ...deps, issueKey: 'NOVA-3' })).text).toContain('already active')
})

test('a malformed mission key is refused', async () => {
  const { deps } = await withEpic()
  expect((await startMission({ ...deps, issueKey: 'not a key' })).text).toContain('Usage')
})

test('the first completed mission guarantees an encounter', async () => {
  const { repo, deps } = await withEpic()
  await startMission({ ...deps, issueKey: 'NOVA-2' })
  const out = await completeMission({ ...deps, now: 1000 })
  expect(out.text).toContain('Encounter waiting')
  expect(await repo.pending()).toBeDefined()
  expect((await repo.meta())!.completedMissions).toBe(1)
})

test('the daily soft cap stops mission encounters for the day', async () => {
  const { repo, deps } = await withEpic()
  const day = '2026-10-06'
  let count = 0
  for (let i = 0; i < 10; i += 1) {
    await startMission({ ...deps, issueKey: `NOVA-${i + 2}` })
    // Six days apart in clock time (a guaranteed encounter) but the same calendar day key.
    await completeMission({ ...deps, now: i * 6 * DAY_MS, day })
    if (await repo.pending()) {
      count += 1
      await repo.clearPending()
    }
  }
  expect(count).toBe(ENCOUNTER.dailySoftCap)
})

test('a new day resets the cap', async () => {
  const { repo, deps } = await withEpic()
  // Six days apart in clock time, so every encounter is guaranteed and only the cap decides.
  for (const [i, day] of ['2026-10-06', '2026-10-06', '2026-10-06', '2026-10-07'].entries()) {
    await startMission({ ...deps, issueKey: `NOVA-${i + 2}` })
    await completeMission({ ...deps, now: (i + 1) * 6 * DAY_MS, day })
    await repo.clearPending()
  }
  expect((await repo.meta())!.encountersToday).toEqual({ day: '2026-10-07', count: 1 })
})

test('passing tests during a mission earn a Reinforced Cell and raise quality', async () => {
  const { repo, deps } = await withEpic()
  await startMission({ ...deps, issueKey: 'NOVA-2' })
  await recordBash({ ...deps, signals: classifyBash('npm test'), commits: 0, isError: false })
  expect((await repo.activeMission())!.testsGreen).toBe(true)
  await completeMission(deps)
  expect((await repo.inventory()).reinforced).toBe(1)
  expect((await repo.pending())!.quality).toBe(0.5)
})

test('a piped or guarded test run never counts as green', async () => {
  const { repo, deps } = await withEpic()
  await startMission({ ...deps, issueKey: 'NOVA-2' })
  for (const c of ['npm test | tail -3', 'npm test || true', 'npm test &']) {
    await recordBash({ ...deps, signals: classifyBash(c), commits: 0, isError: false })
    expect((await repo.activeMission())!.testsGreen).toBe(false)
  }
})

test('a piped test run counts by the summary it prints', async () => {
  const { repo, deps } = await withEpic()
  await startMission({ ...deps, issueKey: 'NOVA-2' })
  const piped = classifyBash('npm test 2>&1 | tail -3')
  await recordBash({ ...deps, signals: piped, commits: 0, isError: false, output: ' 12 pass\n 0 fail\nRan 12 tests' })
  expect((await repo.activeMission())!.testsGreen).toBe(true)
  await recordBash({ ...deps, signals: piped, commits: 0, isError: false, output: ' 11 pass\n 1 fail' })
  expect((await repo.activeMission())!.testsGreen).toBe(false)
  await recordBash({ ...deps, signals: piped, commits: 0, isError: false, output: ' 12 pass\n 0 fail' })
  await recordBash({ ...deps, signals: classifyBash('npm test | grep -c pass'), commits: 0, isError: false, output: '12' })
  expect((await repo.activeMission())!.testsGreen).toBe(false)
})

test('a failing last test run clears testsGreen', async () => {
  const { repo, deps } = await withEpic()
  await startMission({ ...deps, issueKey: 'NOVA-2' })
  await recordBash({ ...deps, signals: classifyBash('npm test'), commits: 0, isError: false })
  await recordBash({ ...deps, signals: classifyBash('npm test'), commits: 0, isError: true })
  expect((await repo.activeMission())!.testsGreen).toBe(false)
  expect((await repo.activeMission())!.testRuns).toBe(2)
})

test('a lint run sets the mission\'s lint verdict by exit status; a piped one is ignored', async () => {
  const { repo, deps } = await withEpic()
  await startMission({ ...deps, issueKey: 'NOVA-2' })
  expect((await repo.activeMission())!.lint).toBe(null)
  await recordBash({ ...deps, signals: classifyBash('npm run lint'), commits: 0, isError: true })
  expect((await repo.activeMission())!.lint).toBe('fail')
  await recordBash({ ...deps, signals: classifyBash('npx tsc -p . | tail -3'), commits: 0, isError: false })
  expect((await repo.activeMission())!.lint).toBe('fail')
  await recordBash({ ...deps, signals: classifyBash('npm run typecheck'), commits: 0, isError: false })
  expect((await repo.activeMission())!.lint).toBe('pass')
  expect((await repo.activeMission())!.testRuns).toBe(0)
})

test('openItems names tests not run or not green, and lint not run or failing', async () => {
  const m = { issueKey: 'NOVA-2', systemId: 's', startedAt: 0, commits: 0, tacticalClean: false }
  expect(openItems({ ...m, testRuns: 0, testsGreen: false, lint: null })).toEqual(['No test run yet', 'No lint or type check yet'])
  expect(openItems({ ...m, testRuns: 2, testsGreen: false, lint: 'fail' })).toEqual(['Tests not green (the last run failed)', 'Lint failing (the last run failed)'])
  expect(openItems({ ...m, testRuns: 1, testsGreen: true, lint: 'pass' })).toEqual([])
})

test('commits are counted on the active mission only', async () => {
  const { repo, deps } = await withEpic()
  await recordBash({ ...deps, signals: classifyBash('git commit -m x'), commits: 1, isError: false })
  await startMission({ ...deps, issueKey: 'NOVA-2' })
  await recordBash({ ...deps, signals: classifyBash('git commit -m x'), commits: 1, isError: false })
  expect((await repo.activeMission())!.commits).toBe(1)
})

test('a slow /epic does not roll back progress saved while it charted', async () => {
  const { repo, deps } = await withEpic()
  let release: () => void = () => {}
  const slow: Complete = () => new Promise(resolve => { release = () => resolve({ ok: false, reason: 'offline' }) })
  const charting = startEpic({ ...deps, epic: { key: 'NOVA-50', title: 'x', description: '' }, complete: slow, privacy: 'standard' })
  await startMission({ ...deps, issueKey: 'NOVA-2' })
  await completeMission(deps)
  const during = (await repo.meta())!
  expect(during.completedMissions).toBe(1)
  release()
  await charting
  const after = (await repo.meta())!
  expect(after.completedMissions).toBe(1)
  expect(after.lastEncounterAt).toBe(during.lastEncounterAt)
  expect(after.activeEpicKey).toBe('NOVA-50')
})

test('two epics charted at once get distinct systems', async () => {
  const { repo } = await fresh()
  const deps = { repo, now: 0, rng: createRng(1) }
  await Promise.all([
    startEpic({ ...deps, epic: { key: 'NOVA-1', title: 'a', description: '' }, complete: offline, privacy: 'standard' }),
    startEpic({ ...deps, rng: createRng(2), epic: { key: 'NOVA-2', title: 'b', description: '' }, complete: offline, privacy: 'standard' }),
  ])
  const ids = await repo.systemIds()
  expect(new Set(ids).size).toBe(2)
  const keys = await Promise.all(ids.map(async id => (await repo.system(id))!.epicKey))
  expect(keys.sort()).toEqual(['NOVA-1', 'NOVA-2'])
})

test('a branch with an issue key starts that mission', async () => {
  const { repo, deps } = await withEpic()
  await onBranch({ ...deps, branch: 'feature/NOVA-7-thing' })
  expect((await repo.activeMission())!.issueKey).toBe('NOVA-7')
  expect(await onBranch({ ...deps, branch: 'feature/NOVA-8-other' })).toBe(undefined)
  expect((await repo.activeMission())!.issueKey).toBe('NOVA-7')
})

test('a branch from another project starts nothing', async () => {
  const { repo, deps } = await withEpic()
  for (const b of ['renovate/node-20', 'fix/utf-8-decoding', 'feature/sha-256', 'feature/OTHER-3-x']) {
    expect(await onBranch({ ...deps, branch: b })).toBe(undefined)
  }
  expect(await repo.activeMission()).toBe(undefined)
})

test('checking out a finished mission branch does not restart it', async () => {
  const { repo, deps } = await withEpic()
  await onBranch({ ...deps, branch: 'feature/NOVA-7-thing' })
  await completeMission(deps)
  expect(await onBranch({ ...deps, branch: 'feature/NOVA-7-thing' })).toBe(undefined)
  expect(await repo.activeMission()).toBe(undefined)
})

test('a branch without an epic starts nothing', async () => {
  const { repo } = await fresh()
  expect(await onBranch({ repo, now: 0, rng: createRng(1), branch: 'feature/NOVA-7-thing' })).toBe(undefined)
})

test('a later same-day mission usually has no encounter', async () => {
  let encounters = 0
  for (let seed = 0; seed < 200; seed += 1) {
    const { repo, deps } = await withEpic(seed)
    await startMission({ ...deps, issueKey: 'NOVA-2' })
    await completeMission(deps)
    await repo.clearPending()
    await startMission({ ...deps, issueKey: 'NOVA-3' })
    await completeMission({ ...deps, now: 1000 })
    if (await repo.pending()) encounters += 1
  }
  expect(encounters).toBeGreaterThan(5)
  expect(encounters).toBeLessThan(50)
})

test('five days without an encounter guarantees one', async () => {
  const { repo, deps } = await withEpic()
  await startMission({ ...deps, issueKey: 'NOVA-2' })
  await completeMission(deps)
  await repo.clearPending()
  await startMission({ ...deps, now: 5 * DAY_MS, issueKey: 'NOVA-3' })
  await completeMission({ ...deps, now: 5 * DAY_MS + 1 })
  expect(await repo.pending()).toBeDefined()
})

test('a pending encounter is not overwritten by a new mission', async () => {
  const { repo, deps } = await withEpic()
  await startMission({ ...deps, issueKey: 'NOVA-2' })
  await completeMission(deps)
  const first = (await repo.pending())!.id
  await startMission({ ...deps, issueKey: 'NOVA-3' })
  await completeMission({ ...deps, now: 6 * DAY_MS })
  expect((await repo.pending())!.id).toBe(first)
})

test('containment resolves: contained, broke free, or fled, never leaving a bad state', async () => {
  const seen = new Set<string>()
  for (let seed = 0; seed < 60; seed += 1) {
    const { repo, deps } = await withEpic(seed)
    await forceEncounter(deps)
    const out = await attemptContainment({ ...deps, cell: 'standard', latticeBonus: 0 })
    if (!('outcome' in out)) throw new Error('expected an outcome')
    seen.add(out.outcome)
    const pending = await repo.pending()
    const specimens = await repo.specimens()
    if (out.outcome === 'contained') {
      expect(pending).toBe(undefined)
      expect(specimens.length).toBe(1)
      expect((await repo.meta())!.companionId).toBe(specimens[0]!.id)
    } else if (out.outcome === 'fled') {
      expect(pending).toBe(undefined)
      expect((await repo.catalog()).some(c => c.status === 'escaped')).toBe(true)
    } else {
      expect(pending!.attempts).toBe(1)
    }
  }
  expect(seen.size).toBe(3)
})

test('a Reinforced Cell is spent only when held', async () => {
  const { repo, deps } = await withEpic()
  await forceEncounter(deps)
  await attemptContainment({ ...deps, cell: 'reinforced', latticeBonus: 0 })
  expect((await repo.inventory()).reinforced).toBe(0)
  await repo.saveInventory({ ...(await repo.inventory()), reinforced: 2 })
  await repo.clearPending()
  await forceEncounter(deps)
  await attemptContainment({ ...deps, cell: 'reinforced', latticeBonus: 0 })
  expect((await repo.inventory()).reinforced).toBe(1)
})

test('completing an epic with an encounter waiting is refused and changes nothing', async () => {
  const { store, repo, deps } = await withEpic()
  await forceEncounter(deps)
  const before = JSON.stringify(store.dump())
  expect((await completeEpic(deps)).text).toContain('already waiting')
  expect(JSON.stringify(store.dump())).toBe(before)
  expect((await repo.meta())!.activeEpicKey).toBe('NOVA-1')
})

test('completing an epic surveys it and grants a non-Common encounter', async () => {
  for (let seed = 0; seed < 30; seed += 1) {
    const { repo, deps } = await withEpic(seed)
    const out = await completeEpic(deps)
    expect(out.text).toContain('Surveyed')
    expect((await repo.pending())!.tier).not.toBe('common')
    expect((await repo.meta())!.activeEpicKey).toBe(null)
  }
})

test('setCompanion accepts a specimen id and refuses an unknown one', async () => {
  const { repo, deps } = await withEpic()
  await repo.addSpecimen({ id: 'spec-1-42', speciesId: 'x', systemId: 'sys-1', tier: 'common', level: 1, xp: 0, stage: 0, containedAt: 0 })
  expect((await setCompanion({ ...deps, specimenId: 'spec-1-42' })).text).toBe('Companion set.')
  expect((await setCompanion({ ...deps, specimenId: 'nope' })).text).toContain('No such specimen')
})

test('command text never carries game flavor words', async () => {
  const { deps } = await withEpic()
  await startMission({ ...deps, issueKey: 'NOVA-2' })
  const out = await completeMission(deps)
  expect(out.text).not.toMatch(/wild|stirs|dark|!|Encounter!/)
})

test('queueTarget picks the latest charting epic of the key\'s project, else the latest of all', async () => {
  const charting = [{ key: 'NOVA-1', startedAt: 10 }, { key: 'NOVA-9', startedAt: 5 }, { key: 'ORION-4', startedAt: 20 }]
  expect(queueTarget('nova-2', charting)).toBe('NOVA-1')
  expect(queueTarget('VEGA-3', charting)).toBe('ORION-4')
  expect(queueTarget('NOVA-2', [])).toBe(undefined)
})

test('a mission started with its epic makes that charted epic active; with a mission running it changes nothing', async () => {
  const { repo, deps } = await withEpic()
  // A second epic charted for a source: charted, not made active.
  await startEpic({ ...deps, epic: { key: 'NOVA-20', title: 'Search', description: '' }, complete: offline, privacy: 'standard', activate: false })
  expect((await repo.meta())!.activeEpicKey).toBe('NOVA-1')
  expect((await startMission({ ...deps, issueKey: 'NOVA-21', epicKey: 'NOVA-20' })).text).toBe('Mission NOVA-21 started.')
  expect((await repo.meta())!.activeEpicKey).toBe('NOVA-20')
  const nova20 = (await repo.activeMission())!.systemId
  expect((await repo.system(nova20))!.epicKey).toBe('NOVA-20')
  await startMission({ ...deps, issueKey: 'NOVA-2', epicKey: 'NOVA-1' })
  expect((await repo.meta())!.activeEpicKey).toBe('NOVA-20')
  // An epic not charted is not made active.
  const fresh2 = await withEpic()
  await startMission({ ...fresh2.deps, issueKey: 'NOVA-31', epicKey: 'NOVA-30' })
  expect((await fresh2.repo.meta())!.activeEpicKey).toBe('NOVA-1')
})

test('/mission reopen undoes the latest completion: out of the log, the count and its cell taken back; it can start again', async () => {
  const { repo, deps } = await withEpic()
  await startMission({ ...deps, issueKey: 'NOVA-2' })
  await recordBash({ ...deps, signals: classifyBash('npm test'), commits: 0, isError: false, output: '' })
  await completeMission({ ...deps, rng: createRng(99) })
  expect((await repo.missionLog()).at(-1)?.reward).toEqual({ counted: true, reinforced: 1 })
  const cells = (await repo.inventory()).reinforced
  const count = (await repo.meta())!.completedMissions
  // A second mission, so the count has one to give back without reaching zero.
  await startMission({ ...deps, issueKey: 'NOVA-3' })
  await completeMission({ ...deps, rng: createRng(99) })
  const out = await reopenMission({ ...deps, issueKey: 'nova-2' })
  expect(out.text).toBe('Mission NOVA-2 reopened: removed from the log; 1 fewer completed mission, Reinforced Cells -1. Encounters and scan signals it gave stay. Start it again with /mission NOVA-2.')
  expect((await repo.missionLog()).some(m => m.issueKey === 'NOVA-2')).toBe(false)
  expect((await repo.inventory()).reinforced).toBe(cells - 1)
  expect((await repo.meta())!.completedMissions).toBe(count)
  expect((await startMission({ ...deps, issueKey: 'NOVA-2' })).text).toBe('Mission NOVA-2 started.')
  expect((await reopenMission({ ...deps, issueKey: 'NOVA-2' })).text).toBe('Mission NOVA-2 is active, not completed.')
})

test('/mission reopen: a closure gave nothing to take; a spent cell is kept; a key not logged or malformed is refused', async () => {
  const { repo, deps } = await withEpic()
  const systemId = (await repo.systemIds())[0]!
  await recordClosure({ ...deps, issueKey: 'NOVA-5', systemId })
  const count = (await repo.meta())!.completedMissions
  expect((await reopenMission({ ...deps, issueKey: 'NOVA-5' })).text).toBe('Mission NOVA-5 reopened: removed from the log. Encounters and scan signals it gave stay. Start it again with /mission NOVA-5.')
  expect((await repo.meta())!.completedMissions).toBe(count)
  await startMission({ ...deps, issueKey: 'NOVA-6' })
  await recordBash({ ...deps, signals: classifyBash('npm test'), commits: 0, isError: false, output: '' })
  await completeMission({ ...deps, rng: createRng(99) })
  await repo.saveInventory({ ...(await repo.inventory()), reinforced: 0 })
  expect((await reopenMission({ ...deps, issueKey: 'NOVA-6' })).text).toContain('1 Reinforced Cell already spent, kept')
  expect((await repo.inventory()).reinforced).toBe(0)
  expect((await reopenMission({ ...deps, issueKey: 'NOVA-6' })).text).toBe('Mission NOVA-6 is not in the log of completed missions.')
  expect((await reopenMission({ ...deps, issueKey: 'nope' })).text).toBe('Usage: /mission reopen <KEY>, for example /mission reopen NOVA-12.')
})

test('/mission reopen of a key completed twice removes only the latest', async () => {
  const { repo, deps } = await withEpic()
  for (const at of [1, 2]) {
    await startMission({ ...deps, now: at, issueKey: 'NOVA-7' })
    await completeMission({ ...deps, now: at, rng: createRng(99) })
  }
  await reopenMission({ ...deps, issueKey: 'NOVA-7' })
  expect((await repo.missionLog()).filter(m => m.issueKey === 'NOVA-7').map(m => m.completedAt)).toEqual([1])
})

test('/mission reopen never returns the count to zero once an encounter has happened: the first mission\'s guarantee is not had twice', async () => {
  const { repo, deps } = await withEpic()
  await startMission({ ...deps, issueKey: 'NOVA-2' })
  await completeMission({ ...deps, rng: createRng(99) })
  expect((await repo.meta())!.lastEncounterAt).not.toBe(null)
  expect((await reopenMission({ ...deps, issueKey: 'NOVA-2' })).text).not.toContain('fewer completed')
  expect((await repo.meta())!.completedMissions).toBe(1)
})
