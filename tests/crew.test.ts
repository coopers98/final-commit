import { expect, test } from 'claude-code/testing'
import { BRIDGE_KEYS, CREW_SPECS, crewLines, crewTask, NO_CREW, parseLint, parseVerdict, roleOf, ROLES, TASK_ROLE } from '../src/crew/roster'
import { recordBash, recordTactical, startEpic, startMission } from '../src/game'
import { classifyBash } from '../src/detect/git'
import { createRng } from '../src/rng'
import { migrate } from '../src/store/migrate'
import { createMemoryStore, createRepo } from '../src/store/repo'

test('crew prompts are working instructions: no game words, and no tool that edits', async () => {
  for (const role of ROLES) {
    const spec = CREW_SPECS[role]
    expect(/diffling|encounter|star ?system|starship|captain|stardate|mission|crew|officer|bridge/i.test(spec.prompt + spec.description)).toBe(false)
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) expect(spec.tools).not.toContain(tool)
    expect(spec.prompt).toContain('Do not modify')
  }
  expect(CREW_SPECS.tactical.prompt).toContain('VERDICT: CLEAN')
})

test('roleOf knows only this plugin\'s crew types', async () => {
  expect(roleOf('final-commit:tactical')).toBe('tactical')
  expect(roleOf('final-commit:engineering')).toBe('engineering')
  expect(roleOf('tactical')).toBe(undefined)
  expect(roleOf('other:tactical')).toBe(undefined)
  expect(roleOf('general-purpose')).toBe(undefined)
})

test('parseVerdict takes the last VERDICT line, bold or not', async () => {
  expect(parseVerdict('ok\nVERDICT: CLEAN')).toBe('clean')
  expect(parseVerdict('**VERDICT: ISSUES**')).toBe('issues')
  expect(parseVerdict('VERDICT: CLEAN\nlater...\nVERDICT: ISSUES')).toBe('issues')
  expect(parseVerdict('looks clean to me')).toBe(undefined)
  expect(parseVerdict('the verdict: clean')).toBe(undefined)
})

test('crewLines: busy wins over a last result; idle by default', async () => {
  expect(crewLines(NO_CREW).every(l => / idle$/.test(l))).toBe(true)
  const lines = crewLines({ running: { a: 'science' }, last: { science: { outcome: 'done', at: 0 }, tactical: { outcome: 'clean', at: 0 } }, fromBridge: [] })
  expect(lines[1]).toMatch(/2 Science +busy$/)
  expect(lines[2]).toMatch(/3 Tactical +all clear$/)
  expect(crewLines(NO_CREW, ['tactical'])[2]).toMatch(/3 Tactical +idle \(report\)$/)
  for (const l of lines) expect([...l].length).toBeLessThanOrEqual(40)
})

async function onMission() {
  const store = createMemoryStore()
  await migrate(store, 0)
  const repo = createRepo(store)
  const deps = { repo, now: 0, rng: createRng(1) }
  await startEpic({ ...deps, epic: { key: 'NOVA-1', title: 'Billing export', description: '' }, complete: async () => ({ ok: false, reason: 'offline' }), privacy: 'standard' })
  await startMission({ ...deps, issueKey: 'NOVA-2' })
  return { repo, deps }
}

test('a clean review counts only with a commit to review, and a later commit clears it', async () => {
  const { repo, deps } = await onMission()
  expect((await recordTactical({ repo, verdict: 'clean' })).counted).toBe(false)
  expect((await repo.activeMission())!.tacticalClean).toBe(false)
  await recordBash({ ...deps, signals: classifyBash('git commit -m x'), commits: 1, isError: false })
  expect((await recordTactical({ repo, verdict: 'clean' })).counted).toBe(true)
  expect((await repo.activeMission())!.tacticalClean).toBe(true)
  await recordBash({ ...deps, signals: classifyBash('git commit -m y'), commits: 1, isError: false })
  expect((await repo.activeMission())!.tacticalClean).toBe(false)
})

test('a review with issues clears a clean verdict; no mission, nothing recorded', async () => {
  const { repo, deps } = await onMission()
  await recordBash({ ...deps, signals: classifyBash('git commit -m x'), commits: 1, isError: false })
  await recordTactical({ repo, verdict: 'clean' })
  await recordTactical({ repo, verdict: 'issues' })
  expect((await repo.activeMission())!.tacticalClean).toBe(false)
  await repo.clearActiveMission()
  expect((await recordTactical({ repo, verdict: 'clean' })).counted).toBe(false)
})

test('Bridge tasks: the lint prompt asks for unpiped runs and a LINT verdict, with no game words', async () => {
  expect(BRIDGE_KEYS).toEqual({ e: 'tests', l: 'lint', s: 'question', t: 'review' })
  expect(TASK_ROLE.lint).toBe('engineering')
  const lint = crewTask('lint').prompt
  expect(lint).toContain('not piped')
  expect(lint).toContain('LINT: PASS')
  for (const t of ['tests', 'lint', 'review'] as const) expect(/diffling|shield|bridge|crew|mission/i.test(crewTask(t).prompt)).toBe(false)
  expect(crewTask('question', '  why?  ').prompt).toBe('why?')
  expect(parseLint('ok\nLINT: PASS')).toBe('pass')
  expect(parseLint('**LINT: FAIL**')).toBe('fail')
  expect(parseLint('lint passed')).toBe(undefined)
})
