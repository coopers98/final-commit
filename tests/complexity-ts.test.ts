import { expect, test } from 'claude-code/testing'
import { costOf } from '../src/puzzle/complexity'
import type { Unit } from '../src/puzzle/units'

// Invented code only (SPEC 15).

const ts = (...lines: string[]): Unit => ({ lang: 'TypeScript', name: /function\s+(\w+)/.exec(lines[0]!)![1]!, lines })
const answer = (u: Unit) => costOf(u)?.answer

/** A function `f` with the given signature parameters and body lines (indented by two). */
const fn = (params: string, ...body: string[]): Unit => ts(`function f(${params}): number {`, ...body.map((l) => `  ${l}`), '}')
/** A loop over `items` whose body is `line`, inside `f(items: number[], ids: number[])`. */
const inLoop = (line: string, params = 'items: number[], ids: number[]'): Unit => fn(params, 'let t = 0', 'for (const x of items) {', `  ${line}`, '  t += 1', '}', 'return t')
/** A unit with a `hidden` stub over `raw` (index into `lines` to raw text). */
const withHidden = (lines: string[], raw: Record<number, string>): Unit => ({ ...ts(...lines), hidden: (check) => Object.entries(raw).every(([at, text]) => check(text, Number(at))) })

test('for-of, counting and nested loops', async () => {
  expect(answer(ts('function f(items: number[]): number {', '  let t = 0', '  for (const x of items) {', '    t += x', '  }', '  return t', '}'))).toBe('O(n)')
  expect(answer(ts('function f(items: number[]): number {', '  let t = 0', '  for (let i = 0; i < items.length; i++) {', '    for (let j = i + 1; j < items.length; j++) {', '      t += items[i] * items[j]', '    }', '  }', '  return t', '}'))).toBe('O(n²)')
  expect(answer(ts('function f(items: number[], ids: number[]): number {', '  let t = 0', '  for (const x of items) {', '    for (const y of ids) {', '      t += x * y', '    }', '  }', '  return t', '}'))).toBe('O(n·m)')
})

test('a linear builtin inside a loop, and a sort', async () => {
  expect(answer(ts('function f(items: number[], ids: number[]): number {', '  let t = 0', '  for (const x of items) {', '    if (ids.includes(x)) {', '      t += 1', '    }', '  }', '  return t', '}'))).toBe('O(n·m)')
  expect(answer(ts('function f(items: number[]): number[] {', '  const s = items.toSorted((a, b) => a - b)', '  return s', '}'))).toBe('O(n log n)')
})

test('halving loops and the binary search shape', async () => {
  expect(answer(ts('function f(n: number): number {', '  let t = 0', '  for (let i = 1; i < n; i *= 2) {', '    t += i', '  }', '  return t', '}'))).toBe('O(log n)')
  expect(answer(ts('function find(items: number[], x: number): number {', '  let lo = 0', '  let hi = items.length - 1', '  while (lo <= hi) {', '    const mid = (lo + hi) >> 1', '    if (items[mid] === x) {', '      return mid', '    }', '    if (items[mid] < x) {', '      lo = mid + 1', '    } else {', '      hi = mid - 1', '    }', '  }', '  return -1', '}'))).toBe('O(log n)')
  // lo = mid can loop forever.
  expect(answer(ts('function find(items: number[], x: number): number {', '  let lo = 0', '  let hi = items.length', '  while (lo < hi) {', '    const mid = (lo + hi) >> 1', '    if (items[mid] < x) {', '      lo = mid', '    } else {', '      hi = mid', '    }', '  }', '  return lo', '}'))).toBe(undefined)
})

test('fails closed on the adversarial review counterexamples', async () => {
  // Derived value grown by push (round 2, #4).
  expect(answer(ts('function f(items: number[]): number {', '  const acc = items.slice()', '  for (const x of items) {', '    for (const y of items) {', '      acc.push(x * y)', '    }', '  }', '  let t = 0', '  for (const a of acc) {', '    t += a', '  }', '  return t', '}'))).toBe(undefined)
  // Growing the bound while looping (round 1, #3).
  expect(answer(ts('function f(items: number[]): number {', '  for (let i = 0; i < items.length; i++) {', '    items.push(i)', '  }', '  return 0', '}'))).toBe(undefined)
  // Spread into push costs m and is refused (round 1, #4).
  expect(answer(ts('function f(groups: number[], extra: number[]): number[] {', '  const out: number[] = []', '  for (const g of groups) {', '    out.push(...extra)', '  }', '  return out', '}'))).toBe(undefined)
  // A closure called in a loop (round 1, #5).
  expect(answer(ts('function f(items: number[]): number {', '  const count = (x: number) => {', '    let c = 0', '    for (const y of items) {', '      c += y === x ? 1 : 0', '    }', '    return c', '  }', '  let best = 0', '  for (const x of items) {', '    best = Math.max(best, count(x))', '  }', '  return best', '}'))).toBe(undefined)
  // A start that is not 0 or 1 (round 1, #6).
  expect(answer(ts('function f(items: number[]): number {', '  let t = 0', '  for (let i = items.length - 3; i < items.length; i++) {', '    t += items.indexOf(items[i])', '  }', '  return t', '}'))).toBe(undefined)
  // Every branch exits: the loop runs once (round 1, #7).
  expect(answer(ts('function f(items: number[], ids: number[]): boolean {', '  for (const x of items) {', '    if (ids.includes(x)) {', '      return true', '    } else {', '      return false', '    }', '  }', '  return false', '}'))).toBe(undefined)
  // A flag exit (round 2, #6).
  expect(answer(ts('function f(items: number[], ids: number[]): number {', '  let first = true', '  let t = 0', '  for (const x of items) {', '    if (!first) {', '      break', '    }', '    first = false', '    t += ids.indexOf(x)', '  }', '  return t', '}'))).toBe(undefined)
  // A size guard through a local (round 2, #7).
  expect(answer(ts('function f(items: number[]): number {', '  const n = items.length', '  if (n > 16) {', '    return -1', '  }', '  let t = 0', '  for (const x of items) {', '    for (const y of items) {', '      t += x * y', '    }', '  }', '  return t', '}'))).toBe(undefined)
  // A builtin name on a named, aliased or property receiver (round 1, #11; round 2, #5).
  expect(answer(ts('function f(items: Ids, x: number): number {', '  let t = 0', '  for (const y of items) {', '    t += items.indexOf(y)', '  }', '  return t', '}'))).toBe(undefined)
  // Unlisted method on a typed string inside a loop (round 2, #5).
  expect(answer(ts('function f(words: string[], text: string): number {', '  let t = 0', '  for (const w of words) {', '    if (text.toLowerCase() === w) {', '      t += 1', '    }', '  }', '  return t', '}'))).toBe(undefined)
  // Body on the header line (round 1, #10).
  expect(answer(ts('function f(a: number[]): number {', '  let t = 0', '  for (const x of a) t += x', '  for (const y of a) {', '    t += y', '  }', '  return t', '}'))).toBe(undefined)
  // Recursion.
  expect(answer(ts('function walk(items: number[]): number {', '  let t = 0', '  for (const x of items) {', '    t += walk(items)', '  }', '  return t', '}'))).toBe(undefined)
  // A comparator that is not constant (round 1, #5).
  expect(answer(ts('function f(items: number[]): number[] {', '  const s = items.toSorted((a, b) => items.indexOf(a) - items.indexOf(b))', '  return s', '}'))).toBe(undefined)
  // No loop and no counted builtin: constant, no puzzle.
  expect(answer(ts('function f(a: number, b: number): number {', '  const c = a + b', '  return c * 2', '}'))).toBe(undefined)
})

