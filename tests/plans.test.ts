import { expect, test } from 'claude-code/testing'
import { PLANS } from '../src/config'
import { NO_PLANS, createPlansSource, diffPlans, keyOf, mergePlans, parsePlan, plansId, trimLog, type Plan, type PlansIo } from '../src/detect/plans'
import { readSettings } from '../src/runtime'
import type { PlansState } from '../src/store/schema'

// Plan documents as a work source (SPEC 4.4 rule 3). Everything here is invented (NOVA-).

const PLAN = `# NOVA-1 Billing export

Export invoices as files for the finance team.
Monthly, as CSV.

## Tasks

- [x] NOVA-2 Write the exporter
- [~] NOVA-3: Schedule it
- [ ] Polish the wording
* [ ] NOVA-4 — Document it

\`\`\`md
- [x] NOVA-9 inside a code block
\`\`\`
`

test('a plan reads as an epic from its first heading and missions from its keyed tasks', () => {
  const { plan, skipped } = parsePlan(PLAN)
  expect(plan?.epic).toEqual({ key: 'NOVA-1', kind: 'epic', title: 'Billing export', description: 'Export invoices as files for the finance team. Monthly, as CSV.' })
  expect(plan?.tasks).toEqual([
    { key: 'NOVA-2', title: 'Write the exporter', status: 'done' },
    { key: 'NOVA-3', title: 'Schedule it', status: 'in_progress' },
    { key: 'NOVA-4', title: 'Document it', status: 'todo' },
  ])
  // By line number: the task's own text never reaches the debug log.
  expect(skipped).toEqual(['line 10: a task has no key'])
})

test('a key leads the text or is bracketed; a technical term mid-text is never a key', () => {
  expect(keyOf('NOVA-12 Convert to UTF-8')).toBe('NOVA-12')
  expect(keyOf('Convert to UTF-8 (NOVA-12)')).toBe('NOVA-12')
  expect(keyOf('Migrate to SHA-256 [NOVA-7]')).toBe('NOVA-7')
  expect(keyOf('[NOVA-7](https://example.com/NOVA-7) Billing')).toBe('NOVA-7')
  expect(keyOf('**NOVA-7**: Billing')).toBe('NOVA-7')
  expect(keyOf('Convert to UTF-8 NOVA-12')).toBe(undefined)
  // A key-shaped term leading the text loses to a bracketed key.
  expect(keyOf('UTF-8 export for finance (NOVA-12)')).toBe('NOVA-12')
  expect(parsePlan('# SHA-256 migration (NOVA-7)\n- [ ] NOVA-8 a\n').plan?.epic.key).toBe('NOVA-7')
  expect(keyOf('NOVA-12x is not a key')).toBe(undefined)
  expect(parsePlan('# [NOVA-7](https://example.com) Billing\n- [ ] NOVA-8 a\n').plan?.epic.title).toBe('Billing')
  expect(parsePlan('# Migrate to SHA-256 (NOVA-7)\n- [ ] NOVA-8 a\n').plan?.epic).toEqual({ key: 'NOVA-7', kind: 'epic', title: 'Migrate to SHA-256', description: '' })
})

test('a plan whose first heading has no key is skipped whole', () => {
  const r = parsePlan('# Billing export\n\n- [x] NOVA-2 Write it\n')
  expect(r.plan).toBe(undefined)
  expect(r.skipped).toEqual(['line 1: the first heading has no key'])
  expect(parsePlan('- [x] NOVA-2 no heading\n').skipped).toEqual(['no heading'])
})

test('a byte-order mark and Windows line ends do not hide the first heading', () => {
  const r = parsePlan('\uFEFF# NOVA-1 Billing\r\n\r\n- [~] NOVA-2 a\r\n')
  expect(r.plan?.epic.key).toBe('NOVA-1')
  expect(r.plan?.tasks).toEqual([{ key: 'NOVA-2', title: 'a', status: 'in_progress' }])
})

