import { expect, test } from 'claude-code/testing'
import { SCAN } from '../src/config'
import { scanRows, silhouette, unresolvedSignals } from '../src/bridge/scan'
import { completeEpic, completeMission, startEpic, startMission } from '../src/game'
import { createRng } from '../src/rng'
import { migrate } from '../src/store/migrate'
import { createMemoryStore, createRepo } from '../src/store/repo'
import type { StarSystem } from '../src/store/schema'
import type { Complete } from '../src/world/generate'

const offline: Complete = async () => ({ ok: false, reason: 'offline' })

async function withEpic() {
  const store = createMemoryStore()
  await migrate(store, 0)
  const repo = createRepo(store)
  const deps = { repo, now: 0, rng: createRng(1) }
  await startEpic({ ...deps, epic: { key: 'NOVA-1', title: 'Billing export', description: '' }, complete: offline, privacy: 'standard' })
  const system = (await repo.system((await repo.systemIds())[0]!))!
  return { repo, deps, system }
}

const texts = (system: StarSystem, ...rest: Parameters<typeof scanRows> extends [unknown, ...infer R] ? R : never) =>
  scanRows(system, ...rest).map(r => r.text)

test('unmet Common and Uncommon lifeforms are named; Rare and up are counted; Anomaly never shows', async () => {
  const { system } = await withEpic()
  const all = texts(system, [], []).join('\n')
  for (const s of system.species) {
    if (SCAN.namedTiers.includes(s.tier)) expect(all).toContain(`${s.name}  not yet encountered`)
    else expect(all).not.toContain(s.name)
  }
  expect(all).toContain('signals, unidentified')
  expect(all).not.toContain('Anomaly')
  expect(all).toContain('No lifeforms met here yet.')
  // No completion ratio: an epic holds too few missions to meet a whole system.
  expect(all).not.toMatch(/\d+\/\d+/)
})

test('a met lifeform shows its best status; a resolved one shows only its silhouette', async () => {
  const { system } = await withEpic()
  const rare = system.species.filter(s => s.tier === 'rare')
  const [met, shaped] = [rare[0]!, rare[1]!]
  const rows = scanRows(system, [{ speciesId: met.id, tier: 'rare', status: 'seen' }, { speciesId: met.id, tier: 'rare', status: 'contained' }], [shaped.id])
  const all = rows.map(r => r.text)
  expect(all).toContain(`${met.name}  contained`)
  expect(all).toContain('Met 1 here, 1 contained.')
  expect(all.join('\n')).not.toContain(shaped.name)
  const art = rows.filter(r => r.isArt).map(r => r.text)
  expect(art).toEqual(silhouette(shaped.stages[0]!.rows))
  expect(art.join('').replace(/[ #]/g, '')).toBe('')
})

test('hidden signals resolve lowest tier first, skipping met, resolved, named and hidden tiers', async () => {
  const { system } = await withEpic()
  const order = unresolvedSignals(system, [], []).map(s => s.tier)
  expect(order[0]).toBe('rare')
  expect(order).not.toContain('common')
  expect(order).not.toContain('anomaly')
  const first = unresolvedSignals(system, [], [])[0]!
  expect(unresolvedSignals(system, [], [first.id]).map(s => s.id)).not.toContain(first.id)
  expect(unresolvedSignals(system, [{ speciesId: first.id, tier: first.tier, status: 'escaped' }], []).map(s => s.id)).not.toContain(first.id)
})

test('a mission with no encounter resolves one signal; a closure with no work resolves none', async () => {
  const { repo, deps } = await withEpic()
  await startMission({ ...deps, issueKey: 'NOVA-2' })
  await completeMission(deps) // the first mission always has an encounter
  expect(await repo.resolved()).toEqual([])
  await startMission({ ...deps, issueKey: 'NOVA-3' })
  const out = await completeMission(deps)
  expect(out.report!.encounter).toBe(null)
  expect(out.report!.lines.at(-1)).toBe("Sensors resolved a Rare signal's shape. /scan")
  expect((await repo.resolved()).length).toBe(1)
  await startMission({ ...deps, issueKey: 'NOVA-4' })
  await completeMission({ ...deps, attachedWork: false })
  expect((await repo.resolved()).length).toBe(1)
})

test('a survey resolves every hidden signal left', async () => {
  const { repo, deps, system } = await withEpic()
  const out = await completeEpic(deps)
  const resolved = await repo.resolved()
  expect(resolved.length).toBeGreaterThan(1)
  expect(out.report!.lines).toContain(`Sensors resolved ${resolved.length} hidden signals' shapes. /scan`)
  expect(unresolvedSignals(system, await repo.catalog(), await repo.resolved())).toEqual([])
})
