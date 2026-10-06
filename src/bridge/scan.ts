import { SCAN, TIERS, TIER_SPECS, type Tier } from '../config'
import type { ScanRow } from '../../types'
import type { CatalogEntry, Species, StarSystem } from '../store/schema'

// SPEC 9.4: what the sensors know about a system. Pure: the pane wraps and
// cuts these rows to its width when drawn.

const STATUS_RANK = { seen: 0, escaped: 1, contained: 2 } as const

/** The best status reached for each species met, over every tier and attachment. */
function metStatus(catalog: readonly CatalogEntry[]): Map<string, CatalogEntry['status']> {
  const met = new Map<string, CatalogEntry['status']>()
  for (const e of catalog) {
    const was = met.get(e.speciesId)
    if (!was || STATUS_RANK[e.status] > STATUS_RANK[was]) met.set(e.speciesId, e.status)
  }
  return met
}

/** A sprite with every drawn cell filled: the shape, not the creature. */
export function silhouette(rows: readonly string[]): string[] {
  return rows.map(r => r.replace(/\S/g, SCAN.silhouetteChar))
}

/**
 * Hidden signals the sensors can still resolve: unmet, unresolved species of
 * the counted tiers, lowest tier first.
 */
export function unresolvedSignals(system: StarSystem, catalog: readonly CatalogEntry[], resolved: readonly string[]): Species[] {
  const met = metStatus(catalog)
  return system.species
    .filter(s => !SCAN.namedTiers.includes(s.tier) && !SCAN.hiddenTiers.includes(s.tier) && !met.has(s.id) && !resolved.includes(s.id))
    .sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier))
}

export function scanRows(system: StarSystem, catalog: readonly CatalogEntry[], resolved: readonly string[]): ScanRow[] {
  const met = metStatus(catalog)
  const shown = system.species.filter(s => !SCAN.hiddenTiers.includes(s.tier))
  // What was learned, not a completion ratio: an epic holds too few missions to meet a whole system.
  const here = shown.filter(s => met.has(s.id))
  const contained = here.filter(s => met.get(s.id) === 'contained').length
  const rows: ScanRow[] = [
    { text: `${system.name} (${system.starClass})${system.status === 'surveyed' ? ' · surveyed' : ''}`, style: 'bold' },
    ...(system.biomes.length ? [{ text: `Biomes: ${system.biomes.map(b => b.name).join(', ')}`, style: 'dim' as const }] : []),
    { text: here.length === 0 ? 'No lifeforms met here yet.' : `Met ${here.length} here, ${contained} contained.` },
  ]
  for (const kind of ['fauna', 'flora'] as const) {
    for (const tier of TIERS) {
      const group = shown.filter(s => s.kind === kind && s.tier === tier)
      if (group.length === 0) continue
      rows.push({ text: '' }, { text: `${TIER_SPECS[tier].glyph} ${TIER_SPECS[tier].label} ${kind}`, style: 'bold' })
      let unidentified = 0
      for (const s of group) {
        const status = met.get(s.id)
        if (status) rows.push({ text: `${s.name}  ${status}` }, { text: s.readout, style: 'dim' })
        else if (named(tier)) rows.push({ text: `${s.name}  not yet encountered` }, { text: s.readout, style: 'dim' })
        else if (resolved.includes(s.id)) {
          rows.push({ text: 'Unidentified, shape resolved' })
          for (const r of silhouette(s.stages[0]?.rows ?? [])) rows.push({ text: r, isArt: true })
        } else unidentified += 1
      }
      if (unidentified > 0) rows.push({ text: `${unidentified} signal${unidentified === 1 ? '' : 's'}, unidentified`, style: 'dim' })
    }
  }
  return rows
}

const named = (tier: Tier) => SCAN.namedTiers.includes(tier)
