import { expect, test } from 'claude-code/testing'
import { containmentChance, resolveAttempt } from '../src/contain/resolve'
import { createRng } from '../src/rng'

test('base chance with no bonuses is the tier base', async () => {
  expect(Math.abs(containmentChance({ tier: 'rare', cell: 'standard', latticeBonus: 0, quality: 0 }) - (0.45))).toBeLessThan(1e-9)
})

test('bonuses add: cell, lattice, puzzle, quality', async () => {
  const c = containmentChance({ tier: 'exotic', cell: 'reinforced', latticeBonus: 0.1, quality: 0.5, puzzleBonus: 0.05 })
  expect(Math.abs(c - (0.25 + 0.15 + 0.1 + 0.05 + 0.05))).toBeLessThan(1e-9)
})

test('chance is capped at 98%', async () => {
  expect(containmentChance({ tier: 'common', cell: 'singularity', latticeBonus: 0.25, quality: 1 })).toBe(0.98)
})

test('negative or oversized bonuses are clamped', async () => {
  expect(Math.abs(containmentChance({ tier: 'rare', cell: 'standard', latticeBonus: -1, quality: -3 }) - (0.45))).toBeLessThan(1e-9)
  expect(Math.abs(containmentChance({ tier: 'anomaly', cell: 'standard', latticeBonus: 0, quality: 7 }) - (0.05 + 0.1))).toBeLessThan(1e-9)
})

test('outcome rates follow chance then flee', async () => {
  const rng = createRng(101)
  const n = 50_000
  const counts = { contained: 0, 'broke-free': 0, fled: 0 }
  for (let i = 0; i < n; i += 1) counts[resolveAttempt({ tier: 'rare', cell: 'standard', latticeBonus: 0, quality: 0 }, rng)] += 1
  // contained 0.45; fled 0.55 * 0.35 = 0.1925; broke free 0.3575
  expect(Math.abs(counts.contained / n - 0.45) < 0.01).toBe(true)
  expect(Math.abs(counts.fled / n - 0.1925) < 0.01).toBe(true)
})
