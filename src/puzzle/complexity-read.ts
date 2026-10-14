import { COMPLEXITY } from '../config'
import type { Rng } from '../rng'
import { costOf, type Reading } from './complexity'
import type { Puzzle } from './puzzle'
import type { Unit } from './units'

// SPEC 8.4, Complexity Read (FC-25): the Big-O of a function, read by the
// game's own cost reader, so the answer is known by construction (8.1 rule 2).

type Read = { unit: Unit; reading: Reading & { params: string[] } }

/** Line 1: the unit's name and parameter names; an over-long parameter list is cut, keeping the closing `)?`. */
function questionLine(name: string, params: readonly string[]): string {
  const head = `What is the time complexity of ${name}(`
  const full = `${head}${params.join(', ')})?`
  if (full.length <= COMPLEXITY.maxQuestionChars) return full
  return `${head}${params.join(', ').slice(0, Math.max(0, COMPLEXITY.maxQuestionChars - head.length - 3))}…)?`
}

/** Line 2: what n (and m) stand for, then the stated conventions. */
function sizeLine(r: Reading): string {
  const size = (s: string): string => (r.numeric.includes(s) ? 'count' : `size of ${s}`)
  return `n = ${size(r.n)}${r.m === undefined ? '' : `, m = ${size(r.m)}`}. ${COMPLEXITY.ruleText}`
}

/**
 * A Complexity Read for one of `units` that has a cost. With `weightOf`, the category is picked first in
 * proportion to its weight among those present (as Bug Hunt does), then a unit of it; none when no unit has a cost.
 */
export function buildComplexityRead(units: readonly Unit[], rng: Rng, weightOf?: (category: string) => number): Puzzle | undefined {
  const reads: Read[] = []
  for (const unit of units) {
    const reading = costOf(unit)
    if (reading) reads.push({ unit, reading })
  }
  if (reads.length === 0) return undefined
  let category: string | undefined
  if (weightOf) {
    const weights: Record<string, number> = {}
    for (const r of reads) weights[r.reading.category] ??= Math.max(0, weightOf(r.reading.category))
    if (Object.values(weights).some(w => w > 0)) category = rng.weighted(weights)
  }
  const { unit, reading } = rng.pick(reads.filter(r => category === undefined || r.reading.category === category))
  const choices = [reading.answer as string, ...(COMPLEXITY.distractors[reading.answer] ?? [])]
  for (let i = choices.length - 1; i > 0; i -= 1) {
    const j = rng.int(i + 1)
    ;[choices[i], choices[j]] = [choices[j]!, choices[i]!]
  }
  return {
    type: 'complexity-read',
    category: reading.category,
    question: `${questionLine(unit.name, reading.params)}\n${sizeLine(reading)}`,
    lang: unit.lang,
    code: [...unit.lines],
    choices,
    answer: choices.indexOf(reading.answer),
    explanation: reading.explanation,
  }
}
