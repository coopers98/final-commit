import { JIRA } from '../config'
import type { WorkItem, WorkSource, WorkStatus, WorkTransition } from './work-source'

// SPEC 4.4 rule 7: Jira Cloud as a work source. An issue assigned to you is
// a mission; its epic is its parent when that parent is an epic, else its
// project's standing backlog (`NOVA-BACKLOG`). A mission's status category
// moving to In Progress starts it and to Done completes it (a Done of an
// issue that is not the active mission is an administrative closure, SPEC
// 4.2 rule 6); an epic's moving to Done surveys it. Each change is timed by Jira's `statuscategorychangedate`
// and keyed by the category and that time, so no state is kept between
// reads. The transport is handed in: REST here (`createJiraRest`), and the
// same mapping serves an MCP transport later (SPEC 4.4 rule 1). Pure apart
// from that transport.

export type JiraSettings = { site: string; email: string; token: string }

/** Only a Jira Cloud site over https: the token is never sent anywhere else. */
const SITE = /^https:\/\/[a-z0-9][a-z0-9-]{0,62}\.atlassian\.net$/

/** The settings as given, trimmed and checked; undefined when incomplete, with what is wrong. */
export function parseJiraSettings(site: unknown, email: unknown, token: unknown): { settings?: JiraSettings; problem?: string } {
  const s = typeof site === 'string' ? site.trim().toLowerCase().replace(/\/+$/, '') : ''
  const e = typeof email === 'string' ? email.trim() : ''
  const t = typeof token === 'string' ? token.trim() : ''
  if (s === '' && e === '' && t === '') return { problem: 'jiraSite, jiraEmail and jiraToken are not set' }
  if (!SITE.test(s)) return { problem: 'jiraSite must be a Jira Cloud site, like https://example.atlassian.net' }
  if (e === '' || t === '') return { problem: 'jiraEmail and jiraToken must both be set' }
  return { settings: { site: s, email: e, token: t } }
}

/** Base64 of the UTF-8 bytes of `text`, for the Basic auth header. */
export function base64(text: string): string {
  const bytes: number[] = []
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c < 0x80) bytes.push(c)
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i]!, bytes[i + 1], bytes[i + 2]]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += abc[(n >> 18) & 63]! + abc[(n >> 12) & 63]! + (b === undefined ? '=' : abc[(n >> 6) & 63]!) + (c === undefined ? '=' : abc[n & 63]!)
  }
  return out
}

type Category = 'new' | 'indeterminate' | 'done'
type IssueType = { name?: string; hierarchyLevel?: number }
type Fields = {
  summary?: string
  issuetype?: IssueType
  status?: { statusCategory?: { key?: string } }
  statuscategorychangedate?: string | null
  project?: { key?: string }
  parent?: { key?: string; fields?: { summary?: string; issuetype?: IssueType } } | null
}
export type JiraIssue = { id?: string; key?: string; fields?: Fields }
export type SearchPage = { issues?: (JiraIssue | null)[]; nextPageToken?: string | null; isLast?: boolean }

export const ISSUE_FIELDS = ['summary', 'issuetype', 'status', 'statuscategorychangedate', 'project', 'parent']

/** An epic: Jira Cloud's epic level (hierarchy 1), or a type named Epic where the level is not given. */
const isEpicType = (t: IssueType | undefined) => t?.hierarchyLevel === 1 || (t?.hierarchyLevel === undefined && t?.name?.toLowerCase() === 'epic')

const STATUS: Record<Category, WorkStatus> = { new: 'todo', indeterminate: 'in_progress', done: 'done' }

/** The project's standing system for issues with no epic; never surveyed. Its title carries no work text. */
export const jiraBacklog = (project: string): WorkItem => ({ key: `${project}-BACKLOG`, kind: 'epic', title: 'Backlog', description: '' })

/**
 * Your issues' status-category changes (SPEC 4.1). Jira keeps the latest
 * change only, so an issue started and finished between two reads is seen
 * Done alone: an administrative closure unless it is the active mission,
 * like any tracker's Done (no start is made up, which would chart its epic
 * and switch the active one). Changes are not filtered by the local clock:
 * the query's window is Jira's own, and processed keys drop repeats.
 * `epics` holds descriptions by key; an issue whose parent is not an epic
 * (a sub-task) goes in its project's backlog.
 */
