import { SINGULARITY_ACTIVATION, TIER_SPECS } from '../config'
import type { BayRow } from '../../types'
import { usableCells } from '../game'
import type { Inventory, Specimen, StarSystem } from '../store/schema'
import { CELL_FLORA_TIERS, floraTiers, heldOfTier } from '../world/flora'

/** The hold: cells and flora samples held (SPEC 7.2), above the specimens. */
export function holdRows(inv: Inventory, systems: StarSystem[]): BayRow[] {
  const usable = usableCells(inv, systems)
  const idle = inv.singularity - usable.singularity
  const tiers = floraTiers(systems)
  return [
    { text: `Cells: Reinforced ${inv.reinforced} · Stasis ${inv.stasis} · Singularity ${inv.singularity}${idle > 0 ? ` (${idle} need ${TIER_SPECS[SINGULARITY_ACTIVATION.tier].glyph} flora)` : ''}` },
    ...CELL_FLORA_TIERS.map(t => ({ text: `Flora ${TIER_SPECS[t].glyph} ${TIER_SPECS[t].label}: ${heldOfTier(inv.flora, tiers, t)}`, tier: t })),
    { text: '' },
  ]
}

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
