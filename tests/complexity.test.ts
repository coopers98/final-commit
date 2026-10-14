import { expect, test } from 'claude-code/testing'
import { add, factor, mul, ONE, readCost, simplify, type Factor } from '../src/puzzle/complexity'

// Invented code only (SPEC 15).

const f = (size: string, at: number, kind: Factor['kind'] = 'loop', log = false, what = `loop over ${size}`): Factor => ({ size, log, kind, at, what })

test('nested loops over one input read O(n²), sequential ones keep the dominant term', async () => {
  const nested = mul(factor(f('items', 2)), factor(f('items', 3)))
  expect(readCost(nested, [], 0)?.answer).toBe('O(n²)')
  expect(readCost(add(nested, factor(f('items', 6))), [], 0)?.answer).toBe('O(n²)')
})

test('n log n is dominated by n², but n² and n·m are not comparable and fail', async () => {
  const sort = mul(factor(f('items', 1, 'sort', false, 'sort of items')), factor(f('items', 1, 'sort', true, 'sort of items')))
  const sq = mul(factor(f('items', 2)), factor(f('items', 3)))
  expect(readCost(add(sort, sq), [], 0)?.answer).toBe('O(n²)')
  const nm = mul(factor(f('items', 5)), factor(f('ids', 6)))
  expect(readCost(add(sq, nm), [], 0)).toBe(undefined)
})

test('two inputs: product is n·m, sum is n + m, n is the first size in line order', async () => {
  const r = readCost(mul(factor(f('ids', 4)), factor(f('items', 2))), [], 0)
  expect(r?.answer).toBe('O(n·m)')
  expect(r?.n).toBe('items')
  expect(r?.m).toBe('ids')
  expect(readCost(add(factor(f('items', 2)), factor(f('ids', 5))), [], 0)?.answer).toBe('O(n + m)')
})

test('a constant cost, a third size, or n² log n is no reading', async () => {
  expect(readCost(ONE, [], 0)).toBe(undefined)
  expect(readCost(mul(mul(factor(f('a', 1)), factor(f('b', 2))), factor(f('c', 3))), [], 0)).toBe(undefined)
  const sq = mul(factor(f('a', 1)), factor(f('a', 2)))
  expect(readCost(mul(sq, factor(f('a', 3, 'halving', true))), [], 0)).toBe(undefined)
})

test('an answer in one size names it n', async () => {
  const r = readCost(factor(f('ids', 3)), [], 0)
  expect(r?.answer).toBe('O(n)')
  expect(r?.n).toBe('ids')
  expect(r?.m).toBe(undefined)
})

test('category: halving, sorting, hidden linear call, two inputs, nested loops, linear scan, by precedence', async () => {
  const halving = mul(factor(f('a', 1)), factor(f('a', 2, 'halving', true)))
  expect(readCost(halving, [], 0)?.category).toBe('halving')
  const sorting = mul(factor(f('a', 1, 'sort')), factor(f('a', 1, 'sort', true)))
  expect(readCost(sorting, [], 0)?.category).toBe('sorting')
  expect(readCost(mul(factor(f('a', 1)), factor(f('a', 2, 'builtin', false, 'includes on a'))), [], 0)?.category).toBe('hidden linear call')
  expect(readCost(mul(factor(f('a', 1)), factor(f('a', 2, 'callback'))), [], 0)?.category).toBe('nested loops')
  expect(readCost(mul(factor(f('a', 1)), factor(f('b', 2))), [], 0)?.category).toBe('two inputs')
  expect(readCost(mul(factor(f('a', 1)), factor(f('a', 2))), [], 0)?.category).toBe('nested loops')
  expect(readCost(factor(f('a', 1, 'builtin', false, 'sum of a')), [], 0)?.category).toBe('linear scan')
})

test('the explanation names sites in line order with pane line numbers, and the product', async () => {
  const r = readCost(mul(factor(f('items', 4, 'builtin', false, 'includes on items')), factor(f('items', 2))), [], 1)
  expect(r?.explanation).toBe('Line 2: loop over items; line 4: includes on items. n × n = O(n²).')
})

test('simplify keeps one copy of equal-shaped terms', async () => {
  expect(simplify(add(factor(f('a', 1)), factor(f('a', 5)))).length).toBe(1)
})
