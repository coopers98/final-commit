import type { Outcome } from '../game'
import { syncWork, type SyncDeps } from './sync'
import type { WorkSource } from './work-source'

// SPEC 4.4: the configured work sources, each synced on its own. A source is
// named by its backend (`plans`, `github`, `jira`, `linear`); the name keys
// its sync record, so two sources never share processed keys or a lastSync.
// Pure: the wiring builds each backend (with its I/O) and hands them in.

/**
 * A backend: builds its source from what the wiring gives it, or several
 * (one per repository, each named apart so each fails and syncs on its own);
 * `undefined` or none when its settings are incomplete.
 */
export type Backend = () => WorkSource | readonly WorkSource[] | undefined

const NAME = /^[a-z][a-z0-9-]{0,31}$/

/** The `workSources` setting, normalized: trimmed, lower case, each name once, in the order given. */
export function sourceNames(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const names = list.filter((v): v is string => typeof v === 'string').map(v => v.trim().toLowerCase()).filter(v => v !== '')
  return [...new Set(names)]
}

export type Resolved = {
  sources: WorkSource[]
  /** Names no backend in this build answers to (or that are not valid names). */
  unknown: string[]
  /** Names whose backend is present but whose own settings are incomplete. */
  incomplete: string[]
}

export function resolveSources(names: readonly string[], backends: Readonly<Record<string, Backend>>): Resolved {
  const out: Resolved = { sources: [], unknown: [], incomplete: [] }
  for (const name of names) {
    const backend = NAME.test(name) && Object.hasOwn(backends, name) ? backends[name] : undefined
    if (!backend) {
      out.unknown.push(name)
      continue
    }
    const built = backend()
    const list = built === undefined ? [] : Array.isArray(built) ? built : [built as WorkSource]
    if (list.length > 0) out.sources.push(...list)
    else out.incomplete.push(name)
  }
  return out
}

export type SourcesDeps = Omit<SyncDeps, 'source'> & {
  sources: readonly WorkSource[]
  /** Sources whose failure was already reported (SPEC 4.4 rule 5: once per outage). */
  failing: ReadonlySet<string>
}

export type SourcesResult = {
  outcomes: Outcome[]
  /** Toasts to show: a source that has just started failing. */
  toasts: string[]
  /** The sources failing after this sync, to hand to the next one. */
  failing: Set<string>
}

/**
 * One sync of every source (SPEC 4.2, 4.4): the catch-up at session start and
 * each poll. A source that fails is reported once and retried at the next
 * poll; the others keep running. An epic one source starts charting counts as
 * charting for the sources after it, so it is charted once.
 */
export async function syncSources(deps: SourcesDeps): Promise<SourcesResult> {
  const { sources, failing: before, ...rest } = deps
  const charting = new Set(rest.charting)
  const chart: SyncDeps['chart'] = epic => {
    // Marked only once the chart has started, so a refused chart is tried by the next source.
    rest.chart(epic)
    charting.add(epic.key)
  }
  const result: SourcesResult = { outcomes: [], toasts: [], failing: new Set() }
  /** Newly failing sources by their error: several failing alike (a backend's shared login) are told in one toast. */
  const fresh = new Map<string, string[]>()
  for (const source of sources) {
    let error: string | undefined
    try {
      const r = await syncWork({ ...rest, source, chart, charting })
      result.outcomes.push(...r.outcomes)
      error = r.error
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
    if (error === undefined) continue
    result.failing.add(source.name)
    if (!before.has(source.name)) fresh.set(error, [...(fresh.get(error) ?? []), source.name])
  }
  for (const [error, names] of fresh) {
    const who = names.length === 1 ? `Work source ${names[0]}` : `Work sources ${names.join(', ')}`
    result.toasts.push(`${who} failed (${error}); retrying at the next poll.`)
  }
  return result
}

export type SyncGate = {
  /**
   * Runs a sync unless one is running. `again`: if one is running, run once
   * more when it ends (a chart a source started has finished, and the mission
   * waiting on it should not wait for the next poll). Never rejects.
   */
  request(opts?: { again?: boolean }): void
}

/**
 * One sync at a time (SPEC 4.2): two at once would read the same sync record
 * and apply its transitions twice. The flag is set before anything awaits.
 */
export function createSyncGate(run: () => Promise<void>): SyncGate {
  let isRunning = false
  let isWanted = false
  const start = (): void => {
    isRunning = true
    isWanted = false
    void run().catch(() => {}).finally(() => {
      isRunning = false
      if (isWanted) start()
    })
  }
  return {
    request: opts => {
      if (!isRunning) start()
      else if (opts?.again) isWanted = true
    },
  }
}
