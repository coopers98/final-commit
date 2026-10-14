// SPEC 8.4, Complexity Read: a corpus of invented TypeScript functions the
// reader accepts, each with its answer key and a generator of worst-case
// inputs by size, and the counting the growth check inserts. Counting reads
// only the text and the inputs, never the reader. Shared by
// complexity-growth.test.ts (the keys) and scripts/growth-check.mjs (the
// measured growth: the plugin's tests cannot run generated code).
// Invented code only (SPEC 15).
import type { Category, Ladder } from '../src/puzzle/complexity'

/** One corpus function: its lines, the reader's key, and inputs of size n (and m) built from the array class given. */
export type Entry = { name: string; lines: string[]; answer: Ladder; category: Category; inputs: (n: number, m: number, from: (xs: readonly number[]) => number[]) => unknown[] }

const range = (n: number, at = 0): number[] => Array.from({ length: n }, (_, i) => at + i)

export const CORPUS: readonly Entry[] = [
  // Linear scans.
  {
    name: 'total', answer: 'O(n)', category: 'linear scan',
    lines: ['function total(items: number[]): number {', '  let t = 0', '  for (const x of items) {', '    t += x', '  }', '  return t', '}'],
    inputs: (n, _m, from) => [from(range(n))],
  },
  {
    name: 'position', answer: 'O(n)', category: 'linear scan',
    // The target is never present: the exit never fires.
    lines: ['function position(items: number[], x: number): number {', '  for (let i = 0; i < items.length; i++) {', '    if (items[i] === x) {', '      return i', '    }', '  }', '  return -1', '}'],
    inputs: (n, _m, from) => [from(range(n)), -1],
  },
  {
    name: 'firstMatch', answer: 'O(n)', category: 'linear scan',
    lines: ['function firstMatch(items: number[], t: number): number {', '  const r = items.find(x => x === t)', '  return r ?? 0', '}'],
    inputs: (n, _m, from) => [from(range(n)), -1],
  },
  {
    name: 'sumUp', answer: 'O(n)', category: 'linear scan',
    lines: ['function sumUp(items: number[]): number {', '  const s = items.reduce((a, x) => a + x, 0)', '  return s', '}'],
    inputs: (n, _m, from) => [from(range(n))],
  },
  {
    name: 'countDown', answer: 'O(n)', category: 'linear scan',
    lines: ['function countDown(n: number): number {', '  let t = 0', '  for (let i = n; i > 0; i -= 1) {', '    t += 1', '  }', '  return t', '}'],
    inputs: (n) => [n],
  },
  {
    name: 'glyphs', answer: 'O(n)', category: 'linear scan',
    lines: ['function glyphs(text: string): number {', '  let t = 0', '  for (const c of text) {', '    t += 1', '  }', '  return t', '}'],
    inputs: (n) => ['q'.repeat(n)],
  },
  {
    name: 'mapTotal', answer: 'O(n)', category: 'linear scan',
    lines: ['function mapTotal(m: Map<string, number>): number {', '  let t = 0', '  for (const [k, v] of m) {', '    t += v', '  }', '  return t', '}'],
    inputs: (n) => [new Map(range(n).map((i) => [`k${i}`, i]))],
  },
  // Halving.
  {
    name: 'doublings', answer: 'O(log n)', category: 'halving',
    lines: ['function doublings(n: number): number {', '  let t = 0', '  for (let i = 1; i < n; i *= 2) {', '    t += i', '  }', '  return t', '}'],
    inputs: (n) => [n],
  },
  {
    name: 'halvings', answer: 'O(log n)', category: 'halving',
    lines: ['function halvings(items: number[]): number {', '  let t = 0', '  for (let i = items.length; i > 0; i >>= 1) {', '    t += 1', '  }', '  return t', '}'],
    inputs: (n, _m, from) => [from(range(n))],
  },
  {
    name: 'floorHalves', answer: 'O(log n)', category: 'halving',
    lines: ['function floorHalves(n: number): number {', '  let t = 0', '  for (let i = n; i > 0; i = Math.floor(i / 2)) {', '    t += 1', '  }', '  return t', '}'],
    inputs: (n) => [n],
  },
  {
    name: 'search', answer: 'O(log n)', category: 'halving',
    // Above every element: never found, so the search runs to its full depth.
    lines: ['function search(items: number[], x: number): number {', '  let lo = 0', '  let hi = items.length - 1', '  while (lo <= hi) {', '    const mid = (lo + hi) >> 1', '    if (items[mid] === x) {', '      return mid', '    }', '    if (items[mid] < x) {', '      lo = mid + 1', '    } else {', '      hi = mid - 1', '    }', '  }', '  return -1', '}'],
    inputs: (n, _m, from) => [from(range(n)), n + 1],
  },
  // Sorting.
  {
    name: 'ordered', answer: 'O(n log n)', category: 'sorting',
    lines: ['function ordered(items: number[]): number {', '  const s = items.toSorted((a, b) => a - b)', '  return s.length', '}'],
    inputs: (n, _m, from) => [from(range(n).reverse())],
  },
  {
    name: 'sortInPlace', answer: 'O(n log n)', category: 'sorting',
    lines: ['function sortInPlace(items: number[]): number {', '  items.sort((a, b) => a - b)', '  return items.length', '}'],
    inputs: (n, _m, from) => [from(range(n).reverse())],
  },
  {
    name: 'sortThenSum', answer: 'O(n log n)', category: 'sorting',
    lines: ['function sortThenSum(items: number[]): number {', '  const s = items.toSorted((a, b) => a - b)', '  let t = 0', '  for (const x of s) {', '    t += x', '  }', '  return t', '}'],
    inputs: (n, _m, from) => [from(range(n).reverse())],
  },
  // Nested loops.
  {
    name: 'pairs', answer: 'O(n²)', category: 'nested loops',
    lines: ['function pairs(items: number[]): number {', '  let t = 0', '  for (let i = 0; i < items.length; i++) {', '    for (let j = i + 1; j < items.length; j++) {', '      t += items[i] * items[j]', '    }', '  }', '  return t', '}'],
    inputs: (n, _m, from) => [from(range(n))],
  },
  {
    name: 'triangle', answer: 'O(n²)', category: 'nested loops',
    lines: ['function triangle(n: number): number {', '  let t = 0', '  for (let i = 0; i < n; i++) {', '    for (let j = 0; j < i; j++) {', '      t += 1', '    }', '  }', '  return t', '}'],
    inputs: (n) => [n],
  },
  {
    name: 'grid', answer: 'O(n²)', category: 'nested loops',
    lines: ['function grid(items: number[]): number {', '  let t = 0', '  items.forEach(x => {', '    for (const y of items) {', '      t += x * y', '    }', '  })', '  return t', '}'],
    inputs: (n, _m, from) => [from(range(n))],
  },
  {
    name: 'triples', answer: 'O(n³)', category: 'nested loops',
    lines: ['function triples(items: number[]): number {', '  let t = 0', '  for (let i = 0; i < items.length; i++) {', '    for (let j = i + 1; j < items.length; j++) {', '      for (let k = j + 1; k < items.length; k++) {', '        t += 1', '      }', '    }', '  }', '  return t', '}'],
    inputs: (n, _m, from) => [from(range(n))],
  },
  {
    name: 'cube', answer: 'O(n³)', category: 'nested loops',
    lines: ['function cube(n: number): number {', '  let t = 0', '  for (let i = 0; i < n; i++) {', '    for (let j = 0; j < n; j++) {', '      for (let k = 0; k < n; k++) {', '        t += 1', '      }', '    }', '  }', '  return t', '}'],
    inputs: (n) => [n],
  },
  // Hidden linear calls.
  {
    name: 'ranks', answer: 'O(n²)', category: 'hidden linear call',
    lines: ['function ranks(items: number[]): number {', '  let t = 0', '  for (const x of items) {', '    t += items.indexOf(x)', '  }', '  return t', '}'],
    inputs: (n, _m, from) => [from(range(n))],
  },
  {
    name: 'lastRanks', answer: 'O(n²)', category: 'hidden linear call',
    lines: ['function lastRanks(items: number[]): number {', '  let t = 0', '  items.forEach(x => {', '    t += items.lastIndexOf(x)', '  })', '  return t', '}'],
    inputs: (n, _m, from) => [from(range(n))],
  },
  {
    name: 'shared', answer: 'O(n·m)', category: 'hidden linear call',
    lines: ['function shared(items: number[], ids: number[]): number {', '  let t = 0', '  for (const x of items) {', '    if (ids.includes(x)) {', '      t += 1', '    }', '  }', '  return t', '}'],
    inputs: (n, m, from) => [from(range(n)), from(range(m, n))],
  },
  {
    name: 'kept', answer: 'O(n·m)', category: 'hidden linear call',
    lines: ['function kept(items: number[], ids: number[]): number {', '  const out = items.filter(x => ids.includes(x))', '  return out.length', '}'],
    inputs: (n, m, from) => [from(range(n)), from(range(m, n))],
  },
  {
    name: 'allKnown', answer: 'O(n·m)', category: 'hidden linear call',
    // Every element is known: every never stops early.
    lines: ['function allKnown(items: number[], ids: number[]): number {', '  const ok = items.every(x => ids.includes(x))', '  return ok ? 1 : 0', '}'],
    inputs: (n, m, from) => [from(range(n).map((i) => i % m)), from(range(m))],
  },
  // Two inputs.
  {
    name: 'products', answer: 'O(n·m)', category: 'two inputs',
    lines: ['function products(items: number[], ids: number[]): number {', '  let t = 0', '  for (const x of items) {', '    for (const y of ids) {', '      t += x * y', '    }', '  }', '  return t', '}'],
    inputs: (n, m, from) => [from(range(n)), from(range(m))],
  },
  {
    name: 'untilMatch', answer: 'O(n·m)', category: 'two inputs',
    // Disjoint inputs: the inner break never fires.
    lines: ['function untilMatch(items: number[], ids: number[]): number {', '  let t = 0', '  for (const x of items) {', '    for (const y of ids) {', '      if (y === x) {', '        break', '      }', '      t += 1', '    }', '  }', '  return t', '}'],
    inputs: (n, m, from) => [from(range(n)), from(range(m, n))],
  },
  {
    name: 'both', answer: 'O(n + m)', category: 'two inputs',
    lines: ['function both(items: number[], ids: number[]): number {', '  let t = 0', '  for (const x of items) {', '    t += x', '  }', '  for (const y of ids) {', '    t += y', '  }', '  return t', '}'],
    inputs: (n, m, from) => [from(range(n)), from(range(m))],
  },
  {
    name: 'scanThenFind', answer: 'O(n + m)', category: 'two inputs',
    // 1 is never in ids: indexOf reads all of it.
    lines: ['function scanThenFind(items: number[], ids: number[]): number {', '  let t = 0', '  for (const x of items) {', '    t += x', '  }', '  t += ids.indexOf(1)', '  return t', '}'],
    inputs: (n, m, from) => [from(range(n)), from(range(m, 2))],
  },
]

