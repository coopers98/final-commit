import { expect, test } from 'claude-code/testing'
import { GENERATION } from '../src/config'
import {
  answerPuzzle, attemptContainment, cellsOf, completeEpic, completeMission, craftCell, forceEncounter, onBranch, openItems, parseCell, parseCraftCell, parseEpicKey,
  queueTarget, recordBash, recordClosure, recordTactical, reopenMission, setCompanion, startEpic, startMission,
} from '../src/game'
import { classifyBash } from '../src/detect/git'
import { xpForLevel } from '../src/companion'
import { DAY_MS } from '../src/encounter/roll'
import { createRng } from '../src/rng'
import { migrate } from '../src/store/migrate'
import { createMemoryStore, createRepo } from '../src/store/repo'
import type { Complete } from '../src/world/generate'
import { DOSSIER, ENCOUNTER } from '../src/config'

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
  const reward = (await repo.missionLog()).at(-1)?.reward
  expect({ ...reward, flora: undefined }).toEqual({ counted: true, reinforced: 1, stasis: 0, flora: undefined })
  // Green tests are quality 0.5: two samples.
  expect(Object.values(reward!.flora).reduce((a, b) => a + b, 0)).toBe(2)
  const cells = (await repo.inventory()).reinforced
  const count = (await repo.meta())!.completedMissions
  // A second mission, so the count has one to give back without reaching zero.
  await startMission({ ...deps, issueKey: 'NOVA-3' })
  await completeMission({ ...deps, rng: createRng(99) })
  const out = await reopenMission({ ...deps, issueKey: 'nova-2' })
  expect(out.text).toBe('Mission NOVA-2 reopened: removed from the log; 1 fewer completed mission, Reinforced Cells -1, Flora samples -2. Encounters and scan signals it gave stay. Start it again with /mission NOVA-2.')
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

/** The system's flora ids by tier. */
async function floraOf(repo: Awaited<ReturnType<typeof withEpic>>['repo']) {
  const system = (await repo.system((await repo.systemIds())[0]!))!
  const of = (t: string) => system.species.filter(s => s.kind === 'flora' && s.tier === t).map(s => s.id)
  return { common: of('common'), rare: of('rare'), legendary: of('legendary') }
}

test('a completed mission harvests flora by quality; the samples are held and met in the catalog', async () => {
  const { repo, deps } = await withEpic()
  await startMission({ ...deps, issueKey: 'NOVA-2' })
  const out = await completeMission({ ...deps, now: 1000 })
  // No tests and no review: quality 0, one sample.
  expect(out.text).toContain('Flora samples +1')
  const held = (await repo.inventory()).flora
  expect(Object.values(held)).toEqual([1])
  expect((await repo.catalog()).some(e => e.speciesId === Object.keys(held)[0] && e.status === 'seen')).toBe(true)
  expect(out.report!.lines.some(l => l.startsWith('Harvested: 1 '))).toBe(true)
})

test('a clean Tactical review earns a Stasis Cell; with green tests too, three samples', async () => {
  const { repo, deps } = await withEpic()
  await startMission({ ...deps, issueKey: 'NOVA-2' })
  await recordBash({ ...deps, signals: classifyBash('git commit -m x'), commits: 1, isError: false })
  await recordBash({ ...deps, signals: classifyBash('npm test'), commits: 0, isError: false, output: '' })
  await recordTactical({ repo, verdict: 'clean' })
  const out = await completeMission({ ...deps, now: 1000 })
  expect(out.text).toContain('Reinforced Cells +1, Stasis Cells +1, Flora samples +3')
  const inv = await repo.inventory()
  expect([inv.reinforced, inv.stasis]).toEqual([1, 1])
  expect((await repo.missionLog()).at(-1)!.reward!.stasis).toBe(1)
})

test('a closure with no work attached gives no Stasis Cell and harvests nothing', async () => {
  const { repo, deps } = await withEpic()
  await startMission({ ...deps, issueKey: 'NOVA-2' })
  await recordBash({ ...deps, signals: classifyBash('git commit -m x'), commits: 1, isError: false })
  await recordTactical({ repo, verdict: 'clean' })
  await completeMission({ ...deps, now: 1000, attachedWork: false })
  const inv = await repo.inventory()
  expect([inv.stasis, inv.flora]).toEqual([0, {}])
})

