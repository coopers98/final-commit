import { expect, test } from 'claude-code/testing'
import { JIRA } from '../src/config'
import {
  ISSUE_FIELDS, adfText, base64, createJiraRest, createJiraSource, epicsDoneFrom, jiraBacklog, missionsFrom, parseJiraSettings, sinceClause,
  type Fetch, type HttpResponse, type JiraIssue, type JiraTransport, type SearchPage,
} from '../src/detect/jira'

// Jira Cloud as a work source (SPEC 4.4 rule 7), against recorded-shape
// responses. Everything here is invented: the site, the account, the token,
// the issues (NOVA-). No test reaches a live Jira.

const T = (minute: number) => new Date(Date.UTC(2026, 0, 1, 9, minute)).toISOString()
const at = (minute: number) => Date.parse(T(minute))
const EPIC_TYPE = { name: 'Epic', hierarchyLevel: 1 }
const STORY = { name: 'Story', hierarchyLevel: 0 }
const SUBTASK = { name: 'Sub-task', hierarchyLevel: -1 }
const issue = (key: string, category: string, minute: number, extra: object = {}): JiraIssue => ({
  id: key.replace(/\D/g, ''), key,
  fields: { summary: `Task ${key}`, issuetype: STORY, status: { statusCategory: { key: category } }, statuscategorychangedate: T(minute), project: { key: 'NOVA' }, ...extra },
})
const EPIC_PARENT = { key: 'NOVA-1', fields: { summary: 'Billing export', issuetype: EPIC_TYPE } }

test('settings: a Jira Cloud site over https, an email and a token; anything else is incomplete and says why', () => {
  expect(parseJiraSettings(' https://example.atlassian.net/ ', ' me@example.com ', ' tok ')).toEqual({ settings: { site: 'https://example.atlassian.net', email: 'me@example.com', token: 'tok' } })
  expect(parseJiraSettings('', '', '').problem).toBe('jiraSite, jiraEmail and jiraToken are not set')
  for (const site of ['http://example.atlassian.net', 'https://example.atlassian.net.evil.test', 'https://jira.example.com', 'https://example.atlassian.net/x'])
    expect(parseJiraSettings(site, 'me@example.com', 'tok').problem).toBe('jiraSite must be a Jira Cloud site, like https://example.atlassian.net')
  expect(parseJiraSettings('https://example.atlassian.net', 'me@example.com', '').problem).toBe('jiraEmail and jiraToken must both be set')
  expect(parseJiraSettings(undefined, 3, null).problem).toBe('jiraSite, jiraEmail and jiraToken are not set')
})

test('base64 matches the standard encoding, padding and UTF-8 included', () => {
  expect(base64('')).toBe('')
  expect(base64('f')).toBe('Zg==')
  expect(base64('fo')).toBe('Zm8=')
  expect(base64('foo')).toBe('Zm9v')
  expect(base64('me@example.com:tok')).toBe('bWVAZXhhbXBsZS5jb206dG9r')
  expect(base64('é€😀')).toBe('w6nigqzwn5iA')
})

test('a mission under an epic starts on In Progress and completes on Done; a Done seen alone is a Done only (no start made up)', () => {
  const epics = new Map([['NOVA-1', 'Export invoices as files.']])
  const found = missionsFrom([
    issue('NOVA-12', 'indeterminate', 5, { parent: EPIC_PARENT }),
    issue('NOVA-13', 'done', 6, { parent: EPIC_PARENT }),
    issue('NOVA-14', 'new', 7, { parent: EPIC_PARENT }),
  ], epics)
  expect(found.map(t => [t.id, t.at, t.item.key, t.to, t.epic?.key])).toEqual([
    [`indeterminate@${T(5)}`, at(5), 'NOVA-12', 'in_progress', 'NOVA-1'],
    [`done@${T(6)}`, at(6), 'NOVA-13', 'done', 'NOVA-1'],
    [`new@${T(7)}`, at(7), 'NOVA-14', 'todo', 'NOVA-1'],
  ])
  expect(found[0]?.epic).toEqual({ key: 'NOVA-1', kind: 'epic', title: 'Billing export', description: 'Export invoices as files.' })
  expect(found[0]?.item).toEqual({ key: 'NOVA-12', kind: 'issue', title: 'Task NOVA-12', description: '' })
})

