import type { AnalyzeView } from '../../types'
import { PUZZLE_VIEW } from '../config'
import { wrap } from '../bridge/text'

// SPEC 8, the Analyze pane's geometry (puzzle view spec, section 2). Pure:
// sizes are in wrapped rows; the pane draws what this returns.

/** The gutter's width: the widest of the line numbers and `[n]>`, and a space. */
export const gutterWidth = (lines: number): number => Math.max(String(lines).length, 4) + 1

/**
 * `lines` wrapped to `width` cells: each line's first row starts with its
 * number, or `[n]>` where `marks` names choice n - 1; the rows it wraps
 * onto are indented two cells past the gutter, so no text is cut.
 */
export function wrapCode(lines: readonly string[], marks: readonly (number | null)[], width: number): { rows: string[]; firstRow: number[] } {
  const g = gutterWidth(lines.length)
  const first = Math.max(1, width - g)
  const rest = Math.max(1, first - 2)
  const rows: string[] = []
  const firstRow: number[] = []
  for (const [i, line] of lines.entries()) {
    firstRow.push(rows.length)
    const mark = marks[i] ?? null
    let text = [...line]
    rows.push(`${(mark === null ? String(i + 1) : `[${mark + 1}]>`).padStart(g - 1)} ${text.slice(0, first).join('')}`)
    text = text.slice(first)
    while (text.length > 0) {
      rows.push(`${' '.repeat(g + 2)}${text.slice(0, rest).join('')}`)
      text = text.slice(rest)
    }
  }
  return { rows, firstRow }
}

export const clampOffset = (offset: number, total: number, visible: number): number => Math.max(0, Math.min(offset, total - visible))

/** A window over wrapped rows: the rows shown and, when not all fit, a last row saying how many are above and below. */
export type CodeWindow = { rows: string[]; more: string | undefined; offset: number; visible: number; total: number }

export function codeWindow(rows: readonly string[], height: number, offset: number): CodeWindow {
  const total = rows.length
  if (total <= height) return { rows: [...rows], more: undefined, offset: 0, visible: total, total }
  const visible = Math.max(1, height - 1)
  const at = clampOffset(offset, total, visible)
  const below = total - at - visible
  const more = [at > 0 ? `↑ ${at} more` : '', below > 0 ? `↓ ${below} more` : ''].filter(s => s !== '').join('  ')
  return { rows: rows.slice(at, at + visible), more, offset: at, visible, total }
}

export type PanelLine = { text: string; kind: 'heading' | 'label' | 'question' | 'choice' | 'result' | 'hint' }

/**
 * The panel's lines at `width`, leaving `maxRows` room for the Input too.
 * Essentials last and never cut: question, choices, the result's first line
 * (right or not) and the hints. When they do not all fit, the explanation
 * is cut first, ending in `…`; then the heading and label go.
 */
export function panelLines(view: AnalyzeView, hints: readonly string[], width: number, maxRows = Number.POSITIVE_INFINITY): PanelLine[] {
  const of = (texts: readonly string[], kind: PanelLine['kind']) => texts.flatMap(t => wrap(t, width)).map(text => ({ text, kind }))
  const head = [...of([view.heading], 'heading'), ...of([view.label], 'label')]
  const question = of([view.question], 'question')
  const choices = of(view.choices, 'choice')
  const verdict = of(view.result?.lines.slice(0, 1) ?? [], 'result')
  const more = of(view.result?.lines.slice(1) ?? [], 'result')
  const keys = of(hints, 'hint')
  const room = maxRows - PUZZLE_VIEW.inputRows
  const essential = question.length + choices.length + verdict.length + keys.length
  const shownHead = essential + head.length <= room ? head : []
  const left = room - essential - shownHead.length
  const shownMore = more.length <= left ? more : left <= 0 ? [] : [...more.slice(0, left - 1), { text: '…', kind: 'result' as const }]
  return [...shownHead, ...question, ...choices, ...verdict, ...shownMore, ...keys]
}

