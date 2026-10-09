import type { AnalyzeView } from '../../types'
import type { Tier } from '../config'
import type { PendingEncounter } from '../store/schema'
import type { Puzzle } from './puzzle'

// SPEC 8: what the Analyze Specimen step shows. Pure; the pane wraps and
// cuts to its width when it draws.

const TYPE_LABEL: Record<Puzzle['type'], string> = { 'pattern-id': 'Pattern ID', trace: 'Trace', 'bug-hunt': 'Bug Hunt' }

export function analyzeView(puzzle: Puzzle, heading: string, tier: Tier): AnalyzeView {
  return {
    heading, tier,
    label: `Analyze Specimen · ${TYPE_LABEL[puzzle.type]} · ${puzzle.lang}`,
    question: puzzle.question,
    // Numbered from 1, as Bug Hunt's choices name them.
    code: puzzle.code.map((l, i) => `${String(i + 1).padStart(2)}| ${l}`),
    choices: puzzle.choices.map((c, i) => `${i + 1}  ${c}`),
    result: null,
  }
}

/** The lines after an answer: right or not, the bonus, and why. */
export function resultLines(puzzle: Puzzle, analysis: NonNullable<PendingEncounter['analysis']>): string[] {
  if (analysis.isSkipped) return ['Skipped.']
  const head = analysis.isCorrect
    ? `Right. Containment +${Math.round(analysis.bonus * 100)}% for this creature.`
    : `Not this time: the answer was ${puzzle.answer + 1}, ${puzzle.choices[puzzle.answer]}.`
  return [head, puzzle.explanation]
}

/** A key typed in the step: a choice's index, `skip`, or nothing it knows. */
export function analyzeKey(c: string, choices: number): number | 'skip' | undefined {
  if (c.toLowerCase() === 's') return 'skip'
  const n = Number(c)
  return Number.isInteger(n) && n >= 1 && n <= choices ? n - 1 : undefined
}