/** The calls whose callbacks are loop bodies. */
export const ITERATORS = ['forEach', 'map', 'filter', 'find', 'findIndex', 'some', 'every', 'reduce']
/** The array methods that cost their receiver's length (sorts: length × log2(length + 1)). */
export const LINEAR = ['includes', 'indexOf', 'lastIndexOf', 'slice', 'concat', 'join', 'toReversed']
export const SORTS = ['toSorted', 'sort']

const ITERATOR_CALL = new RegExp(`\\.(${ITERATORS.join('|')})\\(`)
const LOOP_HEAD = /^\s*(for|while)\b/

/** Index of the end of an arrow's expression body starting at `from`: the `)` or top-level `,` that closes it. */
function bodyEnd(line: string, from: number): number {
  let depth = 0
  for (let i = from; i < line.length; i++) {
    const c = line[i]!
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return i
      depth--
    } else if (c === ',' && depth === 0) return i
  }
  return line.length
}

/** Wraps each expression-bodied arrow passed to an iteration call on the line: `x => e` becomes `x => (__c.n++, e)`. */
function wrapArrows(line: string): string {
  let out = line
  let at = 0
  for (;;) {
    const call = ITERATOR_CALL.exec(out.slice(at))
    if (!call) return out
    const open = at + call.index + call[0].length
    const arrow = /^\s*(\w+|\([^()]*\))\s*=>\s*/.exec(out.slice(open))
    if (!arrow || out[open + arrow[0].length] === '{') {
      at = open
      continue
    }
    const start = open + arrow[0].length
    const end = bodyEnd(out, start)
    out = `${out.slice(0, start)}(__c.n++, ${out.slice(start, end)})${out.slice(end)}`
    at = start
  }
}

/** The function's text with a count of one at the top of every loop body and every iteration callback; types are left for the caller to strip. */
export function instrument(lines: readonly string[]): string {
  return lines
    .map((line, i) => {
      if (i === 0) return line
      const opens = line.trimEnd().endsWith('{')
      if (opens && (LOOP_HEAD.test(line) || ITERATOR_CALL.test(line))) return `${line} __c.n++;`
      return wrapArrows(line)
    })
    .join('\n')
}
