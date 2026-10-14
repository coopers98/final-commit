// SPEC 8.4, Complexity Read: the cost algebra, the ladder and the category
// (spec docs/superpowers/specs/2026-10-13-complexity-read-design.md,
// "Combining" and "Category"), the structure trees ("Nesting and exits") and
// the inert check for hidden lines ("What the reader reads"). Pure; the
// language readers build on it.

import { COMPLEXITY } from '../config'
import { readTypeScript } from './complexity-ts'
import { isBlankedLine } from './readable'
import type { Unit } from './units'

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

/** A unit's answer and its parameter names for the question, by its language's reader; undefined when the reader cannot place it. Python and PHP have no reader yet. */
export function costOf(unit: Unit): (Reading & { params: string[] }) | undefined {
  const read = unit.lang === 'TypeScript' ? readTypeScript(unit) : undefined
  if (!read) return undefined
  const reading = readCost(read.cost, read.numeric, unit.full?.offset ?? 0)
  return reading && { ...reading, params: read.params }
}

/** A line and the lines nested under it; `at` indexes the lines read. */
export type Block = { at: number; text: string; children: Block[] }

/**
 * A line's unmatched braces: closes before its matched pairs, opens after.
 * Undefined when there is more than one of either, or one sits anywhere but
 * the line's ends. A blanked line is read by its kept braces alone (PHP puts
 * them all after the `…`).
 */
function braceEnds(line: string): { closes: number; opens: number } | undefined {
  const s = isBlankedLine(line) ? line.replace(/[^{}]/g, '') : line.trim()
  const open: number[] = []
  let closes = 0
  let onlyCloses = true
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (c === '{') open.push(i)
    else if (c === '}') {
      if (open.length > 0) open.pop()
      else if (onlyCloses) closes++
      else return undefined
    }
    if (c !== '}' && !/\s/.test(c)) onlyCloses = false
  }
  if (closes > 1 || open.length > 1) return undefined
  if (open.length === 1 && open[0] !== s.length - 1) return undefined
  return { closes, opens: open.length }
}

/** A line that only closes: shown `}`, `})`, `});`, or blanked keeping a lone `}` (`}…`, `… }`). It ends a block and is no statement; a blanked one's raw text is still checked through `hidden`. */
const isCloseOnly = (line: string): boolean =>
  isBlankedLine(line) ? line.replace(/[^{}]/g, '') === '}' : /^}[\s)\];,]*$/.test(line.trim())

/**
 * The line the root's `{` opens on: the first holding a brace, when every
 * line before it is a shown, brace-free part of the signature (PSR-12 opens
 * a function's body on its own line).
 */
function rootOpener(lines: readonly string[]): number | undefined {
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k]!
    if (isBlankedLine(line)) return undefined
    if (!/[{}]/.test(line)) continue
    const ends = braceEnds(line)
    return ends?.closes === 0 && ends.opens === 1 ? k : undefined
  }
  return undefined
}

/** TS and PHP: nesting by braces. A line may close (`}` first), open (`{` last), or both (`} else {`). Undefined when the braces do not balance, or a line has an unmatched `{`/`}` anywhere but its ends. The signature line is the root; when the signature runs on, its other lines up to the body's `{` are no blocks. */
export function treeByBraces(lines: readonly string[]): Block | undefined {
  const opener = rootOpener(lines)
  if (opener === undefined) return undefined
  const root: Block = { at: 0, text: lines[0]!, children: [] }
  const open: Block[] = [root]
  for (let at = opener + 1; at < lines.length; at++) {
    const text = lines[at]!
    if (text.trim() === '') continue
    // Anything after the root's close is outside the unit.
    if (open.length === 0) return undefined
    const ends = braceEnds(text)
    if (!ends) return undefined
    if (ends.closes === 1) open.pop()
    if (isCloseOnly(text)) continue
    const parent = open.at(-1)
    if (!parent) return undefined
    const block: Block = { at, text, children: [] }
    parent.children.push(block)
    if (ends.opens === 1) open.push(block)
  }
  return open.length === 0 ? root : undefined
}

const indentOf = (line: string): string => /^[ \t]*/.exec(line)![0]

const PAIRS: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

/** Every `(`, `[` and `{` closed in order on the line itself (strings and comments included: over-strict, so safe). */
function isBalanced(line: string): boolean {
  const stack: string[] = []
  for (const c of line) {
    if (c === '(' || c === '[' || c === '{') stack.push(c)
    else if (c in PAIRS && stack.pop() !== PAIRS[c]) return false
  }
  return stack.length === 0
}

/** One logical line: balanced, and not continued by a trailing backslash. */
const isWholeLine = (line: string): boolean => isBalanced(line) && !line.trimEnd().endsWith('\\')

/** Python: nesting by indentation, the `def` line the root. Undefined on an unbalanced bracket, a trailing backslash, or a dedent to a level never opened. */
export function treeByIndent(lines: readonly string[]): Block | undefined {
  const first = lines[0]
  if (first === undefined || !/^(?:async\s+)?def\b/.test(first.trim()) || !first.trimEnd().endsWith(':')) return undefined
  if (!lines.every(isWholeLine)) return undefined
  const root: Block = { at: 0, text: first, children: [] }
  // The open path from the root to the last line, each with its indent.
  const path: { block: Block; indent: string }[] = [{ block: root, indent: indentOf(first) }]
  for (let at = 1; at < lines.length; at++) {
    const text = lines[at]!
    if (text.trim() === '') continue
    const indent = indentOf(text)
    const last = path.at(-1)!
    if (indent.length > last.indent.length && indent.startsWith(last.indent)) {
      // Deeper only under a block opener; a blanked line may have been one (`if a:  # note`).
      if (!isBlankedLine(last.block.text) && !last.block.text.trimEnd().endsWith(':')) return undefined
    } else {
      // A sibling of a line on the path; the root's own level (or one never opened) is outside the unit.
      const k = path.findIndex((p) => p.indent === indent)
      if (k < 1) return undefined
      path.length = k
    }
    const block: Block = { at, text, children: [] }
    path.at(-1)!.block.children.push(block)
    path.push({ block, indent })
  }
  return root.children.length > 0 ? root : undefined
}

