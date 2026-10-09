import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { tierColor } from '../src/bridge/color'
import { COLORS, SYNC } from '../src/config'

// Engine-level tests: the plugin loaded by the engine's own host, with the
// clock, store, env, model and UI operations answered beneath it.
// FINAL_COMMIT_SEED makes every game roll deterministic.

const START = { cwd: '/work', surface: 'terminal' as const, isInteractive: true }
const SEED = '42'

type World = { clock: ReturnType<typeof mock.clock>; logs: string[]; commands: string[]; agents: string[]; toasts: string[]; status: (string | undefined)[]; prompts: string[]; opened: string[]; release: () => void }

/** `refuse`: pane ids that cannot be placed. `holdModel`: model calls wait for `w.release()`, so charting stays in flight. */
/** `gh`: answers a `gh` command (the github work source); other commands answer as git on `branch`. */
type Gh = (argv: readonly string[]) => { exitCode: number; stdout: string; stderr?: string }

function world(on: On, opts: { branch?: string; seed?: string; env?: Record<string, string>; refuse?: string[]; holdModel?: boolean; gh?: Gh; git?: Gh } = {}): World {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { TERM: 'xterm-256color', FINAL_COMMIT_SEED: opts.seed ?? SEED, ...opts.env })
  const held: (() => void)[] = []
  const w: World = { clock, logs: [], commands: [], agents: [], toasts: [], status: [], prompts: [], opened: [], release: () => held.splice(0).forEach(r => r()) }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('agent.register', (_$, e) => {
    w.agents.push(e.name)
    return { value: { agent: `final-commit:${e.name}` } } as never
  })
  on('command.register', (_$, e) => {
    w.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.open', (_$, e) => {
    if (opts.refuse?.includes(e.id)) return { value: { isPlaced: false, reason: 'no room' } }
    w.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    w.status.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    const gh = e.argv[0] === 'gh' && opts.gh ? opts.gh(e.argv) : e.argv[0] === 'git' && opts.git ? opts.git(e.argv) : undefined
    const out = gh ? { stderr: '', ...gh } : { exitCode: 0, stdout: `${opts.branch ?? 'main'}\n`, stderr: '' }
    return { value: { ...out, isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('model.complete', (_$, e) => {
    w.prompts.push(`${e.system ?? ''}\n${e.prompt}`)
    const answer = { value: { isAnswered: false, reason: 'api-error', usage: {} } }
    if (!opts.holdModel) return answer as never
    return new Promise(resolve => held.push(() => resolve(answer))) as never
  })
  return w
}

async function run($: any, command: string, args = '') {
  return (await $.command.run({ command, args })) as { text?: string }
}

const PANE = (requestId: string, bodyColumns = 60) => ({
  plugin: 'final-commit', surface: 'terminal' as const, component: 'Pane' as const, requestId,
  props: { title: '', isFocused: true, bodyColumns, placement: 'inline' } as never,
})

/** /epic KEY, then the title and description typed into the form pane. */
async function chart($: any, w: World, key: string, title: string, description = '') {
  expect((await run($, 'epic', key)).text).toBe(`Opened the charting form for ${key}.`)
  const form = await $.ui.mount(PANE('fc-epic'))
  await form.input({ key: 'epic-title', text: title })
  await form.input({ key: 'epic-description', text: description })
  await form.unmount()
  await w.clock.settle()
}

async function containWith($: any, keys: (ui: any) => Promise<void>) {
  await run($, 'contain')
  const ui = await $.ui.mount(PANE('fc-lattice'))
  await keys(ui)
  await ui.unmount()
}

test('session start registers the commands', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  for (const n of ['epic', 'mission', 'contain', 'craft', 'calibrate', 'bay', 'scan']) expect(w.commands).toContain(n)
  expect(w.commands).not.toContain('encounter')
})

test('a /clear draws the status line again from the save, without registering commands twice', async ($, on) => {
  const w = world(on)
  on('classic.SessionStart', () => ({}))
  await $.session.start(START)
  const commands = w.commands.length
  const drawn = w.status.length
  await $.classic.SessionStart({ source: 'clear' } as never)
  expect(w.status.length).toBe(drawn + 1)
  expect(w.commands.length).toBe(commands)
  await $.classic.SessionStart({ source: 'resume' } as never)
  expect(w.status.length).toBe(drawn + 1)
})

test('developer mode registers /encounter', { options: { devMode: true } }, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  expect(w.commands).toContain('encounter')
})

/**
 * Plan files in memory for the plans work source, keyed by project-relative
 * path. The engine hands `fs.*` hooks absolute paths, so a file is matched
 * by its relative path at the end of the one asked for.
 */
function planFiles(on: On, files: Record<string, string>) {
  const is = (asked: string, rel: string) => asked === rel || asked.endsWith(`/${rel}`)
  const dirOf = (f: string) => f.slice(0, f.lastIndexOf('/'))
  const under = (dir: string) => Object.keys(files).filter(f => is(dir.replace(/\/+$/, ''), dirOf(f)))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', (_$, e) => ({ value: under(e.path).length > 0 || Object.keys(files).some(f => is(e.path, f)) }))
  on('fs.list', (_$, e) => ({ value: under(e.path).map(f => ({ name: f.slice(f.lastIndexOf('/') + 1), kind: 'file' as const, size: files[f]!.length, mtimeMs: 0, isLink: false })) }))
  on('fs.read', (_$, e) => {
    const f = Object.keys(files).find(k => is(e.path, k))
    return (f === undefined ? Promise.reject(new Error('ENOENT')) : { value: files[f]! }) as never
  })
  return files
}

test('plan documents drive the game: a task marked in progress charts its epic and starts the mission; done completes it; all done surveys the epic', { options: { workSources: 'plans' }, timeoutMs: 15_000 }, async ($, on) => {
  const w = world(on)
  const files = planFiles(on, { 'docs/plans/billing.md': '# NOVA-1 Billing export\n\nExport invoices as files.\n\n- [ ] NOVA-2 Write the exporter\n- [x] NOVA-3 Earlier work\n- [ ] NOVA-4 Document it\n' })
  await $.session.start(START)
  await w.clock.settle()
  // The first sync is the baseline: the task already done is not awarded.
  expect(w.toasts).toEqual([])
  files['docs/plans/billing.md'] = files['docs/plans/billing.md']!.replace('- [ ] NOVA-2', '- [~] NOVA-2')
  await w.clock.advance(SYNC.pollMs)
  await w.clock.settle()
  expect(w.toasts.some(t => t.startsWith('New system charted'))).toBe(true)
  // The chart finishing syncs again at once: the mission starts without waiting for the next poll.
  expect(w.toasts).toContain('Mission NOVA-2 started.')
  // The plan's prose is the epic's description, filtered (strict drops capitalized words) before the model sees it.
  expect(w.prompts.join('\n')).toContain('invoices as files')
  files['docs/plans/billing.md'] = files['docs/plans/billing.md']!.replace('- [~] NOVA-2', '- [x] NOVA-2')
  await w.clock.advance(SYNC.pollMs)
  await w.clock.settle()
  // The mission's result opens in the report pane; NOVA-4 is still open, so the epic is not surveyed.
  const reportTexts = async () => {
    const ui = await $.ui.mount(PANE('fc-report'))
    const texts = (await ui.findAll({ type: 'Text' })).map((t: { text: string }) => t.text)
    await ui.unmount()
    return texts as string[]
  }
  expect(w.opened.at(-1)).toBe('fc-report')
  expect(await reportTexts()).toContain('Mission NOVA-2 complete')
  expect((await run($, 'mission', 'complete')).text).toBe('No active mission. Start one with /mission <KEY>.')
  // The last task done between polls, never seen started: started then completed, unrewarded as no work was
  // tracked on it (SPEC 4.3). Its report takes the pane, so the epic's survey is told by toast.
  files['docs/plans/billing.md'] = files['docs/plans/billing.md']!.replace('- [ ] NOVA-4', '- [x] NOVA-4')
  await w.clock.advance(SYNC.pollMs)
  await w.clock.settle()
  expect(w.toasts).toContain('Mission NOVA-4 started.')
  const last = await reportTexts()
  expect(last).toContain('Mission NOVA-4 complete')
  expect(last).toContain('No encounter: no work was tracked on it.')
  expect(w.toasts.some(t => t.startsWith('System surveyed'))).toBe(true)
  expect(w.logs).toEqual([])
})

test('the plans source reads nothing new between polls, and a later session starts from its record', { options: { workSources: 'plans' } }, async ($, on) => {
  const w = world(on)
  planFiles(on, { 'docs/plans/billing.md': '# NOVA-1 Billing export\n- [~] NOVA-2 Write the exporter\n' })
  await $.session.start(START)
  await w.clock.settle()
  await w.clock.advance(SYNC.pollMs * 3)
  await w.clock.settle()
  expect(w.toasts).toEqual([])
  expect(w.prompts).toEqual([])
})

/** A GitHub repo in memory: issues with timeline events, answered as `gh api graphql` pages filtered by `since`. */
function githubIssues() {
  const issues: { number: number; title: string; body: string; parent?: number; subs: number; events: { __typename: string; id: string; createdAt: string; assignee?: { login: string } }[] }[] = []
  let ids = 0
  // Answers the source's three queries: who you are, your issues (all assigned to you here), closed epics.
  const gh: Gh = argv => {
    const query = argv.find(a => a.startsWith('query='))!
    if (!query.includes('repository(')) return { exitCode: 0, stdout: JSON.stringify({ data: { viewer: { login: 'tester' } } }) }
    if (query.includes('milestones(')) return { exitCode: 0, stdout: JSON.stringify({ data: { repository: { milestones: { nodes: [] } } } }) }
    const since = Date.parse(argv.find(a => a.startsWith('since='))!.slice('since='.length))
    const isEpics = query.includes('states: [CLOSED]')
    const nodes = issues
      .filter(i => i.events.some(e => Date.parse(e.createdAt) >= since) && (isEpics ? i.events.some(e => e.__typename === 'ClosedEvent') : i.subs === 0))
      .map(i => {
        const parent = issues.find(p => p.number === i.parent)
        return {
          number: i.number, title: i.title, body: i.body, milestone: null,
          parent: parent ? { number: parent.number, title: parent.title, body: parent.body, repository: { nameWithOwner: 'example/nova' } } : null,
          subIssuesSummary: { total: i.subs }, timelineItems: { nodes: i.events.filter(e => Date.parse(e.createdAt) >= since) },
        }
      })
    return { exitCode: 0, stdout: JSON.stringify({ data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } }) }
  }
  const event = (number: number, type: 'AssignedEvent' | 'ClosedEvent', now: number) => {
    ids += 1
    issues.find(i => i.number === number)!.events.push({ __typename: type, id: `EV${ids}`, createdAt: new Date(now).toISOString(), ...(type === 'AssignedEvent' ? { assignee: { login: 'tester' } } : {}) })
  }
  return { issues, gh, event }
}

