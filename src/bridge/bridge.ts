import { BRIDGE } from '../config'
import { crewLines, type CrewState } from '../crew/roster'
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
  isPending: boolean
  isAlert: boolean
}

const fit = (text: string, width: number) => [...text].slice(0, Math.max(0, width)).join('')

/** `[######----]`: ASCII, so it is one cell per character everywhere. */
export function gauge(fraction: number): string {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * BRIDGE.gaugeCells)
  return `[${'#'.repeat(filled)}${'-'.repeat(BRIDGE.gaugeCells - filled)}]`
}

const pct = (fraction: number) => `${Math.round(fraction * 100)}%`

export function bridgeRows(d: BridgeData, width: number): string[] {
  const rows: string[] = []
  rows.push(d.system ? `${d.system.name} (${d.system.starClass})${d.system.isSurveyed ? ' surveyed' : ''}` : 'No system charted: /epic <KEY>')
  if (d.isAlert) rows.push('! RED ALERT')
  if (d.isPending) rows.push('Encounter waiting: /contain')
  rows.push('')
  const m = d.mission
  rows.push(m ? `Mission  ${m.key} · ${m.commits} commit${m.commits === 1 ? '' : 's'}` : 'Mission  none')
  const t = d.gauges.tests
  rows.push(t.runs > 0 ? `Hull     ${gauge(t.passes / t.runs)} ${pct(t.passes / t.runs)}` : 'Hull     no test runs yet')
  rows.push(`Shields  ${d.gauges.lint === 'pass' ? 'up' : d.gauges.lint === 'fail' ? 'DOWN: lint failing' : 'no lint run yet'}`)
  rows.push(d.fuel === undefined ? 'Fuel     not measured yet' : `Fuel     ${gauge(d.fuel / 100)} ${Math.round(d.fuel)}%`)
  if (d.crew) rows.push('Crew', ...crewLines(d.crew))
  if (d.log) {
    rows.push('', `Captain's log ${d.log.stardate}`)
    for (const line of d.log.lines.slice(0, BRIDGE.logLines)) rows.push(`  ${line}`)
  }
  return rows.map(r => fit(r, width))
}
