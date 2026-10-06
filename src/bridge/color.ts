import { COLORS, TIER_SPECS, type Tier } from '../config'

// SPEC 6.2: each tier's color. Color is never the only signal: the glyph and
// label are drawn with it.

/** The color to draw `tier` in at `now`; the Anomaly's cycles. */
export function tierColor(tier: Tier, now: number): string {
  const color = TIER_SPECS[tier].color
  if (color !== 'cycle') return color
  return COLORS.cycle[Math.floor(now / COLORS.cycleMs) % COLORS.cycle.length]!
}