test('GitHub issues drive the game: a sub-issue assigned charts its parent and starts the mission; its close completes it; the parent\'s close surveys it', { options: { workSources: 'github', githubRepos: 'example/nova=NOVA' }, timeoutMs: 15_000 }, async ($, on) => {
  const repo = githubIssues()
  repo.issues.push({ number: 1, title: 'Billing export', body: 'Export invoices as files.', subs: 2, events: [] })
  repo.issues.push({ number: 12, title: 'Write the exporter', body: '', parent: 1, subs: 0, events: [] })
  const w = world(on, { gh: repo.gh })
  await $.session.start(START)
  await w.clock.settle()
  expect(w.toasts).toEqual([])
  repo.event(12, 'AssignedEvent', w.clock.now() + 60_000)
  await w.clock.advance(SYNC.pollMs)
  await w.clock.settle()
  expect(w.toasts.some(t => t.startsWith('New system charted'))).toBe(true)
  expect(w.toasts).toContain('Mission NOVA-12 started.')
  repo.event(12, 'ClosedEvent', w.clock.now() + 60_000)
  await w.clock.advance(SYNC.pollMs)
  await w.clock.settle()
  expect(w.opened.at(-1)).toBe('fc-report')
  expect((await run($, 'mission', 'complete')).text).toBe('No active mission. Start one with /mission <KEY>.')
  // The parent closed: the epic is surveyed (its report takes the pane).
  const reports = w.opened.filter(id => id === 'fc-report').length
  repo.event(1, 'ClosedEvent', w.clock.now() + 60_000)
  await w.clock.advance(SYNC.pollMs)
  await w.clock.settle()
  expect(w.opened.filter(id => id === 'fc-report').length).toBe(reports + 1)
  const ui = await $.ui.mount(PANE('fc-report'))
  expect((await ui.findAll({ type: 'Text' })).some((t: { text: string }) => t.text.startsWith('System surveyed'))).toBe(true)
  await ui.unmount()
})

test('a loose GitHub ticket, with no parent or milestone, is a mission in the repo\'s backlog system', { options: { workSources: 'github', githubRepos: 'example/nova=NOVA' }, timeoutMs: 15_000 }, async ($, on) => {
  const repo = githubIssues()
  repo.issues.push({ number: 20, title: 'Fix the export date', body: '', subs: 0, events: [] })
  const w = world(on, { gh: repo.gh })
  await $.session.start(START)
  await w.clock.settle()
  repo.event(20, 'AssignedEvent', w.clock.now() + 60_000)
  await w.clock.advance(SYNC.pollMs)
  await w.clock.settle()
  expect(w.toasts.some(t => t.startsWith('New system charted'))).toBe(true)
  expect(w.toasts).toContain('Mission NOVA-20 started.')
  // The backlog's prompt carries no work text: only its generic title.
  expect(w.prompts.join('\n')).not.toContain('export date')
  expect((await run($, 'scan', 'NOVA-BACKLOG')).text).not.toContain('Usage')
})

/**
 * A Jira Cloud site in memory, answering `$.http.fetch` as the REST API v3:
 * searches by the JQL they carry (yours, or closed epics) and epic lookups.
 * Each issue's status category and when it last changed are set by the test.
 */
function jiraSite(on: On) {
  type Row = { key: string; summary: string; type: 'Epic' | 'Story'; parent?: string; category: 'new' | 'indeterminate' | 'done'; changed: number; description?: string }
  const rows: Row[] = []
  const requests: { url: string; auth?: string }[] = []
  const fields = (r: Row) => {
    const parent = rows.find(p => p.key === r.parent)
    return {
      summary: r.summary, issuetype: { name: r.type, hierarchyLevel: r.type === 'Epic' ? 1 : 0 }, project: { key: 'NOVA' },
      status: { statusCategory: { key: r.category } }, statuscategorychangedate: new Date(r.changed).toISOString(),
      parent: parent ? { key: parent.key, fields: { summary: parent.summary, issuetype: { name: 'Epic', hierarchyLevel: 1 } } } : null,
    }
  }
  on('http.fetch', (_$, e) => {
    requests.push({ url: e.url, ...(e.init?.headers?.Authorization ? { auth: e.init.headers.Authorization } : {}) })
    const ok = (body: object) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })
    if (e.url.endsWith('/rest/api/3/issuetype')) return ok([{ name: 'Epic', hierarchyLevel: 1 }, { name: 'Story', hierarchyLevel: 0 }] as unknown as object) as never
    const lookup = /\/rest\/api\/3\/issue\/([A-Z0-9-]+)/.exec(e.url)
    if (lookup) {
      const r = rows.find(x => x.key === lookup[1])
      return ok({ fields: { summary: r?.summary, description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: r?.description ?? '' }] }] } } }) as never
    }
    const jql = (JSON.parse(e.init?.body ?? '{}') as { jql: string }).jql
    const minutes = Number(/>= -(\d+)m/.exec(jql)![1])
    const since = clockNow() - minutes * 60_000
    const isEpics = jql.startsWith('issuetype in')
    const issues = rows.filter(r => r.changed >= since && (isEpics ? r.type === 'Epic' && r.category === 'done' : r.type !== 'Epic')).map(r => ({ id: r.key, key: r.key, fields: fields(r) }))
    return ok({ issues, isLast: true }) as never
  })
  let clockNow = () => 0
  return { rows, requests, bind: (now: () => number) => void (clockNow = now) }
}

const JIRA_OPTIONS = { workSources: 'jira', jiraSite: 'https://example.atlassian.net', jiraEmail: 'me@example.com', jiraToken: 'sekret-token-0000' }