test('/mission reopen takes back a Stasis Cell and the flora harvested, as far as still held', async () => {
  const { repo, deps } = await withEpic()
  await startMission({ ...deps, issueKey: 'NOVA-2' })
  await recordBash({ ...deps, signals: classifyBash('git commit -m x'), commits: 1, isError: false })
  await recordTactical({ repo, verdict: 'clean' })
  await completeMission({ ...deps, now: 1000 })
  // Quality 0.5 harvested two samples; one is spent before the reopen.
  const inv = await repo.inventory()
  const [id] = Object.keys(inv.flora)
  await repo.saveInventory({ ...inv, flora: { ...inv.flora, [id!]: inv.flora[id!]! - 1 } })
  const out = await reopenMission({ ...deps, issueKey: 'NOVA-2' })
  expect(out.text).toContain('Stasis Cells -1, Flora samples -1, 1 flora sample already spent, kept')
  expect([(await repo.inventory()).stasis, (await repo.inventory()).flora]).toEqual([0, {}])
})

test('a survey grants a Singularity Cell, usable only with a Legendary flora sample to activate it', async () => {
  const { repo, deps } = await withEpic()
  const out = await completeEpic(deps)
  expect(out.text).toContain('Singularity Cell +1')
  expect(out.report!.lines).toContain('Singularity Cell +1 (activates with a Legendary flora sample)')
  expect((await repo.inventory()).singularity).toBe(1)
  expect((await cellsOf(repo)).singularity).toBe(0)
  // Without the flora it throws a Standard Cell and keeps the Singularity Cell.
  const tried = await attemptContainment({ ...deps, cell: 'singularity', latticeBonus: 0 })
  expect(tried.text).not.toContain('Singularity')
  expect((await repo.inventory()).singularity).toBe(1)
})

test('a Singularity Cell spends one Legendary flora sample when thrown', async () => {
  const { repo, deps } = await withEpic()
  const { legendary, common } = await floraOf(repo)
  await repo.saveInventory({ reinforced: 0, stasis: 0, singularity: 1, flora: { [legendary[0]!]: 2, [common[0]!]: 1 } })
  expect((await cellsOf(repo)).singularity).toBe(1)
  await forceEncounter(deps)
  const out = await attemptContainment({ ...deps, cell: 'singularity', latticeBonus: 0 })
  expect(out.text).toMatch(/Singularity Cell|broke free|fled/)
  const inv = await repo.inventory()
  expect(inv.singularity).toBe(0)
  expect(inv.flora).toEqual({ [legendary[0]!]: 1, [common[0]!]: 1 })
})

test('/craft makes a Reinforced Cell from 3 Common samples and a Stasis Cell from 2 Rare; too few changes nothing', async () => {
  const { store, repo, deps } = await withEpic()
  const { common, rare } = await floraOf(repo)
  expect((await craftCell(deps)).text).toBe('Recipes (flora samples): Reinforced: 3 Common, Stasis: 2 Rare. Flora held: 0 Common, 0 Rare, 0 Legendary. Usage: /craft reinforced|stasis.')
  await repo.saveInventory({ reinforced: 0, stasis: 0, singularity: 0, flora: { [common[0]!]: 2, [common[1]!]: 2, [rare[0]!]: 1 } })
  const before = JSON.stringify(store.dump())
  expect((await craftCell({ ...deps, cell: 'stasis' })).text).toBe('A Stasis Cell needs 2 Rare flora samples. Flora held: 4 Common, 1 Rare, 0 Legendary.')
  expect(JSON.stringify(store.dump())).toBe(before)
  expect((await craftCell({ ...deps, cell: 'reinforced' })).text).toBe('Crafted a Reinforced Cell (1 held).')
  const inv = await repo.inventory()
  expect(inv.reinforced).toBe(1)
  expect(Object.values(inv.flora).reduce((a, b) => a + b, 0)).toBe(2)
})

test('cell arguments: a name or its key; craft takes only the craftable cells', async () => {
  expect(['', 'standard', 'r', 'Stasis', ' x ', 'singularity', 'bogus'].map(parseCell)).toEqual(['standard', 'standard', 'reinforced', 'stasis', 'singularity', 'singularity', undefined])
  expect(['r', 'reinforced', 's', 'STASIS', 'singularity', 'x', ''].map(parseCraftCell)).toEqual(['reinforced', 'reinforced', 'stasis', 'stasis', undefined, undefined, undefined])
})

const PUZZLE_FIXTURE = {
  type: 'bug-hunt' as const, category: 'off by one', question: 'Which line?', lang: 'TypeScript',
  code: ['function f() {', '  a()', '}'], choices: ['Line 1', 'Line 2', 'Line 3', 'Line 4'], answer: 2, explanation: 'Line 3 changed.',
}

