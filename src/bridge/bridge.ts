import { BRIDGE, COLORS, type Tier } from '../config'
import { crewLines, type CrewState, type Role } from '../crew/roster'
import type { LogEntry } from '../store/schema'

// SPEC 9 Bridge pane, as text rows. Pure: the pane gathers the values.

/** Session gauges the Bash observer keeps: test runs for the hull, the last lint verdict for the shields. */
export type Gauges = { tests: { runs: number; passes: number }; lint: 'pass' | 'fail' | null }
export const NO_GAUGES: Gauges = { tests: { runs: 0, passes: 0 }, lint: null }

export type BridgeData = {
  system?: { name: string; starClass: string; isSurveyed: boolean }
  mission?: { key: string; commits: number; testRuns: number }
  gauges: Gauges
  /** Context window left, percent; undefined before the session's first reply. */
  fuel?: number
  log?: LogEntry
  crew?: CrewState
  /** Officers with a saved report (the number keys reopen it). */
  reportRoles?: Role[]
  isPending: boolean
  /** The waiting encounter's tier, to color its line. */
  pendingTier?: Tier
  isAlert: boolean
}

/** A Bridge row: a status `color` (a theme key) or a `tier` the pane colors at draw time. */
export type BridgeRow = { text: string; color?: string; tier?: Tier }

const fit = (text: string, width: number) => [...text].slice(0, Math.max(0, width)).join('')

/** `[######----]`: ASCII, so it is one cell per character everywhere. */
export function gauge(fraction: number): string {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * BRIDGE.gaugeCells)
  return `[${'#'.repeat(filled)}${'-'.repeat(BRIDGE.gaugeCells - filled)}]`
}

const pct = (fraction: number) => `${Math.round(fraction * 100)}%`

/** Hull color by pass rate: all passing, some, none. */
function hullColor(rate: number): string {
  return rate >= COLORS.hullCautionBelow ? COLORS.good : rate > 0 ? COLORS.caution : COLORS.bad
}

function fuelColor(fuel: number): string | undefined {
  return fuel < COLORS.fuelBadBelow ? COLORS.bad : fuel < COLORS.fuelCautionBelow ? COLORS.caution : undefined
}

export function bridgeRows(d: BridgeData, width: number): BridgeRow[] {
  const rows: BridgeRow[] = []
  const add = (text: string, style: Omit<BridgeRow, 'text'> = {}) => rows.push({ text, ...style })
  add(d.system ? `${d.system.name} (${d.system.starClass})${d.system.isSurveyed ? ' surveyed' : ''}` : 'No system charted: /epic <KEY>')
  if (d.isAlert) add('! RED ALERT', { color: COLORS.bad })
  if (d.isPending) add('Encounter waiting: /contain', d.pendingTier ? { tier: d.pendingTier } : {})
  add('')
  const m = d.mission
  add(m ? `Mission  ${m.key} · ${m.commits} commit${m.commits === 1 ? '' : 's'}` : 'Mission  none')
  const t = d.gauges.tests
  if (t.runs > 0) add(`Hull     ${gauge(t.passes / t.runs)} ${pct(t.passes / t.runs)}`, { color: hullColor(t.passes / t.runs) })
  else add('Hull     no test runs yet')
  const lint = d.gauges.lint
  add(`Shields  ${lint === 'pass' ? 'up' : lint === 'fail' ? 'DOWN: lint failing' : 'no lint run yet'}`, lint ? { color: lint === 'pass' ? COLORS.good : COLORS.bad } : {})
  if (d.fuel === undefined) add('Fuel     not measured yet')
  else {
    const color = fuelColor(d.fuel)
    add(`Fuel     ${gauge(d.fuel / 100)} ${Math.round(d.fuel)}%`, color ? { color } : {})
  }
  if (d.crew) for (const line of ['Crew', ...crewLines(d.crew, d.reportRoles ?? [])]) add(line)
  if (d.log) {
    add('')
    add(`Captain's log ${d.log.stardate}`)
    for (const line of d.log.lines.slice(0, BRIDGE.logLines)) add(`  ${line}`)
  }
  return rows.map(r => ({ ...r, text: fit(r.text, width) }))
}
