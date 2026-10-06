import { PLANS } from '../config'
import type { PlansState } from '../store/schema'
import type { WorkItem, WorkSource, WorkStatus, WorkTransition } from './work-source'

// SPEC 4.4 rule 3 (D13): plan documents as a work source. A markdown file is
// an epic, keyed by the key in its first heading; each checklist task with a
// key is a mission. `- [ ]` to do, `- [~]` in progress, `- [x]` done; all
// tasks done is the epic's Done. Items without a key are skipped. Changes are
// found by comparing reads, and timed when they were seen. Pure apart from
// the I/O it is handed.

const KEY = '[A-Z][A-Z0-9]{1,9}-[1-9]\\d*'
/** A key in brackets anywhere (`SHA-256 migration (NOVA-7)`, `[NOVA-7](url) x`): it wins, as a key-shaped term may lead the text. */
const BRACKETED_KEY = new RegExp(`[\\[(](${KEY})[\\])]`)
/** Else a key leading the text, after any emphasis (`NOVA-7 x`, `**NOVA-7**: x`). A bare `UTF-8` mid-text is never a key. */
const LEADING_KEY = new RegExp(`^[^\\w]*?(${KEY})(?![\\w-])`)
const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/
const TASK = /^\s*[-*+]\s+\[([ xX~])\]\s+(.*?)\s*$/
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/
const STATUS: Record<string, WorkStatus> = { ' ': 'todo', '~': 'in_progress', x: 'done', X: 'done' }

export type PlanTask = { key: string; title: string; status: WorkStatus }
export type Plan = { epic: WorkItem; tasks: PlanTask[] }
export type ParsedPlan = { plan?: Plan; skipped: string[] }

export function keyOf(text: string): string | undefined {
  return BRACKETED_KEY.exec(text)?.[1] ?? LEADING_KEY.exec(text)?.[1]
}

/** The text without its key (and the link or brackets around it); the key itself when nothing is left. */
function titleOf(text: string, key: string): string {
  return text
    .replace(new RegExp(`\\[${key}\\]\\([^)]*\\)`), ' ')
    .replace(new RegExp(`[\\[(]?${key}[\\])]?`), ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:.*_\-–—]+|[\s:.*_\-–—]+$/g, '') || key
}

/** One plan file. `skipped` says what was left out and why (by line number, never by its text), for the debug log. */
export function parsePlan(text: string): ParsedPlan {
  const skipped: string[] = []
  let epic: WorkItem | undefined
  let fence: { char: string; length: number } | undefined
  let isInTasks = false
  const prose: string[] = []
  const tasks: PlanTask[] = []
  const seen = new Set<string>()
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  for (const [i, line] of lines.entries()) {
    const f = FENCE.exec(line)
    if (f) {
      const marks = f[1] ?? ''
      // A fence closes only on its own character, at least as long, with nothing after it.
      if (!fence) fence = { char: marks[0] ?? '`', length: marks.length }
      else if (marks[0] === fence.char && marks.length >= fence.length && (f[2] ?? '').trim() === '') fence = undefined
      continue
    }
    if (fence) continue
    if (!epic) {
      const h = HEADING.exec(line)
      if (!h) continue
      const heading = h[1] ?? ''
      const key = keyOf(heading)
      if (!key) return { skipped: [...skipped, `line ${i + 1}: the first heading has no key`] }
      epic = { key, kind: 'epic', title: titleOf(heading, key), description: '' }
      continue
    }
    const t = TASK.exec(line)
    if (!t) {
      if (!isInTasks && line.trim() !== '' && !HEADING.test(line)) prose.push(line.trim())
      continue
    }
    isInTasks = true
    const body = t[2] ?? ''
    const key = keyOf(body)
    if (!key) skipped.push(`line ${i + 1}: a task has no key`)
    else if (key === epic.key || seen.has(key)) skipped.push(`line ${i + 1}: ${key} appears twice`)
    else {
      seen.add(key)
      tasks.push({ key, title: titleOf(body, key), status: STATUS[t[1] ?? ' '] ?? 'todo' })
    }
  }
  if (!epic) return { skipped: [...skipped, 'no heading'] }
  epic.description = prose.join(' ').slice(0, PLANS.maxDescriptionChars)
  return { plan: { epic, tasks }, skipped }
}

/**
 * Plans read in order, each key kept the first time: a later plan with an
 * epic key already read is skipped whole, and a task key already read is
 * dropped from the later plan (so it counts toward one epic only).
 */
export function mergePlans(found: readonly { path: string; plan: Plan }[]): { plans: Plan[]; skipped: string[] } {
  const epics = new Set<string>()
  const tasks = new Set<string>()
  const plans: Plan[] = []
  const skipped: string[] = []
  for (const { path, plan } of found) {
    if (epics.has(plan.epic.key)) {
      skipped.push(`${path}: epic ${plan.epic.key} is already read from another plan`)
      continue
    }
    epics.add(plan.epic.key)
    const kept = plan.tasks.filter(t => {
      if (tasks.has(t.key)) skipped.push(`${path}: ${t.key} is already read from another plan`)
      return !tasks.has(t.key) && (tasks.add(t.key), true)
    })
    plans.push({ epic: plan.epic, tasks: kept })
  }
  return { plans, skipped }
}

