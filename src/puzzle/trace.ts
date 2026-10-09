import { PUZZLE, TRACE } from '../config'
import type { Rng } from '../rng'
import type { Puzzle } from './puzzle'
import type { CallResult } from './runners'
import { runnable, type ParamType, type Runnable } from './trace-gate'
import type { Unit } from './units'

// SPEC 8, Trace (Rare): a unit the gate shows self-contained (trace-gate.ts)
// is run by a runner on inputs generated here, with no model, and the player
// says what it returns. The answer is the runner's real output (8.1 rule 1).
// Pure apart from the `exec` it is handed.

/** Runs a runnable unit once per input, in one runner call; undefined when the run fails. */
export type Exec = (unit: Runnable, inputs: unknown[][]) => Promise<CallResult[] | undefined>

/** What `buildPuzzle` is handed when a runner is available: a Trace from these units, or none. */
export type TraceCapability = (units: readonly Unit[], rng: Rng) => Promise<Puzzle | undefined>

const int = (rng: Rng) => TRACE.intMin + rng.int(TRACE.intMax - TRACE.intMin + 1)
const word = (rng: Rng) => rng.pick(TRACE.words)
const list = <T>(rng: Rng, item: (r: Rng) => T): T[] => Array.from({ length: rng.int(TRACE.maxArrayLength + 1) }, () => item(rng))

/** One generated value of `type`. */
export function inputOf(type: ParamType, rng: Rng): unknown {
  switch (type) {
    case 'number': return int(rng)
    case 'string': return word(rng)
    case 'boolean': return rng.chance(0.5)
    case 'number[]': return list(rng, int)
    case 'string[]': return list(rng, word)
  }
}

/** Up to `TRACE.candidates` distinct argument tuples for `params`. */
export function candidateInputs(params: readonly ParamType[], rng: Rng): unknown[][] {
  const seen = new Set<string>()
  const out: unknown[][] = []
  // A few more tries than candidates, since small domains (one boolean) repeat.
  for (let k = 0; k < TRACE.candidates * 3 && out.length < TRACE.candidates; k += 1) {
    const args = params.map(p => inputOf(p, rng))
    const key = JSON.stringify(args)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(args)
  }
  return out
}

/** Printable ASCII and `…` only: no control or direction characters reach the pane. */
const isShowable = (s: string) => /^[\x20-\x7e…]*$/.test(s)

/** A value as a choice: compact JSON, or undefined when too wide or not showable. */
export function render(value: unknown): string | undefined {
  const s = JSON.stringify(value)
  return typeof s === 'string' && s.length <= TRACE.maxAnswerChars && isShowable(s) ? s : undefined
}

/** Near misses of `value`: numbers +/-1, booleans flipped, arrays reversed or one item dropped or added, strings with a letter changed. */
export function perturbations(value: unknown, rng: Rng): unknown[] {
  if (typeof value === 'number') return [value + 1, value - 1, value + 2, value - 2, -value, value * 2]
  if (typeof value === 'boolean') return [!value]
  if (typeof value === 'string') {
    const out: string[] = []
    if (value.length > 0) {
      const at = rng.int(value.length)
      const letter = value[at] === 'a' ? 'e' : 'a'
      out.push(value.slice(0, at) + letter + value.slice(at + 1), value.slice(0, -1), value.slice(1))
    }
    out.push(`${value}s`)
    return out
  }
  if (Array.isArray(value)) {
    const last = value[value.length - 1]
    const extra = typeof last === 'number' ? last + 1 : typeof last === 'string' ? word(rng) : 0
    return [
      [...value].reverse(), value.slice(0, -1), value.slice(1), [...value, extra],
      ...(value.every(v => typeof v === 'number') ? [value.map(v => (v as number) + 1)] : []),
    ]
  }
  return []
}

/** Choices that fit anything, when near misses run out. */
const FALLBACKS: readonly unknown[] = [null, 0, [], '', false, true, 1, -1]

/**
 * Three distractors for `answer`, as rendered choices, each distinct from it
 * and from each other: other inputs' results first, then near misses, then
 * fallbacks. Undefined when three cannot be found.
 */
export function distractors(answer: unknown, others: readonly unknown[], rng: Rng): string[] | undefined {
  const right = render(answer)
  if (right === undefined) return undefined
  const out: string[] = []
  const add = (v: unknown) => {
    const s = render(v)
    if (s !== undefined && s !== right && !out.includes(s) && out.length < PUZZLE.choices - 1) out.push(s)
  }
  for (const v of others) add(v)
  for (const v of perturbations(answer, rng)) add(v)
  for (const v of FALLBACKS) add(v)
  return out.length === PUZZLE.choices - 1 ? out : undefined
}

/** The question for one input. */
export function questionOf(name: string, args: readonly unknown[]): string {
  return `What does ${name}(${args.map(a => JSON.stringify(a)).join(', ')}) return?`
}

/**
 * A Trace from the first of `units` (in a random order, at most
 * `TRACE.maxUnits` runs) that the gate passes and whose run gives an answer:
 * every candidate input is run twice in one call, and only an input whose
 * two results agree, are ok, and render within the limits is asked.
 */
export async function buildTrace(units: readonly Unit[], rng: Rng, exec: Exec): Promise<Puzzle | undefined> {
  const fit = units.map(u => ({ unit: u, run: runnable(u) })).filter((f): f is { unit: Unit; run: Runnable } => f.run !== undefined)
  const order = [...fit]
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = rng.int(i + 1)
    ;[order[i], order[j]] = [order[j]!, order[i]!]
  }
  for (const { unit, run } of order.slice(0, TRACE.maxUnits)) {
    const inputs = candidateInputs(run.params, rng)
    if (inputs.length === 0) continue
    const results = await exec(run, [...inputs, ...inputs])
    if (!results || results.length !== inputs.length * 2) continue
    const n = inputs.length
    const okAt = (i: number) => {
      const a = results[i]!
      const b = results[i + n]!
      return a.ok && b.ok && JSON.stringify(a.value) === JSON.stringify(b.value)
    }
    const valueAt = (i: number) => (results[i] as { value: unknown }).value
    const usable = inputs.map((_, i) => i).filter(okAt)
    for (const i of usable) {
      const answer = render(valueAt(i))
      const question = questionOf(run.name, inputs[i]!)
      if (answer === undefined || question.length > PUZZLE.maxQuestionChars) continue
      const others = usable.filter(k => k !== i).map(valueAt)
      const wrong = distractors(valueAt(i), others, rng)
      if (!wrong) continue
      const at = rng.int(PUZZLE.choices)
      const choices = [...wrong.slice(0, at), answer, ...wrong.slice(at)]
      return {
        type: 'trace', category: 'trace', question, lang: unit.lang, code: unit.lines,
        choices, answer: at, explanation: `Running it gives ${answer}.`,
      }
    }
  }
  return undefined
}
