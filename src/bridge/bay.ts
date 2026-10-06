import { TIER_SPECS } from '../config'
import type { BayRow } from '../../types'
import type { Specimen, StarSystem } from '../store/schema'

/** Rows for the Specimen Bay pane: one line per specimen, at most `columns` wide, with its tier for coloring. */
export function bayRows(specimens: Specimen[], systems: StarSystem[], companionId: string | null, columns: number): BayRow[] {
  if (specimens.length === 0) return [{ text: 'No specimens yet. Finish a mission to find one.' }]
  const speciesName = (s: Specimen) =>
    systems.find(sys => sys.id === s.systemId)?.species.find(sp => sp.id === s.speciesId)?.name ?? 'Unknown'
  return specimens.map((s, i) => {
    const mark = s.id === companionId ? '>' : ' '
    const extra = s.attachment ? ` +${s.attachment.item}` : ''
    const row = `${mark}${String(i + 1).padStart(2)} ${TIER_SPECS[s.tier].glyph} ${speciesName(s)} L${s.level}${extra}`
    return { text: [...row].slice(0, Math.max(10, columns)).join(''), tier: s.tier }
  })
}