export function missionsFrom(issues: readonly (JiraIssue | null)[], epics: ReadonlyMap<string, string>): WorkTransition[] {
  const out: WorkTransition[] = []
  for (const issue of issues) {
    const f = issue?.fields
    const key = issue?.key
    const category = f?.status?.statusCategory?.key as Category | undefined
    const at = f?.statuscategorychangedate ? Date.parse(f.statuscategorychangedate) : NaN
    if (!key || !f || !category || !(category in STATUS) || !Number.isFinite(at)) continue
    // An epic assigned to you is not a mission; its Done is read with the epics.
    if (isEpicType(f.issuetype)) continue
    out.push({ id: `${category}@${f.statuscategorychangedate}`, at, item: { key, kind: 'issue', title: f.summary ?? '', description: '' }, to: STATUS[category], epic: epicOf(issue, epics) })
  }
  return out
}

/** The epic an issue belongs to: its parent when that is an epic, else its project's backlog. */
function epicOf(issue: JiraIssue, epics: ReadonlyMap<string, string>): WorkItem {
  const f = issue.fields ?? {}
  const parent = f.parent?.key && isEpicType(f.parent.fields?.issuetype) ? f.parent : undefined
  if (parent?.key) return { key: parent.key, kind: 'epic', title: parent.fields?.summary ?? '', description: epics.get(parent.key) ?? '' }
  return jiraBacklog(f.project?.key ?? (issue.key ?? '').slice(0, (issue.key ?? '').lastIndexOf('-')))
}

/** Epics whose status category moved to Done in the query's window: each its epic's Done (the system surveyed). */
export function epicsDoneFrom(issues: readonly (JiraIssue | null)[]): WorkTransition[] {
  const out: WorkTransition[] = []
  for (const issue of issues) {
    const f = issue?.fields
    const at = f?.statuscategorychangedate ? Date.parse(f.statuscategorychangedate) : NaN
    if (!issue?.key || !f || f.status?.statusCategory?.key !== 'done' || !Number.isFinite(at)) continue
    out.push({ id: `epic-done@${f.statuscategorychangedate}`, at, item: { key: issue.key, kind: 'epic', title: f.summary ?? '', description: '' }, to: 'done' })
  }
  return out
}

/** Plain text of an Atlassian Document Format value (Jira v3 descriptions), cut to the limit. */
export function adfText(doc: unknown): string {
  const parts: string[] = []
  const walk = (node: unknown) => {
    if (typeof node !== 'object' || node === null) return
    const n = node as { type?: string; text?: unknown; content?: unknown }
    if (typeof n.text === 'string') parts.push(n.text)
    if (Array.isArray(n.content)) n.content.forEach(walk)
    if (n.type === 'paragraph' || n.type === 'heading' || n.type === 'listItem') parts.push(' ')
  }
  walk(doc)
  return parts.join('').replace(/\s+/g, ' ').trim().slice(0, JIRA.maxDescriptionChars)
}

/** What the source needs from Jira, whatever carries it (REST now; MCP later). Rejects with a clean, short message. */
export type JiraTransport = {
  search(jql: string, fields: readonly string[], nextPageToken?: string): Promise<SearchPage>
  /** One issue's summary and description (ADF), for an epic about to be charted. */
  issue(key: string): Promise<{ fields?: { summary?: string; description?: unknown } }>
  /** The site's issue types with their hierarchy level, to find what this site calls its epics. */
  issueTypes(): Promise<{ name?: string; hierarchyLevel?: number }[]>
}

/** A JQL string literal. */
const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** JQL bounded to changes since `since`, in whole minutes relative to Jira's own clock (no time zone to get wrong). */
export function sinceClause(since: number, now: number): string {
  return `statusCategoryChangedDate >= -${Math.max(1, Math.ceil((now - since) / 60_000) + 1)}m`
}

async function searchAll(t: JiraTransport, jql: string, fields: readonly string[], isCapFatal: boolean, log: (line: string) => void): Promise<JiraIssue[]> {
  const all: JiraIssue[] = []
  let token: string | undefined
  for (let n = 0; n < JIRA.maxPages; n++) {
    const page = await t.search(jql, fields, token)
    all.push(...(page.issues ?? []).filter((i): i is JiraIssue => !!i))
    // The token alone says there is more: `isLast` may be absent.
    if (!page.nextPageToken) return all
    token = page.nextPageToken
  }
  const what = `more than ${JIRA.maxPages} pages of ${isCapFatal ? 'your issues' : 'closed epics'} changed since the last read`
  if (isCapFatal) throw new Error(`jira: ${what}`)
  log(`final-commit: jira: ${what}; the rest are not read this time`)
  return all
}