test('Jira issues drive the game: In Progress charts the epic and starts the mission; Done completes it; the epic\'s Done surveys it', { options: JIRA_OPTIONS, timeoutMs: 15_000 }, async ($, on) => {
  const jira = jiraSite(on)
  const w = world(on)
  jira.bind(() => w.clock.now())
  jira.rows.push({ key: 'NOVA-1', summary: 'Billing export', type: 'Epic', category: 'indeterminate', changed: 0, description: 'Export invoices as files.' })
  jira.rows.push({ key: 'NOVA-12', summary: 'Write the exporter', type: 'Story', parent: 'NOVA-1', category: 'new', changed: 0 })
  await $.session.start(START)
  await w.clock.settle()
  const move = (key: string, category: 'indeterminate' | 'done') => Object.assign(jira.rows.find(r => r.key === key)!, { category, changed: w.clock.now() + 60_000 })
  move('NOVA-12', 'indeterminate')
  await w.clock.advance(SYNC.pollMs)
  await w.clock.settle()
  expect(w.toasts.some(t => t.startsWith('New system charted'))).toBe(true)
  expect(w.toasts).toContain('Mission NOVA-12 started.')
  expect(w.prompts.join('\n')).toContain('invoices as files')
  move('NOVA-12', 'done')
  await w.clock.advance(SYNC.pollMs)
  await w.clock.settle()
  expect((await run($, 'mission', 'complete')).text).toBe('No active mission. Start one with /mission <KEY>.')
  const reports = w.opened.filter(id => id === 'fc-report').length
  move('NOVA-1', 'done')
  await w.clock.advance(SYNC.pollMs)
  await w.clock.settle()
  expect(w.opened.filter(id => id === 'fc-report').length).toBe(reports + 1)
  // Every request went to the configured site, with the token only in its auth header; never in what the person or model sees.
  expect(jira.requests.every(r => r.url.startsWith('https://example.atlassian.net/rest/api/3/') && r.auth?.startsWith('Basic '))).toBe(true)
  expect([...w.toasts, ...w.logs, ...w.prompts].join('\n')).not.toContain('sekret-token-0000')
})

test('a Jira source with a site that is not Jira Cloud is missing settings and is never called', { options: { ...JIRA_OPTIONS, jiraSite: 'https://jira.example.com' } }, async ($, on) => {
  const jira = jiraSite(on)
  const w = world(on)
  await $.session.start(START)
  await w.clock.settle()
  await w.clock.advance(SYNC.pollMs)
  expect(w.toasts).toEqual(['Work source jira is missing settings; it is ignored until they are set.'])
  expect(w.logs).toContain('final-commit: jira: jiraSite must be a Jira Cloud site, like https://example.atlassian.net')
  expect(jira.requests).toEqual([])
})

test('a GitHub source with no valid repo is missing settings, and the bad entry is logged', { options: { workSources: 'github', githubRepos: 'not a repo' } }, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.clock.settle()
  expect(w.toasts).toEqual(['Work source github is missing settings; it is ignored until they are set.'])
  expect(w.logs).toContain('final-commit: github: ignored "not a repo" (expected owner/repo=PREFIX, each repo and prefix once)')
})

test('gh failing is told once per outage, with gh\'s own short message', { options: { workSources: 'github', githubRepos: 'example/nova=NOVA' } }, async ($, on) => {
  const w = world(on, { gh: () => ({ exitCode: 1, stdout: '', stderr: 'HTTP 401: Bad credentials' }) })
  await $.session.start(START)
  await w.clock.settle()
  await w.clock.advance(SYNC.pollMs * 3)
  await w.clock.settle()
  expect(w.toasts).toEqual(['Work source github:example/nova failed (gh: HTTP 401: Bad credentials); retrying at the next poll.'])
})

test('a work source this build has no backend for is said once at start, and nothing polls', { options: { workSources: 'linear, Linear' } }, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.clock.settle()
  expect(w.toasts).toEqual(['Work source linear is not available in this build; it is ignored.'])
  await w.clock.advance(SYNC.pollMs * 2)
  expect(w.toasts.length).toBe(1)
})

test('with no work sources configured, session start toasts nothing about them', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.clock.settle()
  expect(w.toasts.some(t => t.startsWith('Work source'))).toBe(false)
})

test('epic text is typed into a pane, filtered, and never put in command output', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Rebuild export for Dr. Testperson', 'SSN 000-00-0000')
  expect(w.prompts.length).toBeGreaterThan(0)
  expect(w.prompts.join('\n')).not.toContain('Testperson')
  expect(w.prompts.join('\n')).not.toContain('000-00-0000')
  expect(w.prompts.join('\n')).not.toContain('NOVA-1')
  expect(w.toasts.some(t => t.startsWith('New system charted'))).toBe(true)
})

test('a full loop: epic, mission, encounter, contain opens', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  expect((await run($, 'mission', 'NOVA-2')).text).toBe('Mission NOVA-2 started.')
  expect((await run($, 'mission', 'complete anyway')).text).toBe('Mission NOVA-2 complete. Flora samples +1. Encounter waiting.')
  expect((await run($, 'contain')).text).toBe('Opened containment.')
  expect(w.status.at(-1)).toContain('/contain')
})

test('/mission reopen takes a completed mission out of the log, so /mission can start it again', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'mission', 'NOVA-2')
  await run($, 'mission', 'complete anyway')
  expect((await run($, 'mission', 'NOVA-2')).text).toBe('Mission NOVA-2 started.')
  await run($, 'mission', 'complete anyway')
  expect((await run($, 'mission', 'reopen NOVA-2')).text).toContain('Mission NOVA-2 reopened: removed from the log; 1 fewer completed mission, Flora samples -1.')
  expect((await run($, 'mission', 'reopen')).text).toBe('Usage: /mission reopen <KEY>, for example /mission reopen NOVA-12.')
})

test('/setup walks through the sources in a pane and saves the answers as settings, the source list last', { options: { jiraToken: 'sekret-token-0000' } }, async ($, on) => {
  const saved: [string, unknown][] = []
  on('config.set', (_$, e) => {
    saved.push([e.key, e.value])
    return { value: e.value }
  })
  const w = world(on, { gh: argv => (argv[1] === 'repo' ? { exitCode: 0, stdout: 'example/nova-tracker\n' } : { exitCode: 1, stdout: '' }) })
  await $.session.start(START)
  expect(w.commands).toContain('setup')
  expect((await run($, 'setup')).text).toBe('Opened the setup pane.')
  const ui = await $.ui.mount(PANE('fc-setup'))
  const field = async (key: string) => (await ui.find({ key })) as { props?: { value?: string } } | undefined
  expect((await field('setup-sources'))?.props?.value).toBe('plans')
  await ui.input({ key: 'setup-sources', text: 'github, jira' })
  // The repo suggested from gh, its prefix from its name.
  expect((await field('setup-github'))?.props?.value).toBe('example/nova-tracker=NT')
  await ui.input({ key: 'setup-github', text: 'example/nova-tracker=NOVA' })
  await ui.input({ key: 'setup-jiraSite', text: 'jira.example.com' })
  expect((await ui.findAll({ type: 'Text' })).some((t: { text: string }) => t.text.includes('Jira Cloud site'))).toBe(true)
  await ui.input({ key: 'setup-jiraSite', text: 'https://example.atlassian.net' })
  await ui.input({ key: 'setup-jiraEmail', text: 'me@example.com' })
  const review = (await ui.findAll({ type: 'Text' })).map((t: { text: string }) => t.text).join('\n')
  expect(review).toContain('Jira API token: set')
  expect(review).not.toContain('sekret-token-0000')
  await ui.input({ key: 'setup-review', text: '' })
  expect(saved).toEqual([
    ['final-commit.githubRepos', 'example/nova-tracker=NOVA'],
    ['final-commit.jiraSite', 'https://example.atlassian.net'],
    ['final-commit.jiraEmail', 'me@example.com'],
    ['final-commit.workSources', 'github, jira'],
  ])
  const done = (await ui.findAll({ type: 'Text' })).map((t: { text: string }) => t.text).join('\n')
  expect(done).toContain('workSources: saved')
  await ui.input({ key: 'setup-done', text: '' })
  await ui.unmount()
  // Nothing typed into the pane reached the transcript the model reads.
  expect([...w.prompts].join('\n')).not.toContain('example/nova-tracker')
})