test('a puzzle answer is kept with the encounter once, counts in the accuracy record, and its bonus reaches every attempt', async () => {
  const { repo, deps } = await withEpic()
  await forceEncounter(deps)
  await repo.savePending({ ...(await repo.pending())!, puzzle: PUZZLE_FIXTURE })
  const first = await answerPuzzle({ ...deps, choice: 2, elapsedMs: 0 })
  expect(first!.isCorrect).toBe(true)
  expect(first!.bonus > 0).toBe(true)
  // A second answer changes nothing.
  expect(await answerPuzzle({ ...deps, choice: 0, elapsedMs: 0 })).toEqual(first)
  expect(await repo.puzzleStats()).toEqual([{ category: 'off by one', type: 'bug-hunt', attempts: 1, correct: 1, lastSeen: 0, recent: [true] }])
})

test('the accuracy record keeps the last answers per category, newest last, up to the window', async () => {
  const { repo, deps } = await withEpic()
  await forceEncounter(deps)
  const answer = async (choice: number) => {
    await repo.savePending({ ...(await repo.pending())!, puzzle: PUZZLE_FIXTURE, analysis: undefined })
    await answerPuzzle({ ...deps, choice, elapsedMs: 0 })
  }
  await answer(0)
  for (let i = 0; i < DOSSIER.recentWindow + 2; i++) await answer(2)
  let [stat] = await repo.puzzleStats()
  expect(stat!.attempts).toBe(DOSSIER.recentWindow + 3)
  expect(stat!.correct).toBe(DOSSIER.recentWindow + 2)
  expect(stat!.recent.length).toBe(DOSSIER.recentWindow)
  expect(stat!.recent.every(Boolean)).toBe(true)
  await answer(0)
  ;[stat] = await repo.puzzleStats()
  expect(stat!.recent.length).toBe(DOSSIER.recentWindow)
  expect(stat!.recent.at(-1)).toBe(false)
  expect(stat!.recent.at(-2)).toBe(true)
})

test('a right answer\'s bonus raises the odds of every containment attempt on that creature', async () => {
  const contained = async (bonus: number | undefined) => {
    let n = 0
    for (let seed = 0; seed < 200; seed += 1) {
      const { repo, deps } = await withEpic()
      await forceEncounter(deps)
      const p = (await repo.pending())!
      await repo.savePending({ ...p, tier: 'legendary', ...(bonus === undefined ? {} : { analysis: { isSkipped: false, isCorrect: true, bonus } }) })
      const out = await attemptContainment({ ...deps, rng: createRng(seed), cell: 'standard', latticeBonus: 0 })
      if ('outcome' in out && out.outcome === 'contained') n += 1
    }
    return n
  }
  // Legendary: 10% base; a +25% answer makes it 35%.
  const without = await contained(undefined)
  const withBonus = await contained(0.25)
  expect(without < 40).toBe(true)
  expect(withBonus > 50).toBe(true)
})

test('skipping a puzzle earns nothing and is not counted; with no puzzle there is nothing to answer', async () => {
  const { repo, deps } = await withEpic()
  await forceEncounter(deps)
  expect(await answerPuzzle({ ...deps, choice: 1, elapsedMs: 0 })).toBe(undefined)
  await repo.savePending({ ...(await repo.pending())!, puzzle: PUZZLE_FIXTURE })
  expect(await answerPuzzle({ ...deps, choice: undefined, elapsedMs: 0 })).toEqual({ isSkipped: true, isCorrect: false, bonus: 0 })
  expect(await repo.puzzleStats()).toEqual([])
})

test('an encounter a mission rolled carries its key, for its puzzle; a forced one does not', async () => {
  const { repo, deps } = await withEpic()
  await startMission({ ...deps, issueKey: 'NOVA-2' })
  await completeMission({ ...deps, now: 1000 })
  expect((await repo.pending())!.missionKey).toBe('NOVA-2')
  await repo.clearPending()
  await forceEncounter(deps)
  expect((await repo.pending())!.missionKey).toBe(undefined)
})

async function withCompanion(seed = 1, over: { xp?: number; level?: number; stage?: 0 | 1 | 2 } = {}) {
  const w = await withEpic(seed)
  const system = (await w.repo.system((await w.repo.systemIds())[0]!))!
  const species = system.species.find(s => s.kind === 'fauna')!
  await w.repo.addSpecimen({ id: 'spec-1', speciesId: species.id, systemId: system.id, tier: species.tier, level: 1, xp: 0, stage: 0, containedAt: 0, ...over })
  await w.repo.patchMeta(m => ({ ...m, companionId: 'spec-1' }))
  return { ...w, name: species.name, systemId: system.id, speciesId: species.id }
}

const companionOf = async (repo: Awaited<ReturnType<typeof fresh>>['repo'], id = 'spec-1') => (await repo.specimens()).find(s => s.id === id)!

test('with no companion a mission gives no XP and records none', async () => {
  const { repo, deps } = await withEpic()
  await startMission({ ...deps, issueKey: 'NOVA-2' })
  const out = await completeMission(deps)
  expect(out.text).not.toContain('XP')
  expect(out.report!.lines.some(l => l.includes('XP'))).toBe(false)
  expect('companionXp' in (await repo.missionLog()).at(-1)!.reward!).toBe(false)
})

