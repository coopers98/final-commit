import { expect, test } from 'claude-code/testing'
import { tierColor } from '../src/bridge/color'
import { COLORS, TIER_SPECS, TIERS } from '../src/config'

test('each tier draws in its SPEC 6.2 color; the Anomaly cycles over time', async () => {
  for (const t of TIERS.filter(t => t !== 'anomaly')) expect(tierColor(t, 0)).toBe(TIER_SPECS[t].color)
  const seen = new Set(COLORS.cycle.map((_, i) => tierColor('anomaly', i * COLORS.cycleMs)))
  expect([...seen].sort()).toEqual([...COLORS.cycle].sort())
  expect(tierColor('anomaly', 0)).toBe(tierColor('anomaly', COLORS.cycleMs * COLORS.cycle.length))
})
