// SPEC 8.4, Complexity Read: the TypeScript reader's answers checked against
// measured growth. Each corpus function (tests/complexity-growth-corpus.ts,
// whose keys tests/complexity-growth.test.ts checks against the reader) runs
// with a count at the top of every loop body and iteration callback, and on
// arrays whose linear builtins add their length, at sizes 64, 128 and 256.
// The ratio of counts between doublings must match the key's class. npm test
// runs this with node after the plugin's own tests, which cannot run
// generated code. Invented code only.
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import assert from 'node:assert/strict'
import { test } from 'node:test'

// The plugin imports without extensions; node needs `.ts`.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (err) {
      if (specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context)
      throw err
    }
  },
})

const { CORPUS, LINEAR, SORTS, instrument } = await import('../tests/complexity-growth-corpus.ts')

const SIZES = [64, 128, 256]
const HELD = 64
/** Relative tolerance on "≈": a ratio of 2 passes from 1.8 to 2.2. */
const NEAR = 0.1

const __c = { n: 0 }

/** Arrays whose linear builtins count their length, and sorts length × log2(length + 1). */
class Counted extends Array {}
for (const name of LINEAR) {
  Counted.prototype[name] = function (...args) {
    __c.n += this.length
    return Array.prototype[name].apply(this, args)
  }
}
for (const name of SORTS) {
  Counted.prototype[name] = function (...args) {
    __c.n += this.length * Math.log2(this.length + 1)
    return Array.prototype[name].apply(this, args)
  }
}
const from = xs => Counted.from(xs)

/** The entry's function, built once from its instrumented, type-stripped text. */
function build(entry) {
  // The corpus is fixed, test-only text in this repository.
  return new Function('__c', `${stripTypeScriptTypes(instrument(entry.lines))}\nreturn ${entry.name}`)(__c)
}

/** The count of one run at sizes n and m. */
function count(f, entry, n, m) {
  const args = entry.inputs(n, m, from)
  __c.n = 0
  f(...args)
  return __c.n
}

/** Ratios of counts between doublings: of n with m held, or of m with n held. */
function ratios(entry, ofM) {
  const f = build(entry)
  const counts = SIZES.map(s => (ofM ? count(f, entry, HELD, s) : count(f, entry, s, HELD)))
  assert.ok(counts.every(c => c > 0), `${entry.name}: counts ${counts}`)
  return { counts, ratios: counts.slice(1).map((c, i) => c / counts[i]) }
}

const near = (r, want) => Math.abs(r - want) <= want * NEAR

const sizeOf = x => (Array.isArray(x) || typeof x === 'string' ? x.length : x instanceof Map || x instanceof Set ? x.size : x)
/** True when the entry's inputs take a second size: m changes some argument. */
const takesM = entry => {
  const [a, b] = [entry.inputs(HELD, HELD, from), entry.inputs(HELD, 2 * HELD, from)]
  return a.some((x, i) => sizeOf(x) !== sizeOf(b[i]))
}
const ONE_SIZE = ['O(log n)', 'O(n)', 'O(n log n)', 'O(n²)', 'O(n³)']

/** Asserts the measured growth matches the key's class. */
function check(entry) {
  const { counts, ratios: rs } = ratios(entry, false)
  const say = `${entry.name} (${entry.answer}): counts ${counts.join(', ')}, ratios ${rs.map(r => r.toFixed(3)).join(', ')}`
  if (ONE_SIZE.includes(entry.answer) && takesM(entry)) {
    // A one-size key: the second size must leave the count flat.
    const m = ratios(entry, true)
    assert.ok(m.ratios.every(r => Math.abs(r - 1) <= NEAR), `${say}; in m: counts ${m.counts.join(', ')}, ratios ${m.ratios.map(r => r.toFixed(3)).join(', ')}`)
  }
  switch (entry.answer) {
    case 'O(log n)': {
      // A constant difference: the ratio falls toward 1.
      assert.ok(rs.every(r => r > 1 && r < 1.3), say)
      const [d1, d2] = [counts[1] - counts[0], counts[2] - counts[1]]
      assert.ok(d1 > 0 && Math.abs(d2 - d1) <= 1, say)
      return
    }
    case 'O(n)':
      return assert.ok(rs.every(r => near(r, 2)), say)
    case 'O(n log n)':
      return assert.ok(rs.every(r => r > 2 && r < 2.4), say)
    case 'O(n²)':
      return assert.ok(rs.every(r => near(r, 4)), say)
    case 'O(n³)':
      return assert.ok(rs.every(r => near(r, 8)), say)
    case 'O(n·m)':
    case 'O(n + m)': {
      const m = ratios(entry, true)
      const sayM = `${say}; in m: counts ${m.counts.join(', ')}, ratios ${m.ratios.map(r => r.toFixed(3)).join(', ')}`
      // n + m stays below 1.8 in each variable: true n·m measures 1.98 to 1.99
      // in m (the outer loop's own count), which a bound of 2 would pass.
      const fits = entry.answer === 'O(n·m)' ? r => near(r, 2) : r => r > 1 && r < 2 * (1 - NEAR)
      return assert.ok([...rs, ...m.ratios].every(fits), sayM)
    }
    default:
      assert.fail(`${entry.name}: no growth class for ${entry.answer}`)
  }
}

for (const entry of CORPUS) {
  test(`${entry.name}: measured growth matches ${entry.answer}`, () => check(entry))
}