test('the companion earns 10 XP for a mission of quality 0; the report names it, the command text does not', async () => {
  const { repo, deps, name } = await withCompanion()
  await startMission({ ...deps, issueKey: 'NOVA-2' })
  const out = await completeMission(deps)
  expect(out.text).toContain('Companion +10 XP')
  expect(out.text).not.toContain(name)
  expect(out.report!.lines).toContain(`${name} +10 XP (level 1)`)
  expect(out.companionToast).toBe(undefined)
  const held = await companionOf(repo)
  expect([held.xp, held.level]).toEqual([10, 1])
  expect((await repo.missionLog()).at(-1)!.reward!.companionXp).toEqual({ specimenId: 'spec-1', xp: 10 })
})

test('green tests raise mission XP to 15: a level up is reported and toasted', async () => {
  const { repo, deps, name } = await withCompanion()
  await startMission({ ...deps, issueKey: 'NOVA-2' })
  await recordBash({ ...deps, signals: classifyBash('npm test'), commits: 0, isError: false, output: '' })
  const out = await completeMission(deps)
  expect(out.text).toContain('Companion +15 XP')
  expect(out.report!.lines).toContain(`${name} +15 XP (level 2)`)
  expect(out.report!.lines).toContain(`${name} reached level 2.`)
  expect(out.companionToast).toBe(`${name} reached level 2.`)
  expect((await companionOf(repo)).level).toBe(2)
})

test('a closure with no work attached gives the companion nothing', async () => {
  const { repo, deps } = await withCompanion()
  await startMission({ ...deps, issueKey: 'NOVA-2' })
  const out = await completeMission({ ...deps, attachedWork: false })
  expect(out.text).not.toContain('XP')
  expect((await companionOf(repo)).xp).toBe(0)
  expect('companionXp' in (await repo.missionLog()).at(-1)!.reward!).toBe(false)
})

test('an epic survey gives the companion 25 XP; with no companion, none', async () => {
  const { repo, deps, name } = await withCompanion()
  const out = await completeEpic(deps)
  expect(out.text).toBe('Surveyed epic NOVA-1. Singularity Cell +1, Companion +25 XP. Encounter waiting.')
  expect(out.report!.lines).toContain(`${name} +25 XP (level 2)`)
  expect(out.companionToast).toBe(`${name} reached level 2.`)
  expect((await companionOf(repo)).xp).toBe(25)
  const plain = await withEpic()
  expect((await completeEpic(plain.deps)).text).toBe('Surveyed epic NOVA-1. Singularity Cell +1. Encounter waiting.')
})

test('reaching level 10 evolves the companion; reopening takes the XP back but not the evolution', async () => {
  const { repo, deps, name } = await withCompanion(1, { xp: xpForLevel(10) - 5, level: 9 })
  await startMission({ ...deps, issueKey: 'NOVA-2' })
  const out = await completeMission(deps)
  for (const line of [`${name} +10 XP (level 10)`, `${name} reached level 10.`, `${name} evolved!`]) expect(out.report!.lines).toContain(line)
  // One toast: the evolution outranks the level up.
  expect(out.companionToast).toBe(`${name} evolved!`)
  const evolved = await companionOf(repo)
  expect([evolved.level, evolved.stage]).toEqual([10, 1])
  const back = await reopenMission({ ...deps, issueKey: 'NOVA-2' })
  expect(back.text).toContain('Companion XP -10')
  const after = await companionOf(repo)
  expect([after.xp, after.level, after.stage]).toEqual([xpForLevel(10) - 5, 9, 1])
})

test('reopening takes XP from the specimen that earned it, even after the companion changed, never below 0', async () => {
  const { repo, deps, systemId, speciesId } = await withCompanion()
  await startMission({ ...deps, issueKey: 'NOVA-2' })
  await completeMission(deps)
  await repo.addSpecimen({ id: 'spec-2', speciesId, systemId, tier: 'common', level: 1, xp: 0, stage: 0, containedAt: 0 })
  await setCompanion({ ...deps, specimenId: 'spec-2' })
  // Its XP fell below what the mission gave (a save edited by hand): only what is held goes.
  await repo.saveSpecimens((await repo.specimens()).map(s => (s.id === 'spec-1' ? { ...s, xp: 4 } : s)))
  expect((await reopenMission({ ...deps, issueKey: 'NOVA-2' })).text).toContain('Companion XP -4')
  expect((await companionOf(repo)).xp).toBe(0)
  expect((await companionOf(repo, 'spec-2')).xp).toBe(0)
})
