import { expect, test } from 'claude-code/testing'
import { KEYS, createMemoryStore } from '../src/store/repo'
import { createRepo } from '../src/store/repo'
import { migrate } from '../src/store/migrate'

test('migrate creates meta on an empty store', async () => {
  const store = createMemoryStore()
  const meta = await migrate(store, 1_000)
  expect(meta.createdAt).toBe(1_000)
  expect(await store.get(KEYS.meta)).toEqual({ ...meta, schemaVersion: 1 })
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
  expect((await store.get(KEYS.meta)) as { schemaVersion: number }).toMatchObject({ schemaVersion: 1 })
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
  await store.set(KEYS.inventory, { schemaVersion: 1, reinforced: 'lots' })
  const lines: string[] = []
  const repo = createRepo(store, line => lines.push(line))
  expect((await repo.inventory()).reinforced).toBe(0)
  expect(lines.length).toBe(1)
})
