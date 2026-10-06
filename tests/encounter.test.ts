import { expect, test } from 'claude-code/testing'
import { TIERS, TIER_SPECS } from '../src/config'
import { rollAttachment } from '../src/encounter/attachments'
import { missionQuality } from '../src/encounter/quality'
import { rollTier, tierWeights } from '../src/encounter/rarity'
import { DAY_MS, encounterChance, shouldEncounter } from '../src/encounter/roll'
import { createRng } from '../src/rng'

test('quality is 0, 0.5 or 1', async () => {
  expect(missionQuality({ testsGreen: false, tacticalClean: false })).toBe(0)
  expect(missionQuality({ testsGreen: true, tacticalClean: false })).toBe(0.5)
  expect(missionQuality({ testsGreen: true, tacticalClean: true })).toBe(1)
})

test('quality 0 gives the spec table', async () => {
  const w = tierWeights(0)
  for (const t of TIERS) expect(Math.abs(w[t] - TIER_SPECS[t].encounterOdds) < 1e-9).toBe(true)
})

test('higher quality makes Common rarer and keeps the table normalized', async () => {
  const low = tierWeights(0)
  const high = tierWeights(1)
  expect(high.common < low.common).toBe(true)
  expect(high.legendary > low.legendary).toBe(true)
  const sum = TIERS.reduce((s, t) => s + high[t], 0)
  expect(Math.abs(sum - 1) < 1e-9).toBe(true)
})

test('excludeCommon never rolls Common', async () => {
  const rng = createRng(21)
  for (let i = 0; i < 5_000; i += 1) expect(rollTier(rng, 0, { excludeCommon: true })).not.toBe('common')
})

test('rollTier matches the table at quality 0', async () => {
  const rng = createRng(22)
  const n = 100_000
  let common = 0
  for (let i = 0; i < n; i += 1) if (rollTier(rng, 0) === 'common') common += 1
  expect(Math.abs(common / n - 0.5) < 0.01).toBe(true)
})

test('encounter chance is 12% plus 12% per whole day, capped at 1', async () => {
  expect(Math.abs(encounterChance(0) - (0.12))).toBeLessThan(1e-9)
  expect(Math.abs(encounterChance(1.9) - (0.24))).toBeLessThan(1e-9)
  expect(Math.abs(encounterChance(3) - (0.48))).toBeLessThan(1e-9)
  expect(encounterChance(40)).toBe(1)
})

test('first completed mission ever is guaranteed', async () => {
  const rng = createRng(1)
  expect(shouldEncounter({ now: 0, lastEncounterAt: null, firstTrackedAt: 0, completedMissions: 0 }, rng)).toBe(true)
})

test('day 5 since the last encounter is guaranteed', async () => {
  const rng = createRng(1)
  const ctx = { now: 5 * DAY_MS, lastEncounterAt: 0, firstTrackedAt: 0, completedMissions: 3 }
  for (let i = 0; i < 100; i += 1) expect(shouldEncounter(ctx, rng)).toBe(true)
})

test('without a last encounter, days count from the first tracked mission', async () => {
  const rng = createRng(1)
  const ctx = { now: 6 * DAY_MS, lastEncounterAt: null, firstTrackedAt: 0, completedMissions: 2 }
  expect(shouldEncounter(ctx, rng)).toBe(true)
})

test('same day encounter rate is about 12%', async () => {
  const rng = createRng(77)
  const n = 50_000
  let hits = 0
  for (let i = 0; i < n; i += 1) {
    if (shouldEncounter({ now: 1000, lastEncounterAt: 0, firstTrackedAt: 0, completedMissions: 4 }, rng)) hits += 1
  }
  expect(Math.abs(hits / n - 0.12) < 0.01).toBe(true)
})

test('a clock earlier than the last encounter counts as day 0', async () => {
  const rng = createRng(5)
  const n = 20_000
  let hits = 0
  for (let i = 0; i < n; i += 1) {
    if (shouldEncounter({ now: 0, lastEncounterAt: DAY_MS, firstTrackedAt: 0, completedMissions: 4 }, rng)) hits += 1
  }
  expect(Math.abs(hits / n - 0.12) < 0.01).toBe(true)
})

test('attachments: about 85% none, items come from their class', async () => {
  const rng = createRng(33)
  const n = 50_000
  let none = 0
  for (let i = 0; i < n; i += 1) {
    const a = rollAttachment(rng)
    if (a === undefined) none += 1
    else if (a.class === 'mythic') expect(['crown', 'halo', 'orbiting moonlet']).toContain(a.item)
  }
  expect(Math.abs(none / n - 0.85) < 0.01).toBe(true)
})