test('/setup says where to set things when its pane cannot open', async ($, on) => {
  world(on, { refuse: ['fc-setup'] })
  await $.session.start(START)
  expect((await run($, 'setup')).text).toBe('The setup pane could not open here. Set workSources and the source settings in /config instead.')
})

test('/setup shows a refused setting with the reason, and the ones saved', async ($, on) => {
  on('config.set', (_$, e) => (e.key === 'final-commit.workSources' ? { deny: 'a managed setting owns it' } : { value: e.value }))
  world(on)
  await $.session.start(START)
  await run($, 'setup')
  const ui = await $.ui.mount(PANE('fc-setup'))
  await ui.input({ key: 'setup-sources', text: 'plans' })
  await ui.input({ key: 'setup-plans', text: 'docs/plans, plans' })
  await ui.input({ key: 'setup-review', text: '' })
  const done = (await ui.findAll({ type: 'Text' })).map((t: { text: string }) => t.text).join('\n')
  expect(done).toContain('plansFolders: saved')
  expect(done).toContain('workSources: not saved (a managed setting owns it)')
  await ui.unmount()
})

test('usage errors', async ($, on) => {
  world(on)
  await $.session.start(START)
  expect((await run($, 'epic', '')).text).toContain('Usage')
  expect((await run($, 'epic', 'NOVA-1 a title in the transcript')).text).toContain('Usage')
  expect((await run($, 'mission', 'NOVA-9')).text).toContain('No active epic')
  expect((await run($, 'contain')).text).toBe('Nothing to contain right now.')
})

test('a save from a newer build is left alone and every command says so', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.env(on, { FINAL_COMMIT_SEED: SEED })
  // The store by hand, to see every write.
  const data = new Map<string, unknown>([['fc:meta', { schemaVersion: 99, createdAt: 0, completedMissions: 3 }]])
  const writes: string[] = []
  on('store.get', (_$, e) => ({ value: data.get(e.key) }))
  on('store.set', (_$, e) => {
    writes.push(e.key)
    data.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    writes.push(e.key)
    data.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...data.keys()] }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.log', () => ({ value: undefined }))
  await $.session.start(START)
  for (const [c, a] of [['epic', 'NOVA-1'], ['mission', 'NOVA-2'], ['contain', ''], ['calibrate', ''], ['bay', '']] as const) {
    expect((await run($, c, a)).text).toContain('could not load its save')
  }
  expect(writes).toEqual([])
})

test('the Lattice pane fits 40 columns and an abandoned run keeps the encounter', { options: { devMode: true } }, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'encounter')
  await run($, 'contain')
  const ui = await $.ui.mount(PANE('fc-lattice', 38))
  for (const el of await ui.findAll({ type: 'Text' })) expect([...el.text].length).toBeLessThanOrEqual(38)
  expect(await ui.find({ key: 'keys' })).toBeDefined()
  // The kit cannot raise a person's Escape (the live tmux spike showed ui.close
  // fires with origin 'person'); an abandoned run must leave the encounter pending.
  await ui.unmount()
  expect((await run($, 'contain')).text).toBe('Opened containment.')
})

test('Space presses seal locks through the Input', { options: { devMode: true } }, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'encounter')
  await containWith($, async ui => {
    // Press, advance a frame, repeat: some presses land in the zone.
    let typed = ''
    for (let i = 0; i < 40; i += 1) {
      typed += ' '
      await ui.input({ key: 'keys', text: typed, kind: 'change' })
      await w.clock.advance(97)
      const locks = (await ui.find({ type: 'Text', text: /^Locks/ }))?.text ?? ''
      if (!locks.includes('-')) break
    }
    const locks = (await ui.find({ type: 'Text', text: /^Locks/ }))?.text
    expect(locks).toMatch(/#/)
  })
})

test('a burst of Spaces seals at most one lock', { options: { devMode: true } }, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'encounter')
  await containWith($, async ui => {
    let best = 0
    for (let i = 0; i < 40; i += 1) {
      await ui.input({ key: 'keys', text: ' '.repeat((i + 1) * 5), kind: 'change' })
      const locks = (await ui.find({ type: 'Text', text: /^Locks/ }))?.text ?? ''
      best = Math.max(best, (locks.match(/#/g) ?? []).length)
      await w.clock.advance(97)
      if (best > 0) break
    }
    expect(best).toBeLessThanOrEqual(1)
  })
})

test('calibration saves an offset for this device', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  expect((await run($, 'calibrate')).text).toBe('Opened calibration.')
  const ui = await $.ui.mount(PANE('fc-calibrate'))
  await w.clock.advance(1_000)
  let typed = ''
  for (let i = 0; i < 8; i += 1) {
    await w.clock.advance(i === 0 ? 790 : 750) // each press lands 40 ms after its beat
    typed += ' '
    await ui.input({ key: 'keys', text: typed, kind: 'change' })
  }
  await w.clock.advance(2_000)
  expect(w.toasts.some(t => /Saved: your presses land \d+ ms late/.test(t))).toBe(true)
  await ui.unmount()
})

test('calibration with no presses saves nothing', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await run($, 'calibrate')
  await w.clock.advance(10_000)
  expect(w.toasts).toContain('Calibration: No presses heard; nothing was saved.')
})

test('the band shows the companion once one is contained, and steps aside during containment', { options: { devMode: true } }, async ($, on) => {
  const w = world(on)
  // What the engine draws when the plugin steps aside.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  let contained = false
  for (let i = 0; i < 30 && !contained; i += 1) {
    await run($, 'encounter')
    // Enter throws the cell; a second Enter closes the result.
    await containWith($, async ui => {
      await ui.input({ key: 'keys', text: '', kind: 'submit' })
      await ui.input({ key: 'done', text: '', kind: 'submit' })
    })
    contained = (await run($, 'bay')).text !== 'Opened the specimen bay (0 specimens).'
  }
  expect(contained).toBe(true)
  const BAND = {
    plugin: 'final-commit', surface: 'terminal' as const, component: 'AbovePrompt' as const,
    props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 40 } as never,
  }
  const band = await $.ui.mount(BAND)
  const texts = (await band.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts.some(t => /idle|content|startled|asleep/.test(t))).toBe(true)
  // What draws beneath keeps the left; the facts sit beside the sprite, trimmed to its drawing.
  expect(texts[0]).toBe('engine band')
  expect(texts[1]).not.toMatch(/^ /)
  const art = texts.slice(-7).filter(t => /^[^A-Za-z·]*$/.test(t))
  expect(art.length).toBeGreaterThan(0)
  for (const t of texts.slice(1)) expect([...t].length).toBeLessThanOrEqual(40 - 2)
  await band.unmount()
  // Too few rows for the sprite: one line, cut to the width.
  const short = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 40 } as never })
  const line = (await short.findAll({ type: 'Text' })).map(t => t.text)
  expect(line.length).toBe(2)
  expect(line[0]).toBe('engine band')
  expect([...line[1]!].length).toBeLessThanOrEqual(40)
  await short.unmount()
  await run($, 'encounter')
  await run($, 'contain')
  const hidden = await $.ui.mount(BAND)
  const shown = (await hidden.findAll({ type: 'Text' })).map(t => t.text)
  expect(shown).toEqual(['engine band'])
  await hidden.unmount()
})

test('/bay companion N picks a companion by its list number', { options: { devMode: true } }, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  expect((await run($, 'bay', 'companion 1')).text).toBe('No such specimen. /bay lists them.')
})