test('a fence closes only on its own kind, so an example inside another fence is not read', () => {
  const text = '# NOVA-1 X\n~~~\n```\n- [x] NOVA-8 example\n```\n- [x] NOVA-9 still an example\n~~~\n````\n```\n````\n- [ ] NOVA-2 real\n'
  expect(parsePlan(text).plan?.tasks.map(t => t.key)).toEqual(['NOVA-2'])
})

test('a key listed twice, or the epic\'s own key as a task, is kept once', () => {
  const r = parsePlan('# NOVA-1 X\n- [ ] NOVA-1 itself\n- [ ] NOVA-2 a\n- [x] NOVA-2 again\n')
  expect(r.plan?.tasks).toEqual([{ key: 'NOVA-2', title: 'a', status: 'todo' }])
  expect(r.skipped).toEqual(['line 2: NOVA-1 appears twice', 'line 4: NOVA-2 appears twice'])
})

test('an epic description is cut to its limit', () => {
  const r = parsePlan(`# NOVA-1 X\n${'word '.repeat(PLANS.maxDescriptionChars)}\n- [ ] NOVA-2 a\n`)
  expect(r.plan?.epic.description.length).toBe(PLANS.maxDescriptionChars)
})

const epicOf = (key: string): Plan['epic'] => ({ key, kind: 'epic', title: `Epic ${key}`, description: '' })
const plan = (statuses: Record<string, Plan['tasks'][number]['status']>, epic = 'NOVA-1'): Plan => ({
  epic: epicOf(epic),
  tasks: Object.entries(statuses).map(([key, status]) => ({ key, title: `Task ${key}`, status })),
})

test('across plans each key is kept the first time: a second plan of one epic is skipped, a shared task counts once', () => {
  const r = mergePlans([
    { path: 'a.md', plan: plan({ 'NOVA-2': 'done' }) },
    { path: 'b.md', plan: plan({ 'NOVA-3': 'todo' }) },
    { path: 'c.md', plan: plan({ 'NOVA-2': 'todo', 'NOVA-51': 'done' }, 'NOVA-50') },
  ])
  expect(r.plans.map(p => [p.epic.key, p.tasks.map(t => t.key)])).toEqual([['NOVA-1', ['NOVA-2']], ['NOVA-50', ['NOVA-51']]])
  expect(r.skipped).toEqual(['b.md: epic NOVA-1 is already read from another plan', 'c.md: NOVA-2 is already read from another plan'])
})

test('the baseline read records statuses and reports nothing', () => {
  const s = diffPlans(NO_PLANS, [plan({ 'NOVA-2': 'done', 'NOVA-3': 'in_progress' })], 5, true)
  expect(s.log).toEqual([])
  expect(s.epoch).toBe(5)
  expect(s.doneEpics).toEqual([])
  expect(diffPlans(NO_PLANS, [plan({ 'NOVA-2': 'done' })], 5, true).doneEpics).toEqual(['NOVA-1'])
  expect(s.tasks).toEqual({ 'NOVA-2': { status: 'done' }, 'NOVA-3': { status: 'in_progress' } })
})

test('each status change is one transition, timed when seen; tasks before their epic\'s Done', () => {
  let s = diffPlans(NO_PLANS, [plan({ 'NOVA-2': 'todo', 'NOVA-3': 'in_progress' })], 0, true)
  s = diffPlans(s, [plan({ 'NOVA-2': 'in_progress', 'NOVA-3': 'in_progress' })], 10)
  s = diffPlans(s, [plan({ 'NOVA-2': 'in_progress', 'NOVA-3': 'in_progress' })], 20)
  s = diffPlans(s, [plan({ 'NOVA-2': 'done', 'NOVA-3': 'done' })], 30)
  expect(s.log.map(t => [t.item.key, t.to, t.at, t.epic?.key])).toEqual([
    ['NOVA-2', 'in_progress', 10, 'NOVA-1'],
    ['NOVA-2', 'done', 30, 'NOVA-1'],
    ['NOVA-3', 'done', 30, 'NOVA-1'],
    ['NOVA-1', 'done', 30, undefined],
  ])
  expect(new Set(s.log.map(t => t.id)).size).toBe(4)
})

