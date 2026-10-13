import { expect, test } from 'claude-code/testing'
import type { AnalyzeView } from '../types'
import { PUZZLE_VIEW } from '../src/config'
import { marksOf } from '../src/puzzle/analyze'
import { clampOffset, codeWindow, dockColumns, gutterWidth, isOverCode, panelLines, paneSize, puzzleLayout, scrollKey, wrapCode } from '../src/puzzle/layout'

// Invented content only (SPEC 15).

const view = (over: Partial<AnalyzeView> = {}): AnalyzeView => ({
  heading: '◆ Gnaw (Rare)',
  tier: 'rare',
  label: 'Analyze Specimen · Bug Hunt · TypeScript',
  question: 'One line was changed to bring in a bug. Which one?',
  code: ['function f(a: number) {', '  const b = a + 1', '  if (b > 2) return b', '  return a', '}'],
  marks: [null, 0, 1, 2, null],
  choices: ['1  Line 2', '2  Line 3', '3  Line 4'],
  result: null,
  offset: null,
  ...over,
})

test('marks come only from a Bug Hunt choice naming a line inside the code', async () => {
  const code = ['a', 'b', 'c', 'd']
  expect(marksOf({ type: 'bug-hunt', code, choices: ['Line 2', 'Line 4', 'Line 9', 'Line x'] })).toEqual([null, 0, null, 1])
  expect(marksOf({ type: 'pattern-id', code, choices: ['Line 3', 'b', 'c', 'd'] })).toEqual([null, null, null, null])
})

test('the gutter numbers each line or marks a candidate, and long lines wrap under a hanging indent', async () => {
  expect(gutterWidth(9)).toBe(5)
  expect(gutterWidth(12345)).toBe(6)
  const w = wrapCode(['short', 'x'.repeat(30)], [null, 1], 20)
  expect(w.rows).toEqual(['   1 short', '[2]> xxxxxxxxxxxxxxx', '       xxxxxxxxxxxxx', '       xx'])
  expect(w.firstRow).toEqual([0, 1])
  for (const r of w.rows) expect([...r].length <= 20).toBe(true)
})

test('the window clamps, says what is above and below, and fits when it can', async () => {
  const rows = ['a', 'b', 'c', 'd', 'e', 'f']
  expect(codeWindow(rows, 10, 3)).toEqual({ rows, more: undefined, offset: 0, visible: 6, total: 6 })
  expect(codeWindow(rows, 3, 0)).toEqual({ rows: ['a', 'b'], more: '↓ 4 more', offset: 0, visible: 2, total: 6 })
  expect(codeWindow(rows, 3, 2)).toEqual({ rows: ['c', 'd'], more: '↑ 2 more  ↓ 2 more', offset: 2, visible: 2, total: 6 })
  expect(codeWindow(rows, 3, 99).offset).toBe(4)
  expect(codeWindow(rows, 3, -5).offset).toBe(0)
  expect(clampOffset(7, 6, 2)).toBe(4)
})

test('a line taller than the window is still reachable row by row', async () => {
  const long = wrapCode(['y'.repeat(400)], [0], 40).rows
  expect(long.length > 10).toBe(true)
  // Continuation rows can read alike, so coverage is counted by row index.
  const seen = new Set<number>()
  for (let at = 0; at < long.length; at += 1) {
    const w = codeWindow(long, 4, at)
    for (let k = 0; k < w.visible; k += 1) seen.add(w.offset + k)
  }
  expect(seen.size).toBe(long.length)
})

test('two columns from 80 body columns, stacked below; the window opens on the first candidate', async () => {
  const wide = puzzleLayout(view(), ['1-3: answer'], { columns: 80, rows: 20 })
  expect(wide.isColumns).toBe(true)
  expect(wide.codeWidth).toBe(80 - PUZZLE_VIEW.panelColumns - 1)
  const narrow = puzzleLayout(view(), ['1-3: answer'], { columns: 79, rows: 20 })
  expect(narrow.isColumns).toBe(false)
  expect(narrow.codeWidth).toBe(79)
  const many = view({ code: Array.from({ length: 30 }, (_, i) => `line ${i}`), marks: Array.from({ length: 30 }, (_, i) => (i === 12 ? 0 : null)) })
  const at = puzzleLayout(many, [], { columns: 140, rows: 10 })
  expect(at.start).toBe(12)
  expect(at.code.offset).toBe(12)
  expect(at.code.rows[0]).toContain('[1]>')
  // Once the reader scrolls, their offset wins.
  expect(puzzleLayout({ ...many, offset: 3 }, [], { columns: 140, rows: 10 }).code.offset).toBe(3)
  // At 40 columns stacked, the code keeps at least minCodeRows.
  expect(puzzleLayout(many, ['1-3: answer', 's: skip'], { columns: 40, rows: 6 }).code.rows.length + 1 >= PUZZLE_VIEW.minCodeRows).toBe(true)
  // No rows (mobile): the code is drawn whole.
  expect(puzzleLayout(many, [], { columns: 40, rows: undefined }).code.rows.length).toBe(30)
})

test('a panel taller than the body cuts the explanation first, never the choices, hints or verdict', async () => {
  const answered = view({ result: { lines: ['Not this time: the answer was 2, Line 3.', 'Line 3: `>` became `>=`. '.repeat(10)] } })
  const lines = panelLines(answered, ['Enter: on to containment', 'd: dispute this puzzle'], 30, 14)
  expect(lines.length <= 14 - PUZZLE_VIEW.inputRows).toBe(true)
  const text = lines.map(l => l.text).join('\n')
  for (const must of ['1  Line 2', '3  Line 4', 'Not this time', 'Enter: on to', 'd: dispute']) expect(text).toContain(must)
  expect(lines.some(l => l.text === '…')).toBe(true)
  // With room, everything shows, the heading first.
  expect(panelLines(answered, ['Enter'], 30)[0]).toEqual({ text: '◆ Gnaw (Rare)', kind: 'heading' })
})

test('the dock asks for a share of the terminal, at least two columns, leaving the transcript room', async () => {
  expect(dockColumns(200)).toBe(120)
  expect(dockColumns(130)).toBe(PUZZLE_VIEW.twoColumnMin)
  expect(dockColumns(110)).toBe(110 - PUZZLE_VIEW.minTranscriptColumns)
  expect(paneSize(view(), { columns: undefined, rows: undefined })).toEqual({})
  expect(paneSize(view(), { columns: 200, rows: 50 })).toEqual({ columns: 120, rows: 5 + 3 + PUZZLE_VIEW.panelReserveRows })
  expect(paneSize(view(), { columns: 200, rows: 12 }).rows).toBe(12 - PUZZLE_VIEW.inlineReserveRows)
})

test('j and k move a row, space and b a page; other keys are not scroll keys', async () => {
  expect(['j', 'k', ' ', 'b', 'd', 's', '1'].map(scrollKey)).toEqual([1, -1, 'page', '-page', undefined, undefined, undefined])
})

test('the wheel is over the code inside its window only', async () => {
  const cols = { isColumns: true, codeColumns: 49, codeRows: 20, bodyOffset: 0 }
  expect(isOverCode(cols, { column: 10, row: 5 })).toBe(true)
  expect(isOverCode(cols, { column: 60, row: 5 })).toBe(false)
  const stacked = { isColumns: false, codeColumns: 40, codeRows: 4, bodyOffset: 2 }
  expect(isOverCode(stacked, { column: 3, row: 1 })).toBe(true)
  expect(isOverCode(stacked, { column: 3, row: 2 })).toBe(false)
})
