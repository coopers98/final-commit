import { expect, test } from 'claude-code/testing'
import { bridgeRows, gauge, NO_GAUGES, type BridgeData } from '../src/bridge/bridge'
import { BRIDGE, COLORS } from '../src/config'
import { classifyBash, lintVerdict } from '../src/detect/git'

const full: BridgeData = {
  system: { name: 'Kepler Drift', starClass: 'K5', isSurveyed: false },
  mission: { key: 'NOVA-12', commits: 2, testRuns: 3 },
  gauges: { tests: { runs: 4, passes: 3 }, lint: 'fail' },
  fuel: 62,
  log: { at: 0, stardate: '26279.5', lines: ['- Added the export button', '- Wrote tests', '- Fixed paging', '- Fourth'] },
  isPending: true,
  isAlert: true,
}

test('the bridge shows system, alert, encounter, mission, hull, shields, fuel and the log tail', async () => {
  const rows = bridgeRows(full, 60).map(r => r.text)
  expect(rows[0]).toBe('Kepler Drift (K5)')
  expect(rows).toContain('! RED ALERT')
  expect(rows).toContain('Encounter waiting: /contain')
  expect(rows).toContain('Mission  NOVA-12 · 2 commits')
  expect(rows).toContain(`Hull     ${gauge(0.75)} 75%`)
  expect(rows).toContain('Shields  DOWN: lint failing')
  expect(rows).toContain(`Fuel     ${gauge(0.62)} 62%`)
  expect(rows).toContain("Captain's log 26279.5")
  expect(rows.filter(r => r.startsWith('  - ')).length).toBe(BRIDGE.logLines)
})

test('alert, hull, shields and fuel are colored by state; a waiting encounter by its tier', async () => {
  const colorOf = (d: BridgeData, starts: string) => bridgeRows(d, 60).find(r => r.text.startsWith(starts))
  expect(colorOf(full, '! RED ALERT')?.color).toBe(COLORS.bad)
  expect(colorOf({ ...full, pendingTier: 'legendary' }, 'Encounter waiting')?.tier).toBe('legendary')
  expect(colorOf(full, 'Hull')?.color).toBe(COLORS.caution)
  expect(colorOf({ ...full, gauges: { tests: { runs: 2, passes: 2 }, lint: 'pass' } }, 'Hull')?.color).toBe(COLORS.good)
  expect(colorOf({ ...full, gauges: { tests: { runs: 2, passes: 0 }, lint: 'pass' } }, 'Hull')?.color).toBe(COLORS.bad)
  expect(colorOf(full, 'Shields')?.color).toBe(COLORS.bad)
  expect(colorOf({ ...full, gauges: { ...full.gauges, lint: 'pass' } }, 'Shields')?.color).toBe(COLORS.good)
  expect(colorOf(full, 'Fuel')?.color).toBe(undefined)
  expect(colorOf({ ...full, fuel: 20 }, 'Fuel')?.color).toBe(COLORS.caution)
  expect(colorOf({ ...full, fuel: 5 }, 'Fuel')?.color).toBe(COLORS.bad)
})

test('an empty bridge says what is missing', async () => {
  const rows = bridgeRows({ gauges: NO_GAUGES, isPending: false, isAlert: false }, 60)
  expect(rows.every(r => r.color === undefined && r.tier === undefined)).toBe(true)
  expect(rows.map(r => r.text)).toEqual(['No system charted: /epic <KEY>', '', 'Mission  none', 'Hull     no test runs yet', 'Shields  no lint run yet', 'Fuel     not measured yet'])
})

test('every bridge row fits 40 columns, and gauges are ASCII', async () => {
  for (const r of bridgeRows(full, 40)) expect([...r.text].length).toBeLessThanOrEqual(40)
  expect(gauge(0.5)).toBe(`[${'#'.repeat(BRIDGE.gaugeCells / 2)}${'-'.repeat(BRIDGE.gaugeCells / 2)}]`)
  expect(gauge(2)).toBe(`[${'#'.repeat(BRIDGE.gaugeCells)}]`)
  expect(/^[\x20-\x7e]*$/.test(gauge(0.3))).toBe(true)
})

test('lint and type-check runs are recognized and judged by exit status only when reliable', async () => {
  for (const c of ['npx eslint .', 'tsc -p .', 'npm run typecheck', 'vendor/bin/phpstan analyse', 'ruff check src', 'cargo clippy']) {
    expect(classifyBash(c).isLintRun).toBe(true)
  }
  expect(classifyBash('npm test').isLintRun).toBe(false)
  expect(lintVerdict(classifyBash('npm run lint'), true)).toBe('fail')
  expect(lintVerdict(classifyBash('npm run lint'), false)).toBe('pass')
  expect(lintVerdict(classifyBash('npm run lint | tail'), false)).toBe(undefined)
  expect(lintVerdict(classifyBash('ls'), false)).toBe(undefined)
})
