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
// Task 7 fix round 2 (ruling D′): a filter body that names another parameter refuses (it builds a derived collection).
  expect(answer(ts('function f(items: number[], ids: number[]): number[] {', '  const out = items.filter(x => ids.includes(x))', '  return out', '}'))).toBe(undefined)
  expect(costOf(ts('function f(items: number[]): number {', '  let t = 0', '  items.forEach(x => {', '    t += items.indexOf(x)', '  })', '  return t', '}'))?.category).toBe('hidden linear call')
})

test('hidden lines: inert passes, a hidden cost fails, a hidden line without hidden() fails', async () => {
  const lines = ['function f(items: number[]): number {', '  let t = 0', '  for (const x of items) {', '    …', '    t += x', '  }', '  return t', '}']
  const raw: Record<number, string> = { 3: '    // step' }
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

test('halving loops: *= 2 and Math.floor(i / 2) read O(log n); shift steps, other starts and steps fail', async () => {
  for (const head of ['let i = 1; i < n; i *= 2', 'let i = 1; i <= n; i *= 2', 'let i = n; i > 0; i = Math.floor(i / 2)']) {
    expect(answer(fn('n: number', 'let t = 0', `for (${head}) {`, '  t += i', '}', 'return t'))).toBe('O(log n)')
  }
  expect(costOf(fn('items: number[]', 'let t = 0', 'for (let i = items.length; i > 0; i = Math.floor(i / 2)) {', '  t += 1', '}', 'return t'))?.category).toBe('halving')
  // Task 7 fix round 1 (ruling C): a 32-bit shift wraps (`1 << 31` is negative), so no shift step counts.
  for (const head of ['let i = 1; i < n; i <<= 1', 'let i = n; i > 0; i >>= 1', 'let i = n; i > 0; i >>>= 1', 'let i = 0; i < n; i *= 2', 'let i = 1; i < n; i *= 3', 'let i = n; i >= 0; i >>= 1', 'let i = n - 1; i > 0; i >>= 1', 'let i = 1; i > 0; i >>= 1']) {
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
  // An object's values are opaque: counted, not added.
  expect(answer(fn('o: Record<string, number>', 'let t = 0', 'for (const [k, v] of Object.entries(o)) {', '  t += 1', '}', 'return t'))).toBe('O(n)')
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
  for (const call of ['ids.includes(x)', 'ids.indexOf(x)', 'ids.lastIndexOf(x)', 'ids.join()', "ids.join(',')", 'ids.toReversed()', 'ids.slice()', 'ids.concat()', 'Array.from(ids)', 'Object.keys(ids)', 'new Set(ids)', '[...ids]', 'JSON.stringify(ids)', 'Math.max(...ids)', 'Math.min(...ids)', 'ids.reduceRight(merge, 0)']) {
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
// Task 7 fix round 2 (ruling D′): a map builds from its own parameters and fixed-cost operands only, and never with a block body.
  expect(answer(fn('items: number[], ids: number[]', 'const out = items.map((x, i) => {', '  const k = ids.indexOf(x)', '  return k + i', '})', 'return out.length'))).toBe(undefined)
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
  for (const call of ['s.has(x)', 'm.has(x)', 'm.get(x)', 'ids.length', 's.size', 'text.length', 'Math.abs(x)', 'Math.max(x, 1)', 'Number(x)', 'parseInt(x)', 'lookup(x)', 'x.toFixed(2)']) {
    expect([call, answer(inLoop(`const r = ${call}`, params))]).toEqual([call, 'O(n)'])
  }
  // Reads by position take a loop's index.
  for (const call of ['ids.at(i)', 'text.at(i)', 'text.charAt(i)', 'text.charCodeAt(i)', 'text.codePointAt(i + 1)', 'text[i]', 'ids[i - 1]']) {
    expect([call, answer(fn(params, 'let t = 0', 'for (let i = 0; i < items.length; i++) {', `  const r = ${call}`, '  t += 1', '}', 'return t'))]).toEqual([call, 'O(n)'])
  }
})

test('accumulators grow by constant operations, and anything else on one fails', async () => {
  expect(answer(fn('items: number[]', 'const out: number[] = []', 'const seen = new Set<number>()', 'const by = new Map<number, number>()', 'for (const x of items) {', '  for (const y of items) {', '    out.push(x * y)', '    seen.add(y)', '    by.set(x, y)', '  }', '}', 'return out.length + seen.size'))).toBe('O(n²)')
  // Task 6 fix round 3: a bracket write takes a number key on an array accumulator or fresh array only.
  expect(answer(fn('items: number[]', 'const count = {}', 'for (const x of items) {', '  count[x] = 1', '}', 'return 0'))).toBe(undefined)
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
  expect(costOf(fn('items: number[]', 'items.sort((a, b) => a - b)', 'return items.length'))?.category).toBe('sorting')
  expect(answer(fn('items: number[]', 'items.sort(byValue)', 'return items.length'))).toBe('O(n log n)')
  expect(answer(fn('items: number[]', 'const s = items.toSorted((a, b) => {', '  return a - b', '})', 'return s.length'))).toBe('O(n log n)')
  expect(answer(fn('items: number[]', 'let t = 0', 'for (const x of items) {', '  items.sort()', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'const s = items.sort()', 'return s.length'))).toBe(undefined)
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
  // Task 6 fix round 4: one value in two atoms of a test fails (the read-once grammar).
  expect(answer(fn('items: number[], ids: number[]', 'if (items.length < 2 || items.length === 0) {', '  return 0', '}', ...nested))).toBe(undefined)
  expect(answer(fn('items: number[], ids: number[]', 'if (items.length < 2) {', '  return 0', '}', ...nested))).toBe('O(n²)')
  // Two size sources in one test fail (fix round 2, family 3).
  expect(answer(fn('items: number[], ids: number[]', 'if (items.length > ids.length) {', '  return 0', '}', ...nested))).toBe(undefined)
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
  // Since fix round 3 (ruling E), a membership exit refuses.
  expect(answer(fn('items: number[], ids: number[]', 'for (const x of items) {', '  if (ids.includes(x)) {', '    return 1', '  }', '}', 'return 0'))).toBe(undefined)
  expect(answer(fn('items: number[], ids: number[]', 'let t = 0', 'for (const x of items) {', '  for (const y of ids) {', '    if (y === x) {', '      break', '    }', '    t += 1', '  }', '}', 'return t'))).toBe('O(n·m)')
  // Since fix round 3 (ruling A), an index from i + 1 does not walk items: no element.
  expect(answer(fn('items: number[]', 'for (let i = 0; i < items.length; i++) {', '  for (let j = i + 1; j < items.length; j++) {', '    if (items[i] === items[j]) {', '      return 1', '    }', '  }', '}', 'return 0'))).toBe(undefined)
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

test('an untyped Python parameter is no loop source, and SQL has no reader', async () => {
  expect(costOf({ lang: 'Python', name: 'f', lines: ['def f(items):', '    for x in items:', '        pass'] })).toBe(undefined)
  expect(costOf({ lang: 'SQL', name: 'q', lines: ['select 1'] })).toBe(undefined)
})

// --- Hidden lines -----------------------------------------------------------

test('every blanked line is checked, a blanked lone close included', async () => {
  const lines = ['function f(items: number[]): number {', '  let t = 0', '  for (const x of items) {', '    t += x', '  }…', '  return t', '}']
  expect(answer(withHidden(lines, { 4: '  } // end' }))).toBe('O(n)')
  expect(answer(withHidden(lines, { 4: '  } while (g()) // c' }))).toBe(undefined)
})

test('a blanked opener must be an else; its body counts, and an exit inside it fails', async () => {
  const lines = ['function f(items: number[]): number {', '  let t = 0', '  for (const x of items) {', '    …{', '      t += x', '    }', '  }', '  return t', '}']
  // Task 6 fix round 1: a hidden test may raise (`if (1 / q.r) {`), so a hidden opener is only an else.
  expect(answer(withHidden(lines, { 3: "    if (mode() === 'a') {" }))).toBe(undefined)
  const elseLines = ['function f(items: number[], k: number): number {', '  let t = 0', '  if (k === 1) {', '    t = 1', '  }…{', '    t = 2', '  }', '  for (const x of items) {', '    t += x', '  }', '  return t', '}']
  expect(answer(withHidden(elseLines, { 4: '  } else { // c' }))).toBe('O(n)')
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

test('a hidden exit passes only last at body level (task 6 fix round 3: not in a guard)', async () => {
  const last = ['function f(items: number[]): number {', '  let t = 0', '  for (const x of items) {', '    t += x', '  }', '  …']
  expect(answer(withHidden([...last, '}'], { 5: "  return 0 // 'none'" }))).toBe('O(n)')
  const guard = ['function f(items: number[]): number {', '  if (items.length === 0) {', '    …', '  }', '  let t = 0', '  for (const x of items) {', '    t += x', '  }', '  return t', '}']
  // Task 6 fix round 3: a hidden exit only as the function's last line (guards may be complementary).
  expect(answer(withHidden(guard, { 2: "    return 0 // 'none'" }))).toBe(undefined)
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
  const unit: Unit = { lang: 'TypeScript', name: 'f', lines: full.slice(0, 5), full: { lines: full, offset: 0 }, hidden: (check) => check('  // done', 5) }
  expect(costOf(unit)?.explanation).toBe('Line 3: loop over items. n = O(n).')
  expect(costOf({ ...unit, hidden: (check) => check('  return items.length // c', 5) })).toBe(undefined)
})

// --- Fix round 1 (task review of 696ba9b) ------------------------------------

const nest = ['let t = 0', 'for (const x of items) {', '  for (const y of items) {', '    t += x * y', '  }', '}', 'return t']

test('an index from entries(), keys(), for-in or Object.keys is no element (fix 1)', async () => {
  const exits: [string, string][] = [
    ['const [i, x] of items.entries()', 'i === 3'],
    ['const i of items.keys()', 'i === 3'],
    ['const k in items', "k === '3'"],
    ['const k of Object.keys(items)', "k === '3'"],
    ['const e of items.entries()', 'e[0] === 3'],
  ]
  for (const [head, test] of exits) {
    expect([head, answer(fn('items: number[]', 'let t = 0', `for (${head}) {`, `  if (${test}) {`, '    return t', '  }', '  t += 1', '}', 'return t'))]).toEqual([head, undefined])
  }
  expect(answer(fn('items: number[]', 'const ks = Object.keys(items)', 'let t = 0', 'for (const k of ks) {', "  if (k === '3') {", '    return t', '  }', '  t += 1', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[], ids: number[]', 'let t = 0', 'for (const k in items) {', "  if (k === '0') {", '    t += ids.indexOf(1)', '  }', '}', 'return t'))).toBe(undefined)
  // The element beside the index still is one.
  expect(answer(fn('items: number[], k: number', 'for (const [i, x] of items.entries()) {', '  if (x === k) {', '    return i', '  }', '}', 'return -1'))).toBe('O(n)')
})

test('a read at a position that is not a loop index probes the size (fix 2)', async () => {
  for (const cond of ['items[16] !== undefined', 'items.at(16) !== undefined', '16 in items', 'items[items.length - 17] === undefined']) {
    expect([cond, answer(fn('items: number[]', `if (${cond}) {`, '  return -1', '}', ...nest))]).toEqual([cond, undefined])
  }
  expect(answer(fn('items: number[]', 'const v = items[16]', 'if (v === undefined) {', '  return -1', '}', ...nest))).toBe(undefined)
  expect(answer(fn('items: number[], text: string', 'if (text.charAt(16)) {', '  return -1', '}', ...nest))).toBe(undefined)
  for (const pre of ['const a = items.concat()', 'const a: number[] = []']) {
    expect([pre, answer(fn('items: number[]', pre, 'if (a[16] !== undefined) {', '  return -1', '}', ...nest))]).toEqual([pre, undefined])
  }
  // A literal loop's index is a constant position too.
  expect(answer(fn('items: number[]', 'let t = 0', 'for (let i = 0; i < 17; i++) {', '  t += items[i] ?? 0', '}', 'return t'))).toBe(undefined)
})

test('.length of a copy, a string or anything but a source is a size in a test (fix 3)', async () => {
  for (const pre of [[], ['const a = items.concat()'], ["const j = items.join(',')"]]) {
    const cond = pre.length === 0 ? 'items.concat().length > 16' : pre[0]!.startsWith('const a') ? 'a.length > 16' : 'j.length > 64'
    expect([cond, answer(fn('items: number[]', ...pre, `if (${cond}) {`, '  return -1', '}', ...nest))]).toEqual([cond, undefined])
  }
  expect(answer(fn('items: number[]', 'const out: number[] = []', 'if (out.length > 3) {', '  return -1', '}', ...nest))).toBe(undefined)
  // An element's length is no size.
// Task 7 fix round 2 (ruling D′): `.length` is a fixed-cost operand of a parameter only.
  expect(answer(fn('words: string[]', 'let t = 0', 'for (const w of words) {', '  if (w.length > 3) {', '    t += 1', '  }', '}', 'return t'))).toBe(undefined)
})

test('sizes compared for equality, or both ways, fail (fix 4)', async () => {
  const two = ['let t = 0', 'for (const x of items) {', '  for (const y of ids) {', '    t += x * y', '  }', '}', 'return t']
  for (const op of ['!==', '===', '!=', '==']) {
    expect([op, answer(fn('items: number[], ids: number[]', `if (items.length ${op} ids.length) {`, '  return 0', '}', ...two))]).toEqual([op, undefined])
  }
  expect(answer(fn('items: number[], ids: number[]', 'if (items.length < ids.length) {', '  return 0', '}', 'if (ids.length < items.length) {', '  return 0', '}', ...two))).toBe(undefined)
  // A < and a > together say the sizes are equal.
  expect(answer(fn('items: number[], ids: number[]', 'if (items.length < ids.length || ids.length < items.length) {', '  return 0', '}', ...two))).toBe(undefined)
  // Since fix round 2 (family 3), one comparison of two sizes fails too.
  expect(answer(fn('items: number[], ids: number[]', 'if (items.length < ids.length) {', '  return 0', '}', ...two))).toBe(undefined)
})

test('a local holding a collection keeps the closed lists, and one reaching a parameter is not mutated (fix 5)', async () => {
  for (const use of ['a.toSpliced(0, 1).length', 'a.toString().length', "(a + '').length", 'a.flat().length']) {
    expect([use, answer(fn('items: number[]', 'const a = items.concat()', 'let t = 0', 'for (const x of items) {', `  t += ${use}`, '}', 'return t'))]).toEqual([use, undefined])
  }
  expect(answer(fn('items: number[], m: Map<number, number[]>', 'let t = 0', 'for (const x of items) {', '  const v = m.get(x)', '  v.push(1)', '  t += 1', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[], m: Map<number, number[]>', 'let t = 0', 'for (const x of items) {', '  const v = m.get(x)', '  v.k = 1', '  t += 1', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[], ids: number[]', 'const seen = new Set(ids)', 'let t = 0', 'for (const x of items) {', '  if (seen.has(x)) {', '    t += 1', '  }', '  seen.add(x)', '}', 'return t'))).toBe('O(n + m)')
})

test('contradictory tests on one path fail, at any depth (fix 6)', async () => {
  expect(answer(fn('items: number[], ids: number[], k: number', 'let t = 0', 'for (const x of items) {', '  if (k > 0) {', '    if (k < 0) {', '      t += ids.indexOf(x)', '    }', '  }', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[], k: number', 'let t = 0', 'if (k > 0) {', '  if (k < 0) {', ...nest.slice(1, 6).map((l) => `    ${l}`), '  }', '}', 'for (const x of items) {', '  t += x', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[], k: number', 'let t = 0', 'if (k > 0 && k < 0) {', ...nest.slice(1, 6).map((l) => `  ${l}`), '}', 'for (const x of items) {', '  t += x', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[], k: number', 'let t = 0', 'if (k > 0) {', ...nest.slice(1, 6).map((l) => `  ${l}`), '}', 'return t'))).toBe('O(n²)')
})

test('NaN is no value an element can choose (fix 7)', async () => {
  expect(answer(fn('items: number[], ids: number[]', 'let t = 0', 'for (const x of items) {', '  if (x === NaN) {', '    t += ids.indexOf(x)', '  }', '}', 'return t'))).toBe(undefined)
})

test('a reduce that may build a string fails (fix 8)', async () => {
  for (const call of ["items.reduce((a, x) => a + x, '')", 'items.reduce((a, x) => a + x)', 'items.reduceRight(join)']) {
    expect([call, answer(fn('items: number[]', `const s = ${call}`, 'return 0'))]).toEqual([call, undefined])
  }
  expect(answer(fn('items: number[]', 'const s = items.reduce((a, x) => a + x, 0)', 'return s'))).toBe('O(n)')
})

test('an array of object or tuple types is an array of opaque elements (fix 9)', async () => {
  for (const type of ['{ id: number }[]', '[number, number][]', 'Array<{ id: number }>']) {
    expect([type, answer(fn(`items: ${type}`, 'let t = 0', 'for (const x of items) {', '  t += 1', '}', 'return t'))]).toEqual([type, 'O(n)'])
  }
  // A property is read and compared, but not added (fix round 2, family 7).
// Task 7 fix round 2 (ruling D′): an element's property is no fixed-cost operand.
  expect(answer(fn('items: { id: number }[], k: number', 'let t = 0', 'for (const x of items) {', '  if (x.id === k) {', '    t += 1', '  }', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: { id: number }[]', 'let t = 0', 'for (const x of items) {', '  t += x.id', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: { id: number }[]', 'let t = 0', 'for (const x of items) {', '  t += x.check()', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: { id: number }[]', 'let t = 0', 'items.forEach(x => x.check())', 'return t'))).toBe(undefined)
})

// --- Fix round 2: allowlists (task re-review of c654688) ----------------------

const nest2 = ['let t = 0', 'for (const x of items) {', '  for (const y of items) {', '    t += x * y', '  }', '}', 'return t']
const two2 = ['let t = 0', 'for (const x of items) {', '  for (const y of ids) {', '    t += x * y', '  }', '}', 'return t']
const guard2 = (pre: string[], cond: string, params = 'items: number[], ids: number[]') => fn(params, ...pre, `if (${cond}) {`, '  return -1', '}', ...nest2)

test('family 1: an exit or choose test reads only an element of a parameter or of a filter of one', async () => {
  // Reviewer: map results hold indices.
  expect(answer(fn('items: number[], ids: number[]', 'const idx = items.map((x, i) => i)', 'let t = 0', 'for (const k of idx) {', '  if (k === 0) {', '    t += ids.indexOf(1)', '  }', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[], ids: number[]', 'const idx = items.map((x, i) => i)', 'let t = 0', 'for (const k of idx) {', '  if (k === 3) {', '    return t', '  }', '  t += ids.indexOf(k)', '}', 'return t'))).toBe(undefined)
  // Own: copies are no parameter source either.
  for (const init of ['items.slice()', 'items.toSorted()', '[...items]', 'Array.from(items)']) {
    expect([init, answer(fn('items: number[], k: number', `const c = ${init}`, 'for (const y of c) {', '  if (y === k) {', '    return 1', '  }', '}', 'return 0'))]).toEqual([init, undefined])
  }
  expect(answer(fn('items: number[], ids: number[]', 'const c = items.map(x => x * 2)', 'const r = c.find(y => ids.includes(y))', 'return r ?? 0'))).toBe(undefined)
  // A filter of a parameter keeps its elements.
// Task 7 fix round 2 (ruling D′): an element of a derived collection is no fixed-cost operand.
  expect(answer(fn('items: number[], k: number, t: number', 'const d = items.filter(x => x !== k)', 'for (const y of d) {', '  if (y === t) {', '    return 1', '  }', '}', 'return 0'))).toBe(undefined)
})

test('family 2: a condition outside loops holds only literals, number parameters, a parameter size and size-free scalars', async () => {
  // Reviewer.
  for (const cond of ['items.slice()[16] !== undefined', '[...items][16] !== undefined', 'Object.keys(items)[16] !== undefined', '16 in Object.keys(items)', 'Object.keys(items).at(16) !== undefined', 'items.concat().at(16) !== undefined', "items.join(',')[64] !== undefined", "items.join().charAt(64) !== ''"]) {
    expect([cond, answer(guard2([], cond))]).toEqual([cond, undefined])
  }
  expect(answer(guard2(['const ks = Object.keys(items)'], "ks.includes('16')"))).toBe(undefined)
  expect(answer(guard2(['const ks = Object.keys(items)'], "ks.indexOf('16') >= 0"))).toBe(undefined)
  // Own.
  expect(answer(guard2([], 'items.toSorted()[16] !== undefined'))).toBe(undefined)
  expect(answer(guard2([], '!items'))).toBe(undefined)
  expect(answer(guard2([], 'helper(k)', 'items: number[], ids: number[], k: number'))).toBe(undefined)
  // Inside a loop, a read by position on a call's result still needs a loop's index.
  expect(answer(fn('items: number[], ids: number[]', 'let t = 0', 'for (const x of items) {', '  if (ids.slice().at(16) === undefined) {', '    t += ids.indexOf(x)', '  }', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[], ids: number[]', 'let t = 0', 'for (const x of items) {', '  if (ids.slice()[16] === undefined) {', '    t += ids.indexOf(x)', '  }', '}', 'return t'))).toBe(undefined)
  // Allowed: literals, number and boolean parameters, a parameter's size.
  expect(answer(guard2([], 'k > 3 && on', 'items: number[], ids: number[], k: number, on: boolean'))).toBe('O(n²)')
  expect(answer(guard2([], 'items.length === 0'))).toBe('O(n²)')
})

test('family 3: a condition naming two size sources fails, in any form', async () => {
  for (const cond of ['items.length < ids.length || !(items.length <= ids.length)', '!(items.length >= ids.length) || items.length > ids.length', 'items.length < ids.length || !(ids.length >= items.length)', 'items.length > ids.length', 'items.length * 2 > ids.length', 'items.length < 2 || ids.length === 0']) {
    expect([cond, answer(fn('items: number[], ids: number[]', `if (${cond}) {`, '  return 0', '}', ...two2))]).toEqual([cond, undefined])
  }
  expect(answer(fn('items: number[], ids: number[]', 'const n = items.length', 'const m = ids.length', 'if (n > m) {', '  return 0', '}', ...two2))).toBe(undefined)
  expect(answer(fn('items: number[], ids: number[]', 'let t = 0', 'for (const x of items) {', '  t += items.length > ids.length ? 1 : 0', '}', 'return t'))).toBe(undefined)
})

test('family 4: a local not proven scalar is closed-list', async () => {
  const use = (pre: string[], expr: string, params = 'items: number[], k: number') => fn(params, ...pre, 'let t = 0', 'for (const x of items) {', `  t += ${expr}`, '}', 'return t')
  // Reviewer.
  expect(answer(use(['const a = k > 0 ? items.concat() : items.slice()'], 'a.toString().length'))).toBe(undefined)
  expect(answer(use(['const a = items.concat() ?? []'], 'a.toString().length'))).toBe(undefined)
  expect(answer(use(['let a', 'a = items.concat()'], 'a.toString().length'))).toBe(undefined)
  expect(answer(use(['const o = { a: items.concat() }'], 'o.a.toString().length'))).toBe(undefined)
  // Own.
  expect(answer(use(['let a: number[]', 'a = items.slice()'], 'a.toString().length'))).toBe(undefined)
  expect(answer(use(['const a = load()'], 'a.toString().length'))).toBe(undefined)
  expect(answer(use(['const r = items.find(y => y === k)'], 'r.toString().length'))).toBe(undefined)
  // A copy's elements are the parameter's: no mutation through it.
  expect(answer(fn('grid: number[][]', 'let t = 0', 'for (const x of grid) {', '  const a = grid.slice()', '  a[0].push(1)', '  t += 1', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('grid: number[][]', 'let t = 0', 'for (const x of grid) {', '  const a = [x]', '  a[0].push(1)', '  t += 1', '}', 'return t'))).toBe(undefined)
  // A proven scalar takes the O(1) list (fix round 3, ruling C).
  expect(answer(use(["const s = 'ab'"], 's.charAt(0).length'))).toBe('O(n)')
  expect(answer(use(["const s = 'ab'"], 's.toUpperCase().length'))).toBe(undefined)
})

test('family 5: + and += take only proven numbers', async () => {
  // Reviewer.
  for (const call of ['items.reduce((a, x) => a + x, [])', 'items.reduce((a, x) => a + x, {})', "items.reduce((a, x) => a + 'x', 0)"]) {
    expect([call, answer(fn('items: number[]', `const s = ${call}`, 'return 0'))]).toEqual([call, undefined])
  }
  expect(answer(fn('words: string[]', 'const s = words.reduce((a, x) => a + x, 0)', 'return 0'))).toBe(undefined)
  expect(answer(fn('words: string[]', 'let t = 0', 'for (const x of words) {', '  t += x', '}', 'return t'))).toBe(undefined)
  // Own.
  expect(answer(fn('items: number[]', "const s = items.reduce((a, x) => a + x + '', 0)", 'return 0'))).toBe(undefined)
  expect(answer(fn('words: string[]', 'let t = 0', 'for (const w of words) {', '  t = t + w', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: { name: string }[]', 'let t = 0', 'for (const x of items) {', '  t += x.name', '}', 'return t'))).toBe(undefined)
  // Numbers pass.
  expect(answer(fn('words: string[]', 'let t = 0', 'for (const w of words) {', '  t += w.length + 1', '}', 'return t'))).toBe('O(n)')
})

test('family 6: a counted local is no size-free value in a condition outside its loop', async () => {
  // Reviewer.
  expect(answer(guard2([], 'items.reduce((a, x) => a + 1, 0) > 16'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'let c = 0', 'for (const x of items) {', '  c += 1', '}', 'if (c > 16) {', '  return -1', '}', ...nest2))).toBe(undefined)
  expect(answer(fn('items: number[]', 'let c = 0', 'items.forEach(x => {', '  c += 1', '})', 'if (c > 16) {', '  return -1', '}', ...nest2))).toBe(undefined)
  // Own.
  expect(answer(fn('items: number[]', 'let c = 0', 'for (const x of items) {', '  c++', '}', 'if (c > 16) {', '  return -1', '}', ...nest2))).toBe(undefined)
  expect(answer(guard2(['const c = items.indexOf(1)'], 'c > 16'))).toBe(undefined)
  // A local set once from literals is size-free, but (task 6 fix round 4) it is constant, so its test fails;
  // one that holds a number parameter plus a literal passes.
  expect(answer(guard2(['const c = 3 * 2'], 'c > 16'))).toBe(undefined)
  expect(answer(guard2(['const c = k + 2'], 'c > 16', 'items: number[], k: number'))).toBe('O(n²)')
})

test('family 7: values reached from an opaque element take no method call, + or alias', async () => {
  const tags = 'items: { tags: number[] }[]'
  // Reviewer.
  expect(answer(fn(tags, 'let t = 0', 'for (const x of items) {', '  const s = x.tags', '  t += s.toString().length', '}', 'return t'))).toBe(undefined)
  expect(answer(fn(tags, 'let t = 0', 'for (const x of items) {', '  const y = x', '  t += y.tags.toString().length', '}', 'return t'))).toBe(undefined)
  for (const init of ['items.map(x => x)', 'Object.values(items)', 'Array.from(items)', '[...items]']) {
    expect([init, answer(fn(tags, `const c = ${init}`, 'let t = 0', 'for (const y of c) {', '  t += y.tags.toString().length', '}', 'return t'))]).toEqual([init, undefined])
  }
  expect(answer(fn(tags, 'const c = items.map(x => x.tags)', 'let t = 0', 'for (const y of c) {', '  t += y.toString().length', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: Foo[]', 'let t = 0', 'for (const x of items) {', '  t += x.tags.toString().length', '}', 'return t'))).toBe(undefined)
  expect(answer(fn(`${tags}, k: number`, 'const r = items.find(x => x.tags.length === k)', 'let t = 0', 'for (const y of items) {', '  t += r.tags.toString().length', '}', 'return t'))).toBe(undefined)
  // Own.
  expect(answer(fn(tags, 'let t = 0', 'for (const x of items) {', '  t += size(x.tags)', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items', 'let t = 0', 'for (const x of items) {', '  t += x.toString().length', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('m: Map<string, number[]>', 'let t = 0', 'for (const v of m.values()) {', '  t += v.toString().length', '}', 'return t'))).toBe(undefined)
  // Allowed: a comparison, a key, a push, a property's length.
  expect(answer(fn(`${tags}, k: number`, 'const seen = new Set<number>()', 'const out: number[][] = []', 'let t = 0', 'for (const x of items) {', '  if (x.tags.length === k) {', '    t += 1', '  }', '  seen.add(x)', '  out.push(x.tags)', '  t += x.tags.length', '}', 'return t'))).toBe(undefined) // ruling D′: a property is no operand
})

// --- Fix round 3: default-refuse rules (task re-review of 93b7239) -------------

test('ruling A: p[i] is an element only for an index that walks p from 0 to p.length', async () => {
  const choose = (head: string[], close: string) => fn('items: number[], ids: number[]', 'let t = 0', ...head, '  if (items[i] === 0) {', '    t += ids.indexOf(1)', '  }', close, 'return t')
  // Reviewer: indices of another source.
  expect(answer(choose(['for (let i = 0; i < ids.length; i++) {'], '}'))).toBe(undefined)
  expect(answer(choose(['for (const i of ids.keys()) {'], '}'))).toBe(undefined)
  expect(answer(choose(['for (const [i, y] of ids.entries()) {'], '}'))).toBe(undefined)
  expect(answer(choose(['ids.forEach((y, i) => {'], '})'))).toBe(undefined)
  // Own: a literal position, a binary search's mid over another source, a start other than 0.
  expect(answer(fn('items: number[], ids: number[], k: number', 'let t = 0', 'for (const x of ids) {', '  t += ids.indexOf(x)', '  if (items[0] === k) {', '    return t', '  }', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[], k: number', 'for (let i = 0; i < items.length; i++) {', '  for (let j = i + 1; j < items.length; j++) {', '    if (items[j] === k) {', '      return 1', '    }', '  }', '}', 'return 0'))).toBe(undefined)
  // Walking its own source: still an element.
  expect(answer(choose(['for (const i of items.keys()) {'], '}'))).toBe('O(n·m)')
  expect(answer(choose(['items.forEach((y, i) => {'], '})'))).toBe('O(n·m)')
})

test('ruling B: no await or async; any value not proven plain is opaque', async () => {
  const af = (params: string, ...body: string[]): Unit => ({ lang: 'TypeScript', name: 'f', lines: [`async function f(${params}): Promise<number> {`, ...body.map((l) => `  ${l}`), '}'] })
  // Reviewer.
  expect(answer(af('items: { tags: number[] }[]', 'let t = 0', 'for (const x of items) {', '  const a = await x.tags', '  t += a.toString().length', '}', 'return t'))).toBe(undefined)
  expect(answer(af('items: number[], ids: number[]', 'const a = await ids.slice()', 'let t = 0', 'for (const x of items) {', '  t += a.toString().length', '}', 'return t'))).toBe(undefined)
  expect(answer(af('items: number[]', 'let t = 0', 'for (const x of items) {', '  t += x', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[][]', 'let t = 0', 'for (let i = 0; i < items.length; i++) {', '  t += items.at(i).toString().length', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('m: Map<string, number[]>, keys: string[]', 'let t = 0', 'for (const k of keys) {', '  t += m.get(k).toString().length', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: { tags: number[] }[]', 'const c = items.map(x => x.tags)', 'let t = 0', 'for (let i = 0; i < c.length; i++) {', '  t += c.at(i).toString().length', '}', 'return t'))).toBe(undefined)
  // Own: a result through a find, a property of this, and a boolean proven by name alone.
  expect(answer(fn('items: { id: number; tags: number[] }[], ids: number[]', 'let t = 0', 'for (const k of ids) {', '  t += items.find(x => x.id === k).tags.toString().length', '}', 'return t'))).toBe(undefined)
  expect(answer(inLoop('const r = this.items.size()'))).toBe(undefined)
  expect(answer(fn('items: number[], opts: Store', 'const a = opts.has(1)', 'let t = 0', 'for (const x of items) {', '  t += a.toString().length', '}', 'return t'))).toBe(undefined)
})

test('ruling C: methods on a string or number take only a closed O(1) list', async () => {
  // Reviewer.
  expect(answer(fn('n: number', 'let t = 0', 'for (let i = 0; i < n; i++) {', "  t += 'a'.repeat(n).length", '}', 'return t'))).toBe(undefined)
  expect(answer(fn('n: number', "const s = 'a'", 'let t = 0', 'for (let i = 0; i < n; i++) {', '  t += s.repeat(n).length', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'let t = 0', 'for (const x of items) {', "  t += ''.padStart(items.length).length", '}', 'return t'))).toBe(undefined)
  expect(answer(fn('words: string[], n: number', 'let t = 0', 'for (const w of words) {', '  t += w.repeat(n).length', '}', 'return t'))).toBe(undefined)
  // Own.
  expect(answer(fn('words: string[]', 'let t = 0', 'for (const w of words) {', '  t += w.toUpperCase().length', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[], k: number', 'let t = 0', 'for (const x of items) {', '  t += x.toFixed(k).length', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[], n: number', 'let t = 0', 'for (const x of items) {', '  t += n.toString().length', '}', 'return t'))).toBe(undefined)
  // The list itself.
// Task 7 fix round 2 (ruling D′): a character read is fixed only on a parameter at an index that walks it.
  expect(answer(fn('words: string[]', 'let t = 0', 'for (const w of words) {', "  if (w.charAt(0) === 'a') {", '    t += 1', '  }', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'let t = 0', 'for (const x of items) {', '  t += x.toFixed(2).length', '}', 'return t'))).toBe('O(n)')
})

test('ruling D: a reduce accumulator is a number only when every return of its callback is', async () => {
  expect(answer(fn('items: number[]', "const s = items.reduce((a, x) => x < 0 ? 'z' : a + x, 0)", 'return s'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'const s = items.reduce((a, x) => x < 0 ? [] : a + x, 0)', 'return s'))).toBe(undefined)
  expect(answer(fn('items: number[], k: number', 'const s = items.reduce((a, x) => x === k ? load() : a + x, 0)', 'return s'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'const s = items.reduce((a, x) => x < 0 ? a : a + x, 0)', 'return s'))).toBe('O(n)')
})

test('ruling E: an element exit counts only as === on a number or string element', async () => {
  const exits = (params: string, a: string, b: string) => fn(`${params}, ids: number[]`, 'let t = 0', 'for (const x of items) {', '  t += ids.indexOf(1)', `  if (${a}) {`, '    return t', '  }', `  if (${b}) {`, '    return t', '  }', '}', 'return t')
  // Reviewer.
  expect(answer(exits("items: ('a' | 'b')[]", "x === 'a'", "x === 'b'"))).toBe(undefined)
  expect(answer(exits('items: (0 | 1)[]', 'x === 0', 'x === 1'))).toBe(undefined)
  expect(answer(exits('items: Dir[]', "x === 'a'", "x === 'b'"))).toBe(undefined)
  expect(answer(exits('items: number[], k: number', 'x < k', 'x >= k'))).toBe(undefined)
  expect(answer(exits('items: number[]', 'x === 5', 'x !== 5'))).toBe(undefined)
  // Own: a boolean element, a membership test, a property of an element.
  expect(answer(exits('items: boolean[], k: boolean', 'x === k', 'x === k'))).toBe(undefined)
  expect(answer(fn('items: number[], ids: number[]', 'for (const x of items) {', '  if (ids.includes(x)) {', '    return 1', '  }', '}', 'return 0'))).toBe(undefined)
  expect(answer(fn('items: { id: number }[], k: number', 'for (const x of items) {', '  if (x.id === k) {', '    return 1', '  }', '}', 'return 0'))).toBe(undefined)
  // Several === exits on one number element can all be avoided.
  expect(answer(exits('items: number[], k: number, j: number', 'x === k', 'x === j'))).toBe('O(n·m)')
})

test('ruling F: a binary search is mid, an optional equality exit, then an if/else setting lo and hi', async () => {
  const bs = (cond: string, hi: string, ...body: string[]) => fn('items: number[], x: number', 'let t = 0', 'let lo = 0', `let hi = ${hi}`, `while (${cond}) {`, '  const mid = (lo + hi) >> 1', ...body.map((l) => `  ${l}`), '}', 'return t')
  // Reviewer.
  expect(answer(bs('lo <= hi', 'items.length - 1', 't += items.indexOf(mid)', 'lo = mid + 1', 'hi = mid - 1'))).toBe(undefined)
  expect(answer(bs('lo < hi', 'items.length', 'lo = mid + 1', 'hi = mid'))).toBe(undefined)
  expect(answer(bs('lo <= hi', 'items.length - 1', 'if (items[mid] < x) {', '  lo = mid + 1', '}', 'hi = mid - 1'))).toBe(undefined)
  // Own: an else-if instead of an else; a test that does not read mid; the exit after the halving.
  expect(answer(bs('lo <= hi', 'items.length - 1', 'if (items[mid] < x) {', '  lo = mid + 1', '} else if (items[mid] > x) {', '  hi = mid - 1', '}'))).toBe(undefined)
  expect(answer(bs('lo <= hi', 'items.length - 1', 'if (t < x) {', '  lo = mid + 1', '} else {', '  hi = mid - 1', '}'))).toBe(undefined)
  expect(answer(bs('lo <= hi', 'items.length - 1', 'if (items[mid] < x) {', '  lo = mid + 1', '} else {', '  hi = mid - 1', '}', 'if (items[mid] === x) {', '  return mid', '}'))).toBe(undefined)
  // The accepted shape, with and without the equality exit.
  expect(answer(bs('lo <= hi', 'items.length - 1', 'if (items[mid] === x) {', '  return mid', '}', 'if (items[mid] < x) {', '  lo = mid + 1', '} else {', '  hi = mid - 1', '}'))).toBe('O(log n)')
  expect(answer(bs('lo < hi', 'items.length', 'if (items[mid] < x) {', '  lo = mid + 1', '} else {', '  hi = mid', '}'))).toBe('O(log n)')
})

test('ruling C (fix round 4): a method on a parameter that is not a known collection, string or number refuses', async () => {
  // Reviewer.
  expect(answer(fn("n: number, s: 'a' | 'b'", 'let t = 0', 'for (let i = 0; i < n; i++) {', '  t += s.repeat(n).length', '}', 'return t'))).toBe(undefined)
  expect(answer(fn("items: number[], s: 'a' | 'b'", 'let t = 0', 'for (const x of items) {', '  t += s.repeat(items.length).length', '}', 'return t'))).toBe(undefined)
  expect(answer(fn("n: number, s: 'x'", 'let t = 0', 'for (let i = 0; i < n; i++) {', '  t += s.padStart(n).length', '}', 'return t'))).toBe(undefined)
  expect(answer(fn("items: number[], s: 'a' | 'b'", 'let t = 0', 'for (const x of items) {', '  t += s.repeat(t).length', '}', 'return t'))).toBe(undefined)
  for (const type of ['String', 'string | number', 'Text']) {
    expect(answer(fn(`n: number, s: ${type}`, 'let t = 0', 'for (let i = 0; i < n; i++) {', '  t += s.repeat(n).length', '}', 'return t'))).toBe(undefined)
  }
  expect(answer(fn('n: number, s', 'let t = 0', 'for (let i = 0; i < n; i++) {', '  t += s.repeat(n).length', '}', 'return t'))).toBe(undefined)
  // Own: a method outside the list on a literal union, a number union, a tuple, an object and a callback.
  expect(answer(fn("items: number[], s: 'a' | 'b'", 'let t = 0', 'for (const x of items) {', '  t += s.toUpperCase().length', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[], k: 1 | 2', 'let t = 0', 'for (const x of items) {', '  t += k.toString().length', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[], p: [string, string]', 'let t = 0', 'for (const x of items) {', '  t += p.join().length', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[], o: { a: string }', 'let t = 0', 'for (const x of items) {', '  t += o.toString().length', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[], cb: (x: number) => number', 'let t = 0', 'for (const x of items) {', '  t += cb.call(null, x)', '}', 'return t'))).toBe(undefined)
  // The list itself on a string or number literal union.
// Task 7 fix round 2 (ruling D′): a literal union parameter is no number type.
  expect(answer(fn("items: number[], s: 'ab' | 'cd'", 'let t = 0', 'for (const x of items) {', "  if (s.charAt(0) === 'a') {", '    t += 1', '  }', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[], k: 1 | 2', 'let t = 0', 'for (const x of items) {', '  t += k.toFixed(2).length', '}', 'return t'))).toBe('O(n)')
})

test('fix round 5: a literal-typed parameter is no size, loop source or length', async () => {
  // Reviewer.
  expect(answer(fn("s: 'ab' | 'cd'", 'let t = 0', 'for (const c of s) {', '  t += 1', '}', 'return t'))).toBe(undefined)
  expect(answer(fn("s: 'ab'", 'let t = 0', 'for (let i = 0; i < s.length; i++) {', '  t += 1', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('s: 1 | 2', 'let t = 0', 'for (const c of s) {', '  t += 1', '}', 'return t'))).toBe(undefined)
  // Own: a template literal type, a for-in, Object.keys, and a size test on its length.
  expect(answer(fn('s: `ab`', 'let t = 0', 'for (const c of s) {', '  t += 1', '}', 'return t'))).toBe(undefined)
  expect(answer(fn("s: 'ab' | 'cd'", 'let t = 0', 'for (const k in s) {', '  t += 1', '}', 'return t'))).toBe(undefined)
  expect(answer(fn("s: 'ab' | 'cd'", 'let t = 0', 'for (const k of Object.keys(s)) {', '  t += 1', '}', 'return t'))).toBe(undefined)
  expect(answer(fn("items: number[], s: 'ab' | 'cd'", 'let t = 0', 'if (s.length > 1) {', '  for (const x of items) {', '    t += x', '  }', '}', 'return t'))).toBe(undefined)
})

// --- Task 6 fix round 1: raises and exits the input cannot avoid -----------------

test('task 6 fix round 1: a hidden line that may raise or exit fails, in a loop or before it', async () => {
  const inLoop = ['function f(items: number[]): number {', '  let t = 0', '  for (const x of items) {', '    …', '    t += x', '  }', '  return t', '}']
  const before = ['function f(items: number[]): number {', '  …', '  let t = 0', '  for (const x of items) {', '    t += x', '  }', '  return t', '}']
  expect(answer(withHidden(inLoop, { 3: '    // step' }))).toBe('O(n)')
  // Fix round 2: a hidden call is no hidden form.
  expect(answer(withHidden(inLoop, { 3: "    log('step')" }))).toBe(undefined)
  expect(answer(withHidden(before, { 1: '  // note' }))).toBe('O(n)')
  for (const raw of ['const z = (1 as any).x.y // c', 'process.exit(1) // stop', "JSON.parse('') // c", 'const z = q.r // c', "lib.abort('x') // c", 'const z = 1 / q // c']) {
    expect([raw, answer(withHidden(inLoop, { 3: `    ${raw}` }))]).toEqual([raw, undefined])
    expect([raw, answer(withHidden(before, { 1: `  ${raw}` }))]).toEqual([raw, undefined])
  }
})

test('task 6 fix round 1: a property is read only on an element of an object type, or on a helper or module result', async () => {
  const read = (params: string, line: string): Unit => fn(params, 'let t = 0', 'for (const x of items) {', `  ${line}`, '  t += 1', '}', 'return t')
  expect(answer(read('items: Foo[]', 'const w = x.a'))).toBe('O(n)')
  expect(answer(read('items: { a: number }[]', 'const w = x.a'))).toBe('O(n)')
  expect(answer(read('items: number[]', 'const w = lib.get(x).a'))).toBe('O(n)')
  for (const [params, line] of [['items: number[][]', 'const w = x.size.a'], ['items: number[]', 'const w = x.a.b'], ['items: Foo[]', 'const w = x.a.b'], ['items: T[]', 'const w = x.a'], ['items: string[]', 'const w = x.a.b']]) {
    expect([params, line, answer(read(params!, line!))]).toEqual([params, line, undefined])
  }
  expect(answer(fn('items: number[]', 'let t = 0', 'const v = null', 'for (const x of items) {', '  const w = v.a', '  t += x', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'let t = 0', 'for (const x of items) {', '  const v = undefined', '  const w = v.a', '  t += x', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'const m = new Map()', 'let t = 0', 'for (const x of items) {', '  const w = m.get(x).a', '  t += x', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[], opts: Opts', 'let t = 0', 'for (const x of items) {', '  const w = opts.a.b', '  t += x', '}', 'return t'))).toBe(undefined)
})

test('task 6 fix round 1: a call to an exit or abort name fails', async () => {
  expect(answer(fn('items: number[]', 'let t = 0', 'for (const x of items) {', '  t += x', '}', 'lib.log(t)', 'return t'))).toBe('O(n)')
  for (const line of ['process.exit(0)', 'lib.abort()', 'proc.kill(1)', 'exit(0)', 'lib.quit()', 'lib.die()']) {
    expect([line, answer(fn('items: number[]', 'let t = 0', 'for (const x of items) {', '  t += x', '}', line, 'return t'))]).toEqual([line, undefined])
    expect([line, answer(fn('items: number[]', 'let t = 0', 'for (const x of items) {', '  t += x', `  ${line}`, '}', 'return t'))]).toEqual([line, undefined])
  }
})

test('task 6 fix round 1: a property or index write needs a receiver that is never null', async () => {
  const write = (decl: string, line: string): Unit => fn('items: number[]', 'let t = 0', decl, 'for (const x of items) {', `  ${line}`, '  t += x', '}', 'return t')
  expect(answer(write('const v = { a: 0 }', 'v.a = x'))).toBe('O(n)')
  expect(answer(write('const v = new Map<number, number>()', 'v.set(x, 1)'))).toBe('O(n)')
  expect(answer(write('const v = null', 'v.a = x'))).toBe(undefined)
  expect(answer(write('const v = null', 'v[x] = 1'))).toBe(undefined)
  expect(answer(write('const v = lib.make()', 'v.a = x'))).toBe(undefined)
})

// --- Task 6 fix round 2 -----------------------------------------------------------

test('task 6 fix round 2: an index read or write needs a receiver that is never null, and a primitive takes no write', async () => {
  const loop = (decl: string, line: string): Unit => fn('items: number[]', 'let t = 0', decl, 'for (const x of items) {', `  ${line}`, '  t += x', '}', 'return t')
  expect(answer(loop('const v: number[] = []', 'v[x] = 1'))).toBe('O(n)')
  expect(answer(loop('const v = null', 'const w = v[x]'))).toBe(undefined)
  expect(answer(loop('const v = null', "const w = v['a']"))).toBe(undefined)
  expect(answer(loop("let v = 'ab'", 'v[0] = 1'))).toBe(undefined)
  expect(answer(loop("let v = 'ab'", 'v.a = 1'))).toBe(undefined)
  expect(answer(loop('let v = 3', 'v.a = 1'))).toBe(undefined)
  expect(answer(loop('const v = [1]', 'v.length = -1'))).toBe(undefined)
})

test('task 6 fix round 2: an exit name matches by substring; toFixed takes 0 to 20; a signature type is never called', async () => {
  const after = (line: string, params = 'items: number[]'): Unit => fn(params, 'let t = 0', 'for (const x of items) {', '  t += 1', '}', line, 'return t')
  expect(answer(after('lib.log(t)'))).toBe('O(n)')
  for (const line of ['process.reallyExit(1)', 'lib.dieRoll()', 'lib.onSignal(1)', 'lib.crashNow()', 'lib.panic()', 'lib.terminateAll()', 'lib.segvHere()']) expect([line, answer(after(line))]).toEqual([line, undefined])
  expect(answer(fn('items: number[]', 'let t = 0', 'for (const x of items) {', '  t += x.toFixed(2).length', '}', 'return t'))).toBe('O(n)')
  expect(answer(fn('items: number[]', 'let t = 0', 'for (const x of items) {', '  t += x.toFixed(200).length', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('items: number[]', 'let t = 0', 'for (const x of items) {', '  t += x.toFixed(21).length', '}', 'return t'))).toBe(undefined)
  expect(answer(after('Foo(1)', 'items: Foo[]'))).toBe(undefined)
  expect(answer(after('Bar(1)', 'items: Foo[]'))).toBe('O(n)')
})

// --- Task 6 fix round 3 -----------------------------------------------------------

test('task 6 fix round 3: a hidden template or string is a tagged call after an expression', async () => {
  const inLoop = ['function f(items: number[]): number {', '  let t = 0', '  for (const x of items) {', '    t += x', '    …', '  }', '  return t', '}']
  expect(answer(withHidden(inLoop, { 4: '    // step' }))).toBe('O(n)')
  for (const raw of ['    `step`', "    'step'", "    'a' `b`", '    `a` `b`']) expect([raw, answer(withHidden(inLoop, { 4: raw }))]).toEqual([raw, undefined])
})

test('task 6 fix round 3: hidden exits in complementary guards fail', async () => {
  const guards = (a: string, b: string, k = 'number'): string[] => [`function f(items: number[], k: ${k}): number {`, '  let t = 0', `  if (${a}) {`, '    …', '  }', `  if (${b}) {`, '    …', '  }', '  for (const y of items) {', '    t += y', '  }', '  return t', '}']
  const both = (u: string[]): Unit => withHidden(u, { 3: '    return 0', 6: '    return 1' })
  expect(answer(both(guards('k === 1', 'k !== 1')))).toBe(undefined)
  expect(answer(both(guards('k', '!k', 'boolean')))).toBe(undefined)
  expect(answer(both(guards('k > 0', '!(k > 0)')))).toBe(undefined)
})

test('task 6 fix round 3: a literal operand of || or && or !, or a literal condition, fails; a name twice in a root test fails', async () => {
  const guard = (c: string): Unit => fn('items: number[], k: number', 'let t = 0', `if (${c}) {`, '  return 0', '}', 'for (const y of items) {', '  t += y', '}', 'return t')
  expect(answer(guard('k > 0'))).toBe('O(n)')
  for (const c of ['k > 0 || true', 'true || k > 0', 'k > 0 || 1', "k > 0 || 'a'", 'k > 0 || []', 'k > 0 || {}', '!false', 'k > 0 && !0', 'k !== k + 1', 'true']) expect([c, answer(guard(c))]).toEqual([c, undefined])
  expect(answer(fn('items: number[], k: number', 'let t = 0', 'for (const y of items) {', '  t += (k > 0 || true) ? y : 0', '}', 'return t'))).toBe(undefined)
})

test('task 6 fix round 3: a bracket write takes a number key on an array accumulator or a fresh array', async () => {
  const loop = (decl: string, line: string): Unit => fn('items: number[]', 'let t = 0', decl, 'for (let i = 0; i < items.length; i++) {', `  ${line}`, '  t += 1', '}', 'return t')
  expect(answer(loop('const v: number[] = []', 'v[i] = 1'))).toBe('O(n)')
  expect(answer(loop('const v = [0]', 'v[i] = 1'))).toBe('O(n)')
  for (const [decl, line] of [['const v: number[] = []', "v['length'] = -1"], ['const v: number[] = []', 'v[`length`] = -1'], ['const v: number[] = []', 'v["length"] = -1'], ['const v: number[] = []', "v['length'] -= 5"], ['const v = [0]', "v['length'] = -1"], ['const m = new Map()', "m['size'] = 1"], ['const s = new Set()', 's[i] = 1'], ['const o = {}', "o['k'] = 1"]]) {
    expect([decl, line, answer(loop(decl!, line!))]).toEqual([decl, line, undefined])
  }
})

test('task 6 fix round 3: a scalar method matches its receiver: string methods on strings, toFixed on numbers; bigint is no number', async () => {
  const each = (params: string, line: string): Unit => fn(params, 'let t = 0', 'for (const x of items) {', `  ${line}`, '}', 'return t')
  expect(answer(each('items: number[]', 't += x.toFixed(2).length'))).toBe('O(n)')
  expect(answer(each('items: string[]', 't += x.charAt(0).length'))).toBe('O(n)')
  for (const [params, line] of [['items: string[]', 't += x.toFixed(2).length'], ['items: boolean[]', 't += x.toFixed(2).length'], ['items: bigint[]', 't += x.toFixed(2).length'], ['items: number[]', 't += x.charAt(0).length'], ['items: boolean[]', 't += x.charAt(0).length'], ['items: bigint[]', 't += x'], ['items: number[], k: bigint', 't += k']]) {
    expect([params, line, answer(each(params!, line!))]).toEqual([params, line, undefined])
  }
})

test('task 6 fix round 3: an exit name fails as a constructor too, and in any Unicode form', async () => {
  const after = (line: string): Unit => fn('items: number[]', 'let t = 0', 'for (const x of items) {', '  t += 1', '}', line, 'return t')
  expect(answer(after('lib.log(t)'))).toBe('O(n)')
  for (const line of ['new Exit()', 'new lib.Exit()', 'lib.ｅxit(0)', 'lib.ſignal()']) expect([line, answer(after(line))]).toEqual([line, undefined])
})

// --- Task 6 fix round 4: the read-once condition grammar --------------------------

const R4 = 'items: number[], ids: number[], k: number, b: boolean, c: boolean'
/** `if (cond) return 0`, then a loop over items: O(1) when cond always holds. */
const r4Exit = (cond: string): Unit => fn(R4, `if (${cond}) {`, '  return 0', '}', 'let t = 0', 'for (const x of items) {', '  t += x', '}', 'return t')
/** A loop over items behind `cond`: O(1) when cond never holds. */
const r4Work = (cond: string): Unit => fn(R4, 'let t = 0', `if (${cond}) {`, '  for (const x of items) {', '    t += x', '  }', '}', 'return t')

test('task 6 fix round 4: a guard that always holds fails', async () => {
  for (const c of ['k > 0 || -1', 'k > 0 || +1', 'k > 0 || 1 + 1', 'k > 0 || 1 > 0', 'k > 0 || 2 >= 1', 'k > 0 || 1 !== 2', '!(k > 0 && 0 > 1)', 'k > 0 || typeof k', 'k > 0 ? true : true', 'k > 0 ? 1 : 1', '(k > 0 ? 1 : 2) > 0', '(b ? 1 : 1) > 0', 'b === true || b === false', 'b || b === false', 'b || c || !b', '(b && c) || !b || !c', 'k > 0 || !(0 < k)']) {
    expect([c, answer(r4Exit(c))]).toEqual([c, undefined])
  }
})

test('task 6 fix round 4: a guard that never holds fails', async () => {
  for (const c of ['k > 0 && 0 > 1', 'k > 0 && 1 - 1', 'k > 0 && -0', '!(k > 0 || 1 > 0)', 'k > 0 ? false : false', '(k > 0 ? 0 : 0) > 0']) {
    expect([c, answer(r4Work(c))]).toEqual([c, undefined])
  }
})

test('task 6 fix round 4: an atom compares named values with finite literals of their own type', async () => {
  for (const c of ['k > 1e400', `k > 1${'0'.repeat(400)}`, 'k > Infinity', 'k > -Infinity', "k === 'a' || b", 'k !== null', 'k !== undefined', 'b === true', 'b !== false', 'b < c', 'k === b', 'b === c']) {
    expect([c, answer(r4Exit(c))]).toEqual([c, undefined])
  }
  for (const c of ['k > 0', 'b', '!b', 'b && c', 'b || k > 0', '!(k > 0 && b)', 'k > -1', 'k !== 3', 'k > 0 || c', '(b || c) && k < 2', 'k >= -2']) {
    expect([c, answer(r4Exit(c))]).toEqual([c, 'O(n)'])
  }
  expect(answer(r4Work('b && k < 3'))).toBe('O(n)')
})

test('task 6 fix round 4: a local in a guard is read through to what it holds, once', async () => {
  // m always exceeds k; five is never more than three; on is never set.
  expect(answer(fn(R4, 'const m = k + 1', 'if (m > k) {', '  return 0', '}', 'let t = 0', 'for (const x of items) {', '  t += x', '}', 'return t'))).toBe(undefined)
  expect(answer(fn(R4, 'const m = 5', 'if (k > 0 || m > 3) {', '  return 0', '}', 'let t = 0', 'for (const x of items) {', '  t += x', '}', 'return t'))).toBe(undefined)
  expect(answer(fn(R4, 'let on = false', 'if (k > 0 && 0 > 1) {', '  on = true', '}', 'let t = 0', 'if (on) {', '  for (const x of items) {', '    t += x', '  }', '}', 'return t'))).toBe(undefined)
  expect(answer(fn(R4, 'const m = k + 1', 'if (m > 3) {', '  return 0', '}', 'let t = 0', 'for (const x of items) {', '  t += x', '}', 'return t'))).toBe('O(n)')
})

test('task 6 fix round 4: a test that guards costly work inside a loop, or the right of && and ||, takes the grammar', async () => {
  expect(answer(fn(R4, 'let t = 0', 'const r = k > 0 && 0 > 1 && items.indexOf(k) > 0', 'return t'))).toBe(undefined)
  expect(answer(fn(R4, 'let t = 0', 'for (const x of items) {', '  if (x === k && 0 > 1) {', '    t += ids.indexOf(x)', '  }', '}', 'return t'))).toBe(undefined)
  expect(answer(fn(R4, 'let t = 0', 'for (const x of items) {', '  t += x === k && 0 > 1 ? ids.indexOf(x) : 0', '}', 'return t'))).toBe(undefined)
  expect(answer(fn(R4, 'let t = 0', 'for (const x of items) {', '  if (x === k) {', '    t += ids.indexOf(x)', '  }', '}', 'return t'))).toBe('O(n·m)')
  expect(answer(fn(R4, 'let t = 0', 'for (const x of items) {', '  t += x === k ? ids.indexOf(x) : 0', '}', 'return t'))).toBe('O(n·m)')
})

// --- Task 6 fix round 5: filter predicates and logical assignments ----------------

test('task 6 fix round 5: a filter predicate takes the grammar, so a filter that keeps nothing is no full-size source', async () => {
  const nestOver = (d: string): string[] => ['let t = 0', `for (const u of ${d}) {`, `  for (const v of ${d}) {`, '    t += u * v', '  }', '}', 'return t']
  const preds = ['x => false', 'x => 0 > 1', 'x => !true', 'x => k > 0 && 0 > 1', 'x => k > 0 && k < 0', 'x => b && !b', 'x => k > 0 && -0', 'x => k > 0 && 1 - 1', 'x => (k > 0 ? 0 : 0) > 0', 'x => !(k > 0 || 1 > 0)']
  for (const p of preds) {
    expect([p, answer(fn(R4, `const d = items.filter(${p})`, ...nestOver('d')))]).toEqual([p, undefined])
    expect([p, 'toSorted', answer(fn(R4, `const d = items.filter(${p})`, 'return d.toSorted().length'))]).toEqual([p, 'toSorted', undefined])
    expect([p, 'indexOf', answer(fn(R4, `const d = ids.filter(${p})`, 'let t = 0', 'for (const x of items) {', '  t += d.indexOf(x)', '}', 'return t'))]).toEqual([p, 'indexOf', undefined])
    expect([p, 'includes', answer(fn(R4, `const d = ids.filter(${p})`, 'let t = 0', 'for (const x of items) {', '  if (d.includes(x)) {', '    t += 1', '  }', '}', 'return t'))]).toEqual([p, 'includes', undefined])
    expect([p, 'every', answer(fn(R4, `const d = ids.filter(${p})`, 'return items.every(x => d.includes(x)) ? 1 : 0'))]).toEqual([p, 'every', undefined])
  }
  // Inline, a filter's own walk costs n whatever its test; the test still takes the grammar.
  expect(answer(fn(R4, 'let t = 0', 'for (const y of ids) {', '  t += items.filter(x => x === y && 0 > 1).length', '}', 'return t'))).toBe(undefined)
  // Controls.
  expect(answer(fn(R4, 'const d = items.filter(x => x !== k)', ...nestOver('d')))).toBe('O(n²)')
  expect(answer(fn(R4, 'let t = 0', 'for (const y of ids) {', '  t += items.filter(x => x === y).length', '}', 'return t'))).toBe('O(n·m)')
})

test('task 6 fix round 5: &&=, ||= and ??= fail', async () => {
  for (const [init, line] of [['let t = 0', 't &&= ids.indexOf(k)'], ['let t = 1', 't ||= ids.indexOf(k)'], ['let t = 0', 't ??= ids.indexOf(k)'], ['let t = k', 't &&= ids.indexOf(k)'], ['let t = 0', 't &&= 1'], ['let t = 0', 't ??= k']]) {
    expect([line, answer(fn(R4, init!, line!, 'for (const x of items) {', '  t += x', '}', 'return t'))]).toEqual([line, undefined])
    expect([line, 'loop', answer(fn(R4, init!, 'for (const x of items) {', `  ${line!.replace('(k)', '(x)')}`, '}', 'return t'))]).toEqual([line, 'loop', undefined])
  }
  expect(answer(fn(R4, 'let t = 0', 't += k', 'for (const x of items) {', '  t += x', '}', 'return t'))).toBe('O(n)')
})

// --- Task 7 fix round 1 (shared rulings) ------------------------------------------

test('ruling A: a number literal beyond 2^31 - 1, in any form, refuses', async () => {
  for (const lit of ['2147483648', '1e400', '1e10', '0xFFFFFFFFF', '0b111111111111111111111111111111111', '2147483648.5', '9007199254740993']) {
    expect(answer(r4Work(`k > ${lit}`))).toBe(undefined)
    expect(answer(r4Exit(`k <= ${lit}`))).toBe(undefined)
    expect(answer(inLoop(`t += ${lit}`))).toBe(undefined)
  }
  expect(answer(r4Work('k > 2147483647'))).toBe('O(n)')
  expect(answer(r4Work('k > -2147483647'))).toBe('O(n)')
})

test('ruling B: a join separator is a literal; a string parameter refuses', async () => {
  expect(answer(inLoop('t += ids.join(sep).length', 'items: number[], ids: number[], sep: string'))).toBe(undefined)
  expect(answer(inLoop('t += ids.join(sep.charAt(0)).length', 'items: number[], ids: number[], sep: string'))).toBe(undefined)
  expect(answer(inLoop("t += ids.join(',').length"))).toBe('O(n·m)')
  expect(answer(inLoop('t += ids.join().length'))).toBe('O(n·m)')
})

test('ruling D: a string parameter (or an alias of one) is no comparison operand, needle or key', async () => {
  const P = 'items: number[], words: string[], s: string, t2: string, set: Set<string>, m: Map<string, number>'
  for (const body of [
    ['let c = 0', 'for (const x of items) {', '  if (s === t2) {', '    c++', '  }', '}', 'return c'],
    ['let c = 0', 'for (const x of items) {', '  if (s < t2) {', '    c++', '  }', '}', 'return c'],
    ['let c = 0', 'for (const w of words) {', '  if (w === s) {', '    c++', '  }', '}', 'return c'],
    ['let c = 0', 'for (const w of words) {', '  if (w === s) {', '    return c', '  }', '}', 'return c'],
    ['let c = 0', 'for (const x of items) {', '  if (words.includes(s)) {', '    c++', '  }', '}', 'return c'],
    ['let c = 0', 'for (const x of items) {', '  c += words.indexOf(s)', '}', 'return c'],
    ['let c = 0', 'for (const x of items) {', '  if (set.has(s)) {', '    c++', '  }', '}', 'return c'],
    ['let c = 0', 'for (const x of items) {', '  c += m.get(s) ?? 0', '}', 'return c'],
    ['const u = s', 'let c = 0', 'for (const x of items) {', '  if (u === t2) {', '    c++', '  }', '}', 'return c'],
    ['const seen = new Set<string>()', 'for (const x of items) {', '  seen.add(s)', '}', 'return seen.size'],
    ['const seen = new Map<string, number>()', 'for (const x of items) {', '  seen.set(s, 1)', '}', 'return seen.size'],
    ['let c = 0', 'for (const w of words) {', '  c += w === s ? 1 : 0', '}', 'return c'],
    ['const d = words.filter(w => w === s)', 'return d.length'],
  ]) {
    expect(answer(fn(P, ...body))).toBe(undefined)
  }
  // .length and single characters stay.
  expect(answer(fn(P, 'let c = 0', 'for (const x of items) {', '  c += s.length', '}', 'return c'))).toBe('O(n)')
  expect(answer(fn(P, 'let c = 0', 'for (let i = 0; i < s.length; i++) {', "  if (s.charAt(i) === 'a') {", '    c++', '  }', '}', 'return c'))).toBe('O(n)')
})

// --- Task 7 fix round 2: ruling D′, fixed-cost operands ------------------------------

test('D-c: only a number literal, a plain string literal, a number parameter, a counter, an element or a character is an operand, needle or key', async () => {
  for (const type of ['(string)', 'Lowercase<string>', 'Uppercase<string>', 'NonNullable<string>', 'Readonly<string>', 'string & {}', 'string | number', 'number | string', 'any', 'unknown', 'Name', "'a' | 'b'", 'string', 'boolean']) {
    expect(answer(fn(`items: number[], s: ${type}, c: ${type}`, 'let t = 0', 'for (const x of items) {', '  if (s === c) {', '    t++', '  }', '}', 'return t'))).toBe(undefined)
    expect(answer(fn(`items: number[], s?: ${type}, c?: ${type}`, 'let t = 0', 'for (const x of items) {', '  t += s < c ? 1 : 0', '}', 'return t'))).toBe(undefined)
    expect(answer(fn(`items: number[], ids: string[], s: ${type}`, 'let t = 0', 'for (const x of items) {', '  t += ids.indexOf(s)', '}', 'return t'))).toBe(undefined)
  }
  expect(answer(ts('function f(items: number[], s = "x", c = "y"): number {', '  let t = 0', '  for (const x of items) {', '    if (s === c) {', '      t++', '    }', '  }', '  return t', '}'))).toBe(undefined)
  // Number parameters, counters, elements and literals stay.
  expect(answer(fn('items: number[], k: number, j: number', 'let t = 0', 'for (const x of items) {', '  if (k === j) {', '    t++', '  }', '}', 'return t'))).toBe('O(n)')
  expect(answer(fn('items: number[], ids: number[], k: number', 'let t = 0', 'for (const x of items) {', '  t += ids.indexOf(x + k)', '}', 'return t'))).toBe('O(n·m)')
  expect(answer(fn('items: number[], ids: number[]', 'let t = 0', 'for (const x of items) {', '  t += ids.indexOf(x)', '}', 'return t'))).toBe('O(n·m)')
  expect(answer(fn('items: string[]', 'let t = 0', 'for (const x of items) {', "  if (x === 'a') {", '    t++', '  }', '}', 'return t'))).toBe('O(n)')
})

test('D-a in TypeScript: a map or filter callback names only its own parameters, literals and fixed-cost operands', async () => {
  for (const cb of ['items.map(y => s)', 'items.map(y => ids)', 'items.filter(y => ids.includes(y))', 'items.filter(y => set.has(y))', 'items.map(y => y.toString())']) {
    expect(answer(fn('items: number[], ids: number[], s: string, set: Set<number>', 'const t2 = 1', `const d = ${cb}`, 'return d.length'))).toBe(undefined)
  }
  expect(answer(fn('items: number[], k: number', 'const d = items.map(y => y + k)', 'return d.length'))).toBe('O(n)')
  expect(answer(fn('items: number[], k: number', 'const d = items.filter(y => y > k)', 'let t = 0', 'for (const u of d) {', '  t += u', '}', 'return t'))).toBe('O(n)')
  // A derived collection's element is no fixed-cost operand.
  expect(answer(fn('items: number[], ids: number[]', 'const d = items.slice()', 'let t = 0', 'for (const u of d) {', '  t += ids.indexOf(u)', '}', 'return t'))).toBe(undefined)
})

test('destructured parts of an element are no fixed-cost operands: such a loop refuses, as in Python and PHP (final review M1)', async () => {
  expect(answer(fn('srows: string[][]', 'let t = 0', 'for (const [p, q] of srows) {', '  if (p === q) {', '    t++', '  }', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('rows: number[][], k: number', 'let t = 0', 'for (const [p, q] of rows) {', '  if (p === k) {', '    t += q', '  }', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('srows: string[][]', 'const st = new Set<string>()', 'for (const [p] of srows) {', '  st.add(p)', '}', 'return st.size'))).toBe(undefined)
  // Object patterns, in a loop head or a callback, refuse too.
  expect(answer(fn('rows: Row[], k: number', 'let t = 0', 'for (const { a, b } of rows) {', '  if (a === k) {', '    t += 1', '  }', '}', 'return t'))).toBe(undefined)
  expect(answer(fn('rows: Row[], k: number', 'let t = 0', 'rows.forEach(({ a }) => {', '  if (a === k) {', '    t += 1', '  }', '})', 'return t'))).toBe(undefined)
  expect(answer(fn('rows: number[][], k: number', 'let t = 0', 'rows.forEach(([p, q]) => {', '  if (p === k) {', '    t += q', '  }', '})', 'return t'))).toBe(undefined)
  // Pairs and entries still read.
  expect(answer(fn('m: Map<string, number>, k: number', 'let t = 0', 'for (const [key, v] of m) {', '  if (v === k) {', '    t += 1', '  }', '}', 'return t'))).toBe('O(n)')
  expect(answer(fn('items: number[], k: number', 'for (const [i, x] of items.entries()) {', '  if (x === k) {', '    return i', '  }', '}', 'return -1'))).toBe('O(n)')
})