test('an issue with no epic, or a sub-task (its parent not an epic), goes in its project\'s backlog; an epic of yours is not a mission', () => {
  const found = missionsFrom([
    issue('NOVA-20', 'indeterminate', 5),
    issue('NOVA-21', 'indeterminate', 5, { parent: { key: 'NOVA-20', fields: { summary: 'Story', issuetype: STORY } }, issuetype: SUBTASK }),
    issue('NOVA-2', 'indeterminate', 5, { issuetype: EPIC_TYPE }),
  ], new Map())
  expect(found.map(t => [t.item.key, t.epic?.key])).toEqual([['NOVA-20', 'NOVA-BACKLOG'], ['NOVA-21', 'NOVA-BACKLOG']])
  expect(found[0]?.epic).toEqual(jiraBacklog('NOVA'))
  expect(jiraBacklog('NOVA')).toEqual({ key: 'NOVA-BACKLOG', kind: 'epic', title: 'Backlog', description: '' })
})

test('unknown categories and malformed issues are left out without throwing; nothing is filtered by the local clock', () => {
  const bad = [null, {}, { key: 'NOVA-30' }, issue('NOVA-31', 'weird', 9), issue('NOVA-32', 'done', 1), { ...issue('NOVA-33', 'done', 9), fields: { ...issue('NOVA-33', 'done', 9).fields, statuscategorychangedate: 'no' } }, issue('NOVA-34', 'indeterminate', 9)]
  // NOVA-32 changed long ago by this clock, yet Jira's own window returned it: kept (a repeat is dropped by its processed key).
  expect(missionsFrom(bad as JiraIssue[], new Map()).map(t => t.item.key)).toEqual(['NOVA-32', 'NOVA-34'])
})

test('an epic whose category is Done is its Done; others are not', () => {
  const found = epicsDoneFrom([issue('NOVA-1', 'done', 9, { issuetype: EPIC_TYPE }), issue('NOVA-2', 'indeterminate', 9, { issuetype: EPIC_TYPE })])
  expect(found.map(t => [t.id, t.item.key, t.item.kind, t.to])).toEqual([[`epic-done@${T(9)}`, 'NOVA-1', 'epic', 'done']])
})

test('ADF descriptions become plain text, cut to the limit', () => {
  const doc = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Export invoices' }, { type: 'text', text: ' as files.' }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Monthly' }] }] }] },
  ] }
  expect(adfText(doc)).toBe('Export invoices as files. Monthly')
  expect(adfText(null)).toBe('')
  expect(adfText('plain')).toBe('')
  expect(adfText({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(JIRA.maxDescriptionChars + 9) }] }] }).length).toBe(JIRA.maxDescriptionChars)
})

test('the JQL window is whole minutes back from now, with one to spare, never less than one', () => {
  expect(sinceClause(at(0), at(10))).toBe('statusCategoryChangedDate >= -11m')
  expect(sinceClause(at(0), at(0) + 30_000)).toBe('statusCategoryChangedDate >= -2m')
  expect(sinceClause(at(5), at(5))).toBe('statusCategoryChangedDate >= -1m')
})

/** A transport answering searches by which JQL they carry, epic lookups from a table (an Error rejects), and the site's issue types. */
function fakeTransport(pages: { mine?: SearchPage[]; epics?: SearchPage[] }, descriptions: Record<string, unknown> = {}, types: { name?: string; hierarchyLevel?: number }[] = [{ name: 'Epic', hierarchyLevel: 1 }, { name: 'Story', hierarchyLevel: 0 }]) {
  const searches: { jql: string; fields: readonly string[]; token?: string }[] = []
  const lookups: string[] = []
  let typeReads = 0
  const transport: JiraTransport = {
    issueTypes: async () => (typeReads++, types),
    search: async (jql, fields, token) => {
      searches.push({ jql, fields, ...(token ? { token } : {}) })
      const list = jql.startsWith('assignee') ? pages.mine : pages.epics
      return list?.shift() ?? { issues: [], isLast: true }
    },
    issue: async key => {
      lookups.push(key)
      const d = descriptions[key]
      if (d instanceof Error) throw d
      return { fields: { summary: 'x', description: d } }
    },
  }
  return { transport, searches, lookups, typeReads: () => typeReads }
}
const lines: string[] = []
const io = (transport: JiraTransport, now = at(10)) => ({ transport, now: async () => now, log: (l: string) => void lines.push(l) })
const desc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