/** Where a hidden line sits, for the exit rule. */
export type HiddenPlace = { isInLoop: boolean; isLastAtBodyLevel: boolean; isInGuard: boolean }

/** Line breaks other than the split's: a raw line holding one is more than one line to some language. */
const ODD_BREAK = /[\n\r\v\f\u0085\u2028\u2029]/

/** Rule 1: TS and PHP keep the same braces in the same order; Python the same indent, one whole line. */
function hasKeptStructure(raw: string, kept: string, lang: 'TypeScript' | 'Python' | 'PHP'): boolean {
  if (lang === 'Python') return indentOf(raw) === indentOf(kept) && isWholeLine(raw)
  return raw.replace(/[^{}]/g, '') === kept.replace(/[^{}]/g, '')
}

/** TypeScript's identifier escapes (`i`, `\u{69}`) decoded, so an escaped name reads as itself. */
const decodeEscapes = (s: string): string =>
  s.replace(/\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})/g, (m, a: string | undefined, b: string | undefined) => {
    const code = parseInt(a ?? b ?? '', 16)
    return code <= 0x10ffff ? String.fromCodePoint(code) : m
  })

/**
 * Token shapes, each a reading of what one name may be: ASCII, Unicode
 * identifiers (with `$` and without, so PHP's `$name` and a string's `'$name'`
 * give `name`), and PHP's any-byte-above-ASCII names. Their union only adds
 * matches, never loses one.
 */
const TOKEN_SHAPES = [/[A-Za-z0-9_]+/g, /[\p{ID_Continue}\u200c\u200d]+/gu, /[\p{ID_Continue}$\u200c\u200d]+/gu, /[A-Za-z0-9_\u0080-\u{10ffff}]+/gu]

/** Compared as each language does: PHP ignores case (keywords and function names), Python reads names in NFKC. NFKC applies to all: over-strict, so safe. */
const keyOf = (s: string, lang: string): string => (lang === 'PHP' ? s.toLowerCase() : s).normalize('NFKC')

/** Every name the text could hold, strings and comments included, as keys. */
function namesIn(raw: string, lang: string): Set<string> {
  const names = new Set<string>()
  const decoded = decodeEscapes(raw)
  for (const text of [raw, decoded, raw.normalize('NFKC'), decoded.normalize('NFKC')]) {
    for (const shape of TOKEN_SHAPES) {
      for (const [token] of text.matchAll(shape)) {
        names.add(keyOf(token, lang))
        names.add(keyOf(token.replace(/^\d+/, ''), lang))
      }
    }
  }
  return names
}

/** A listed name is in the text when each of its name parts is (`Object.keys`: `Object` and `keys`). */
function holdsName(names: ReadonlySet<string>, name: string, lang: string): boolean {
  const parts = [...keyOf(name, lang).matchAll(/[\p{ID_Continue}$\u200c\u200d]+/gu)].map(([p]) => p.replace(/^\$+/, ''))
  return parts.length > 0 && parts.every((p) => p !== '' && names.has(p))
}

/** Python words after which `*` cannot be multiplication. */
const BEFORE_UNPACK = /(?:^|[^\p{ID_Continue}])(?:return|yield|await|in|is|not|and|or|if|elif|else|while|for|assert|del|lambda|import|from|print|match|case|with|as|except)$/u

/** Python unpacking: a `*` or `**` not after an operand (a name, number, closing bracket or quote), or after a keyword. Over-strict on purpose. */
function unpacksPython(raw: string): boolean {
  for (const m of raw.matchAll(/\*+/g)) {
    const before = raw.slice(0, m.index).trimEnd()
    const operand = /[\p{ID_Continue})\]}'"]$/u.test(before)
    if (!operand || BEFORE_UNPACK.test(before)) return true
  }
  return false
}

/** Spec "What the reader reads", rules 1 to 4. `kept` is the blanked line as shown; `bound` every name bound in the unit plus the unit's own name; `words` the language's builtin and global names. */
export function isInert(raw: string, kept: string, lang: 'TypeScript' | 'Python' | 'PHP', bound: ReadonlySet<string>, words: ReadonlySet<string>, place: HiddenPlace): boolean {
  if (!isBlankedLine(kept) || ODD_BREAK.test(raw)) return false
  if (!hasKeptStructure(raw, kept, lang)) return false
  const names = namesIn(raw, lang)
  const holds = (list: Iterable<string>): boolean => [...list].some((w) => holdsName(names, w, lang))
  if (holds(bound) || holds(words) || holds(COMPLEXITY.loopWords) || holds(COMPLEXITY.closureWords)) return false
  if (COMPLEXITY.inertSymbols.some((s) => raw.includes(s))) return false
  if (lang === 'Python' && unpacksPython(raw)) return false
  // PHP variable variables (`${'it'.'ems'}`, `$$name`) reach a name without writing it.
  if (lang === 'PHP' && (raw.includes('${') || raw.includes('$$'))) return false
  if (holds(COMPLEXITY.exitWords)) return !place.isInLoop && (place.isLastAtBodyLevel || place.isInGuard)
  return true
}