test('a test run on a branch with a key starts and feeds the mission', async ($, on) => {
  const w = world(on, { branch: 'feature/NOVA-5-x' })
  on('tool.call', () => ({ result: { stdout: 'ok' } }) as never)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await $.tool.call({ tool: 'Bash', command: 'git switch feature/NOVA-5-x' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  const out = await run($, 'mission', 'complete anyway')
  expect(out.text).toContain('NOVA-5')
  expect(out.text).toContain('Reinforced Cells +1')
})

test('a failed or backgrounded Bash call is not counted', async ($, on) => {
  const w = world(on)
  let next: { result: unknown; isError?: true } = { result: {} }
  on('tool.call', () => next as never)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'mission', 'NOVA-2')
  next = { result: { backgroundTaskId: 'b1' } }
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  next = { result: {}, isError: true }
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' } as never)
  const out = await run($, 'mission', 'complete anyway')
  expect(out.text).not.toContain('Reinforced')
})

test('the status line shows charting while the model works, and clears after', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { TERM: 'xterm-256color', FINAL_COMMIT_SEED: SEED })
  const status: (string | undefined)[] = []
  let release: () => void = () => {}
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', (_$, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  // The model holds its answer until the test releases it.
  on('model.complete', () =>
    new Promise(resolve => {
      release = () => resolve({ value: { isAnswered: false, reason: 'api-error', usage: {} } })
    }) as never,
  )
  await $.session.start(START)
  expect((await run($, 'epic', 'NOVA-1')).text).toBe('Opened the charting form for NOVA-1.')
  const form = await $.ui.mount(PANE('fc-epic'))
  await form.input({ key: 'epic-title', text: 'Billing export' })
  await form.input({ key: 'epic-description', text: '' })
  await form.unmount()
  expect(status.at(-1)).toBe('| charting NOVA-1 0s')
  expect((await run($, 'epic', 'NOVA-1')).text).toBe('Epic NOVA-1 is already being charted.')
  release()
  await clock.settle()
  expect(status.at(-1)).not.toContain('charting')
})

test('a result stays up until Enter, and late Spaces land in the pane, not the prompt', { options: { devMode: true } }, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'encounter')
  await run($, 'contain')
  const ui = await $.ui.mount(PANE('fc-lattice'))
  await ui.input({ key: 'keys', text: '', kind: 'submit' })
  await w.clock.advance(10_000)
  // Still showing the result, with a focused input that swallows stray keys.
  expect(await ui.find({ key: 'done' })).toBeDefined()
  expect(await ui.find({ key: 'keys' })).toBe(undefined)
  await ui.input({ key: 'done', text: '   ', kind: 'change' })
  expect(await ui.find({ key: 'done' })).toBeDefined()
  await ui.input({ key: 'done', text: '', kind: 'submit' })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['Nothing to contain.'])
  await ui.unmount()
})

test('the Bash observer reads a piped run\'s summary from the tool output', async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ result: { stdout: 'tests/a.test.ts:\n(pass) x\n\n 3 pass\n 0 fail\n', stderr: '' } }) as never)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'mission', 'NOVA-2')
  await $.tool.call({ tool: 'Bash', command: 'npm test 2>&1 | tail -5' } as never)
  expect((await run($, 'mission', 'complete anyway')).text).toContain('Reinforced Cells +1')
})

test('a finished mission shows a report that stays until dismissed, and Enter goes to containment', async ($, on) => {
  const w = world(on)
  const opened = w.opened
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'mission', 'NOVA-2')
  await run($, 'mission', 'complete anyway')
  expect(opened.at(-1)).toBe('fc-report')
  const ui = await $.ui.mount(PANE('fc-report'))
  await w.clock.advance(60_000)
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('Mission NOVA-2 complete')
  expect(texts).toContain('Encounter!')
  expect(texts.join(' ')).toContain('Enter: contain now')
  await ui.input({ key: 'report', text: '', kind: 'submit' })
  expect(opened.at(-1)).toBe('fc-lattice')
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['Nothing to report.'])
  await ui.unmount()
})

test('leaving the report keeps the encounter waiting', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'mission', 'NOVA-2')
  await run($, 'mission', 'complete anyway')
  const ui = await $.ui.mount(PANE('fc-report'))
  await ui.unmount()
  expect((await run($, 'contain')).text).toBe('Opened containment.')
})

test('a mission with no encounter says why in its report', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'mission', 'NOVA-2')
  await run($, 'mission', 'complete anyway') // the first mission always has one
  await run($, 'mission', 'NOVA-3')
  await run($, 'mission', 'complete anyway')
  const ui = await $.ui.mount(PANE('fc-report'))
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('An encounter is already waiting: /contain.')
  expect(texts).toContain('Enter or Esc: close')
  await ui.unmount()
})

test('typing r on the report contains with a Reinforced Cell', async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ result: { stdout: ' 3 pass\n 0 fail\n' } }) as never)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'mission', 'NOVA-2')
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  await run($, 'mission', 'complete anyway')
  const ui = await $.ui.mount(PANE('fc-report'))
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join(' ')).toContain('Reinforced Cell (1)')
  await ui.input({ key: 'report', text: 'r', kind: 'submit' })
  await ui.unmount()
  const lattice = await $.ui.mount(PANE('fc-lattice'))
  expect((await lattice.findAll({ type: 'Text' })).map(t => t.text).join(' ')).toContain('throw Reinforced Cell')
  await lattice.unmount()
})

test('a failing test run during a mission raises a red alert that flashes, then clears', async ($, on) => {
  const w = world(on, { branch: 'feature/NOVA-5-x' })
  let next: { result: unknown; isError?: true } = { result: { stdout: '' } }
  on('tool.call', () => next as never)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await $.tool.call({ tool: 'Bash', command: 'git switch feature/NOVA-5-x' } as never)
  next = { result: { stdout: ' 1 fail\n' }, isError: true }
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  expect(w.toasts).toContain('Red alert! Tests failing on NOVA-5.')
  expect(w.status.at(-1)).toMatch(/^! RED ALERT/)
  // A grep with no match is a routine non-zero exit, not an alert.
  const toasts = w.toasts.length
  await $.tool.call({ tool: 'Bash', command: 'grep nothing file' } as never)
  expect(w.toasts.length).toBe(toasts)
  await w.clock.advance(10_000)
  expect(w.status.at(-1)).toBe('NOVA-5 · ' + w.status.at(-1)!.split(' · ')[1])
  expect(w.status.at(-1)).not.toMatch(/RED ALERT/)
})

test('a failed tool call with no mission raises nothing', async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ result: {}, isError: true }) as never)
  await $.session.start(START)
  await $.tool.call({ tool: 'Edit', file_path: '/work/a', old_string: 'x', new_string: 'y' } as never)
  expect(w.toasts.some(t => t.startsWith('Red alert'))).toBe(false)
})

