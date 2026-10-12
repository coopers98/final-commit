import { PUZZLE } from '../config'
import type { Rng } from '../rng'
import type { Puzzle } from './puzzle'
import type { Unit } from './units'

// SPEC 8, Bug Hunt: one known defect injected into a unit; the answer is
// known by construction (8.1 rule 2), so no model is asked.

/**
 * One change: `from` becomes `to`. Without `match`, every occurrence of
 * `from` is a place for it; with `match` (global), every match is, and
 * the text matched is what is replaced.
 */
type Mutation = { from: string; to: string; category: string; match?: RegExp }

/** Each replaces one spaced operator, so generics (`a<b>`) and arrows (`=>`) are never touched. */
const TS_MUTATIONS: readonly Mutation[] = [
  { from: ' === ', to: ' !== ', category: 'comparison' },
  { from: ' !== ', to: ' === ', category: 'comparison' },
  { from: ' <= ', to: ' < ', category: 'off by one' },
  { from: ' >= ', to: ' > ', category: 'off by one' },
  { from: ' < ', to: ' <= ', category: 'off by one' },
  { from: ' > ', to: ' >= ', category: 'off by one' },
  { from: ' && ', to: ' || ', category: 'boolean logic' },
  { from: ' || ', to: ' && ', category: 'boolean logic' },
  { from: ' + 1', to: ' - 1', category: 'off by one' },
  { from: ' - 1', to: ' + 1', category: 'off by one' },
]

/** Python's: comparisons, boolean words, negated identity and membership, off by one. */
const PY_MUTATIONS: readonly Mutation[] = [
  { from: ' == ', to: ' != ', category: 'comparison' },
  { from: ' != ', to: ' == ', category: 'comparison' },
  { from: ' <= ', to: ' < ', category: 'off by one' },
  { from: ' >= ', to: ' > ', category: 'off by one' },
  { from: ' < ', to: ' <= ', category: 'off by one' },
  { from: ' > ', to: ' >= ', category: 'off by one' },
  { from: ' and ', to: ' or ', category: 'boolean logic' },
  { from: ' or ', to: ' and ', category: 'boolean logic' },
  { from: ' is not ', to: ' is ', category: 'comparison' },
  { from: ' not in ', to: ' in ', category: 'comparison' },
  { from: ' + 1', to: ' - 1', category: 'off by one' },
  { from: ' - 1', to: ' + 1', category: 'off by one' },
]

/** PHP's: strict and loose comparisons, boolean operators, off by one. */
const PHP_MUTATIONS: readonly Mutation[] = [
  { from: ' === ', to: ' !== ', category: 'comparison' },
  { from: ' !== ', to: ' === ', category: 'comparison' },
  { from: ' == ', to: ' != ', category: 'comparison' },
  { from: ' != ', to: ' == ', category: 'comparison' },
  { from: ' <= ', to: ' < ', category: 'off by one' },
  { from: ' >= ', to: ' > ', category: 'off by one' },
  { from: ' < ', to: ' <= ', category: 'off by one' },
  { from: ' > ', to: ' >= ', category: 'off by one' },
  { from: ' && ', to: ' || ', category: 'boolean logic' },
  { from: ' || ', to: ' && ', category: 'boolean logic' },
  { from: ' + 1', to: ' - 1', category: 'off by one' },
  { from: ' - 1', to: ' + 1', category: 'off by one' },
]

/** The same change in upper case and lower case, as SQL keywords are written either way. */
const bothCases = (from: string, to: string, category: string, match: (from: string) => RegExp): Mutation[] => [
  { from: from.toUpperCase(), to: to.toUpperCase(), category, match: match(from.toUpperCase()) },
  { from: from.toLowerCase(), to: to.toLowerCase(), category, match: match(from.toLowerCase()) },
]

/** A keyword run as a whole word, its spaces any run of spaces or tabs. */
const keyword = (k: string) => new RegExp(`(?<![\\w$])${k.replace(/ /g, '[ \\t]+')}(?![\\w$])`, 'g')

/**
 * SQL's injected bad join or filter: a comparison turned around (an `=` only
 * after a filter keyword on its line, so never a `SET` or a default), a range
 * bound moved by one, `AND` and `OR` swapped (never after `BETWEEN`), a null
 * check or membership negated, a join made outer or inner.
 */
