import { PUZZLE } from '../config'
import type { Rng } from '../rng'
import type { Puzzle } from './puzzle'
import type { Unit } from './units'

// SPEC 8, Bug Hunt: one known defect injected into a unit; the answer is
// known by construction (8.1 rule 2), so no model is asked.

type Mutation = { from: string; to: string; category: string }

/** Each replaces one spaced operator, so generics (`a<b>`) and arrows (`=>`) are never touched. */
const MUTATIONS: readonly Mutation[] = [
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

/** Lines a choice may name: inside the body, with more than a brace on them. */
function bodyLines(unit: Unit): number[] {
  return unit.lines.map((_, i) => i).filter(i => i > 0 && i < unit.lines.length - 1 && /[^\s{}();,]/.test(unit.lines[i]!))
}

const mutationsOf = (line: string) => MUTATIONS.filter(m => line.includes(m.from))

/** A Bug Hunt from one of `units`, or undefined when none has a line to change and enough lines to choose from. */
export function buildBugHunt(units: readonly Unit[], rng: Rng): Puzzle | undefined {
  const fit = units.filter(u => bodyLines(u).length >= PUZZLE.choices && bodyLines(u).some(i => mutationsOf(u.lines[i]!).length > 0))
  if (fit.length === 0) return undefined
  const unit = rng.pick(fit)
  const lines = bodyLines(unit)
  const target = rng.pick(lines.filter(i => mutationsOf(unit.lines[i]!).length > 0))
  const mutation = rng.pick(mutationsOf(unit.lines[target]!))
  const original = unit.lines[target]!
  // One occurrence, chosen at random when the line has several.
  const at: number[] = []
  for (let k = original.indexOf(mutation.from); k >= 0; k = original.indexOf(mutation.from, k + 1)) at.push(k)
  const pos = rng.pick(at)
  const changed = original.slice(0, pos) + mutation.to + original.slice(pos + mutation.from.length)

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
    question: 'One line was changed to bring in a bug. Which one?',
    lang: unit.lang,
    code: unit.lines.map((l, i) => (i === target ? changed : l)),
    choices: picked.map(i => `Line ${i + 1}`),
    answer: picked.indexOf(target),
    explanation: `Line ${target + 1} read \`${original.trim()}\`; \`${mutation.from.trim()}\` became \`${mutation.to.trim()}\`.`,
  }
}
