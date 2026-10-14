import { expect, test } from 'claude-code/testing'
import { costOf } from '../src/puzzle/complexity'
import type { Category, Ladder } from '../src/puzzle/complexity'
import { CORPUS, instrument } from './complexity-growth-corpus'

// SPEC 8.4, Complexity Read: the growth corpus's keys. The measured growth is
// checked by scripts/growth-check.mjs (node), since generated code cannot run
// here. Invented code only (SPEC 15).

const LADDER: Ladder[] = ['O(log n)', 'O(n)', 'O(n log n)', 'O(n²)', 'O(n³)', 'O(n·m)', 'O(n + m)']
const CATEGORIES: Category[] = ['halving', 'sorting', 'hidden linear call', 'two inputs', 'nested loops', 'linear scan']

test('the corpus holds at least 20 distinct functions and covers every answer and category', async () => {
  expect(CORPUS.length).toBeGreaterThanOrEqual(20)
  expect(new Set(CORPUS.map((e) => e.name)).size).toBe(CORPUS.length)
  for (const a of LADDER) expect(CORPUS.some((e) => e.answer === a)).toBe(true)
  for (const c of CATEGORIES) expect(CORPUS.some((e) => e.category === c)).toBe(true)
})

test('the reader gives each corpus function its stated answer and category', async () => {
  for (const e of CORPUS) {
    const r = costOf({ lang: 'TypeScript', name: e.name, lines: e.lines })
    expect([e.name, r?.answer, r?.category]).toEqual([e.name, e.answer, e.category])
  }
})

test('counting goes at the top of every loop body and iteration callback, and nowhere else', async () => {
  expect(instrument(['function f(items: number[], ids: number[]): number {', '  let t = 0', '  for (const x of items) {', '    while (t < 3) {', '      t += 1', '    }', '  }', '  items.forEach((x, i) => {', '    t += x', '  })', '  return t', '}']).split('\n')).toEqual([
    'function f(items: number[], ids: number[]): number {', '  let t = 0', '  for (const x of items) { __c.n++;', '    while (t < 3) { __c.n++;', '      t += 1', '    }', '  }', '  items.forEach((x, i) => { __c.n++;', '    t += x', '  })', '  return t', '}',
  ])
  expect(instrument(['function f(items: number[], ids: number[]): number {', '  const s = items.reduce((a, x) => a + ids.indexOf(x), 0)', '  const k = items.filter(x => ids.includes(x)).map(x => x * 2)', '  const o = items.toSorted((a, b) => a - b)', '  return s + k.length + o.length', '}']).split('\n')).toEqual([
    'function f(items: number[], ids: number[]): number {', '  const s = items.reduce((a, x) => (__c.n++, a + ids.indexOf(x)), 0)', '  const k = items.filter(x => (__c.n++, ids.includes(x))).map(x => (__c.n++, x * 2))', '  const o = items.toSorted((a, b) => a - b)', '  return s + k.length + o.length', '}',
  ])
})
