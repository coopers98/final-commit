import { expect, test } from 'claude-code/testing'
import { GITHUB } from '../src/config'
import { EPICS_QUERY, MINE_QUERY, VIEWER_QUERY, createGithubSources, epicsOf, missionsOf, parseRepos, type GithubRepo, type IssuesPage, type RunResult } from '../src/detect/github'
import type { WorkTransition } from '../src/detect/work-source'

// GitHub Issues as a work source (SPEC 4.4), against recorded-shape responses.
// Everything here is invented: the repos, the people, the issues (NOVA-).

const REPO: GithubRepo = { owner: 'example', name: 'nova', prefix: 'NOVA' }
const ATLAS: GithubRepo = { owner: 'example', name: 'atlas', prefix: 'AT' }
const T = (minute: number) => new Date(Date.UTC(2026, 0, 1, 9, minute)).toISOString()
const at = (minute: number) => Date.parse(T(minute))

const assigned = (id: string, minute: number, login = 'tester') => ({ __typename: 'AssignedEvent', id, createdAt: T(minute), assignee: { login } })
const closed = (id: string, minute: number) => ({ __typename: 'ClosedEvent', id, createdAt: T(minute) })
const reopened = (id: string, minute: number) => ({ __typename: 'ReopenedEvent', id, createdAt: T(minute) })

const PARENT = { number: 1, title: 'Billing export', body: 'Export invoices as files.', repository: { nameWithOwner: 'example/nova' } }
const mine = (number: number, events: unknown[], parent: object | null = PARENT) => ({ number, title: `Task ${number}`, body: 'Details.', parent, timelineItems: { nodes: events } })
const page = (nodes: unknown[], next?: string): IssuesPage => ({
  data: { repository: { issues: { pageInfo: { hasNextPage: next !== undefined, endCursor: next ?? null }, nodes: nodes as never } } },
})
const ids = (found: WorkTransition[]) => found.map(t => t.id)

test('repos are listed as owner/repo=PREFIX; malformed entries, a repeated repo or a taken prefix are invalid', () => {
  expect(parseRepos(['example/nova=NOVA', ' example/other.repo = ab1 ', 'example/nova', 'nova=NOVA', 'a/b=1X', 'example/third=nova', 'Example/Nova=ZZ'])).toEqual({
    repos: [{ owner: 'example', name: 'nova', prefix: 'NOVA' }, { owner: 'example', name: 'other.repo', prefix: 'AB1' }],
    invalid: ['example/nova', 'nova=NOVA', 'a/b=1X', 'example/third=nova', 'Example/Nova=ZZ'],
  })
})

test('your issue starts when assigned to you, its close is Done, a reopen is reported back to to do; timed and keyed by the event', () => {
  const { found, skipped } = missionsOf(REPO, [REPO], 'tester', page([mine(12, [assigned('E0', 4, 'someone-else'), assigned('E1', 5), closed('E2', 30), reopened('E3', 40)])]), 0)
  expect(found.map(t => [t.id, t.at, t.item.key, t.to, t.epic?.key])).toEqual([
    ['E1', at(5), 'NOVA-12', 'in_progress', 'NOVA-1'],
    ['E2', at(30), 'NOVA-12', 'done', 'NOVA-1'],
    ['E3', at(40), 'NOVA-12', 'todo', 'NOVA-1'],
  ])
  expect(found[0]?.epic).toEqual({ key: 'NOVA-1', kind: 'epic', title: 'Billing export', description: 'Export invoices as files.' })
  expect(found[0]?.item).toEqual({ key: 'NOVA-12', kind: 'issue', title: 'Task 12', description: 'Details.' })
  expect(skipped).toEqual([])
})

test('a parent in another listed repo keys the epic with that repo\'s prefix; an unlisted one is skipped and said', () => {
  const inAtlas = { ...PARENT, number: 3, repository: { nameWithOwner: 'Example/Atlas' } }
  const elsewhere = { ...PARENT, number: 4, repository: { nameWithOwner: 'example/unlisted' } }
  const r = missionsOf(REPO, [REPO, ATLAS], 'tester', page([mine(12, [assigned('E1', 5)], inAtlas), mine(13, [assigned('E2', 5)], elsewhere), mine(14, [assigned('E3', 5)], null)]), 0)
  expect(r.found.map(t => [t.item.key, t.epic?.key])).toEqual([['NOVA-12', 'AT-3']])
  expect(r.skipped).toEqual(['NOVA-13: its parent is in example/unlisted, which is not listed'])
})

