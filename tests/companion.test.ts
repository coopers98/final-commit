import { expect, test } from 'claude-code/testing'
import { grantXp, levelForXp, missionXp, stageForLevel, stageRows, takeXp, xpForLevel, xpToNext } from '../src/companion'
import { COMPANION_XP } from '../src/config'
import { NO_MOOD, snapshot } from '../src/runtime'
import { migrate } from '../src/store/migrate'
import { createMemoryStore, createRepo } from '../src/store/repo'
import type { Specimen, StarSystem } from '../src/store/schema'

const specimen = (over: Partial<Specimen> = {}): Specimen => ({
  id: 'spec-1', speciesId: 'sys-1:f0', systemId: 'sys-1', tier: 'common', level: 1, xp: 0, stage: 0, containedAt: 0, ...over,
})

test('the level curve: 15 XP to level 2, then 5 more for each level after', async () => {
  expect([1, 2, 3, 10].map(xpToNext)).toEqual([15, 20, 25, 60])
  expect(levelForXp(0)).toBe(1)
  expect(levelForXp(14)).toBe(1)
  expect(levelForXp(15)).toBe(2)
  expect(levelForXp(34)).toBe(2)
  expect(levelForXp(35)).toBe(3)
  for (const level of [2, 5, 10, 25, 50]) {
    expect(levelForXp(xpForLevel(level))).toBe(level)
    expect(levelForXp(xpForLevel(level) - 1)).toBe(level - 1)
  }
  expect(levelForXp(-5)).toBe(1)
})

test('the level is capped at 99, however much XP is held', async () => {
  expect(levelForXp(xpForLevel(COMPANION_XP.maxLevel))).toBe(99)
  expect(levelForXp(10_000_000)).toBe(99)
})

test('evolution: stage 1 at level 10, stage 2 at level 25', async () => {
  expect([1, 9, 10, 24, 25, 99].map(stageForLevel)).toEqual([0, 0, 1, 1, 2, 2])
})

test('mission XP scales with quality, 10 to 20', async () => {
  expect([0, 0.5, 1].map(missionXp)).toEqual([10, 15, 20])
  expect(missionXp(0.24)).toBe(12)
  expect(missionXp(2)).toBe(20)
})

test('granting XP raises the level and evolves at its levels; a level up and an evolution are flagged', async () => {
  const small = grantXp(specimen(), 10)
  expect([small.specimen.xp, small.specimen.level, small.isLevelUp, small.isEvolved]).toEqual([10, 1, false, false])
  const up = grantXp(small.specimen, 5)
  expect([up.specimen.level, up.isLevelUp, up.isEvolved]).toEqual([2, true, false])
  const evolved = grantXp(specimen(), xpForLevel(10))
  expect([evolved.specimen.level, evolved.specimen.stage, evolved.isEvolved]).toEqual([10, 1, true])
  const twice = grantXp(specimen(), xpForLevel(25))
  expect([twice.specimen.stage, twice.isEvolved]).toEqual([2, true])
})

test('taking XP back lowers the level but never the stage, and never goes below 0', async () => {
  const evolved = grantXp(specimen(), xpForLevel(10)).specimen
  const back = takeXp(evolved, 100)
  expect([back.taken, back.specimen.level < 10, back.specimen.stage]).toEqual([100, true, 1])
  const empty = takeXp(specimen({ xp: 4 }), 15)
  expect([empty.taken, empty.specimen.xp, empty.specimen.level]).toEqual([4, 0, 1])
})

test('a sprite at a stage falls back to the last stage drawn below it, then to none', async () => {
  const rows = (s: string) => ({ rows: [s] })
  const three = { stages: [rows('a'), rows('b'), rows('c')] }
  expect([0, 1, 2].map(st => stageRows(three, st))).toEqual([['a'], ['b'], ['c']])
  // Flora have one stage; a missing or empty stage falls back.
  expect(stageRows({ stages: [rows('a')] }, 2)).toEqual(['a'])
  expect(stageRows({ stages: [rows('a'), { rows: [] }, rows('c')] }, 1)).toEqual(['a'])
  expect(stageRows({ stages: [rows('a'), rows('b')] }, 2)).toEqual(['b'])
  expect(stageRows({ stages: [] }, 1)).toEqual([])
  expect(stageRows(undefined, 0)).toEqual([])
})

test('the band draws the companion at its stage', async () => {
  const store = createMemoryStore()
  await migrate(store, 0)
  const repo = createRepo(store)
  const system = {
    id: 'sys-1', epicKey: 'NOVA-1', name: 'Kessa Reach', starClass: 'K', lore: '', biomes: [], status: 'open', chartedAt: 0,
    species: [{ id: 'sys-1:f0', kind: 'fauna', tier: 'common', name: 'Glimmer', readout: '', behavior: '', stages: [{ rows: ['egg'] }, { rows: ['pup'] }], anchors: {}, isProcedural: true }],
  } as unknown as StarSystem
  await repo.saveSystem(system)
  await repo.addSpecimen(specimen({ stage: 1 }))
  await repo.patchMeta(m => ({ ...m, companionId: 'spec-1' }))
  expect((await snapshot(repo, NO_MOOD, 0)).band!.sprite).toEqual(['pup'])
  await repo.saveSpecimens([specimen({ stage: 2 })])
  expect((await snapshot(repo, NO_MOOD, 0)).band!.sprite).toEqual(['pup'])
})
