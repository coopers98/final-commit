import { expect, test } from 'claude-code/testing'
import { HARVEST, TIER_SPECS } from '../src/config'
import { createRng } from '../src/rng'
import type { Species, StarSystem } from '../src/store/schema'
import { addFlora, floraTiers, harvest, harvestCount, heldOfTier, spendFlora } from '../src/world/flora'

const plant = (id: string, tier: Species['tier']): Species => ({ id, kind: 'flora', tier, name: id, readout: '', stages: [] }) as unknown as Species
const system = (species: Species[]): StarSystem =>
  ({ id: 'sys-1', epicKey: 'NOVA-1', name: 'Kepler', starClass: 'G', biomes: [], species, status: 'open', chartedAt: 0 }) as unknown as StarSystem
const flora = system([plant('moss', 'common'), plant('fern', 'common'), plant('bloom', 'rare'), plant('crown', 'legendary')])
const tiers = floraTiers([flora])

test('a mission harvests from the minimum at quality 0 to the maximum at quality 1', async () => {
  expect(harvestCount(0)).toBe(HARVEST.minSamples)
  expect(harvestCount(0.5)).toBe(2)
  expect(harvestCount(1)).toBe(HARVEST.maxSamples)
  expect(harvestCount(5)).toBe(HARVEST.maxSamples)
})

test('harvest draws the system\'s flora by tier odds: Common mostly, Legendary rarely', async () => {
  const got = harvest(flora, 20_000, createRng(7))
  const total = Object.values(got).reduce((a, b) => a + b, 0)
  expect(total).toBe(20_000)
  const share = (t: Species['tier']) => heldOfTier(got, tiers, t) / total
  const odds = TIER_SPECS.common.encounterOdds + TIER_SPECS.rare.encounterOdds + TIER_SPECS.legendary.encounterOdds
  expect(Math.abs(share('common') - TIER_SPECS.common.encounterOdds / odds)).toBeLessThan(0.02)
  expect(Math.abs(share('legendary') - TIER_SPECS.legendary.encounterOdds / odds)).toBeLessThan(0.01)
  // Both Commons are drawn.
  expect(got.moss! > 0 && got.fern! > 0).toBe(true)
})

test('a system with no flora harvests nothing', async () => {
  expect(harvest(system([]), 3, createRng(1))).toEqual({})
})

test('spending flora takes the largest piles of the tier first, and refuses when too few are held', async () => {
  const held = { moss: 1, fern: 3, bloom: 2, stray: 9 }
  expect(spendFlora(held, tiers, 'common', 3)).toEqual({ moss: 1, bloom: 2, stray: 9 })
  expect(spendFlora(held, tiers, 'common', 4)).toEqual({ bloom: 2, stray: 9 })
  expect(spendFlora(held, tiers, 'common', 5)).toBe(undefined)
  // A species no charted system holds counts for no tier.
  expect(spendFlora(held, tiers, 'legendary', 1)).toBe(undefined)
  expect(heldOfTier(held, tiers, 'common')).toBe(4)
})

test('adding flora sums piles; taking it back never goes below zero and drops empty piles', async () => {
  expect(addFlora({ moss: 1 }, { moss: 2, fern: 1 })).toEqual({ moss: 3, fern: 1 })
  expect(addFlora({ moss: 1, fern: 2 }, { moss: 3, fern: 1 }, -1)).toEqual({ fern: 1 })
})
