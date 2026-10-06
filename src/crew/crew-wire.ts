import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import { recordTactical } from '../game'
import { createRepo, type Repo } from '../store/repo'
import { NO_CREW, parseVerdict, roleOf, ROLE_LABELS } from './roster'

// SPEC 9.1: follows the crew's subagents from spawn to finished turn. The
// agent types are registered at session start (hooks/register.tsx, as a
// plugin has one session.start hook).

const crew = atom({ plugin: 'final-commit', key: 'crew' } as const, NO_CREW)
const ready = atom({ plugin: 'final-commit', key: 'ready' } as const, false)

function repoOf($: EngineInterface): Repo {
  return createRepo(
    { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value), delete: key => $.store.delete(key), keys: () => $.store.keys() },
    line => $.ui.log(line, { to: 'debug' }),
  )
}

async function finished($: EngineInterface, agentId: string, answer: string, isAborted: boolean) {
  let role: ReturnType<typeof roleOf>
  await update($, crew, c => {
    role = c.running[agentId]
    const { [agentId]: _done, ...running } = c.running
    return role ? { ...c, running } : c
  })
  if (!role) return
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
