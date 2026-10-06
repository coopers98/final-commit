import { expect, test } from 'claude-code/testing'
import { KEYS, createMemoryStore } from '../src/store/repo'
import { createRepo } from '../src/store/repo'
import { migrate } from '../src/store/migrate'
import { STORE } from '../src/config'

test('migrate creates meta on an empty store', async () => {
  const store = createMemoryStore()
  const meta = await migrate(store, 1_000)
  expect(meta.createdAt).toBe(1_000)
  expect(await store.get(KEYS.meta)).toEqual({ ...meta, schemaVersion: STORE.schemaVersion })
})

test('migrate is idempotent', async () => {
  const store = createMemoryStore()
  const first = await migrate(store, 1_000)
  const second = await migrate(store, 9_999)
  expect(second).toEqual(first)
})

test('a corrupt meta value is replaced and logged', async () => {
  const store = createMemoryStore()
  await store.set(KEYS.meta, 'not an object')
  const lines: string[] = []
  const meta = await migrate(store, 5, line => lines.push(line))
  expect(meta.createdAt).toBe(5)
  expect((await store.get(KEYS.meta)) as { schemaVersion: number }).toMatchObject({ schemaVersion: STORE.schemaVersion })
  expect(lines.length).toBe(1)
})

test('a meta from a newer build is left alone and reported', async () => {
  const store = createMemoryStore()
  await store.set(KEYS.meta, { schemaVersion: 99, createdAt: 1, firstTrackedAt: null, lastEncounterAt: null, completedMissions: 0 })
  await expect(migrate(store, 5)).rejects.toThrow()
})

test('every value the repo writes carries schemaVersion', async () => {
  const store = createMemoryStore()
  await migrate(store, 0)
  const repo = createRepo(store)
  await repo.saveInventory({ reinforced: 2, stasis: 0, singularity: 0, flora: {} })
  await repo.addSpecimen({
    id: 's1', speciesId: 'sp1', systemId: 'sys1', tier: 'common', level: 1, xp: 0, stage: 0, containedAt: 10,
  })
  for (const value of Object.values(store.dump())) {
    expect(typeof (value as { schemaVersion?: unknown }).schemaVersion).toBe('number')
  }
})

test('reads of missing keys return defaults', async () => {
  const repo = createRepo(createMemoryStore())
  expect(await repo.inventory()).toEqual({ reinforced: 0, stasis: 0, singularity: 0, flora: {} })
  expect(await repo.specimens()).toEqual([])
  expect(await repo.activeMission()).toBe(undefined)
  expect(await repo.pending()).toBe(undefined)
})

test('a value of the wrong shape reads as the default and is logged', async () => {
  const store = createMemoryStore()
  await store.set(KEYS.inventory, { schemaVersion: STORE.schemaVersion, reinforced: 'lots' })
  const lines: string[] = []
  const repo = createRepo(store, line => lines.push(line))
  expect((await repo.inventory()).reinforced).toBe(0)
  expect(lines.length).toBe(1)
})

test('schema 1 to 2: every value is restamped and missions gain a null lint verdict', async () => {
  const store = createMemoryStore()
  const mission = { issueKey: 'NOVA-2', systemId: 's', startedAt: 0, commits: 1, testRuns: 1, testsGreen: true, tacticalClean: false }
  await store.set(KEYS.meta, { schemaVersion: 1, createdAt: 1, firstTrackedAt: null, lastEncounterAt: null, completedMissions: 1, activeEpicKey: 'NOVA-1', companionId: null, encountersToday: { day: '', count: 0 } })
  await store.set(KEYS.activeMission, { ...mission, schemaVersion: 1 })
  await store.set(KEYS.missionLog, { items: [{ ...mission, issueKey: 'NOVA-3', completedAt: 5 }], schemaVersion: 1 })
  await store.set(KEYS.inventory, { reinforced: 2, stasis: 0, singularity: 0, flora: {}, schemaVersion: 1 })
  const meta = await migrate(store, 9)
  expect(meta.completedMissions).toBe(1)
  const repo = createRepo(store)
  expect(await repo.activeMission()).toEqual({ ...mission, lint: null })
  expect((await repo.missionLog()).map(m => m.lint)).toEqual([null])
  expect((await repo.inventory()).reinforced).toBe(2)
  for (const value of Object.values(store.dump())) expect((value as { schemaVersion: number }).schemaVersion).toBe(STORE.schemaVersion)
})

test('schema 2 to 3: values are restamped and the unowned single sync record is dropped', async () => {
  const store = createMemoryStore()
  await store.set(KEYS.meta, { schemaVersion: 2, createdAt: 1, firstTrackedAt: null, lastEncounterAt: null, completedMissions: 4, activeEpicKey: 'NOVA-1', companionId: null, encountersToday: { day: '', count: 0 } })
  await store.set(KEYS.inventory, { reinforced: 3, stasis: 0, singularity: 0, flora: {}, schemaVersion: 2 })
  await store.set('fc:sync', { lastSync: 5, processed: ['NOVA-2:t1'], schemaVersion: 2 })
  const meta = await migrate(store, 9)
  expect(meta.completedMissions).toBe(4)
  expect(await store.get('fc:sync')).toBe(undefined)
  const repo = createRepo(store)
  expect((await repo.inventory()).reinforced).toBe(3)
  expect(await repo.sync('jira')).toEqual({ lastSync: null, processed: [] })
  for (const value of Object.values(store.dump())) expect((value as { schemaVersion: number }).schemaVersion).toBe(3)
})
