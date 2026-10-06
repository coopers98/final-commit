import { expect, test } from 'claude-code/testing'
import { createRng } from '../src/rng'

test('same seed gives the same sequence', async () => {
  const a = createRng(42)
  const b = createRng(42)
  const left = [a.next(), a.next(), a.next()]
  const right = [b.next(), b.next(), b.next()]
  expect(left).toEqual(right)
})

test('different seeds diverge', async () => {
  expect(createRng(1).next()).not.toBe(createRng(2).next())
})

test('next stays in [0, 1)', async () => {
  const rng = createRng(7)
  for (let i = 0; i < 10_000; i += 1) {
    const x = rng.next()
    expect(x >= 0 && x < 1).toBe(true)
  }
})

test('int covers 0..n-1 and nothing else', async () => {
  const rng = createRng(3)
  const seen = new Set<number>()
  for (let i = 0; i < 2_000; i += 1) seen.add(rng.int(5))
  expect([...seen].sort()).toEqual([0, 1, 2, 3, 4])
})

test('chance(0) is never true and chance(1) is always true', async () => {
  const rng = createRng(9)
  for (let i = 0; i < 1_000; i += 1) {
    expect(rng.chance(0)).toBe(false)
    expect(rng.chance(1)).toBe(true)
  }
})

test('weighted follows the weights within 2 percentage points', async () => {
  const rng = createRng(11)
  const counts = { a: 0, b: 0, c: 0 }
  const n = 50_000
  for (let i = 0; i < n; i += 1) counts[rng.weighted({ a: 0.5, b: 0.3, c: 0.2 })] += 1
  expect(Math.abs(counts.a / n - 0.5) < 0.02).toBe(true)
  expect(Math.abs(counts.b / n - 0.3) < 0.02).toBe(true)
  expect(Math.abs(counts.c / n - 0.2) < 0.02).toBe(true)
})

test('weighted never picks a zero weight', async () => {
  const rng = createRng(5)
  for (let i = 0; i < 5_000; i += 1) expect(rng.weighted({ a: 0, b: 1 })).toBe('b')
})

test('weighted rejects an all-zero table', async () => {
  expect(() => createRng(1).weighted({ a: 0 })).toThrow()
})

test('pick returns members only', async () => {
  const rng = createRng(13)
  for (let i = 0; i < 500; i += 1) expect(['x', 'y']).toContain(rng.pick(['x', 'y']))
})
