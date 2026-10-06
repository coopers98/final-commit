import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { CalibrationView, EpicFormView, LatticeView, ReportView } from '../../types'
import { recordLint, recordTactical } from '../game'
import { createRepo, type Repo } from '../store/repo'
import { NO_GAUGES } from '../bridge/bridge'
import { NO_CREW, parseLint, parseVerdict, reportLines, roleOf, ROLE_LABELS, type Role } from './roster'

/** The report pane, drawn in src/contain/lattice.tsx. */
const REPORT_PANE = 'fc-report'

// SPEC 9.1: follows the crew's subagents from spawn to finished turn. The
// agent types are registered at session start (hooks/register.tsx, as a
// plugin has one session.start hook).

const crew = atom({ plugin: 'final-commit', key: 'crew' } as const, NO_CREW)
const ready = atom({ plugin: 'final-commit', key: 'ready' } as const, false)
const gauges = atom({ plugin: 'final-commit', key: 'gauges' } as const, NO_GAUGES)
const report = atom({ plugin: 'final-commit', key: 'report' } as const, null as ReportView | null)
const lattice = atom({ plugin: 'final-commit', key: 'lattice' } as const, null as LatticeView | null)
const calibration = atom({ plugin: 'final-commit', key: 'calibration' } as const, null as CalibrationView | null)
const form = atom({ plugin: 'final-commit', key: 'epicForm' } as const, null as EpicFormView | null)

function repoOf($: EngineInterface): Repo {
  return createRepo(
    { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value), delete: key => $.store.delete(key), keys: () => $.store.keys() },
    line => $.ui.log(line, { to: 'debug' }),
  )
}

/**
 * A run launched from the Bridge reports in the report pane, as nothing else
 * relays its answer. A pane already in use (a report, a timing game, the
 * epic form) is never taken over: a toast says the run finished instead.
 */
async function showReport($: EngineInterface, role: Role, answer: string, isAborted: boolean) {
  const title = `${ROLE_LABELS[role]} report`
  const busy = (await read($, report)) !== null || (await read($, lattice)) !== null || (await read($, calibration)) !== null || (await read($, form)) !== null
  if (busy || isAborted) {
    $.ui.toast(isAborted ? `${ROLE_LABELS[role]} stopped before reporting.` : `${title} finished while a pane was open; it was not shown.`)
    return
  }
  const r: ReportView = { title, lines: reportLines(answer), encounter: null, reinforced: 0 }
  await update($, report, () => r)
  const placed = await $.ui.open({ id: REPORT_PANE, title, focus: true, closeOnEscape: true })
  if (!placed.isPlaced) {
    await update($, report, () => null)
    $.ui.toast(`${title} is ready, but no pane could open here.`)
  }
}

async function finished($: EngineInterface, agentId: string, answer: string, isAborted: boolean) {
  let role: ReturnType<typeof roleOf>
  let isFromBridge = false
  await update($, crew, c => {
    role = c.running[agentId]
    const { [agentId]: _done, ...running } = c.running
    const fromBridge = c.fromBridge ?? []
    isFromBridge = fromBridge.includes(agentId)
    return role ? { ...c, running, fromBridge: fromBridge.filter(id => id !== agentId) } : c
  })
  if (!role) return
  // Every report is kept, whoever sent the officer, so the Bridge can show it again.
  if (!isAborted && answer.trim() !== '') {
    await repoOf($).saveCrewReport({ role, at: await $.clock.now(), lines: reportLines(answer) })
  }
  // An Engineering lint run ends with LINT: PASS or FAIL: the Bridge's shields and the mission's lint, even where an exit status was not seen.
  const lint = role === 'engineering' && !isAborted ? parseLint(answer) : undefined
  if (lint) {
    await update($, gauges, g => ({ ...g, lint }))
    if (await read($, ready)) await recordLint({ repo: repoOf($), verdict: lint })
  }
  if (isFromBridge) await showReport($, role, answer, isAborted)
  const now = await $.clock.now()
  const verdict = role === 'tactical' && !isAborted ? parseVerdict(answer) : undefined
  const outcome = isAborted ? 'stopped' : verdict ?? 'done'
  const r = role
  await update($, crew, c => ({ ...c, last: { ...c.last, [r]: { outcome, at: now } } }))
  if (!verdict) return
  if (!(await read($, ready))) return
  const { counted } = await recordTactical({ repo: repoOf($), verdict })
  $.ui.toast(verdict === 'clean'
    ? `${ROLE_LABELS.tactical}: all clear${counted ? '. Mission quality up.' : '.'}`
    : `${ROLE_LABELS.tactical}: security issues found. See the report.`)
}

export function wireCrew(on: On): void {
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const role = roleOf(e.subagentType)
    const id = started.agentId
    if (role && id !== undefined) await update($, crew, c => ({ ...c, running: { ...c.running, [id]: role } }))
    return started
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      try {
        await finished($, e.agentId, e.answer, e.isAborted)
      } catch (err) {
        $.ui.log(`final-commit: crew: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
      }
    }
    return next(e)
  })
}
