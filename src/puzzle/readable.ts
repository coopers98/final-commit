import { PUZZLE, PUZZLE_VIEW } from '../config'
import type { Unit } from './units'

// SPEC 8.3: whether a filtered unit is worth showing. A unit the filters
// mostly blanked or replaced is no puzzle: it is trimmed, or skipped. Pure.

/** The privacy filters' replacement tokens. */
const PLACEHOLDER = /\[(?:quoted|name|url|email|ip|host|key|ssn|date|phone|id|age|number|secret)\]/

/** A line a filter blanked: a `…` with nothing beside it but punctuation the filters keep (`…;`, `} …`). */
export const isBlankedLine = (line: string): boolean => line.includes('…') && line.replace(/[\s…;,{}()[\]]/g, '') === ''

/** Words (runs of non-space) holding a placeholder, over all words; 0 when there are none. */
export function placeholderShare(text: string): number {
  const words = text.split(/\s+/).filter(w => w !== '')
  return words.length === 0 ? 0 : words.filter(w => PLACEHOLDER.test(w)).length / words.length
}

/** A line worth naming in a puzzle: not blanked, and not mostly placeholders. */
export const isReadableLine = (line: string): boolean => !isBlankedLine(line) && placeholderShare(line) <= PUZZLE_VIEW.maxPlaceholderShare

/**
 * `unit` with blanked lines trimmed from both ends, or undefined when what
 * is left is too small, mostly blanked, or mostly placeholders.
 */
export function readableUnit(unit: Unit): Unit | undefined {
  let from = 0
  let to = unit.lines.length
  while (from < to && isBlankedLine(unit.lines[from]!)) from += 1
  while (to > from && isBlankedLine(unit.lines[to - 1]!)) to -= 1
  const lines = unit.lines.slice(from, to)
  if (lines.length < PUZZLE.unitMinLines) return undefined
  if (lines.filter(isBlankedLine).length / lines.length > PUZZLE_VIEW.maxBlankShare) return undefined
  if (placeholderShare(lines.join(' ')) > PUZZLE_VIEW.maxPlaceholderShare) return undefined
  return from === 0 && to === unit.lines.length ? unit : { ...unit, lines }
}
