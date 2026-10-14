// SPEC 8.4, Complexity Read: the cost algebra, the ladder and the category
// (spec docs/superpowers/specs/2026-10-13-complexity-read-design.md,
// "Combining" and "Category"). Pure; the language readers build on it.

/** What a factor came from: the category and the explanation read it. */
export type FactorKind = 'loop' | 'callback' | 'builtin' | 'sort' | 'halving' | 'search'
/** One factor of a term: the size of parameter `size` (or its log), from the site at `at` (an index into the lines read). */
export type Factor = { size: string; log: boolean; kind: FactorKind; at: number; what: string }
/** A product of factors; the empty product is 1. */
export type Term = Factor[]
/** A sum of terms. */
export type Cost = Term[]

export const ONE: Cost = [[]]
export const factor = (f: Factor): Cost => [[f]]

/** Sequential costs add. */
export function add(a: Cost, b: Cost): Cost {
  return [...a, ...b]
}

/** Nested costs multiply. */
export function mul(a: Cost, b: Cost): Cost {
  const out: Cost = []
  for (const x of a) for (const y of b) out.push([...x, ...y])
  return out
}

type Degree = { pow: number; logs: number }

/** Per size, how many plain and how many log factors the term has. */
function degrees(t: Term): Map<string, Degree> {
  const d = new Map<string, Degree>()
  for (const f of t) {
    const e = d.get(f.size) ?? { pow: 0, logs: 0 }
    if (f.log) e.logs++
    else e.pow++
    d.set(f.size, e)
  }
  return d
}

const shapeKey = (d: Map<string, Degree>): string =>
  [...d].map(([s, e]) => `${s}:${e.pow}:${e.logs}`).sort().join('|')

/** True when `a` is at most `b` in every size, (power, log count) compared lexicographically. */
function dominatedBy(a: Map<string, Degree>, b: Map<string, Degree>): boolean {
  for (const [s, x] of a) {
    const y = b.get(s) ?? { pow: 0, logs: 0 }
    if (x.pow > y.pow || (x.pow === y.pow && x.logs > y.logs)) return false
  }
  return true
}

const firstAt = (t: Term): number => Math.min(...t.map((f) => f.at))

/** Drops every term dominated in every size by another (per size, (power, log count) compared lexicographically), and duplicates by shape. */
export function simplify(c: Cost): Cost {
  const byShape = new Map<string, { t: Term; d: Map<string, Degree> }>()
  for (const t of c) {
    const d = degrees(t)
    const k = shapeKey(d)
    const kept = byShape.get(k)
    // Of equal shapes keep the one whose first site is earliest, so the explanation names it.
    if (!kept || firstAt(t) < firstAt(kept.t)) byShape.set(k, { t, d })
  }
  const unique = [...byShape.values()]
  // Shapes are distinct here, so domination is strict: no pair removes each other.
  return unique.filter((x) => !unique.some((y) => y !== x && dominatedBy(x.d, y.d))).map((x) => x.t)
}

export type Ladder = 'O(1)' | 'O(log n)' | 'O(n)' | 'O(n log n)' | 'O(n²)' | 'O(n³)' | 'O(n·m)' | 'O(n + m)'
export type Category = 'halving' | 'sorting' | 'hidden linear call' | 'two inputs' | 'nested loops' | 'linear scan'
/** A unit's answer: undefined when the cost is constant or off the ladder (spec "Combining"). */
export type Reading = { answer: Ladder; category: Category; n: string; m?: string; numeric: string[]; explanation: string }

const SINGLE: Record<string, Ladder> = { '0,1': 'O(log n)', '1,0': 'O(n)', '1,1': 'O(n log n)', '2,0': 'O(n²)', '3,0': 'O(n³)' }

/** The ladder entry for a simplified cost, or undefined when it is none. */
function place(terms: Cost): Ladder | undefined {
  if (terms.length === 1) {
    const d = [...degrees(terms[0]!)]
    if (d.length === 1) return SINGLE[`${d[0]![1].pow},${d[0]![1].logs}`]
    if (d.length === 2 && d.every(([, e]) => e.pow === 1 && e.logs === 0)) return 'O(n·m)'
    return undefined
  }
  if (terms.length === 2) {
    const ds = terms.map((t) => [...degrees(t)])
    const linear = ds.every((d) => d.length === 1 && d[0]![1].pow === 1 && d[0]![1].logs === 0)
    if (linear && ds[0]![0]![0] !== ds[1]![0]![0]) return 'O(n + m)'
  }
  return undefined
}

const LOOPY: readonly FactorKind[] = ['loop', 'callback', 'halving', 'search']

function categoryOf(terms: Cost, answer: Ladder): Category {
  const all = terms.flat()
  if (all.some((f) => f.log && (f.kind === 'halving' || f.kind === 'search'))) return 'halving'
  if (all.some((f) => f.log && f.kind === 'sort')) return 'sorting'
  if (terms.some((t) => t.some((f) => f.kind === 'builtin') && t.some((f) => LOOPY.includes(f.kind)))) return 'hidden linear call'
  if (answer === 'O(n·m)' || answer === 'O(n + m)') return 'two inputs'
  if (terms.some((t) => t.filter((f) => f.kind === 'loop' || f.kind === 'callback').length >= 2)) return 'nested loops'
  return 'linear scan'
}

/** `term` written in n and m: sizes in name order, plain factors then logs, joined by ×. */
function product(t: Term, name: (s: string) => string): string {
  const parts: string[] = []
  for (const [s, e] of [...degrees(t)].sort((a, b) => Number(name(a[0]) === 'm') - Number(name(b[0]) === 'm'))) {
    for (let i = 0; i < e.pow; i++) parts.push(name(s))
    for (let i = 0; i < e.logs; i++) parts.push(`log ${name(s)}`)
  }
  return parts.join(' × ')
}

/** `cost` simplified and placed on the ladder; `numeric` names number parameters (sized by value); `offset` maps `at` to the pane's line numbers (`at - offset + 1`). */
export function readCost(cost: Cost, numeric: readonly string[], offset: number): Reading | undefined {
  const terms = simplify(cost)
  const answer = place(terms)
  if (!answer) return undefined
  const factors = terms.flat()
  const first = [...factors].sort((a, b) => a.at - b.at)
  const n = first[0]!.size
  const m = first.find((f) => f.size !== n)?.size
  const name = (s: string): string => (s === n ? 'n' : 'm')
  const sites: string[] = []
  const seen = new Set<string>()
  for (const f of first) {
    const k = `${f.at}:${f.what}`
    if (seen.has(k)) continue
    seen.add(k)
    sites.push(`${sites.length === 0 ? 'Line' : 'line'} ${f.at - offset + 1}: ${f.what}`)
  }
  // n first, then m: a term holding n sorts before one holding only m.
  const products = [...terms].sort((a, b) => Number(!a.some((f) => f.size === n)) - Number(!b.some((f) => f.size === n))).map((t) => product(t, name))
  const explanation = `${sites.join('; ')}. ${products.join(' + ')} = ${answer}.`
  return {
    answer,
    category: categoryOf(terms, answer),
    n,
    ...(m === undefined ? {} : { m }),
    numeric: [n, ...(m === undefined ? [] : [m])].filter((s) => numeric.includes(s)),
    explanation,
  }
}