export type JiraIo = { transport: JiraTransport; now(): Promise<number>; log(line: string): void }

export function createJiraSource(io: JiraIo): WorkSource {
  // Epic descriptions, fetched once per epic per session, only for an issue about to start (its epic may be charted).
  const described = new Map<string, string>()
  // What this site calls its epic-level types (a site may rename Epic), read once per session.
  let epicTypes: string[] | undefined
  return {
    name: 'jira',
    changedSince: async since => {
      const window = sinceClause(since, await io.now())
      const mine = await searchAll(io.transport, `assignee = currentUser() AND ${window}`, ISSUE_FIELDS, true, io.log)
      for (const i of mine) {
        const parent = i.fields?.parent
        if (i.fields?.status?.statusCategory?.key !== 'indeterminate' || !parent?.key || !isEpicType(parent.fields?.issuetype) || described.has(parent.key)) continue
        try {
          described.set(parent.key, adfText((await io.transport.issue(parent.key)).fields?.description))
        } catch (err) {
          // One epic you cannot read never holds back the rest: it is charted from its title alone.
          described.set(parent.key, '')
          io.log(`final-commit: jira: ${parent.key}'s description could not be read (${err instanceof Error ? err.message : String(err)})`)
        }
      }
      epicTypes ??= (await io.transport.issueTypes()).filter(t => t.hierarchyLevel === 1 && typeof t.name === 'string').map(t => t.name!)
      const names = [...new Set(epicTypes)]
      const epics = names.length === 0 ? [] : await searchAll(io.transport, `issuetype in (${names.map(quote).join(', ')}) AND statusCategory = Done AND ${window}`, ['summary', 'status', 'statuscategorychangedate'], false, io.log)
      return [...missionsFrom(mine, described), ...epicsDoneFrom(epics)]
    },
  }
}

export type HttpResponse = { status: number; ok: boolean; text: string }
export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<HttpResponse>

/** A short message for a failed response; Jira's own error text when it gives one. Never the request or its headers. */
function failure(r: HttpResponse): string {
  if (r.status === 401) return 'jira: 401 unauthorized (check jiraEmail and jiraToken)'
  if (r.status === 403) return 'jira: 403 forbidden'
  if (r.status === 429) return 'jira: 429 rate limited'
  let said = ''
  try {
    const body = JSON.parse(r.text) as { errorMessages?: string[]; message?: string }
    said = body.errorMessages?.[0] ?? body.message ?? ''
  } catch {
    // Not JSON: say the status only.
  }
  return `jira: ${r.status}${said ? ` ${said.slice(0, JIRA.maxErrorChars)}` : ''}`
}

/** The REST transport (Jira Cloud API v3) over the host's fetch, with Basic auth from the email and API token. */
export function createJiraRest(settings: JiraSettings, fetch: Fetch): JiraTransport {
  const headers = { Authorization: `Basic ${base64(`${settings.email}:${settings.token}`)}`, Accept: 'application/json', 'Content-Type': 'application/json' }
  const call = async (path: string, init: { method: string; body?: string }) => {
    let r: HttpResponse
    try {
      r = await fetch(`${settings.site}${path}`, { ...init, headers })
    } catch {
      throw new Error('jira: the site could not be reached')
    }
    if (!r.ok) throw new Error(failure(r))
    try {
      return JSON.parse(r.text) as unknown
    } catch {
      throw new Error('jira: the response was not JSON')
    }
  }
  return {
    search: async (jql, fields, nextPageToken) => (await call('/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify({ jql, fields, maxResults: JIRA.pageSize, ...(nextPageToken ? { nextPageToken } : {}) }),
    })) as SearchPage,
    issue: async key => (await call(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description`, { method: 'GET' })) as { fields?: { summary?: string; description?: unknown } },
    issueTypes: async () => {
      const types = await call('/rest/api/3/issuetype', { method: 'GET' })
      // Not a list: an error, retried at the next poll, rather than a site with no epics for the whole session.
      if (!Array.isArray(types)) throw new Error('jira: the issue types could not be read')
      return types as { name?: string; hierarchyLevel?: number }[]
    },
  }
}