test('a task done between two reads, never seen started, is reported started then done', () => {
  let s = diffPlans(NO_PLANS, [plan({ 'NOVA-2': 'todo', 'NOVA-3': 'todo' })], 0, true)
  s = diffPlans(s, [plan({ 'NOVA-2': 'done', 'NOVA-3': 'todo' })], 10)
  expect(s.log.map(t => [t.item.key, t.to])).toEqual([['NOVA-2', 'in_progress'], ['NOVA-2', 'done']])
})

test('a task first seen already done is old work: recorded, not reported; a new task first seen started is reported', () => {
  let s = diffPlans(NO_PLANS, [plan({ 'NOVA-2': 'todo' })], 0, true)
  // A finished plan moved in: nothing to start, and its epic's Done finds no system to survey.
  s = diffPlans(s, [plan({ 'NOVA-2': 'todo', 'NOVA-4': 'done', 'NOVA-5': 'in_progress' }), plan({ 'NOVA-51': 'done' }, 'NOVA-50')], 10)
  expect(s.log.map(t => [t.item.key, t.to])).toEqual([['NOVA-5', 'in_progress'], ['NOVA-50', 'done']])
  expect(s.tasks['NOVA-4']).toEqual({ status: 'done' })
})

test('ids carry the baseline\'s time: a project read again from a new baseline never reuses one', () => {
  let a = diffPlans(NO_PLANS, [plan({ 'NOVA-2': 'todo' })], 100, true)
  a = diffPlans(a, [plan({ 'NOVA-2': 'in_progress' })], 200)
  let b = diffPlans(NO_PLANS, [plan({ 'NOVA-2': 'todo' })], 300, true)
  b = diffPlans(b, [plan({ 'NOVA-2': 'in_progress' })], 400)
  expect(a.log[0]?.id).not.toBe(b.log[0]?.id)
})

test('a task missing from a read keeps its status, so its return reports nothing', () => {
  let s = diffPlans(NO_PLANS, [plan({ 'NOVA-2': 'done' })], 0, true)
  s = diffPlans(s, [], 10)
  s = diffPlans(s, [plan({ 'NOVA-2': 'done' })], 20)
  expect(s.log).toEqual([])
})

test('a reopened epic reports its next Done again', () => {
  let s = diffPlans(NO_PLANS, [plan({ 'NOVA-2': 'done' })], 0, true)
  s = diffPlans(s, [plan({ 'NOVA-2': 'done', 'NOVA-3': 'todo' })], 10)
  s = diffPlans(s, [plan({ 'NOVA-2': 'done', 'NOVA-3': 'done' })], 20)
  expect(s.log.filter(t => t.item.kind === 'epic').map(t => t.at)).toEqual([20])
})

test('the log keeps what a sync can still ask for, under a safety cap', () => {
  let s = diffPlans(NO_PLANS, [plan({ 'NOVA-2': 'todo' })], 0, true)
  s = diffPlans(s, [plan({ 'NOVA-2': 'in_progress' })], 10)
  s = diffPlans(s, [plan({ 'NOVA-2': 'done' })], 20)
  expect(trimLog(s, 15).log.map(t => [t.item.key, t.to])).toEqual([['NOVA-2', 'done'], ['NOVA-1', 'done']])
  // A long wait keeps everything since it, up to the cap.
  for (let i = 1; i <= PLANS.keepLog; i++) s = diffPlans(s, [plan({ 'NOVA-2': i % 2 === 1 ? 'in_progress' : 'done' })], 20 + i)
  const kept = trimLog(s, 0)
  expect(kept.log.length).toBe(PLANS.keepLog)
  expect(kept.log.at(-1)?.at).toBe(20 + PLANS.keepLog)
})

/** Plan files in memory, a clock, a project, and each project's saved state, as the source sees them. */
function fakeIo(files: Record<string, string>, folders = ['docs/plans']) {
  const states: Record<string, PlansState> = {}
  let now = 0
  let project = 'aaaa0001'
  const lines: string[] = []
  const io: PlansIo = {
    folders,
    project: async () => project,
    exists: async path => Object.keys(files).some(f => f.startsWith(`${path}/`)),
    list: async dir => Object.entries(files)
      .filter(([f]) => f.startsWith(`${dir}/`) && !f.slice(dir.length + 1).includes('/'))
      .map(([f, text]) => ({ name: f.slice(dir.length + 1), kind: 'file' as const, size: text.length })),
    read: async path => {
      const text = files[path]
      if (text === undefined) throw new Error('missing')
      return text
    },
    load: async p => states[p],
    save: async (p, s) => void (states[p] = s),
    now: async () => now,
    log: line => void lines.push(line),
  }
  return { io, files, lines, states, at: (t: number) => void (now = t), cd: (p: string) => void (project = p) }
}