test('a callback is a loop body, and its cost multiplies', async () => {
  expect(answer(ts('function f(items: number[], ids: number[]): number[] {', '  const out = items.filter(x => ids.includes(x))', '  return out', '}'))).toBe('O(n·m)')
  expect(costOf(ts('function f(items: number[]): number {', '  let t = 0', '  items.forEach(x => {', '    t += items.indexOf(x)', '  })', '  return t', '}'))?.category).toBe('hidden linear call')
})

test('hidden lines: inert passes, a hidden cost fails, a hidden line without hidden() fails', async () => {
  const lines = ['function f(items: number[]): number {', '  let t = 0', '  for (const x of items) {', '    …', '    t += x', '  }', '  return t', '}']
  const raw: Record<number, string> = { 3: "    log('step')" }
  const withHidden = (r: Record<number, string>): Unit => ({ ...ts(...lines), hidden: check => Object.entries(r).every(([at, text]) => check(text, Number(at))) })
  expect(answer(withHidden(raw))).toBe('O(n)')
  expect(answer(withHidden({ 3: "    t += items.indexOf(x) // 'x'" }))).toBe(undefined)
  expect(answer(ts(...lines))).toBe(undefined)
})

// --- The loop table -------------------------------------------------------

test('counting up accepts a start of 0 or 1, < or <= with B - 1, and each step form; another start fails', async () => {
  for (const head of ['let i = 0; i < items.length; i++', 'let i = 1; i <= items.length - 1; ++i', 'let i = 0; i < items.length - 1; i += 1', 'let i = 0; i <= items.length; i++']) {
    expect(answer(fn('items: number[]', 'let t = 0', `for (${head}) {`, '  t += items[i]', '}', 'return t'))).toBe('O(n)')
  }
  expect(answer(fn('items: number[]', 'let t = 0', 'for (let i = 2; i < items.length; i++) {', '  t += items[i]', '}', 'return t'))).toBe(undefined)
  // A step that does not match the direction, or a bound other than B or B - 1.
  expect(answer(fn('items: number[]', 'let t = 0', 'for (let i = 0; i < items.length; i--) {', '  t += 1', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'let t = 0', 'for (let i = 0; i < items.length - 2; i++) {', '  t += 1', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'let t = 0', 'for (let i = 0; i < items.length; i += 2) {', '  t += 1', '}', 'return t'))).toBe(undefined)
  // Three clauses must name one index.
  expect(answer(fn('items: number[]', 'let t = 0', 'let j = 0', 'for (let i = 0; j < items.length; i++) {', '  t += 1', '}', 'return t'))).toBe(undefined)
})

test('counting down from B or B - 1 to a literal reads O(n); a start that is not B fails', async () => {
  expect(answer(fn('items: number[]', 'let t = 0', 'for (let i = items.length - 1; i >= 0; i--) {', '  t += items[i]', '}', 'return t'))).toBe('O(n)')
  expect(answer(fn('items: number[]', 'let t = 0', 'for (let i = items.length; i > 0; --i) {', '  t += 1', '}', 'return t'))).toBe('O(n)')
  expect(answer(fn('n: number', 'let t = 0', 'for (let i = n; i > 0; i -= 1) {', '  t += 1', '}', 'return t'))).toBe('O(n)')
  expect(answer(fn('items: number[]', 'let t = 0', 'for (let i = items.length - 2; i >= 0; i--) {', '  t += 1', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'let t = 0', 'for (let i = items.length; i > 0; i++) {', '  t += 1', '}', 'return t'))).toBe(undefined)
})

test('an inner index bound reads the enclosing factor; under a halving loop, or with an index start, it fails', async () => {
  expect(answer(fn('items: number[]', 'let t = 0', 'for (let i = 0; i < items.length; i++) {', '  for (let j = 0; j < i; j++) {', '    t += items[j]', '  }', '}', 'return t'))).toBe('O(n²)')
  expect(answer(fn('items: number[]', 'let t = 0', 'for (let i = items.length - 1; i >= 0; i--) {', '  for (let j = 0; j <= i; j++) {', '    t += 1', '  }', '}', 'return t'))).toBe('O(n²)')
  // Under a halving loop the inner sum is linear, not n log n.
  expect(answer(fn('n: number', 'let t = 0', 'for (let i = 1; i < n; i *= 2) {', '  for (let j = 0; j < i; j++) {', '    t += 1', '  }', '}', 'return t'))).toBe(undefined)
  // j from i + 1 to i never runs.
  expect(answer(fn('items: number[]', 'let t = 0', 'for (let i = 0; i < items.length; i++) {', '  for (let j = i + 1; j < i; j++) {', '    t += 1', '  }', '}', 'return t'))).toBe(undefined)
  // From an enclosing index over another size: the sum is not n × m.
  expect(answer(fn('items: number[], ids: number[]', 'let t = 0', 'for (let i = 0; i < ids.length; i++) {', '  for (let j = i; j < items.length; j++) {', '    t += 1', '  }', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'let t = 0', 'for (let i = 0; i < items.length; i++) {', '  for (let j = i - 1; j < items.length; j++) {', '    t += 1', '  }', '}', 'return t'))).toBe('O(n²)')
  // A bound that is a for-of element, not an index.
  expect(answer(fn('items: number[]', 'let t = 0', 'for (const x of items) {', '  for (let j = 0; j < x; j++) {', '    t += 1', '  }', '}', 'return t'))).toBe(undefined)
})

test('halving loops: *= 2, <<= 1, >>= 1 and Math.floor(i / 2) read O(log n); other starts and steps fail', async () => {
  for (const head of ['let i = 1; i < n; i <<= 1', 'let i = 1; i <= n; i *= 2', 'let i = n; i > 0; i >>= 1', 'let i = n; i > 0; i = Math.floor(i / 2)']) {
    expect(answer(fn('n: number', 'let t = 0', `for (${head}) {`, '  t += i', '}', 'return t'))).toBe('O(log n)')
  }
  expect(costOf(fn('items: number[]', 'let t = 0', 'for (let i = items.length; i > 0; i >>= 1) {', '  t += 1', '}', 'return t'))?.category).toBe('halving')
  for (const head of ['let i = 0; i < n; i *= 2', 'let i = 1; i < n; i *= 3', 'let i = n; i >= 0; i >>= 1', 'let i = n - 1; i > 0; i >>= 1', 'let i = 1; i > 0; i >>= 1']) {
    expect(answer(fn('n: number', 'let t = 0', `for (${head}) {`, '  t += i', '}', 'return t'))).toBe(undefined)
  }
})