test('events before since, and malformed nodes or events, are left out without throwing', () => {
  expect(ids(missionsOf(REPO, [REPO], 'tester', page([mine(23, [assigned('F', 1), closed('G', 9)])]), at(3)).found)).toEqual(['G'])
  const p = page([null, { number: 'x' }, mine(30, [null, { __typename: 'ClosedEvent' }, { __typename: 'ClosedEvent', id: 'K', createdAt: 'not a date' }, closed('L', 9)])])
  expect(ids(missionsOf(REPO, [REPO], 'tester', p, 0).found)).toEqual(['L'])
  expect(missionsOf(REPO, [REPO], 'tester', {}, 0).found).toEqual([])
})

test('an epic description is cut to its limit', () => {
  const long = { ...PARENT, body: 'x'.repeat(GITHUB.maxDescriptionChars + 50) }
  expect(missionsOf(REPO, [REPO], 'tester', page([mine(12, [assigned('E1', 5)], long)]), 0).found[0]?.epic?.description.length).toBe(GITHUB.maxDescriptionChars)
})

test('a closed issue with sub-issues is its epic\'s Done; one without is not an epic', () => {
  const p = page([
    { number: 1, title: 'Billing export', subIssuesSummary: { total: 3 }, timelineItems: { nodes: [closed('C1', 50)] } },
    { number: 12, title: 'Task', subIssuesSummary: { total: 0 }, timelineItems: { nodes: [closed('C2', 51)] } },
  ])
  // Epic closes have their own ids, apart from a mission's close of the same issue.
  expect(epicsOf(REPO, p, 0).map(t => [t.id, t.item.key, t.item.kind, t.to, t.epic])).toEqual([['epic-C1', 'NOVA-1', 'epic', 'done', undefined]])
})

/** gh answered by query: the viewer, the viewer's issues, closed epics. Each list is used in order; past its end, an empty page. */
function fakeGh(answers: { viewer?: (RunResult | Error)[]; mine?: (RunResult | Error)[]; epics?: (RunResult | Error)[] }) {
  const calls: string[][] = []
  const run = async (argv: readonly string[]) => {
    calls.push([...argv])
    const q = argv.find(a => a.startsWith('query='))?.slice('query='.length)
    const list = q === VIEWER_QUERY ? answers.viewer : q === MINE_QUERY ? answers.mine : q === EPICS_QUERY ? answers.epics : undefined
    const next = list?.shift() ?? ok(page([]))
    if (next instanceof Error) throw next
    return next
  }
  return { run, calls }
}
const ok = (p: object): RunResult => ({ exitCode: 0, stdout: JSON.stringify(p), stderr: '' })
const VIEWER = ok({ data: { viewer: { login: 'tester' } } })
const lines: string[] = []
const log = (line: string) => void lines.push(line)

test('each repo is its own source; together they ask who you are once, then page your issues and closed epics from since', async () => {
  const gh = fakeGh({
    viewer: [VIEWER],
    mine: [ok(page([mine(12, [assigned('E1', 5)])], 'CUR1')), ok(page([mine(13, [closed('E2', 6)])]))],
    epics: [ok(page([{ number: 1, title: 'Billing export', subIssuesSummary: { total: 2 }, timelineItems: { nodes: [closed('C1', 7)] } }]))],
  })
  const [nova, atlas] = createGithubSources({ repos: [REPO, ATLAS], run: gh.run, log })
  expect([nova?.name, atlas?.name]).toEqual(['github:example/nova', 'github:example/atlas'])
  expect((await nova!.changedSince(at(0))).map(t => [t.item.key, t.to])).toEqual([['NOVA-12', 'in_progress'], ['NOVA-13', 'done'], ['NOVA-1', 'done']])
  await atlas!.changedSince(at(0))
  const mineCalls = gh.calls.filter(c => c.includes(`query=${MINE_QUERY}`))
  expect(mineCalls[0]).toContain('owner=example')
  expect(mineCalls[0]).toContain('name=nova')
  expect(mineCalls[0]).toContain('viewer=tester')
  expect(mineCalls[0]).toContain(`since=${T(0)}`)
  expect(mineCalls[0]).toContain(`first=${GITHUB.minePageSize}`)
  expect(mineCalls[0]!.some(a => a.startsWith('cursor='))).toBe(false)
  expect(mineCalls[1]).toContain('cursor=CUR1')
  expect(mineCalls[2]).toContain('name=atlas')
  expect(gh.calls.filter(c => c.includes(`query=${VIEWER_QUERY}`)).length).toBe(1)
})