test('/captains-log writes a session summary from a fork and shows it in the report pane', async ($, on) => {
  const w = world(on)
  const forks: string[] = []
  on('model.fork', (_$, e) => {
    forks.push(e.prompt)
    return { value: { isAnswered: true, text: '- Added the export button\n\n- Next: tests', usage: {} } } as never
  })
  await $.session.start(START)
  expect((await run($, 'captains-log')).text).toBe("Writing a session summary to the captain's log.")
  await w.clock.settle()
  expect(forks.length).toBe(1)
  expect(w.opened).toContain('fc-report')
  const pane = await $.ui.mount(PANE('fc-report'))
  const texts = (await pane.findAll({ type: "Text" })).map(t => t.text)
  expect(texts.some(t => /^Captain's log, stardate \d{5}\.\d$/.test(t))).toBe(true)
  expect(texts).toContain('- Added the export button')
  expect(texts).toContain('- Next: tests')
  await pane.unmount()
})

test('/captains-log before any reply says there is nothing to log', async ($, on) => {
  const w = world(on)
  on('model.fork', () => ({ value: { isAnswered: false, reason: 'nothing-to-fork' } }) as never)
  await $.session.start(START)
  await run($, 'captains-log')
  await w.clock.settle()
  expect(w.toasts).toContain('Nothing to log yet: the session has no replies.')
  expect(w.opened).not.toContain('fc-report')
})

test('an interrupted call raises no red alert', async ($, on) => {
  const w = world(on)
  let next: { result: unknown; isError?: true; text?: string } = { result: {} }
  on('tool.call', () => next as never)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'mission', 'NOVA-2')
  next = { result: 'Interrupted by user', isError: true, text: 'Interrupted by user' }
  await $.tool.call({ tool: 'Edit', file_path: '/work/a', old_string: 'x', new_string: 'y' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  expect(w.toasts.some(t => t.startsWith('Red alert'))).toBe(false)
  next = { result: 'String not found', isError: true, text: 'String not found' }
  await $.tool.call({ tool: 'Edit', file_path: '/work/a', old_string: 'x', new_string: 'y' } as never)
  expect(w.toasts).toContain('Red alert! Edit failed on NOVA-2.')
})

test('a captain\'s log finished while a report is open does not replace it', async ($, on) => {
  const w = world(on)
  let answer: (v: unknown) => void = () => {}
  on('model.fork', () => new Promise(resolve => { answer = resolve }) as never)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'mission', 'NOVA-2')
  await run($, 'captains-log')
  await run($, 'mission', 'complete anyway')
  const opened = w.opened.length
  answer({ value: { isAnswered: true, text: '- Did things', usage: {} } })
  await w.clock.settle()
  expect(w.opened.length).toBe(opened)
  expect(w.toasts.some(t => /^Captain's log, stardate .*, recorded\.$/.test(t))).toBe(true)
  const pane = await $.ui.mount(PANE('fc-report'))
  const texts = (await pane.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('Mission NOVA-2 complete')
  await pane.unmount()
})

test('/bridge opens a pane with the system, mission, hull, shields and fuel', async ($, on) => {
  const w = world(on)
  on('tool.call', (_$, e) => ({ result: { stdout: '' }, ...((e as { command?: string }).command === 'npm run lint' ? { isError: true } : {}) }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, tokens: 50_000, percent: 25 }, rateLimits: {}, cost: { usd: 0 } } }) as never)
  await $.session.start(START)
  expect(w.commands).toContain('bridge')
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'mission', 'NOVA-2')
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm run lint' } as never)
  expect((await run($, 'bridge')).text).toBe('Opened the bridge.')
  expect(w.opened).toContain('fc-bridge')
  const pane = await $.ui.mount(PANE('fc-bridge', 40))
  const texts = (await pane.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('Mission  NOVA-2 · 0 commits')
  expect(texts.some(t => /^Hull +\[#{10}\] 100%$/.test(t))).toBe(true)
  expect(texts).toContain('Shields  DOWN: lint failing')
  expect(texts.some(t => /^Fuel +\[#+-+\] 75%$/.test(t))).toBe(true)
  for (const t of texts) expect([...t].length).toBeLessThanOrEqual(40)
  await pane.unmount()
})

/** A crew officer spawned through the Agent tool, then its run finishing with `answer`. */
async function crewRun($: any, role: string, agentId: string, answer: string, isAborted = false) {
  await $.agent.spawn({ prompt: 'review', description: 'review', subagentType: `final-commit:${role}` })
  await $.turn.complete({ agentId, answer, durationMs: 1, isAborted, turnId: 't', reason: isAborted ? 'aborted' : 'answer' })
}

test('session start registers the three crew agent types', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  expect(w.agents).toEqual(['engineering', 'science', 'tactical'])
})

test('a clean Tactical review after a commit raises mission quality; one with nothing committed does not', async ($, on) => {
  const w = world(on, { branch: 'feature/NOVA-5-x' })
  let nextId = 'a1'
  on('agent.spawn', () => ({ model: 'm', agentId: nextId }) as never)
  on('tool.call', () => ({ result: { stdout: '' } }) as never)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await $.tool.call({ tool: 'Bash', command: 'git switch feature/NOVA-5-x' } as never)
  await crewRun($, 'tactical', 'a1', 'Nothing to review.\nVERDICT: CLEAN')
  expect(w.toasts).toContain('Tactical: all clear.')

  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' } as never)
  nextId = 'a2'
  await crewRun($, 'tactical', 'a2', 'Reviewed 1 commit.\n**VERDICT: CLEAN**')
  expect(w.toasts).toContain('Tactical: all clear. Mission quality up.')
  await run($, 'mission', 'complete anyway')
  const report = await $.ui.mount(PANE('fc-report'))
  expect((await report.findAll({ type: 'Text' })).map(t => t.text)).toContain('Tactical review: all clear')
  await report.unmount()
})

test('a clean Tactical review earns a Stasis Cell that s on the report throws; a cell not held loads a Standard one', async ($, on) => {
  const w = world(on, { branch: 'feature/NOVA-5-x' })
  on('agent.spawn', () => ({ model: 'm', agentId: 'a1' }) as never)
  on('tool.call', () => ({ result: { stdout: '' } }) as never)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await $.tool.call({ tool: 'Bash', command: 'git switch feature/NOVA-5-x' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' } as never)
  await crewRun($, 'tactical', 'a1', 'Reviewed 1 commit.\nVERDICT: CLEAN')
  expect((await run($, 'mission', 'complete anyway')).text).toContain('Stasis Cells +1')
  const report = await $.ui.mount(PANE('fc-report'))
  expect((await report.findAll({ type: 'Text' })).map(t => t.text).join(' ')).toContain('s Enter: use a Stasis Cell (1)')
  await report.input({ key: 'report', text: 's', kind: 'submit' })
  await report.unmount()
  const lattice = await $.ui.mount(PANE('fc-lattice'))
  expect((await lattice.findAll({ type: 'Text' })).map(t => t.text).join(' ')).toContain('throw Stasis Cell')
  await lattice.unmount()
  await run($, 'contain', 'singularity')
  const again = await $.ui.mount(PANE('fc-lattice'))
  const texts = (await again.findAll({ type: 'Text' })).map(t => t.text).join(' ')
  expect(texts).toContain('No Singularity Cell held. Standard Cell loaded.')
  expect(texts).toContain('throw Standard Cell')
  await again.unmount()
})

test('/craft lists the recipes and what is held', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  expect((await run($, 'craft')).text).toContain('Recipes (flora samples): Reinforced: 3 Common, Stasis: 2 Rare.')
  expect((await run($, 'craft', 'stasis')).text).toContain('A Stasis Cell needs 2 Rare flora samples.')
})

test('a Tactical review with issues says so, and the bridge shows each officer', async ($, on) => {
  const w = world(on)
  on('agent.spawn', (_$, e) => ({ model: 'm', agentId: (e as { subagentType: string }).subagentType === 'final-commit:science' ? 's1' : 't1' }) as never)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'mission', 'NOVA-2')
  await crewRun($, 'tactical', 't1', 'src/a.ts:3 shell injection.\nVERDICT: ISSUES')
  expect(w.toasts).toContain('Tactical: security issues found. See the report.')
  // Science spawned and still running.
  await $.agent.spawn({ prompt: 'q', description: 'q', subagentType: 'final-commit:science' } as never)
  await run($, 'bridge')
  const pane = await $.ui.mount(PANE('fc-bridge', 40))
  const texts = (await pane.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('Crew')
  expect(texts.some(t => /^ +1 Engineering +idle$/.test(t))).toBe(true)
  expect(texts.some(t => /^ +2 Science +busy$/.test(t))).toBe(true)
  expect(texts.some(t => /^ +3 Tactical +ISSUES FOUND \(report\)$/.test(t))).toBe(true)
  await pane.unmount()
})

test('agents that are not crew are left alone', async ($, on) => {
  const w = world(on)
  on('agent.spawn', () => ({ model: 'm', agentId: 'x1' }) as never)
  await $.session.start(START)
  await $.agent.spawn({ prompt: 'p', description: 'd', subagentType: 'general-purpose' } as never)
  await $.turn.complete({ agentId: 'x1', answer: 'VERDICT: CLEAN', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
  expect(w.toasts.some(t => t.startsWith('Tactical'))).toBe(false)
})

/** Developer-mode encounters until one is contained, so a companion exists. */
async function getCompanion($: any) {
  for (let i = 0; i < 30; i += 1) {
    await run($, 'encounter')
    await containWith($, async ui => {
      await ui.input({ key: 'keys', text: '', kind: 'submit' })
      await ui.input({ key: 'done', text: '', kind: 'submit' })
    })
    if ((await run($, 'bay')).text !== 'Opened the specimen bay (0 specimens).') return
  }
  throw new Error('no specimen contained in 30 tries')
}

test('Bridge keys send the crew; a finished run opens its report', async ($, on) => {
  const w = world(on)
  const spawned: { type: string; prompt: string }[] = []
  // The plugin's own spawn reaches the kit as an Agent tool call, answered in that tool's result shape.
  on('agent.spawn', (_$, e) => {
    const s = e as unknown as { subagent_type: string; prompt: string }
    spawned.push({ type: s.subagent_type, prompt: s.prompt })
    return { result: { status: 'async_launched', agentId: `id${spawned.length}` }, model: 'm' } as never
  })
  await $.session.start(START)
  await run($, 'bridge')
  const pane = await $.ui.mount(PANE('fc-bridge', 60))
  await pane.input({ key: 'bridge-keys-1', text: 't', kind: 'change' })
  expect(spawned.at(-1)?.type).toBe('final-commit:tactical')
  expect(w.toasts).toContain('Tactical is on it.')
  // A second t while it runs sends nobody.
  await pane.input({ key: 'bridge-keys-2', text: 't', kind: 'change' })
  expect(spawned.length).toBe(1)
  expect(w.toasts).toContain('Tactical is already on it.')
  // s asks for a question first; Enter sends it.
  await pane.input({ key: 'bridge-keys-3', text: 's', kind: 'change' })
  await pane.input({ key: 'bridge-ask-4', text: 'Where is paging handled?', kind: 'submit' })
  expect(spawned.at(-1)).toEqual({ type: 'final-commit:science', prompt: 'Where is paging handled?' })
  await pane.unmount()

  await $.turn.complete({ agentId: 'id1', answer: 'Checked 2 files.\nVERDICT: CLEAN', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
  expect(w.opened).toContain('fc-report')
  const report = await $.ui.mount(PANE('fc-report', 60))
  const texts = (await report.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('Tactical report')
  expect(texts).toContain('Checked 2 files.')
  expect(texts).toContain('VERDICT: CLEAN')
  await report.unmount()
})

test('l on the Bridge sends Engineering to lint, and its verdict sets the shields', async ($, on) => {
  const w = world(on)
  const spawned: string[] = []
  on('agent.spawn', (_$, e) => (spawned.push((e as { prompt: string }).prompt), { result: { status: 'async_launched', agentId: 'lint1' }, model: 'm' }) as never)
  await $.session.start(START)
  await run($, 'bridge')
  const pane = await $.ui.mount(PANE('fc-bridge', 60))
  await pane.input({ key: 'bridge-keys-1', text: 'l', kind: 'change' })
  expect(spawned[0]).toContain('LINT: PASS')
  await pane.unmount()
  await $.turn.complete({ agentId: 'lint1', answer: 'src/a.ts:4 unused import\nLINT: FAIL', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
  const after = await $.ui.mount(PANE('fc-bridge', 60))
  expect((await after.findAll({ type: 'Text' })).map(t => t.text)).toContain('Shields  DOWN: lint failing')
  await after.unmount()
  expect(w.toasts).toContain('Engineering is on it.')
})

test('while the Bridge is open the companion draws in it, and returns to the band when it closes', { options: { devMode: true } }, async ($, on) => {
  const w = world(on)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await getCompanion($)
  const BAND = {
    plugin: 'final-commit', surface: 'terminal' as const, component: 'AbovePrompt' as const,
    props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 60 } as never,
  }
  const bandTexts = async () => {
    const b = await $.ui.mount(BAND)
    const t = (await b.findAll({ type: 'Text' })).map(x => x.text)
    await b.unmount()
    return t
  }
  const name = (await bandTexts())[1]!
  await run($, 'bridge')
  expect(await bandTexts()).toEqual(['engine band'])
  const pane = await $.ui.mount(PANE('fc-bridge', 60))
  const texts = (await pane.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain(name)
  expect(texts.some(t => /idle|content|startled|asleep/.test(t))).toBe(true)
  await pane.unmount()
  // The kit cannot raise a person's Escape (CLAUDE.md); closing was checked live in tmux.
})

test('every crew report is kept, and 1 to 3 on the Bridge reopen it', async ($, on) => {
  const w = world(on)
  on('agent.spawn', () => ({ model: 'm', agentId: 'tac1' }) as never)
  await $.session.start(START)
  // Dispatched by the model, not the Bridge: no report pane opens, but the report is kept.
  await crewRun($, 'tactical', 'tac1', 'src/a.ts:3 shell injection in the export command.\nVERDICT: ISSUES')
  expect(w.opened).not.toContain('fc-report')
  await run($, 'bridge')
  const pane = await $.ui.mount(PANE('fc-bridge', 60))
  expect((await pane.findAll({ type: 'Text' })).map(t => t.text).some(t => /3 Tactical +ISSUES FOUND \(report\)$/.test(t))).toBe(true)
  await pane.input({ key: 'bridge-keys-1', text: '1', kind: 'change' })
  expect(w.toasts).toContain('Engineering has no report yet.')
  await pane.input({ key: 'bridge-keys-2', text: '3', kind: 'change' })
  await pane.unmount()
  expect(w.opened).toContain('fc-report')
  const report = await $.ui.mount(PANE('fc-report', 60))
  const texts = (await report.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('Tactical report')
  expect(texts).toContain('src/a.ts:3 shell injection in the export command.')
  await report.unmount()
})

test('/mission complete with open items asks in a pane first, and Enter completes it', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'mission', 'NOVA-2')
  const asked = await run($, 'mission', 'complete')
  expect(asked.text).toBe('Mission NOVA-2 has open items: No test run yet; No lint or type check yet. Asked for confirmation in a pane; not completed yet.')
  expect(w.opened.at(-1)).toBe('fc-confirm')
  expect((await run($, 'mission', 'NOVA-3')).text).toContain('Mission NOVA-2 is already active')
  const ui = await $.ui.mount(PANE('fc-confirm', 40))
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('- No test run yet')
  expect(texts).toContain('- No lint or type check yet')
  expect(texts.every(t => t.length <= 40)).toBe(true)
  await ui.input({ key: 'confirm', text: '', kind: 'submit' })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['Nothing to confirm.'])
  await ui.unmount()
  expect(w.opened.at(-1)).toBe('fc-report')
  expect((await run($, 'mission', 'complete')).text).toContain('No active mission')
})

test('a mission with green tests and lint completes without asking', async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ result: { stdout: 'ok' } }) as never)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'mission', 'NOVA-2')
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm run lint' } as never)
  expect((await run($, 'mission', 'complete')).text).toContain('Mission NOVA-2 complete.')
  expect(w.opened).not.toContain('fc-confirm')
})

test('where the confirmation cannot open, /mission complete says how to complete anyway', async ($, on) => {
  const w = world(on, { refuse: ['fc-confirm'] })
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'mission', 'NOVA-2')
  expect((await run($, 'mission', 'complete')).text).toContain('Not completed. /mission complete anyway completes it regardless.')
  expect((await run($, 'mission', 'complete anyway')).text).toContain('Mission NOVA-2 complete.')
})

/** /epic KEY and its form, leaving the charting in flight (with holdModel). */
async function startChart($: any, key: string, title: string) {
  await run($, 'epic', key)
  const form = await $.ui.mount(PANE('fc-epic'))
  await form.input({ key: 'epic-title', text: title })
  await form.input({ key: 'epic-description', text: '' })
  await form.unmount()
}

test('/mission during charting is queued, and starts on that epic when charting finishes', async ($, on) => {
  const w = world(on, { holdModel: true })
  await $.session.start(START)
  await startChart($, 'NOVA-1', 'Billing export')
  expect((await run($, 'mission', 'nova-2')).text).toBe('Mission NOVA-2 queued: it starts on epic NOVA-1 when charting finishes.')
  expect((await run($, 'mission', 'complete')).text).toBe('No active mission: NOVA-2 is queued until epic NOVA-1 is charted.')
  await w.clock.advance(30_000)
  w.release()
  await w.clock.settle()
  expect(w.toasts).toContain('Mission NOVA-2 started.')
  expect(w.status.at(-1)).toContain('NOVA-2')
  expect((await run($, 'mission', 'NOVA-3')).text).toBe('Mission NOVA-2 is already active. Finish it with /mission complete.')
})

test('a second /mission during charting replaces the queued one', async ($, on) => {
  const w = world(on, { holdModel: true })
  await $.session.start(START)
  await startChart($, 'NOVA-1', 'Billing export')
  await run($, 'mission', 'NOVA-2')
  expect((await run($, 'mission', 'NOVA-3')).text).toBe('Mission NOVA-3 queued: it starts on epic NOVA-1 when charting finishes. It replaces the queued NOVA-2.')
  w.release()
  await w.clock.settle()
  expect(w.toasts).toContain('Mission NOVA-3 started.')
  expect(w.toasts).not.toContain('Mission NOVA-2 started.')
})

test('with an active mission, /mission during charting is not queued', async ($, on) => {
  const w = world(on, { holdModel: true })
  await $.session.start(START)
  await startChart($, 'NOVA-1', 'Billing export')
  w.release()
  await w.clock.settle()
  await run($, 'mission', 'NOVA-2')
  await startChart($, 'NOVA-9', 'Search')
  expect((await run($, 'mission', 'NOVA-3')).text).toBe('Mission NOVA-2 is already active. Finish it with /mission complete.')
  w.release()
  await w.clock.settle()
})

test('/scan opens a pane for the active system and keeps species names out of its output', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  expect((await run($, 'scan')).text).toBe('No active epic. /scan <KEY> scans a charted one.')
  await chart($, w, 'NOVA-1', 'Billing export')
  expect((await run($, 'scan', 'NOVA-7')).text).toBe('Epic NOVA-7 is not charted.')
  expect((await run($, 'scan', 'not a key')).text).toBe('Usage: /scan [KEY], for example /scan NOVA-1.')
  expect((await run($, 'scan')).text).toBe('Opened the scan of epic NOVA-1.')
  expect(w.opened.at(-1)).toBe('fc-scan')
  const ui = await $.ui.mount(PANE('fc-scan', 40))
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts.some(t => t.endsWith('not yet encountered'))).toBe(true)
  expect(texts.every(t => [...t].length <= 40)).toBe(true)
  await ui.unmount()
})

test('an Engineering LINT verdict counts as the mission\'s lint, so /mission complete stops asking about it', async ($, on) => {
  const w = world(on)
  let nextId = 'e1'
  on('agent.spawn', () => ({ model: 'm', agentId: nextId }) as never)
  on('tool.call', () => ({ result: { stdout: 'ok' } }) as never)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'mission', 'NOVA-2')
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  await crewRun($, 'engineering', 'e1', 'src/a.ts:4 unused import\nLINT: FAIL')
  expect((await run($, 'mission', 'complete')).text).toContain('open items: Lint failing (the last run failed).')
  nextId = 'e2'
  await crewRun($, 'engineering', 'e2', 'All checks ran clean.\nLINT: PASS')
  expect((await run($, 'mission', 'complete')).text).toContain('Mission NOVA-2 complete.')
})

test('the encounter report draws its creature in its tier color, and the Bridge colors the shields', async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ result: { stdout: 'ok' } }) as never)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'mission', 'NOVA-2')
  await $.tool.call({ tool: 'Bash', command: 'npm run lint' } as never)
  await run($, 'mission', 'complete anyway') // the first mission always has an encounter
  const ui = await $.ui.mount(PANE('fc-report'))
  const texts = await ui.findAll({ type: 'Text' })
  const heading = texts.find(t => /\((Common|Uncommon|Rare|Exotic|Legendary|Anomaly)\)/.test(t.text))!
  const tier = /\((\w+)\)/.exec(heading.text)![1]!.toLowerCase() as 'common'
  expect(heading.props.color).toBe(tierColor(tier, w.clock.now()))
  await ui.unmount()
  await run($, 'bridge')
  const bridge = await $.ui.mount(PANE('fc-bridge', 60))
  expect((await bridge.findAll({ type: 'Text' })).find(t => t.text.startsWith('Shields'))!.props.color).toBe(COLORS.good)
  await bridge.unmount()
})