test('a loop with both ends literal costs 1: alone no puzzle, beside a scan O(n)', async () => {
  expect(answer(fn('items: number[]', 'let t = 0', 'for (let i = 0; i < 8; i++) {', '  t += i', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'let t = 0', 'for (let i = 0; i < 8; i++) {', '  for (const x of items) {', '    t += x', '  }', '}', 'return t'))).toBe('O(n)')
})

test('a number parameter is a size by its value, and is reported as numeric', async () => {
  const r = costOf(fn('n: number', 'let t = 0', 'for (let i = 0; i < n; i++) {', '  t += i', '}', 'return t'))
  expect(r?.answer).toBe('O(n)')
  expect(r?.numeric).toEqual(['n'])
  expect(r?.params).toEqual(['n'])
})

test('size sources: for-in, Object.keys/values/entries, entries() and Map or Set parameters read O(n); a for-in over a Set fails', async () => {
  expect(answer(fn('o: Record<string, number>', 'let t = 0', 'for (const k in o) {', '  t += 1', '}', 'return t'))).toBe('O(n)')
  for (const src of ['Object.keys(o)', 'Object.values(o)']) {
    expect(answer(fn('o: Record<string, number>', 'let t = 0', `for (const v of ${src}) {`, '  t += 1', '}', 'return t'))).toBe('O(n)')
  }
  expect(answer(fn('o: Record<string, number>', 'let t = 0', 'for (const [k, v] of Object.entries(o)) {', '  t += v', '}', 'return t'))).toBe('O(n)')
  expect(answer(fn('items: number[]', 'let t = 0', 'for (const [i, x] of items.entries()) {', '  t += i * x', '}', 'return t'))).toBe('O(n)')
  expect(answer(fn('m: Map<string, number>', 'let t = 0', 'for (const [k, v] of m) {', '  t += v', '}', 'return t'))).toBe('O(n)')
  expect(answer(fn('s: Set<number> | undefined', 'let t = 0', 'for (const v of s.values()) {', '  t += v', '}', 'return t'))).toBe('O(n)')
  expect(answer(fn('text: string', 'let t = 0', 'for (const c of text) {', '  t += 1', '}', 'return t'))).toBe('O(n)')
  expect(answer(fn('s: Set<number>', 'let t = 0', 'for (const k in s) {', '  t += 1', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('m: Map<string, number>', 'let t = 0', 'for (const k of Object.keys(m)) {', '  t += 1', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('n: number', 'let t = 0', 'for (const k of n) {', '  t += 1', '}', 'return t'))).toBe(undefined)
  // A tuple or object type has a fixed size.
  for (const p of ['pair: [number, number]', 'pair: readonly [number, number]', 'pair: { a: number }']) {
    expect([p, answer(fn(p, 'let t = 0', 'for (const k of pair) {', '  t += 1', '}', 'return t'))]).toEqual([p, undefined])
  }
})

test('iterating a plain local, an accumulator, an element or a call fails; an untyped parameter reads O(n)', async () => {
  expect(answer(fn('items', 'let t = 0', 'for (const x of items) {', '  t += 1', '}', 'return t'))).toBe('O(n)')
  // An untyped or other-typed parameter may be a one-shot iterator: inside a loop it runs once.
  expect(answer(fn('items, ids: number[]', 'let t = 0', 'for (const y of ids) {', '  for (const x of items) {', '    t += 1', '  }', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: Iterable<number>', 'let t = 0', 'for (const y of items) {', '  for (const x of items) {', '    t += 1', '  }', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'const rows = load()', 'let t = 0', 'for (const x of rows) {', '  t += 1', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'const out: number[] = []', 'for (const x of items) {', '  out.push(x)', '}', 'let t = 0', 'for (const y of out) {', '  t += y', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('grid: number[][]', 'let t = 0', 'for (const row of grid) {', '  for (const v of row) {', '    t += v', '  }', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'let t = 0', 'for (const x of load(items)) {', '  t += 1', '}', 'return t'))).toBe(undefined)
  // A while loop that is not a binary search.
  expect(answer(fn('items: number[]', 'let i = 0', 'while (i < items.length) {', '  i += 1', '}', 'return i'))).toBe(undefined)
})

test('a loop index or element assigned in the body fails', async () => {
  expect(answer(fn('items: number[]', 'let t = 0', 'for (let i = 0; i < items.length; i++) {', '  i += 1', '  t += 1', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'let t = 0', 'for (let x of items) {', '  x = 0', '  t += 1', '}', 'return t'))).toBe(undefined)
})

// --- Binary search ----------------------------------------------------------

const search = (cond: string, hi: string, mid: string, ...body: string[]): Unit =>
  fn('items: number[], x: number', 'let lo = 0', `let hi = ${hi}`, `while (${cond}) {`, `  const mid = ${mid}`, ...body.map((l) => `  ${l}`), '}', 'return lo')
const halves = ['if (items[mid] < x) {', '  lo = mid + 1', '} else {', '  hi = mid - 1', '}']

test('binary search accepts each listed mid form and the < shape with hi = mid', async () => {
  for (const mid of ['(lo + hi) >> 1', 'lo + ((hi - lo) >> 1)', 'Math.floor((lo + hi) / 2)']) {
    expect(answer(search('lo <= hi', 'items.length - 1', mid, ...halves))).toBe('O(log n)')
  }
  const r = costOf(search('lo < hi', 'items.length', '(lo + hi) >> 1', 'if (items[mid] < x) {', '  lo = mid + 1', '} else {', '  hi = mid', '}'))
  expect(r?.answer).toBe('O(log n)')
  expect(r?.category).toBe('halving')
})

test('binary search refuses other mid forms, hi = mid with <=, mid not first, a path that assigns nothing, a continue, and reassignment elsewhere', async () => {
  expect(answer(search('lo <= hi', 'items.length - 1', '(lo + hi) >> 2', ...halves))).toBe(undefined)
  expect(answer(search('lo <= hi', 'items.length - 1', '(lo + hi) >> 1', 'if (items[mid] < x) {', '  lo = mid + 1', '} else {', '  hi = mid', '}'))).toBe(undefined)
  expect(answer(search('lo <= hi', 'items.length', '(lo + hi) >> 1', ...halves))).toBe(undefined)
  expect(answer(search('lo <= hi', 'items.length - 1', '(lo + hi) >> 1', 'if (items[mid] < x) {', '  lo = mid + 1', '}'))).toBe(undefined)
  expect(answer(search('lo <= hi', 'items.length - 1', '(lo + hi) >> 1', 'if (items[mid] === x) {', '  continue', '}', ...halves))).toBe(undefined)
  expect(answer(fn('items: number[], x: number', 'let lo = 0', 'let hi = items.length - 1', 'while (lo <= hi) {', '  const t = 1', '  const mid = (lo + hi) >> 1', ...halves.map((l) => `  ${l}`), '}', 'return lo'))).toBe(undefined)
  expect(answer(fn('items: number[], x: number', 'let lo = 0', 'let hi = items.length - 1', 'while (lo <= hi) {', '  const mid = (lo + hi) >> 1', ...halves.map((l) => `  ${l}`), '}', 'lo = 0', 'return lo'))).toBe(undefined)
  // lo and hi set somewhere other than just before the loop.
  expect(answer(fn('items: number[], x: number', 'let lo = 0', 'let hi = items.length - 1', 'let t = 0', 'while (lo <= hi) {', '  const mid = (lo + hi) >> 1', ...halves.map((l) => `  ${l}`), '}', 'return lo'))).toBe(undefined)
  // A loop over a size inside the search is log n × n.
  expect(answer(search('lo <= hi', 'items.length - 1', '(lo + hi) >> 1', 'for (const y of items) {', '  lo += 0', '}', ...halves))).toBe(undefined)
})

// --- Builtins by receiver -----------------------------------------------------

test('each linear builtin on an array parameter costs its size', async () => {
  for (const call of ['ids.includes(x)', 'ids.indexOf(x)', 'ids.lastIndexOf(x)', 'ids.join()', 'ids.join(sep)', 'ids.toReversed()', 'ids.slice()', 'ids.concat()', 'Array.from(ids)', 'Object.keys(ids)', 'new Set(ids)', '[...ids]', 'JSON.stringify(ids)', 'Math.max(...ids)', 'Math.min(...ids)', 'ids.reduceRight(merge)']) {
    expect([call, answer(inLoop(`const r = ${call}`))]).toEqual([call, 'O(n·m)'])
  }
  // entries, keys and values are lazy iterators: costly only as a for-of source.
  for (const call of ['ids.entries()', 'ids.keys()', 'ids.values()']) expect([call, answer(inLoop(`const r = ${call}`))]).toEqual([call, undefined])
  // A start index limits the search: Σ (m − i) is not n × m.
  for (const call of ['ids.indexOf(x, t)', 'ids.includes(x, t)', 'ids.lastIndexOf(x, t)', 'Array.from(ids, double)', 'JSON.stringify(ids, null)', 'Math.max(...ids, 0)']) {
    expect([call, answer(inLoop(`const r = ${call}`))]).toEqual([call, undefined])
  }
})

test('each iteration callback is a loop body over its receiver', async () => {
  for (const call of ['ids.filter(y => y > x)', 'ids.map(y => y + x)', 'ids.reduce((a, y) => a + y, 0)', 'ids.forEach(y => log(y))', 'ids.find(y => y === x)', 'ids.findIndex(y => y === x)', 'ids.some(y => y === x)', 'ids.forEach(log)', 'ids.map(double)']) {
    expect([call, answer(inLoop(`const r = ${call}`))]).toEqual([call, 'O(n·m)'])
  }
  expect(answer(fn('items: number[], ids: number[]', 'const ok = items.every(x => ids.includes(x))', 'return ok ? 1 : 0'))).toBe('O(n·m)')
  // A block callback with its body on the following lines.
  expect(answer(fn('items: number[], ids: number[]', 'const out = items.map((x, i) => {', '  const k = ids.indexOf(x)', '  return k + i', '})', 'return out.length'))).toBe('O(n·m)')
})

test('a short-circuit callback must be able to run to the end', async () => {
  // Always true at the first element: the call costs 1.
  expect(answer(fn('items: number[]', 'const r = items.find(x => x === x)', 'return r ?? 0'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'const r = items.some(x => x !== 0)', 'return r ? 1 : 0'))).toBe(undefined)
  // every stops at the first false; equality cannot hold for every element of a distinct source.
  expect(answer(fn('items: number[], t: number', 'const r = items.every(x => x === t)', 'return r ? 1 : 0'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'const r = items.find(isOk)', 'return r ?? 0'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'const r = items.some(x => {', '  return x === 1', '})', 'return r ? 1 : 0'))).toBe(undefined)
  expect(answer(fn('items: number[], t: number', 'const r = items.find(x => x === t)', 'return r ?? 0'))).toBe('O(n)')
})

test('each constant builtin keeps the loop O(n)', async () => {
  const params = 'items: number[], s: Set<number>, m: Map<number, number>, text: string, ids: number[]'
  for (const call of ['s.has(x)', 'm.has(x)', 'm.get(x)', 'ids.at(x)', 'ids.length', 's.size', 'text.length', 'text.at(x)', 'text.charAt(x)', 'text.charCodeAt(x)', 'text.codePointAt(x)', 'text[x]', 'ids[x]', 'Math.abs(x)', 'Math.max(x, 1)', 'Number(x)', 'parseInt(x)', 'lookup(x)', 'x.toFixed()']) {
    expect([call, answer(inLoop(`const r = ${call}`, params))]).toEqual([call, 'O(n)'])
  }
})

test('accumulators grow by constant operations, and anything else on one fails', async () => {
  expect(answer(fn('items: number[]', 'const out: number[] = []', 'const seen = new Set<number>()', 'const by = new Map<number, number>()', 'const count = {}', 'for (const x of items) {', '  for (const y of items) {', '    out.push(x * y)', '    seen.add(y)', '    by.set(x, y)', '    count[x] = y', '  }', '}', 'return out.length + seen.size'))).toBe('O(n²)')
  for (const use of ['return out.join()', 'return out.includes(1) ? 1 : 0', 'return [...out].length', 'return use(out)', 'out = []']) {
    expect([use, answer(fn('items: number[]', 'let out: number[] = []', 'for (const x of items) {', '  out.push(x)', '}', use))]).toEqual([use, undefined])
  }
  expect(answer(fn('items: number[]', 'const out: number[] = []', 'for (const x of items) {', '  out.push(x)', '}', 'return out.length'))).toBe('O(n)')
})

test('derived values are sized by their parameter; one built in a loop, reassigned or mutated is not', async () => {
  expect(answer(fn('items: number[], k: number', 'const big = items.filter(x => x > k)', 'let t = 0', 'for (const b of big) {', '  for (const x of items) {', '    t += b * x', '  }', '}', 'return t'))).toBe('O(n²)')
  for (const init of ['items.map(x => x * 2)', 'items.slice()', 'items.toReversed()', 'Array.from(items)', '[...items]', 'Object.values(items)']) {
    expect([init, answer(fn('items: number[], ids: number[]', `const d = ${init}`, 'let t = 0', 'for (const y of ids) {', '  if (d.includes(y)) {', '    t += 1', '  }', '}', 'return t'))]).toEqual([init, 'O(n·m)'])
  }
  expect(answer(fn('items: number[], ids: number[]', 'let t = 0', 'for (const y of ids) {', '  const d = items.slice()', '  t += 1', '}', 'for (const y of ids) {', '  t += 1', '}', 'return t'))).toBe('O(n·m)')
  expect(answer(fn('items: number[], ids: number[]', 'let d = items.slice()', 'd = ids.slice()', 'let t = 0', 'for (const y of d) {', '  t += y', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'const d = items.slice()', 'd.sort()', 'let t = 0', 'for (const y of d) {', '  t += y', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'const d = items.slice(0, 4)', 'let t = 0', 'for (const y of d) {', '  t += y', '}', 'return t'))).toBe(undefined)
  // A filter whose test may hold for no element can be empty: it is no size source.
  for (const test of ['x => x !== x', 'x => x > 2', 'isOk', 'x => first']) {
    expect([test, answer(fn('items: number[]', 'let first = true', `const d = items.filter(${test})`, 'let t = 0', 'for (const y of d) {', '  for (const x of items) {', '    t += x', '  }', '}', 'return t'))]).toEqual([test, undefined])
  }
  expect(answer(fn('items: number[], k: number', 'const d = items.filter(x => x !== k)', 'let t = 0', 'for (const y of d) {', '  for (const x of items) {', '    t += x', '  }', '}', 'return t'))).toBe('O(n²)')
})

test('a counted name on a receiver the reader does not know fails; other methods there cost 1', async () => {
  for (const p of ['items: Ids', 'items: T', 'items: Iterable<number>', 'items']) {
    expect([p, answer(fn(p, 'let t = 0', 'for (const x of items) {', '  t += items.indexOf(x)', '}', 'return t'))]).toEqual([p, undefined])
  }
  for (const line of ['const r = this.items.includes(x)', 'const r = load().map(double)', 'const r = repo.find(x)', 'const r = x.toString().split(sep)']) {
    expect([line, answer(inLoop(line))]).toEqual([line, undefined])
  }
  expect(answer(inLoop('const r = repo.fetch(x)'))).toBe('O(n)')
})

test('each failing name, global and unlisted method fails the unit', async () => {
  const params = 'items: number[], ids: number[], s: Set<number>, m: Map<number, number>, text: string'
  for (const call of ['ids.flat()', 'ids.flatMap(double)', 'name.split(sep)', 'name.replace(a, b)', 'name.replaceAll(a, b)', 'ids.splice(0, 1)', 'Object.assign(a, b)', 'JSON.parse(raw)', 'structuredClone(x)', 'eval(code)', 'Function(code)', 'arguments.length', 'Reflect.get(a, b)', 'ids.findLast(isOk)', 'ids.toSpliced(0)', 'text.includes(x)', 'text.indexOf(x)', 'text.slice()', 's.forEach(log)', 'm.keys()', 'new Array(x)', 'String(x)', 'Boolean(x)', 'Number.isInteger(x)', 'Array.isArray(x)', 'parseFloat(x)', 'ids.includes', 'new Set(load())', 'Math.max(...load())', 'ids.copyWithin(0, 1)', 'x instanceof Map']) {
    expect([call, answer(inLoop(`const r = ${call}`, params))]).toEqual([call, undefined])
  }
})

test('sorts cost n log n with a constant comparator; an in-place sort of a parameter only as a statement outside loops', async () => {
  expect(costOf(fn('items: number[]', 'items.sort((a, b) => a - b)', 'return items[0]'))?.category).toBe('sorting')
  expect(answer(fn('items: number[]', 'items.sort(byValue)', 'return items[0]'))).toBe('O(n log n)')
  expect(answer(fn('items: number[]', 'const s = items.toSorted((a, b) => {', '  return a - b', '})', 'return s[0]'))).toBe('O(n log n)')
  expect(answer(fn('items: number[]', 'let t = 0', 'for (const x of items) {', '  items.sort()', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'const s = items.sort()', 'return s[0]'))).toBe(undefined)
  // A sort beside a loop: n log n + n² is n².
  expect(answer(fn('items: number[]', 'const s = items.toSorted()', 'let t = 0', 'for (const x of s) {', '  for (const y of items) {', '    t += x * y', '  }', '}', 'return t'))).toBe('O(n²)')
})

// --- Whole-unit gates ---------------------------------------------------------

test('gate 3: plain parameters pass (optional, typed, defaulted, multi-line, arrow, method); destructured, rest and other defaults fail', async () => {
  const loop = ['  let t = 0', '  for (const x of items) {', '    t += x', '  }', '  return t', '}']
  expect(answer(ts('function f(items?: readonly number[], k = 3, flag: boolean = false): number {', ...loop))).toBe('O(n)')
  expect(answer(ts('function f(', '  items: ReadonlyArray<number> | undefined,', '  k: number,', '): number {', ...loop))).toBe('O(n)')
  expect(answer({ lang: 'TypeScript', name: 'f', lines: ['export const f = (items: Array<number>): number => {', ...loop] })).toBe('O(n)')
  expect(answer({ lang: 'TypeScript', name: 'f', lines: ['  public f(items: number[]): number {', ...loop] })).toBe('O(n)')
  expect(answer(ts('function f({ items }: Bag): number {', ...loop))).toBe(undefined)
  expect(answer(ts('function f(...items: number[]): number {', ...loop))).toBe(undefined)
  expect(answer(ts('function f(items: number[], k = load()): number {', ...loop))).toBe(undefined)
  expect(answer({ lang: 'TypeScript', name: 'f', lines: ['function* f(items: number[]): number {', ...loop] })).toBe(undefined)
  expect(answer({ lang: 'TypeScript', name: 'constructor', lines: ['  constructor(private items: number[]) {', ...loop] })).toBe(undefined)
  // A unit whose name does not match its signature.
  expect(answer({ lang: 'TypeScript', name: 'g', lines: ['function f(items: number[]): number {', ...loop] })).toBe(undefined)
})

test('gate 4: the unit naming itself anywhere after the first line fails', async () => {
  expect(answer({ lang: 'TypeScript', name: 'walk', lines: ['  walk(items: number[]): number {', '    let t = 0', '    for (const x of items) {', '      t += this.walk(items)', '    }', '    return t', '  }'] })).toBe(undefined)
})

test('gate 5: a nested function, class or arrow outside an iteration callback fails', async () => {
  for (const line of ['const g = (y: number) => y', 'const g = (y) => y', 'const g = y => y', 'const r = later(() => x)', 'const r = repo.each(y => y)']) {
    expect([line, answer(inLoop(line))]).toEqual([line, undefined])
  }
  expect(answer(fn('items: number[]', 'const g = function () {', '  return 1', '}', 'let t = 0', 'for (const x of items) {', '  t += x', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'class K {', '}', 'let t = 0', 'for (const x of items) {', '  t += x', '}', 'return t'))).toBe(undefined)
})

test('gate 6: do, while (true), for (;;), labels, for await, yield and await in a loop header fail', async () => {
  const cases: string[][] = [
    ['let t = 0', 'do {', '  t += 1', '} while (t < 3)', 'for (const x of items) {', '  t += x', '}', 'return t'],
    ['let t = 0', 'while (true) {', '  break', '}', 'for (const x of items) {', '  t += x', '}', 'return t'],
    ['let t = 0', 'for (;;) {', '  break', '}', 'for (const x of items) {', '  t += x', '}', 'return t'],
    ['let t = 0', 'outer: for (const x of items) {', '  t += x', '}', 'return t'],
    ['let t = 0', 'for await (const x of items) {', '  t += x', '}', 'return t'],
    ['let t = 0', 'for (const x of await load(1)) {', '  t += x', '}', 'return t'],
    ['let t = 0', 'for (const x of items) {', '  yield x', '}', 'return t'],
  ]
  for (const body of cases) expect([body[1], answer(fn('items: number[]', ...body))]).toEqual([body[1], undefined])
})

test('gate 7: a statement over two lines fails', async () => {
  expect(answer(fn('items: number[]', 'let t = 0', 'for (const x of items) {', '  t += x +', '    1', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'const s = items', '  .filter(x => x > 0)', 'let t = 0', 'for (const x of s) {', '  t += x', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'let t = 0', 'for (const x of items) {', '  t += 1', '}', '(t)', 'return t'))).toBe(undefined)
})

test('gate 8: a loop or if body on its header line, or without braces, fails', async () => {
  expect(answer(fn('items: number[]', 'let t = 0', 'for (const x of items) {', '  if (x > 1) t += 1', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'let t = 0', 'for (const x of items) {', '  if (x > 1)', '    t += 1', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'let t = 0', 'for (const x of items) {', '  t += 1', '}', 'if (t > 1)', '  t = 0', 'return t'))).toBe(undefined)
})

test('gate 9: assigning to or mutating a parameter fails', async () => {
  for (const line of ['items = ids', 'items[0] = x', 'ids.length = 0', 'n++', 'n += 1', 'ids.reverse()', 'ids.fill(0)', 'ids.unshift(x)', 'm.set(x, 1)', 'm.delete(x)', 's.add(x)', 'o.k = 1', 'ids.pop()', 'ids[0].push(x)', 'm.get(x).push(1)', 'o.list().push(x)']) {
    expect([line, answer(inLoop(line, 'items: number[], ids: number[], n: number, m: Map<number, number>, s: Set<number>, o: Box'))]).toEqual([line, undefined])
  }
})

test('gate 9 reaches through loop variables: an element of a parameter is not mutated either', async () => {
  expect(answer(fn('grid: number[][], ids: number[]', 'let t = 0', 'for (const row of grid) {', '  row.push(1)', '  t += 1', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('grid: number[][]', 'let t = 0', 'grid.forEach(row => row.pop())', 'return t'))).toBe(undefined)
  expect(answer(fn('grid: number[][]', 'let t = 0', 'for (const row of grid) {', '  t += row.length', '}', 'return t'))).toBe('O(n)')
})

test('a parameter or local named like a global fails', async () => {
  expect(answer(fn('items: number[]', 'const Set = load()', 'let t = 0', 'for (const x of items) {', '  t += x', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[], Math: Box', 'let t = 0', 'for (const x of items) {', '  t += x', '}', 'return t'))).toBe(undefined)
})

test('gate 10: a size compared with anything but another size or a loop index fails, except a tiny guard that exits', async () => {
  const nested = ['let t = 0', 'for (const x of items) {', '  for (const y of items) {', '    t += x * y', '  }', '}', 'return t']
  expect(answer(fn('items: number[]', 'if (items.length === 0) {', '  return 0', '}', ...nested))).toBe('O(n²)')
  expect(answer(fn('items: number[]', 'if (!items.length) {', '  return 0', '}', ...nested))).toBe('O(n²)')
  expect(answer(fn('items: number[], ids: number[]', 'if (items.length < 2 || ids.length === 0) {', '  return 0', '}', ...nested))).toBe('O(n²)')
  expect(answer(fn('items: number[], ids: number[]', 'if (items.length > ids.length) {', '  return 0', '}', ...nested))).toBe('O(n²)')
  expect(answer(fn('items: number[]', 'let t = 0', 'for (let i = 0; i < items.length; i++) {', '  if (i < items.length - 1) {', '    t += items[i]', '  }', '}', 'return t'))).toBe('O(n)')
  // Small sizes that do not exit, or exit for large sizes.
  expect(answer(fn('items: number[]', 'let t = 0', 'if (items.length < 2) {', '  for (const x of items) {', '    for (const y of items) {', '      t += x * y', '    }', '  }', '}', 'for (const x of items) {', '  t += x', '}', 'return t'))).toBe(undefined)
  for (const cond of ['items.length > 16', 'items.length >= 1', '!(items.length === 0)', 'items.length', 'items.length === 3', 'small(items.length)', 'items.length < k']) {
    expect([cond, answer(fn('items: number[], k: string', `if (${cond}) {`, '  return 0', '}', ...nested))]).toEqual([cond, undefined])
  }
  expect(answer(fn('items: number[]', 'const big = items.length > 16', 'let t = 0', 'for (const x of items) {', '  t += x', '}', 'return big ? 0 : t'))).toBe(undefined)
  expect(answer(fn('n: number', 'let t = 0', 'for (let i = 0; i < n; i++) {', '  t += n > 4 ? 1 : 0', '}', 'return t'))).toBe(undefined)
  // A tiny guard whose body is not constant.
  expect(answer(fn('items: number[], ids: number[]', 'if (items.length === 0) {', '  return ids.indexOf(1)', '}', ...nested))).toBe(undefined)
})

test('a condition that cannot depend on the input fails', async () => {
  expect(answer(fn('items: number[]', 'let t = 0', 'if (1 > 0) {', '  return 0', '}', 'for (const x of items) {', '  t += x', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[], k: number', 'let t = 0', 'if (k === k) {', '  return 0', '}', 'for (const x of items) {', '  t += x', '}', 'return t'))).toBe(undefined)
  for (const cond of ['k > 0 || k <= 0', 'on || !on', 'on && !on']) {
    expect([cond, answer(fn('items: number[], k: number, on: boolean', 'let t = 0', `if (${cond}) {`, '  return 0', '}', 'for (const x of items) {', '  t += x', '}', 'return t'))]).toEqual([cond, undefined])
  }
  expect(answer(fn('items: number[], k: number, on: boolean', 'let t = 0', 'if (on || k > 0) {', '  return 0', '}', 'for (const x of items) {', '  t += x', '}', 'return t'))).toBe('O(n)')
})

// --- Exits ----------------------------------------------------------------------

test('an ordinary search that may find its target keeps the worst case', async () => {
  expect(answer(fn('items: number[], x: number', 'for (let i = 0; i < items.length; i++) {', '  if (items[i] === x) {', '    return i', '  }', '}', 'return -1'))).toBe('O(n)')
  expect(answer(fn('items: number[], ids: number[]', 'for (const x of items) {', '  if (ids.includes(x)) {', '    return 1', '  }', '}', 'return 0'))).toBe('O(n·m)')
  expect(answer(fn('items: number[], ids: number[]', 'let t = 0', 'for (const x of items) {', '  for (const y of ids) {', '    if (y === x) {', '      break', '    }', '    t += 1', '  }', '}', 'return t'))).toBe('O(n·m)')
  // Two indices that are never equal compare distinct elements.
  expect(answer(fn('items: number[]', 'for (let i = 0; i < items.length; i++) {', '  for (let j = i + 1; j < items.length; j++) {', '    if (items[i] === items[j]) {', '      return 1', '    }', '  }', '}', 'return 0'))).toBe('O(n²)')
  // A throw with a target.
  expect(answer(fn('items: number[], x: number', 'let t = 0', 'for (const y of items) {', '  if (y === x) {', '    throw fault(y)', '  }', '  t += y', '}', 'return t'))).toBe('O(n)')
})

test('an exit that always or soon fires fails', async () => {
  const cases: string[][] = [
    // Unconditional.
    ['for (const x of items) {', '  return x', '}', 'return 0'],
    // An index.
    ['let t = 0', 'for (let i = 0; i < items.length; i++) {', '  if (i > 3) {', '    break', '  }', '  t += 1', '}', 'return t'],
    // A local.
    ['let t = 0', 'for (const x of items) {', '  if (t > 3) {', '    break', '  }', '  t += x', '}', 'return t'],
    // Inequality: almost every element differs.
    ['for (const x of items) {', '  if (x !== k) {', '    return x', '  }', '}', 'return 0'],
    // The same element source on both sides: equal at the first pair.
    ['for (const x of items) {', '  for (const y of items) {', '    if (x === y) {', '      return 1', '    }', '  }', '}', 'return 0'],
    ['for (let i = 0; i < items.length; i++) {', '  for (let j = 0; j < items.length; j++) {', '    if (items[i] === items[j]) {', '      return 1', '    }', '  }', '}', 'return 0'],
    // In an else.
    ['for (const x of items) {', '  if (x === k) {', '    log(x)', '  } else {', '    return 1', '  }', '}', 'return 0'],
    // An ordering against a literal.
    ['for (const x of items) {', '  if (x >= 0) {', '    return 1', '  }', '}', 'return 0'],
    // Code after an unconditional continue never runs.
    ['let t = 0', 'for (const x of items) {', '  continue', '  t += 1', '}', 'return t'],
  ]
  for (const body of cases) expect([body.join(' | '), answer(fn('items: number[], k: number', ...body))]).toEqual([body.join(' | '), undefined])
})

test('a callback return is no exit, but a throw in one is', async () => {
  expect(answer(fn('items: number[]', 'let t = 0', 'items.forEach(x => {', '  if (x > 3) {', '    return', '  }', '  t += x', '})', 'return t'))).toBe('O(n)')
  expect(answer(fn('items: number[]', 'let t = 0', 'items.forEach(x => {', '  throw fault(x)', '})', 'return t'))).toBe(undefined)
})

test('costly work on a path that runs at most once, or not every time, fails', async () => {
  // In the exiting branch: runs once.
  expect(answer(fn('items: number[], ids: number[], k: number', 'for (const x of items) {', '  if (x === k) {', '    return ids.indexOf(x)', '  }', '}', 'return 0'))).toBe(undefined)
  // On the first iteration only.
  expect(answer(fn('items: number[], ids: number[]', 'let t = 0', 'for (let i = 0; i < items.length; i++) {', '  if (i === 0) {', '    t += ids.indexOf(1)', '  }', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[], ids: number[]', 'let t = 0', 'for (let i = 0; i < items.length; i++) {', '  t += i === 0 ? ids.indexOf(1) : 0', '}', 'return t'))).toBe(undefined)
  // Equality on a source of distinct elements holds once at most.
  expect(answer(fn('s: Set<number>, ids: number[], k: number', 'let t = 0', 'for (const x of s) {', '  if (x === k) {', '    t += ids.indexOf(x)', '  }', '}', 'return t'))).toBe(undefined)
  // A flag that holds once.
  expect(answer(fn('items: number[], ids: number[]', 'let first = true', 'let t = 0', 'for (const x of items) {', '  if (first) {', '    t += ids.indexOf(x)', '    first = false', '  }', '}', 'return t'))).toBe(undefined)
  // After an exit on the same test, the branch never runs.
  expect(answer(fn('items: number[], ids: number[], k: number', 'let t = 0', 'for (const x of items) {', '  if (x === k) {', '    return t', '  }', '  if (x === k) {', '    t += ids.indexOf(x)', '  }', '}', 'return t'))).toBe(undefined)
})

test('costly work behind a test the input can satisfy every time keeps its cost', async () => {
  expect(answer(fn('items: number[], ids: number[], k: number', 'let t = 0', 'for (const x of items) {', '  if (x > k) {', '    t += ids.indexOf(x)', '  }', '}', 'return t'))).toBe('O(n·m)')
  expect(answer(fn('items: number[], ids: number[], k: number', 'let t = 0', 'for (const x of items) {', '  if (x === k) {', '    continue', '  }', '  t += ids.indexOf(x)', '}', 'return t'))).toBe('O(n·m)')
  expect(answer(fn('items: number[], ids: number[], k: number', 'let t = 0', 'for (const x of items) {', '  if (x === k) {', '    t += ids.indexOf(x)', '  }', '}', 'return t'))).toBe('O(n·m)')
  expect(answer(fn('items: number[], ids: number[], on: boolean', 'let t = 0', 'for (const x of items) {', '  if (on) {', '    t += ids.indexOf(x)', '  } else {', '    t += 1', '  }', '}', 'return t'))).toBe('O(n·m)')
})

// --- Locals, names and strings ----------------------------------------------

test('a parameter aliased, passed to a helper or shadowed fails; loop names may repeat in sibling loops', async () => {
  expect(answer(fn('items: number[]', 'const a = items', 'let t = 0', 'for (const x of items) {', '  t += x', '}', 'return t'))).toBe(undefined)
  expect(answer(inLoop('use(ids)'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'let t = 0', 'for (const items of load()) {', '  t += 1', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'let t = 0', 'for (const x of items) {', '  t += items.filter(x => x > 0).length', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'let t = 0', 'for (const x of items) {', '  t += x', '}', 'for (const x of items) {', '  t += x', '}', 'return t'))).toBe('O(n)')
})

test('+= on a value that may be a string inside a loop fails; on a number it passes', async () => {
  expect(answer(fn('items: number[]', "let s = ''", 'for (const x of items) {', '  s += x', '}', 'return s.length'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'let s = load()', 'for (const x of items) {', '  s = s + x', '}', 'return 0'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'let s: number = load()', 'for (const x of items) {', '  s += x', '}', 'return s'))).toBe('O(n)')
})

// --- Combining and categories ---------------------------------------------

test('sequential costs add, the dominated term drops, and incomparable sums fail', async () => {
  const two = (...body: string[]) => fn('items: number[], ids: number[]', 'let t = 0', ...body, 'return t')
  expect(answer(two('for (const x of items) {', '  t += x', '}', 'for (const y of ids) {', '  t += y', '}'))).toBe('O(n + m)')
  expect(costOf(two('for (const x of items) {', '  t += x', '}', 'for (const y of ids) {', '  t += y', '}'))?.category).toBe('two inputs')
  expect(answer(two('for (const x of items) {', '  t += x', '}', 'for (const x of items) {', '  for (const y of items) {', '    t += y', '  }', '}'))).toBe('O(n²)')
  expect(costOf(two('for (const x of items) {', '  for (const y of items) {', '    t += y', '  }', '}'))?.category).toBe('nested loops')
  expect(costOf(two('for (const x of items) {', '  t += x', '}'))?.category).toBe('linear scan')
  expect(answer(two('for (const x of items) {', '  for (const y of items) {', '    t += y', '  }', '}', 'for (const x of items) {', '  for (const y of ids) {', '    t += y', '  }', '}'))).toBe(undefined)
  // Branches count as all taken.
  expect(answer(fn('items: number[], ids: number[], on: boolean', 'let t = 0', 'if (on) {', '  for (const x of items) {', '    t += x', '  }', '} else {', '  t += ids.indexOf(1)', '}', 'return t'))).toBe('O(n + m)')
})

test('the explanation names shown lines', async () => {
  expect(costOf(fn('items: number[], ids: number[]', 'let t = 0', 'for (const x of items) {', '  t += ids.indexOf(x)', '}', 'return t'))?.explanation).toBe('Line 3: loop over items; line 4: indexOf on ids. n × m = O(n·m).')
})

test('Python and PHP units are not read yet', async () => {
  expect(costOf({ lang: 'Python', name: 'f', lines: ['def f(items):', '    for x in items:', '        pass'] })).toBe(undefined)
  expect(costOf({ lang: 'SQL', name: 'q', lines: ['select 1'] })).toBe(undefined)
})

// --- Hidden lines -----------------------------------------------------------

test('every blanked line is checked, a blanked lone close included', async () => {
  const lines = ['function f(items: number[]): number {', '  let t = 0', '  for (const x of items) {', '    t += x', '  }…', '  return t', '}']
  expect(answer(withHidden(lines, { 4: '  } // end' }))).toBe('O(n)')
  expect(answer(withHidden(lines, { 4: '  } while (g()) // c' }))).toBe(undefined)
})

test('a blanked opener must be an if or else; its body counts, and an exit inside it fails', async () => {
  const lines = ['function f(items: number[]): number {', '  let t = 0', '  for (const x of items) {', '    …{', '      t += x', '    }', '  }', '  return t', '}']
  expect(answer(withHidden(lines, { 3: "    if (mode() === 'a') {" }))).toBe('O(n)')
  // Its test is unknown and may never hold: a costly body under it fails.
  const costly = ['function f(items: number[]): number {', '  let t = 0', '  …{', '    for (const x of items) {', '      t += x', '    }', '  }', '  return t', '}']
  expect(answer(withHidden(costly, { 2: '  if (false) { // off' }))).toBe(undefined)
  for (const raw of ["    switch (mode('a')) {", "    const o = { // c", "    try { // c"]) expect([raw, answer(withHidden(lines, { 3: raw }))]).toEqual([raw, undefined])
  const exit = ['function f(items: number[]): number {', '  let t = 0', '  …{', '    return t', '  }', '  for (const x of items) {', '    t += x', '  }', '  return t', '}']
  expect(answer(withHidden(exit, { 2: "  if (mode() === 'a') {" }))).toBe(undefined)
  // A blanked else after a shown if: the if's exits make the code after it dead.
  const chain = ['function f(items: number[], k: number): number {', '  let t = 0', '  if (k === 1) {', '    return 0', '  }…{', '    return 1', '  }', '  for (const x of items) {', '    t += x', '  }', '  return t', '}']
  expect(answer(withHidden(chain, { 4: '  } else { // c' }))).toBe(undefined)
})

test('a hidden exit passes only last at body level or last in a guard outside loops', async () => {
  const last = ['function f(items: number[]): number {', '  let t = 0', '  for (const x of items) {', '    t += x', '  }', '  …']
  expect(answer(withHidden([...last, '}'], { 5: "  return 0 // 'none'" }))).toBe('O(n)')
  const guard = ['function f(items: number[]): number {', '  if (items.length === 0) {', '    …', '  }', '  let t = 0', '  for (const x of items) {', '    t += x', '  }', '  return t', '}']
  expect(answer(withHidden(guard, { 2: "    return 0 // 'none'" }))).toBe('O(n)')
  // The guard must exit: a hidden line that does not leaves the guard as a plain small-size branch.
  expect(answer(withHidden(guard, { 2: "    log('none')" }))).toBe(undefined)
  const inLoopLines = ['function f(items: number[]): number {', '  let t = 0', '  for (const x of items) {', '    …', '    t += x', '  }', '  return t', '}']
  expect(answer(withHidden(inLoopLines, { 3: "    break // 'x'" }))).toBe(undefined)
  // Not last in its guard: the code after it may never run.
  const early = ['function f(items: number[], k: number): number {', '  let t = 0', '  if (k === 1) {', '    …', '    for (const x of items) {', '      t += x', '    }', '  }', '  return t', '}']
  expect(answer(withHidden(early, { 3: "    return 0 // 'none'" }))).toBe(undefined)
})

test('the reader reads full lines and numbers sites from the shown offset', async () => {
  const full = ['function f(items: number[]): number {', '  let t = 0', '  for (const x of items) {', '    t += x', '  }', '  …', '}']
  const unit: Unit = { lang: 'TypeScript', name: 'f', lines: full.slice(0, 5), full: { lines: full, offset: 0 }, hidden: (check) => check("  log('done')", 5) }
  expect(costOf(unit)?.explanation).toBe('Line 3: loop over items. n = O(n).')
  expect(costOf({ ...unit, hidden: (check) => check('  return items.length // c', 5) })).toBe(undefined)
})