test('the source reads your changes and closed epics in Jira\'s window, paging by token, and an epic\'s description once, for an issue starting', async () => {
  const fake = fakeTransport({
    mine: [{ issues: [issue('NOVA-12', 'indeterminate', 5, { parent: EPIC_PARENT })], nextPageToken: 'P2' }, { issues: [issue('NOVA-13', 'done', 6, { parent: { ...EPIC_PARENT, key: 'NOVA-5' } })] }],
    epics: [{ issues: [issue('NOVA-1', 'done', 8, { issuetype: EPIC_TYPE })], isLast: true }],
  }, { 'NOVA-1': desc('Export invoices as files.') }, [{ name: 'Epic', hierarchyLevel: 1 }, { name: 'Initiative "big"', hierarchyLevel: 1 }, { name: 'Story', hierarchyLevel: 0 }])
  const source = createJiraSource(io(fake.transport))
  expect(source.name).toBe('jira')
  const found = await source.changedSince(at(0))
  expect(found.map(t => [t.item.key, t.to])).toEqual([['NOVA-12', 'in_progress'], ['NOVA-13', 'done'], ['NOVA-1', 'done']])
  expect(found[0]?.epic?.description).toBe('Export invoices as files.')
  expect(fake.searches.map(s => [s.jql, s.token])).toEqual([
    ['assignee = currentUser() AND statusCategoryChangedDate >= -11m', undefined],
    ['assignee = currentUser() AND statusCategoryChangedDate >= -11m', 'P2'],
    ['issuetype in ("Epic", "Initiative \\"big\\"") AND statusCategory = Done AND statusCategoryChangedDate >= -11m', undefined],
  ])
  expect(fake.searches[0]?.fields).toEqual(ISSUE_FIELDS)
  // Only the epic of an issue starting is described: NOVA-13 is done, so NOVA-5 is not read.
  expect(fake.lookups).toEqual(['NOVA-1'])
  await source.changedSince(at(0))
  expect(fake.lookups).toEqual(['NOVA-1'])
  expect(fake.typeReads()).toBe(1)
})

test('a site that renamed its epic level is searched by that name; one with no epic level skips the epic search', async () => {
  const renamed = fakeTransport({}, {}, [{ name: 'Feature', hierarchyLevel: 1 }])
  await createJiraSource(io(renamed.transport)).changedSince(at(0))
  expect(renamed.searches.map(s => s.jql)[1]).toBe('issuetype in ("Feature") AND statusCategory = Done AND statusCategoryChangedDate >= -11m')
  const flat = fakeTransport({}, {}, [{ name: 'Task', hierarchyLevel: 0 }])
  await createJiraSource(io(flat.transport)).changedSince(at(0))
  expect(flat.searches.length).toBe(1)
})

test('an epic whose description cannot be read is charted from its title alone, and logged; the rest are read', async () => {
  lines.length = 0
  const fake = fakeTransport({ mine: [{ issues: [issue('NOVA-12', 'indeterminate', 5, { parent: EPIC_PARENT })] }] }, { 'NOVA-1': new Error('jira: 403 forbidden') })
  const found = await createJiraSource(io(fake.transport)).changedSince(at(0))
  expect(found.map(t => [t.item.key, t.epic?.description])).toEqual([['NOVA-12', '']])
  expect(lines).toEqual(["final-commit: jira: NOVA-1's description could not be read (jira: 403 forbidden)"])
})