/** The state before a project's first read: `epoch` is set by the baseline. */
export const NO_PLANS: PlansState = { epoch: 0, tasks: {}, doneEpics: [], log: [], seq: 0 }

/**
 * What changed since the last read, appended to the state's log at `now`.
 * `isBaseline`: the first read records statuses and reports nothing. A task
 * missing from the files keeps its last status. A task that went from to do
 * straight to done between reads is reported started, then done (the sync
 * applies a start first at one instant); one first seen already done is
 * recorded and not reported. Within one read, tasks go before
 * their epic's Done. Ids carry the baseline's time, so a new baseline never
 * reuses one.
 */
export function diffPlans(state: PlansState, plans: readonly Plan[], now: number, isBaseline = false): PlansState {
  const epoch = isBaseline ? now : state.epoch
  const tasks = { ...state.tasks }
  let doneEpics = isBaseline ? [] : [...state.doneEpics]
  const found: WorkTransition[] = []
  let seq = isBaseline ? 0 : state.seq
  const report = (item: WorkItem, to: WorkStatus, epic?: WorkItem) => {
    if (isBaseline) return
    seq += 1
    found.push({ id: `p${epoch.toString(36)}-${seq}`, at: now, item, to, ...(epic ? { epic } : {}) })
  }
  for (const { epic, tasks: list } of plans) {
    for (const t of list) {
      const before = tasks[t.key]?.status
      tasks[t.key] = { status: t.status }
      if (t.status === before) continue
      // A task first seen already done (a plan added or moved in, a key rewritten) is old work: recorded, not reported.
      if (before === undefined && t.status === 'done') continue
      const item: WorkItem = { key: t.key, kind: 'issue', title: t.title, description: '' }
      // No changelog to read: a task seen to do, then done, is taken as started then done, not closed unstarted.
      if (t.status === 'done' && before === 'todo') report(item, 'in_progress', epic)
      report(item, t.status, epic)
    }
    const isDone = list.length > 0 && list.every(t => t.status === 'done')
    const wasDone = doneEpics.includes(epic.key)
    if (isDone && !wasDone) {
      doneEpics.push(epic.key)
      report(epic, 'done')
    } else if (!isDone && wasDone) {
      // Reopened: no transition (an epic's start is its first task's), but its next Done counts again.
      doneEpics = doneEpics.filter(k => k !== epic.key)
    }
  }
  return { epoch, tasks, doneEpics, log: [...state.log, ...found], seq }
}

/**
 * The log a sync can still need: a change older than `since` is applied
 * already (a sync's lastSync never passes a change still waiting, SPEC 4.2
 * rule 5), so it goes; `keepLog` is a safety cap on what a long wait can
 * pile up.
 */
export function trimLog(state: PlansState, since: number): PlansState {
  return { ...state, log: state.log.filter(t => t.at >= since).slice(-PLANS.keepLog) }
}

export type PlansIo = {
  folders: readonly string[]
  /** The id of the project folder the session is in now; each has its own state and sync record. */
  project(): Promise<string>
  exists(path: string): Promise<boolean>
  list(dir: string): Promise<{ name: string; kind: 'file' | 'dir' | 'other'; size: number }[]>
  read(path: string): Promise<string>
  load(project: string): Promise<PlansState | undefined>
  save(project: string, state: PlansState): Promise<void>
  now(): Promise<number>
  log(line: string): void
}

/** Every plan in the folders, in folder order then file name. A folder that does not exist has none. */
async function readPlans(io: PlansIo): Promise<Plan[]> {
  const found: { path: string; plan: Plan }[] = []
  for (const folder of io.folders) {
    const dir = folder.replace(/\/+$/, '') || folder
    if (!(await io.exists(dir))) continue
    // A link is `other`, never followed.
    const entries = (await io.list(dir))
      .filter(e => e.kind === 'file' && e.name.toLowerCase().endsWith('.md'))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      const path = `${dir}/${e.name}`
      if (e.size > PLANS.maxFileBytes) {
        io.log(`final-commit: plans: skipped ${path} (larger than ${PLANS.maxFileBytes} bytes)`)
        continue
      }
      const parsed = parsePlan(await io.read(path))
      for (const why of parsed.skipped) io.log(`final-commit: plans: ${path}: ${why}`)
      if (parsed.plan) found.push({ path, plan: parsed.plan })
    }
  }
  const merged = mergePlans(found)
  for (const why of merged.skipped) io.log(`final-commit: plans: ${why}`)
  return merged.plans
}

export function createPlansSource(io: PlansIo): WorkSource {
  async function refresh(since: number | undefined): Promise<PlansState> {
    const project = await io.project()
    const plans = await readPlans(io)
    const now = await io.now()
    const before = await io.load(project)
    // No record for this project yet: this read is its baseline.
    const next = diffPlans(before ?? NO_PLANS, plans, now, before === undefined)
    const kept = since === undefined ? next : trimLog(next, since)
    await io.save(project, kept)
    return kept
  }
  return {
    name: 'plans',
    record: async () => `plans:${await io.project()}`,
    start: async () => {
      await refresh(undefined)
    },
    changedSince: async since => (await refresh(since)).log,
  }
}

/** A short stable id for a project folder, so its path is not a store key. FNV-1a, 32 bits. */
export function plansId(cwd: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < cwd.length; i++) {
    h ^= cwd.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