// SPEC 8: a mission's changed code becomes the puzzle asked before containment.
const TOTAL_TS = [
  'export function totalOf(items: number[], limit: number): number {',
  '  let total = 0',
  '  for (const n of items) {',
  '    if (n > 0 && total < limit) total = total + 1',
  '  }',
  '  return total',
  '}',
].join('\n')

/** git as a mission that changed src/total.ts: the diff touches line 4. */
const missionGit: Gh = argv => {
  if (argv[1] === 'rev-list') return { exitCode: 0, stdout: 'abc123\n' }
  if (argv.includes('diff') && argv.includes('--raw')) return { exitCode: 0, stdout: ':100644 100644 aaa bbb M\0src/total.ts\0' }
  if (argv.includes('diff')) return { exitCode: 0, stdout: 'diff --git a/src/total.ts b/src/total.ts\n+++ b/src/total.ts\n@@ -4 +4 @@\n' }
  return { exitCode: 0, stdout: 'main\n' }
}

async function missionWithCode($: any, on: On, w: World) {
  on('fs.read', (_$, e) => (e.path.endsWith('src/total.ts') ? { value: TOTAL_TS } : Promise.reject(new Error('ENOENT'))) as never)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'mission', 'NOVA-2')
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' } as never)
  await run($, 'mission', 'complete anyway')
  await w.clock.settle()
}

