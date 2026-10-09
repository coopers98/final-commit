import { PUZZLE } from '../config'
import type { Rng } from '../rng'
import { isBanned, parseReply, type Complete } from '../world/generate'
import type { Puzzle } from './puzzle'
import type { Unit } from './units'

// SPEC 8, Pattern ID: which pattern a function from the mission uses. One
// call writes the question; a second, independent call answers it without
// the key, and only an agreed answer is kept (8.1 rule 3). The prompts are
// working instructions (CLAUDE.md rule 1) and carry only filtered code.

/** Categories the accuracy record groups by (SPEC 8.2); the model picks one. */
export const PATTERN_CATEGORIES = [
  'hash map lookup', 'two pointers', 'sliding window', 'early return', 'guard clause', 'recursion', 'memoization',
  'map filter reduce', 'accumulator', 'state machine', 'builder', 'strategy', 'observer', 'dependency injection',
  'retry with backoff', 'pagination', 'batching', 'debounce', 'caching', 'validation', 'parsing', 'other',
] as const

const SYSTEM = 'You write short multiple-choice questions that test whether a developer recognizes the programming pattern in a piece of code. Reply with JSON only.'

export function generatorPrompt(unit: Unit): string {
  return [
    `Here is a ${unit.lang} function. String literals were replaced by … and comments removed.`,
    '',
    '```',
    ...unit.lines,
    '```',
    '',
    'Write one question asking which pattern or technique this function mainly uses.',
    `Give exactly 4 choices, each a short pattern name of at most ${PUZZLE.maxChoiceChars} characters: one clearly right, three plausible but wrong for this code.`,
    `Keep the question under ${PUZZLE.maxQuestionChars} characters and the explanation under ${PUZZLE.maxExplanationChars}.`,
    `Pick the category from: ${PATTERN_CATEGORIES.join(', ')}.`,
    'Reply with JSON: {"question": string, "choices": [string, string, string, string], "answer": 1 to 4, "explanation": string, "category": string}',
  ].join('\n')
}

export function checkerPrompt(unit: Unit, question: string, choices: readonly string[]): string {
  return [
    `Here is a ${unit.lang} function. String literals were replaced by … and comments removed.`,
    '',
    '```',
    ...unit.lines,
    '```',
    '',
    question,
    ...choices.map((c, i) => `${i + 1}. ${c}`),
    '',
    'Reply with JSON: {"answer": 1 to 4}, the number of the best choice.',
  ].join('\n')
}

type Generated = { question: string; choices: string[]; answer: number; explanation: string; category: string }

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= max

/** A generated question, checked for shape and length; undefined when it does not hold. */
export function parseGenerated(text: string): Generated | undefined {
  const v = parseReply(text) as Record<string, unknown> | undefined
  if (!v || typeof v !== 'object') return undefined
  const { question, choices, answer, explanation, category } = v
  if (!isText(question, PUZZLE.maxQuestionChars) || !isText(explanation, PUZZLE.maxExplanationChars)) return undefined
  if (!Array.isArray(choices) || choices.length !== PUZZLE.choices || !choices.every(c => isText(c, PUZZLE.maxChoiceChars))) return undefined
  const trimmed = (choices as string[]).map(c => c.trim())
  if (new Set(trimmed.map(c => c.toLowerCase())).size !== trimmed.length) return undefined
  if (typeof answer !== 'number' || !Number.isInteger(answer) || answer < 1 || answer > PUZZLE.choices) return undefined
  if ([question, explanation, ...trimmed].some(isBanned)) return undefined
  const cat = typeof category === 'string' && (PATTERN_CATEGORIES as readonly string[]).includes(category) ? category : 'other'
  return { question: question.trim(), choices: trimmed, answer: answer - 1, explanation: explanation.trim(), category: cat }
}

/** The checker's answer as an index, or undefined. */
export function parseCheck(text: string): number | undefined {
  const v = parseReply(text) as { answer?: unknown } | undefined
  const a = v && typeof v === 'object' ? v.answer : undefined
  return typeof a === 'number' && Number.isInteger(a) && a >= 1 && a <= PUZZLE.choices ? a - 1 : undefined
}

/** The largest unit: the most to recognize a pattern in. Ties go to the first. */
function richest(units: readonly Unit[]): Unit {
  return units.reduce((a, u) => (u.lines.length > a.lines.length ? u : a))
}

/** A Pattern ID from `units`, or undefined when a call fails, the reply does not hold, or the check disagrees. */
export async function buildPatternId(units: readonly Unit[], rng: Rng, complete: Complete): Promise<Puzzle | undefined> {
  const unit = richest(units)
  const made = await complete({ system: SYSTEM, prompt: generatorPrompt(unit) })
  const g = made.ok ? parseGenerated(made.text) : undefined
  if (!g) return undefined
  // Shuffled here, so the right answer's place is the game's choice, not the model's habit.
  const order = g.choices.map((_, i) => i)
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = rng.int(i + 1)
    ;[order[i], order[j]] = [order[j]!, order[i]!]
  }
  const choices = order.map(i => g.choices[i]!)
  const answer = order.indexOf(g.answer)
  const checked = await complete({ system: SYSTEM, prompt: checkerPrompt(unit, g.question, choices) })
  if (!checked.ok || parseCheck(checked.text) !== answer) return undefined
  return { type: 'pattern-id', category: g.category, question: g.question, lang: unit.lang, code: unit.lines, choices, answer, explanation: g.explanation }
}