export type PuzzleLayout = { isColumns: boolean; codeWidth: number; panel: PanelLine[]; code: CodeWindow; start: number }

/**
 * The pane at `size` body cells. `rows` undefined (no Input to scroll with,
 * as on mobile): the code is drawn whole. Two columns from
 * `twoColumnMin`: code left, the panel right with a one-cell gap; below
 * that, stacked: the code window on top, the panel under it.
 */
export function puzzleLayout(view: AnalyzeView, hints: readonly string[], size: { columns: number; rows: number | undefined }): PuzzleLayout {
  const isColumns = size.columns >= PUZZLE_VIEW.twoColumnMin
  const panelWidth = isColumns ? PUZZLE_VIEW.panelColumns : size.columns
  const codeWidth = isColumns ? size.columns - PUZZLE_VIEW.panelColumns - 1 : size.columns
  const wrapped = wrapCode(view.code, view.marks, codeWidth)
  const first = view.marks.findIndex(m => m !== null)
  const start = first < 0 ? 0 : wrapped.firstRow[first]!
  if (size.rows === undefined) {
    return { isColumns, codeWidth, panel: panelLines(view, hints, panelWidth), code: codeWindow(wrapped.rows, wrapped.rows.length, 0), start }
  }
  // Only the two-column panel cuts; stacked, the window takes the rows left (at least minCodeRows) and the body scrolls past that.
  const panel = panelLines(view, hints, panelWidth, isColumns ? size.rows : undefined)
  const height = isColumns ? size.rows : Math.max(PUZZLE_VIEW.minCodeRows, size.rows - panel.length - PUZZLE_VIEW.inputRows)
  return { isColumns, codeWidth, panel, code: codeWindow(wrapped.rows, height, view.offset ?? start), start }
}

/** The dock width to ask for beside a transcript `terminal` columns wide. */
export function dockColumns(terminal: number): number {
  const wanted = Math.max(PUZZLE_VIEW.twoColumnMin, Math.round(terminal * PUZZLE_VIEW.dockShare))
  return Math.max(1, Math.min(wanted, terminal - PUZZLE_VIEW.minTranscriptColumns))
}

/** What `$.ui.open` asks for: a dock width, and inline rows for the code and choices plus the panel, leaving the prompt room. */
export function paneSize(view: AnalyzeView, terminal: { columns: number | undefined; rows: number | undefined }): { columns?: number; rows?: number } {
  const out: { columns?: number; rows?: number } = {}
  if (terminal.columns !== undefined) out.columns = dockColumns(terminal.columns)
  if (terminal.rows !== undefined) {
    const wanted = view.code.length + view.choices.length + PUZZLE_VIEW.panelReserveRows
    out.rows = Math.max(PUZZLE_VIEW.minCodeRows, Math.min(wanted, terminal.rows - PUZZLE_VIEW.inlineReserveRows))
  }
  return out
}

/** A scroll key typed into the pane's Input: rows to move, or a page either way. */
export function scrollKey(c: string): number | 'page' | '-page' | undefined {
  return c === 'j' ? 1 : c === 'k' ? -1 : c === ' ' ? 'page' : c === 'b' ? '-page' : undefined
}

/** Whether a wheel at `pointer` (cells from the body's first showing row) moves the code: the code window's rows when stacked, the whole body in two columns. */
export function isOverCode(at: { isColumns: boolean; codeRows: number; bodyOffset: number }, pointer: { column: number; row: number }): boolean {
  const row = pointer.row + at.bodyOffset
  return pointer.column >= 0 && row >= 0 && (at.isColumns || row < at.codeRows)
}

/** Whether a wheel at `pointer` moves the code: over the code, and the code window has rows it does not show. Else the body scrolls. */
export function wheelMovesCode(at: { isColumns: boolean; codeRows: number; bodyOffset: number; visible: number; total: number }, pointer: { column: number; row: number }): boolean {
  return at.total > at.visible && isOverCode(at, pointer)
}
