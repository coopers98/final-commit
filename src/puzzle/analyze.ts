import type { AnalyzeView } from '../../types'
import type { Tier } from '../config'
import type { PendingEncounter } from '../store/schema'
import type { Puzzle } from './puzzle'

// SPEC 8: what the Analyze Specimen step shows. Pure; the pane lays it out (src/puzzle/layout.ts).

const TYPE_LABEL: Record<Puzzle['type'], string> = { 'pattern-id': 'Pattern ID', trace: 'Trace', 'bug-hunt': 'Bug Hunt' }

export function analyzeView(puzzle: Puzzle, heading: string, tier: Tier): AnalyzeView {
  return {
    heading, tier,
    label: `Analyze Specimen · ${TYPE_LABEL[puzzle.type]} · ${puzzle.lang}`,
    question: puzzle.question,
    code: [...puzzle.code],
    marks: marksOf(puzzle),
    choices: puzzle.choices.map((c, i) => `${i + 1}  ${c}`),
    result: null,
    offset: null,
  }
}

/**
 * Bug Hunt's candidate lines: for each code line, the choice that names it
 * (`Line 8`), else null. Read from the choices, so a saved puzzle needs no
 * new field; another type's choices (a model's) mark nothing.
 */
export function marksOf(puzzle: Pick<Puzzle, 'type' | 'code' | 'choices'>): (number | null)[] {
  const marks: (number | null)[] = puzzle.code.map(() => null)
  if (puzzle.type !== 'bug-hunt') return marks
  for (const [i, c] of puzzle.choices.entries()) {
    const n = /^Line (\d+)$/.exec(c)?.[1]
    const at = n === undefined ? -1 : Number(n) - 1
    if (at >= 0 && at < marks.length) marks[at] = i
  }
  return marks
}

/** SPEC 8.1 rule 4: added to the result once the puzzle is disputed. */
export const DISPUTED_LINE = 'Disputed: kept for review, and this answer no longer counts in the dossier.'

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