const SQL_MUTATIONS: readonly Mutation[] = [
  { from: ' = ', to: ' <> ', category: 'comparison', match: /(?<=(?<![\w$])(?:WHERE|ON|AND|OR|HAVING|WHEN|where|on|and|or|having|when)(?![\w$]).*) = /g },
  { from: ' <> ', to: ' = ', category: 'comparison' },
  { from: ' != ', to: ' = ', category: 'comparison' },
  { from: ' <= ', to: ' < ', category: 'off by one' },
  { from: ' >= ', to: ' > ', category: 'off by one' },
  { from: ' < ', to: ' <= ', category: 'off by one' },
  { from: ' > ', to: ' >= ', category: 'off by one' },
  { from: ' + 1', to: ' - 1', category: 'off by one' },
  { from: ' - 1', to: ' + 1', category: 'off by one' },
  { from: ' AND ', to: ' OR ', category: 'boolean logic', match: /(?<!(?<![\w$])BETWEEN(?![\w$]).*) AND /g },
  { from: ' and ', to: ' or ', category: 'boolean logic', match: /(?<!(?<![\w$])between(?![\w$]).*) and /g },
  { from: ' OR ', to: ' AND ', category: 'boolean logic' },
  { from: ' or ', to: ' and ', category: 'boolean logic' },
  ...bothCases('is null', 'is not null', 'null check', keyword),
  ...bothCases('is not null', 'is null', 'null check', keyword),
  ...bothCases(' in (', ' not in (', 'comparison', k => new RegExp(`(?<!(?<![\\w$])[Nn][Oo][Tt])${k.replace('(', '\\(')}`, 'g')),
  ...bothCases(' not in (', ' in (', 'comparison', k => new RegExp(k.replace('(', '\\('), 'g')),
  ...bothCases('left join', 'inner join', 'join type', keyword),
  ...bothCases('inner join', 'left join', 'join type', keyword),
  ...bothCases('join', 'left join', 'join type', k => new RegExp(`(?<![\\w$]|(?:left|right|inner|full|outer|cross|natural|LEFT|RIGHT|INNER|FULL|OUTER|CROSS|NATURAL)[ \\t]+)${k}(?![\\w$])`, 'g')),
]

/** A whole lowercase word (or words), not part of a longer word or a hyphenated one. */
const word = (w: string, notBefore = '') => new RegExp(`(?<![\\w-])${w.replace(/ /g, '[ \\t]+')}(?![\\w-]${notBefore})`, 'g')

/** A pair of words that contradict each other, each turned into the other. */
const flip = (a: string, b: string, category: string): Mutation[] => [
  { from: a, to: b, category, match: word(a) },
  { from: b, to: a, category, match: word(b) },
]

/**
 * Markdown's injected contradictions: whole lowercase words flipped both
 * ways. `must`, `should` and `can` are not negated where a `not` already
 * follows (no `must not not`), and `can` never inside `cannot` or `can't`.
 */
const MD_MUTATIONS: readonly Mutation[] = [
  { from: 'must', to: 'must not', category: 'negation', match: word('must', '|[ \\t]+not\\b') },
  { from: 'must not', to: 'must', category: 'negation', match: word('must not') },
  { from: 'should', to: 'should not', category: 'negation', match: word('should', '|[ \\t]+not\\b') },
  { from: 'should not', to: 'should', category: 'negation', match: word('should not') },
  { from: 'can', to: 'cannot', category: 'negation', match: word('can', "|['’]|[ \\t]+not\\b") },
  { from: 'cannot', to: 'can', category: 'negation', match: word('cannot') },
  ...flip('always', 'never', 'negation'),
  ...flip('true', 'false', 'negation'),
  ...flip('before', 'after', 'order'),
  ...flip('first', 'last', 'order'),
  ...flip('more', 'fewer', 'quantity'),
  ...flip('increase', 'decrease', 'quantity'),
  ...flip('minimum', 'maximum', 'quantity'),
  ...flip('above', 'below', 'quantity'),
  ...flip('enable', 'disable', 'scope'),
  ...flip('add', 'remove', 'scope'),
  ...flip('allow', 'deny', 'scope'),
  ...flip('required', 'optional', 'scope'),
]