test('past the page cap your own issues fail the read, so none is skipped; closed epics are read up to it and logged', async () => {
  const more = (i: number): SearchPage => ({ issues: [issue(`NOVA-${100 + i}`, 'new', 5)], nextPageToken: `P${i}` })
  const tooMany = fakeTransport({ mine: Array.from({ length: JIRA.maxPages + 1 }, (_, i) => more(i)) })
  let message = ''
  try {
    await createJiraSource(io(tooMany.transport)).changedSince(at(0))
  } catch (err) {
    message = (err as Error).message
  }
  expect(message).toBe(`jira: more than ${JIRA.maxPages} pages of your issues changed since the last read`)
  lines.length = 0
  const epics = fakeTransport({ epics: Array.from({ length: JIRA.maxPages + 1 }, (_, i) => ({ issues: [issue(`NOVA-${i + 1}`, 'done', 5, { issuetype: EPIC_TYPE })], nextPageToken: `E${i}` })) })
  expect((await createJiraSource(io(epics.transport)).changedSince(at(0))).length).toBe(JIRA.maxPages)
  expect(lines).toEqual([`final-commit: jira: more than ${JIRA.maxPages} pages of closed epics changed since the last read; the rest are not read this time`])
})

const SETTINGS = { site: 'https://example.atlassian.net', email: 'me@example.com', token: 'tok' }
function fakeFetch(answers: (HttpResponse | Error)[]) {
  const calls: { url: string; init: Parameters<Fetch>[1] }[] = []
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init })
    const next = answers.shift() ?? { status: 200, ok: true, text: '{}' }
    if (next instanceof Error) throw next
    return next
  }
  return { fetch, calls }
}
const json = (body: object, status = 200): HttpResponse => ({ status, ok: status < 300, text: JSON.stringify(body) })

test('REST: searches POST to the enhanced search with Basic auth; issues are read by key', async () => {
  const f = fakeFetch([json({ issues: [], isLast: true }), json({ fields: { summary: 'Billing export', description: null } })])
  const rest = createJiraRest(SETTINGS, f.fetch)
  await rest.search('assignee = currentUser()', ['summary'], 'TOKEN1')
  await rest.issue('NOVA-1')
  expect(f.calls[0]?.url).toBe('https://example.atlassian.net/rest/api/3/search/jql')
  expect(f.calls[0]?.init.method).toBe('POST')
  expect(f.calls[0]?.init.headers.Authorization).toBe(`Basic ${base64('me@example.com:tok')}`)
  expect(JSON.parse(f.calls[0]!.init.body!)).toEqual({ jql: 'assignee = currentUser()', fields: ['summary'], maxResults: JIRA.pageSize, nextPageToken: 'TOKEN1' })
  expect(f.calls[1]).toEqual({ url: 'https://example.atlassian.net/rest/api/3/issue/NOVA-1?fields=summary,description', init: { method: 'GET', headers: f.calls[0]!.init.headers } })
  const types = fakeFetch([json([{ name: 'Epic', hierarchyLevel: 1 }] as unknown as object), json({ not: 'a list' })])
  const typed = createJiraRest(SETTINGS, types.fetch)
  expect(await typed.issueTypes()).toEqual([{ name: 'Epic', hierarchyLevel: 1 }])
  expect(types.calls[0]?.url).toBe('https://example.atlassian.net/rest/api/3/issuetype')
  let message = ''
  try {
    await typed.issueTypes()
  } catch (err) {
    message = (err as Error).message
  }
  expect(message).toBe('jira: the issue types could not be read')
})

test('REST failures become short messages that never carry the request or its token', async () => {
  const fail = async (answer: HttpResponse | Error) => {
    try {
      await createJiraRest(SETTINGS, fakeFetch([answer]).fetch).search('x', [])
      return 'resolved'
    } catch (err) {
      return (err as Error).message
    }
  }
  expect(await fail(new Error('getaddrinfo ENOTFOUND example.atlassian.net with Authorization: Basic secret'))).toBe('jira: the site could not be reached')
  expect(await fail(json({}, 401))).toBe('jira: 401 unauthorized (check jiraEmail and jiraToken)')
  expect(await fail(json({}, 403))).toBe('jira: 403 forbidden')
  expect(await fail(json({}, 429))).toBe('jira: 429 rate limited')
  expect(await fail(json({ errorMessages: ['The value \'x\' does not exist for the field \'project\'.'] }, 400))).toBe("jira: 400 The value 'x' does not exist for the field 'project'.")
  expect(await fail({ status: 502, ok: false, text: '<html>bad gateway</html>' })).toBe('jira: 502')
  expect(await fail({ status: 200, ok: true, text: 'not json' })).toBe('jira: the response was not JSON')
  for (const m of [await fail(json({}, 401)), await fail(new Error('Basic dG9r'))]) expect(m).not.toContain('tok')
})