test('a repo that is not found, or that the login cannot see, fails its own source only', async () => {
  const missing: RunResult = { exitCode: 1, stdout: '{"data":{"repository":null},"errors":[{"type":"NOT_FOUND","message":"Could not resolve to a Repository with the name \'example/nova\'."}]}', stderr: "gh: Could not resolve to a Repository with the name 'example/nova'." }
  const gh = fakeGh({ viewer: [VIEWER], mine: [missing, ok(page([mine(5, [assigned('E1', 5)], { ...PARENT, number: 2, repository: { nameWithOwner: 'example/atlas' } })]))] })
  const [nova, atlas] = createGithubSources({ repos: [REPO, ATLAS], run: gh.run, log })
  let message = ''
  try {
    await nova!.changedSince(0)
  } catch (err) {
    message = (err as Error).message
  }
  expect(message).toBe("gh: Could not resolve to a Repository with the name 'example/nova'.")
  expect((await atlas!.changedSince(0)).map(t => t.item.key)).toEqual(['AT-5'])
  // A repository missing from the data without an error says so plainly.
  const empty = fakeGh({ viewer: [VIEWER], mine: [ok({ data: { repository: null } })] })
  let plain = ''
  try {
    await createGithubSources({ repos: [REPO], run: empty.run, log })[0]!.changedSince(0)
  } catch (err) {
    plain = (err as Error).message
  }
  expect(plain).toBe('gh: example/nova was not found, or this gh login cannot see it')
})

test('gh failures become short, clean messages', async () => {
  const fail = async (answer: RunResult | Error, where: 'viewer' | 'mine' = 'mine') => {
    try {
      await createGithubSources({ repos: [REPO], run: fakeGh(where === 'viewer' ? { viewer: [answer] } : { viewer: [VIEWER], mine: [answer] }).run, log })[0]!.changedSince(0)
      return 'resolved'
    } catch (err) {
      return (err as Error).message
    }
  }
  expect(await fail(new Error('spawn gh ENOENT'), 'viewer')).toBe('gh could not be run (not installed, or it timed out)')
  expect(await fail({ exitCode: 1, stdout: '', stderr: '\nHTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with: gh auth login\n' }, 'viewer'))
    .toBe('gh: HTTP 401: Bad credentials (https://api.github.com/graphql)')
  expect(await fail(ok({ data: { viewer: null } }), 'viewer')).toBe('gh: could not read the signed-in user')
  expect(await fail({ exitCode: 4, stdout: '', stderr: 'x'.repeat(500) })).toBe(`gh: ${'x'.repeat(GITHUB.maxErrorChars)}`)
  expect(await fail({ exitCode: 0, stdout: 'not json', stderr: '' })).toBe('gh: the response was not JSON')
  expect(await fail({ exitCode: 0, stdout: '{}', stderr: '', isStdoutTruncated: true })).toBe('gh: the response was too large')
  expect(await fail(ok({ errors: [{ message: 'Something went wrong' }] }))).toBe('gh: Something went wrong')
})

test('at the page cap your own issues fail the read, so nothing is skipped; closed epics are read up to it and logged', async () => {
  const full = (i: number) => ok(page([mine(100 + i, [assigned(`E${i}`, 5)])], `C${i}`))
  const tooMany = fakeGh({ viewer: [VIEWER], mine: Array.from({ length: GITHUB.maxPages + 1 }, (_, i) => full(i)) })
  let message = ''
  try {
    await createGithubSources({ repos: [REPO], run: tooMany.run, log })[0]!.changedSince(0)
  } catch (err) {
    message = (err as Error).message
  }
  expect(message).toBe(`gh: more than ${GITHUB.maxPages * GITHUB.minePageSize} changed issues in example/nova since the last read`)
  lines.length = 0
  const epic = (i: number) => ok(page([{ number: i + 1, title: 'E', subIssuesSummary: { total: 1 }, timelineItems: { nodes: [closed(`C${i}`, 5)] } }], `C${i}`))
  const gh = fakeGh({ viewer: [VIEWER], epics: Array.from({ length: GITHUB.maxPages + 1 }, (_, i) => epic(i)) })
  const found = await createGithubSources({ repos: [REPO], run: gh.run, log })[0]!.changedSince(0)
  expect(found.length).toBe(GITHUB.maxPages)
  expect(lines.length).toBe(1)
})