const MUTATIONS_BY_LANG: Record<string, readonly Mutation[]> = { TypeScript: TS_MUTATIONS, Python: PY_MUTATIONS, PHP: PHP_MUTATIONS, SQL: SQL_MUTATIONS, Markdown: MD_MUTATIONS }

/** Where `mutation` can apply in `line`: each place and the length of the text it replaces. */
export function mutationSites(mutation: Mutation, line: string): { at: number; length: number }[] {
  const out: { at: number; length: number }[] = []
  if (!mutation.match) {
    for (let k = line.indexOf(mutation.from); k >= 0; k = line.indexOf(mutation.from, k + 1)) out.push({ at: k, length: mutation.from.length })
    return out
  }
  const re = new RegExp(mutation.match.source, 'g')
  for (let m = re.exec(line); m; m = re.exec(line)) {
    out.push({ at: m.index, length: m[0].length })
    re.lastIndex = m.index + Math.max(1, m[0].length)
  }
  return out
}

/** Every mutation of `lang`, for tests and the docs. */
export const mutationsFor = (lang: string): readonly Mutation[] => MUTATIONS_BY_LANG[lang] ?? []

/** Prose lines a contradiction can name: not the heading, not a blanked line, with a letter on it. */
const isMarkdownChoice = (line: string) => line.trim() !== '…' && /[A-Za-z]/.test(line)

/**
 * Lines a choice may name: inside the body, with more than a brace or a
 * blank on them. A block that ends in a `}` (TypeScript) leaves it out;
 * Python's last line is code.
 */
function bodyLines(unit: Unit): number[] {
  if (unit.lang === 'Markdown') return unit.lines.map((_, i) => i).filter(i => i > 0 && isMarkdownChoice(unit.lines[i]!))
  const last = unit.lines.length - 1
  const hasCloser = unit.lines[last]!.trim().startsWith('}')
  return unit.lines.map((_, i) => i).filter(i => i > 0 && (i < last || !hasCloser) && /[^\s{}();,…]/.test(unit.lines[i]!))
}

/** The mutations for `unit`'s language that can change `line`. */
const mutationsOf = (unit: Unit, line: string) => (MUTATIONS_BY_LANG[unit.lang] ?? []).filter(m => (m.match ? mutationSites(m, line).length > 0 : line.includes(m.from)))

/** A Bug Hunt from one of `units`, or undefined when none has a line to change and enough lines to choose from. */
export function buildBugHunt(units: readonly Unit[], rng: Rng): Puzzle | undefined {
  const fit = units.filter(u => bodyLines(u).length >= PUZZLE.choices && bodyLines(u).some(i => mutationsOf(u, u.lines[i]!).length > 0))
  if (fit.length === 0) return undefined
  const unit = rng.pick(fit)
  const lines = bodyLines(unit)
  const target = rng.pick(lines.filter(i => mutationsOf(unit, unit.lines[i]!).length > 0))
  const mutation = rng.pick(mutationsOf(unit, unit.lines[target]!))
  const original = unit.lines[target]!
  // One occurrence, chosen at random when the line has several.
  const site = rng.pick(mutationSites(mutation, original))
  const changed = original.slice(0, site.at) + mutation.to + original.slice(site.at + site.length)

  const others = lines.filter(i => i !== target)
  const picked = [target]
  while (picked.length < PUZZLE.choices) {
    const i = rng.pick(others.filter(o => !picked.includes(o)))
    picked.push(i)
  }
  picked.sort((a, b) => a - b)
  return {
    type: 'bug-hunt',
    category: mutation.category,
    question:
      unit.lang === 'Markdown'
        ? 'One line was changed to contradict the document. Which one?'
        : unit.lang === 'SQL'
          ? 'One line of the query was changed to bring in a bad join or filter. Which one?'
          : 'One line was changed to bring in a bug. Which one?',
    lang: unit.lang,
    code: unit.lines.map((l, i) => (i === target ? changed : l)),
    choices: picked.map(i => `Line ${i + 1}`),
    answer: picked.indexOf(target),
    explanation: `Line ${target + 1} read \`${original.trim()}\`; \`${mutation.from.trim()}\` became \`${mutation.to.trim()}\`.`,
  }
}