test('with puzzles local, a mission\'s changed code becomes a Bug Hunt before containment; a right answer goes on to the lattice', { options: { puzzles: 'local' } }, async ($, on) => {
  const w = world(on, { git: missionGit })
  on('tool.call', () => ({ result: { stdout: '' } }) as never)
  await missionWithCode($, on, w)
  // Local: nothing was sent to a model.
  expect(w.prompts.filter(p => p.includes('function'))).toEqual([])
  expect((await run($, 'contain')).text).toBe('Opened containment, with a puzzle first.')
  const pane = await $.ui.mount(PANE('fc-lattice', 100))
  const texts = (await pane.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('Analyze Specimen · Bug Hunt · TypeScript')
  // The changed line is the one that differs from the file; its choice is the answer.
  const original = TOTAL_TS.split('\n')
  const shown = texts.filter(t => /^ ?\d\| /.test(t)).map(t => t.slice(4))
  const line = shown.findIndex((l, i) => l !== original[i]) + 1
  const choice = texts.filter(t => /^\d {2}Line /.test(t)).findIndex(t => t.endsWith(`Line ${line}`)) + 1
  expect(choice > 0).toBe(true)
  await pane.input({ key: 'analyze', text: String(choice), kind: 'change' })
  const after = (await pane.findAll({ type: 'Text' })).map(t => t.text).join(' ')
  expect(after).toContain('Right. Containment +')
  await pane.input({ key: 'analyzed', text: '', kind: 'submit' })
  expect((await pane.findAll({ type: 'Text' })).map(t => t.text).join(' ')).toContain('Space: seal')
  await pane.unmount()
  // Answered once: the next /contain goes straight to the lattice.
  expect((await run($, 'contain')).text).toBe('Opened containment.')
})

test('s skips the puzzle straight to the lattice', { options: { puzzles: 'local' } }, async ($, on) => {
  const w = world(on, { git: missionGit })
  on('tool.call', () => ({ result: { stdout: '' } }) as never)
  await missionWithCode($, on, w)
  await run($, 'contain')
  const pane = await $.ui.mount(PANE('fc-lattice', 100))
  await pane.input({ key: 'analyze', text: 's', kind: 'change' })
  expect((await pane.findAll({ type: 'Text' })).map(t => t.text).join(' ')).toContain('Space: seal')
  await pane.unmount()
})

test('with puzzles off, containment opens with no puzzle and git is never asked for the diff', { options: { puzzles: 'off' } }, async ($, on) => {
  const asked: string[] = []
  const w = world(on, { git: argv => (asked.push(...argv), missionGit(argv)) })
  on('tool.call', () => ({ result: { stdout: '' } }) as never)
  await missionWithCode($, on, w)
  expect(asked).not.toContain('diff')
  expect((await run($, 'contain')).text).toBe('Opened containment.')
})

test('with puzzles on and the standard filter, Pattern ID sends filtered code to the puzzle model, and falls back to Bug Hunt when the model fails', { options: { puzzles: 'on', privacyMode: 'standard' } }, async ($, on) => {
  const w = world(on, { git: missionGit })
  on('tool.call', () => ({ result: { stdout: '' } }) as never)
  await missionWithCode($, on, w)
  const sent = w.prompts.filter(p => p.includes('totalOf'))
  expect(sent.length).toBe(1)
  expect((await run($, 'contain')).text).toBe('Opened containment, with a puzzle first.')
  const pane = await $.ui.mount(PANE('fc-lattice'))
  expect((await pane.findAll({ type: 'Text' })).map(t => t.text)).toContain('Analyze Specimen · Bug Hunt · TypeScript')
  await pane.unmount()
})

test('with puzzles on but the strict filter (the default), no code is sent: Bug Hunt only', { options: { puzzles: 'on' } }, async ($, on) => {
  const w = world(on, { git: missionGit })
  on('tool.call', () => ({ result: { stdout: '' } }) as never)
  await missionWithCode($, on, w)
  expect(w.prompts.filter(p => p.includes('totalOf'))).toEqual([])
  expect((await run($, 'contain')).text).toBe('Opened containment, with a puzzle first.')
})
