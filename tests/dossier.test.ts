import { expect, test } from 'claude-code/testing'
import { DOSSIER } from '../src/config'
import { EMPTY_DOSSIER, dossierRows, totalsLine, trendOf, weakestOf } from '../src/bridge/dossier'
import type { DossierStat } from '../types'

const stat = (category: string, type: string, correct: number, attempts: number, recent: boolean[] = []): DossierStat => ({ category, type, attempts, correct, recent })
const text = (rows: { text: string }[]) => rows.map(r => r.text)

test('an empty record says so, wrapped to the width', () => {
  expect(text(dossierRows([], 80))).toEqual([EMPTY_DOSSIER])
  expect(text(dossierRows([stat('x', 'trace', 0, 0)], 80))).toEqual([EMPTY_DOSSIER])
  // Prose wraps rather than being cut.
  expect(text(dossierRows([], 40))).toEqual(['No puzzles answered yet. They come', '  before containment.'])
})

test('the totals line counts answers and rounds the percentage', () => {
  expect(totalsLine([stat('a', 'trace', 5, 8), stat('b', 'bug-hunt', 4, 4)])).toBe('12 answered, 9 right (75%)')
})

test('groups follow the type order, with the totals first and unlisted types last', () => {
  const rows = text(dossierRows([stat('t', 'trace', 1, 2), stat('p', 'pattern-id', 1, 2), stat('b', 'bug-hunt', 1, 2), stat('z', 'zeta', 1, 2)], 60))
  expect(rows[0]).toBe('8 answered, 4 right (50%)')
  expect(rows.filter(r => ['Pattern ID', 'Bug Hunt', 'Trace', 'zeta'].includes(r))).toEqual(['Pattern ID', 'Bug Hunt', 'Trace', 'zeta'])
})

test('within a type, the lowest accuracy comes first, ties by more answers then name', () => {
  const rows = text(dossierRows([
    stat('strong', 'trace', 9, 10), stat('few', 'trace', 1, 2), stat('many', 'trace', 3, 6), stat('alpha', 'trace', 3, 6),
  ], 60))
  const order = rows.filter(r => /^(strong|few|many|alpha)/.test(r)).map(r => r.split(' ')[0])
  expect(order).toEqual(['alpha', 'many', 'few', 'strong'])
})

test('a row reads category, right/answered, percentage and trend, with the numbers aligned', () => {
  const rows = text(dossierRows([
    stat('off by one', 'bug-hunt', 3, 6, [true, false, true, false, true, false]),
    stat('loops', 'bug-hunt', 12, 12),
  ], 60))
  const a = rows.find(r => r.startsWith('off by one'))!
  const b = rows.find(r => r.startsWith('loops'))!
  expect(a).toMatch(/^off by one +3\/6 +50% +steady/)
  expect(b).toMatch(/^loops +12\/12 +100%/)
  expect(a.indexOf('50%')).toBe(b.indexOf('100%') + 1)
})

test('trend: none below the minimum, then up, down or steady by the margin', () => {
  expect(trendOf(stat('a', 'trace', 2, 4, [true, true, false, false]))).toBeUndefined()
  const five = (recent: boolean[]) => stat('a', 'trace', 5, 10, recent)
  expect(trendOf(five([true, true, true, true, true]))).toBe('up')
  expect(trendOf(five([false, false, false, false, false]))).toBe('down')
  // 60% recent against 50% overall is exactly the margin, so up; 40% is down.
  expect(DOSSIER.trendMargin).toBe(0.1)
  expect(trendOf(five([true, true, true, false, false]))).toBe('up')
  expect(trendOf(five([true, true, false, false, false]))).toBe('down')
  // 50% recent against 50% overall is inside the margin.
  expect(trendOf(stat('a', 'trace', 5, 10, [true, false, true, false, true, false, true, false, true, false]))).toBe('steady')
  // Migrated stats have no recent answers: no trend.
  expect(trendOf(stat('a', 'trace', 5, 10))).toBeUndefined()
})

test('only the one weakest category with enough answers and a miss is marked', () => {
  const stats = [stat('few', 'trace', 0, DOSSIER.minAnswers - 1), stat('weak', 'trace', 2, 6), stat('worse', 'bug-hunt', 1, 6), stat('perfect', 'bug-hunt', 6, 6)]
  expect(weakestOf(stats)!.category).toBe('worse')
  const marked = text(dossierRows(stats, 60)).filter(r => r.endsWith('weakest'))
  expect(marked.length).toBe(1)
  expect(marked[0]).toMatch(/^worse/)
  // Nothing qualifies: no marker.
  expect(weakestOf([stat('few', 'trace', 0, 4), stat('perfect', 'trace', 6, 6)])).toBeUndefined()
  expect(text(dossierRows([stat('perfect', 'trace', 6, 6)], 60)).some(r => r.includes('weakest'))).toBe(false)
})

test('at 40 columns every row fits, the category is cut and the numbers stay whole', () => {
  const long = 'a very long category name that cannot fit'
  const stats = [stat(long, 'pattern-id', 3, 12, [true, false, true, false, true, true, true, true, true, true]), stat('short', 'trace', 9, 10)]
  for (const width of [40, 30, 24]) {
    expect(text(dossierRows(stats, width)).every(r => [...r].length <= width)).toBe(true)
  }
  const rows = text(dossierRows(stats, 40))
  const row = rows.find(r => r.startsWith('a very'))!
  expect(row).toContain('…')
  expect(row).toMatch(/3\/12 +25% +up +weakest$/)
  expect(rows.find(r => r.startsWith('short'))).toMatch(/9\/10 +90%/)
})
