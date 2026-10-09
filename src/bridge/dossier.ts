import { DOSSIER } from '../config'
import { wrap } from './text'
import type { DossierRow, DossierStat } from '../../types'

// SPEC 8.2: puzzle accuracy by category. Pure: the pane draws these rows.

export const EMPTY_DOSSIER = 'No puzzles answered yet. They come before containment.'

const accuracy = (s: Pick<DossierStat, 'attempts' | 'correct'>) => s.correct / s.attempts
const percent = (s: Pick<DossierStat, 'attempts' | 'correct'>) => Math.round(accuracy(s) * 100)

export function totalsLine(stats: readonly DossierStat[]): string {
  const answered = stats.reduce((n, s) => n + s.attempts, 0)
  const right = stats.reduce((n, s) => n + s.correct, 0)
  return `${answered} answered, ${right} right (${answered === 0 ? 0 : Math.round((right / answered) * 100)}%)`
}

/** How the last answers compare to the whole record; undefined with too few answers to say. */
export function trendOf(s: DossierStat): 'up' | 'down' | 'steady' | undefined {
  if (s.attempts === 0 || s.recent.length < DOSSIER.minAnswers) return undefined
  const diff = s.recent.filter(Boolean).length / s.recent.length - accuracy(s)
  // A small tolerance keeps a margin that is exact in decimals from tipping on float error.
  if (diff >= DOSSIER.trendMargin - 1e-9) return 'up'
  if (diff <= -DOSSIER.trendMargin + 1e-9) return 'down'
  return 'steady'
}

/** Lowest accuracy first; ties by more answers, then by name. */
function weakestFirst(a: DossierStat, b: DossierStat): number {
  return accuracy(a) - accuracy(b) || b.attempts - a.attempts || a.category.localeCompare(b.category)
}

/** The one category most worth practicing: lowest accuracy among those with enough answers and a miss. */
export function weakestOf(stats: readonly DossierStat[]): DossierStat | undefined {
  return stats.filter(s => s.attempts >= DOSSIER.minAnswers && s.correct < s.attempts).sort(weakestFirst)[0]
}

const cut = (text: string, width: number) => {
  const chars = [...text]
  if (width <= 0) return ''
  if (chars.length <= width) return text
  return width === 1 ? '…' : `${chars.slice(0, width - 1).join('')}…`
}

const WEAKEST = 'weakest'
const GAP = '  '

/**
 * The rows for `width` columns: totals, then a group per puzzle type, each
 * category weakest first as `category  right/answered  pct%  trend`. The
 * category is the part cut to fit; the numbers stay whole (40 columns minimum).
 */
export function dossierRows(stats: readonly DossierStat[], width: number): DossierRow[] {
  const used = stats.filter(s => s.attempts > 0)
  if (used.length === 0) return wrap(EMPTY_DOSSIER, width).map(text => ({ text }))
  const weakest = weakestOf(used)
  const countW = Math.max(...used.map(s => `${s.correct}/${s.attempts}`.length))
  const trendW = Math.max(...used.map(s => trendOf(s)?.length ?? 0))
  const numbers = (s: DossierStat) =>
    `${`${s.correct}/${s.attempts}`.padStart(countW)}${GAP}${`${percent(s)}%`.padStart(4)}${trendW === 0 ? '' : GAP + (trendOf(s) ?? '').padEnd(trendW)}`
  const numW = numbers(used[0]!).length
  const tag = weakest ? GAP.length + WEAKEST.length : 0
  const catW = Math.max(1, width - numW - GAP.length - tag)

  const types = [...new Set(used.map(s => s.type))].sort((a, b) => {
    const ia = DOSSIER.typeOrder.indexOf(a)
    const ib = DOSSIER.typeOrder.indexOf(b)
    return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib) || a.localeCompare(b)
  })
  const rows: DossierRow[] = [{ text: cut(totalsLine(used), width), style: 'bold' }]
  for (const type of types) {
    rows.push({ text: '' }, { text: cut(DOSSIER.typeLabels[type] ?? type, width), style: 'bold' })
    for (const s of used.filter(u => u.type === type).sort(weakestFirst)) {
      const line = `${cut(s.category, catW).padEnd(catW)}${GAP}${numbers(s)}${s === weakest ? GAP + WEAKEST : ''}`
      rows.push({ text: cut(line, width) })
    }
  }
  return rows
}