test('the source takes its baseline at start, then reports what changed since', async () => {
  const f = fakeIo({ 'docs/plans/billing.md': '# NOVA-1 Billing\n- [x] NOVA-2 a\n- [ ] NOVA-3 b\n', 'docs/plans/notes.txt': '# NOVA-7 not a plan\n- [~] NOVA-8 x\n' })
  const source = createPlansSource(f.io)
  expect(source.name).toBe('plans')
  await source.start?.()
  expect(await source.changedSince(0)).toEqual([])
  f.files['docs/plans/billing.md'] = '# NOVA-1 Billing\n- [x] NOVA-2 a\n- [~] NOVA-3 b\n'
  f.at(100)
  expect((await source.changedSince(50)).map(t => [t.item.key, t.to, t.at])).toEqual([['NOVA-3', 'in_progress', 100]])
  // Read back for a sync that waited, then dropped once a sync asks from later.
  expect((await source.changedSince(100)).length).toBe(1)
  expect(await source.changedSince(101)).toEqual([])
  expect(f.states['aaaa0001']?.log).toEqual([])
  expect(f.states['aaaa0001']?.tasks['NOVA-8']).toBe(undefined)
})

test('each project has its own state and sync record; a project first read is its baseline', async () => {
  const f = fakeIo({ 'docs/plans/billing.md': '# NOVA-1 Billing\n- [~] NOVA-2 a\n' })
  const source = createPlansSource(f.io)
  expect(await source.record?.()).toBe('plans:aaaa0001')
  expect(await source.changedSince(0)).toEqual([])
  f.cd('bbbb0002')
  expect(await source.record?.()).toBe('plans:bbbb0002')
  expect(await source.changedSince(0)).toEqual([])
  expect(Object.keys(f.states).sort()).toEqual(['aaaa0001', 'bbbb0002'])
})

test('missing folders hold no plans; large files and unkeyed plans are skipped and logged', async () => {
  const f = fakeIo({
    'docs/plans/a.md': '# No key here\n- [ ] NOVA-2 a\n',
    'docs/plans/big.md': `# NOVA-5 Big\n- [ ] NOVA-6 b\n${'x'.repeat(PLANS.maxFileBytes)}`,
    'plans/c.md': '# NOVA-10 C\n- [ ] NOVA-11 c\n',
  }, ['docs/plans', 'nowhere', 'plans/'])
  await createPlansSource(f.io).start?.()
  expect(Object.keys(f.states['aaaa0001']!.tasks)).toEqual(['NOVA-11'])
  expect(f.lines).toEqual([
    'final-commit: plans: docs/plans/a.md: line 1: the first heading has no key',
    `final-commit: plans: skipped docs/plans/big.md (larger than ${PLANS.maxFileBytes} bytes)`,
  ])
})

test('plan folders stay inside the project: absolute, home and parent paths are dropped', () => {
  expect(readSettings({ plansFolders: ['docs/plans', '/etc', '~/notes', '../other', 'a/../../b', 'C:\\plans', ' plans '] }).plansFolders).toEqual(['docs/plans', 'plans'])
  expect(readSettings({ plansFolders: ['/etc'] }).plansFolders).toEqual([...PLANS.defaultFolders])
  expect(readSettings({}).plansFolders).toEqual([...PLANS.defaultFolders])
})

test('a project folder\'s id is stable and short', () => {
  expect(plansId('/work/a')).toBe(plansId('/work/a'))
  expect(plansId('/work/a')).not.toBe(plansId('/work/b'))
  expect(plansId('/work/a')).toMatch(/^[0-9a-f]{8}$/)
})
