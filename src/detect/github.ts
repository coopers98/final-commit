import { GITHUB } from '../config'
import type { WorkItem, WorkSource, WorkStatus, WorkTransition } from './work-source'

// SPEC 4.4: GitHub Issues as a work source, through `gh` (its own auth). An
// issue with sub-issues is an epic; a sub-issue assigned to you is a mission.
// Each repo is listed with its key prefix (`owner/repo=FC`), and issue #12 is
// `FC-12`. Changes come from the issues' timeline events, so they are timed
// when they happened and keyed by the event's id: no state is kept between
// reads. Pure apart from the command runner it is handed.

export type GithubRepo = { owner: string; name: string; prefix: string }

const ENTRY = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\s*=\s*([A-Za-z][A-Za-z0-9]{1,9})$/

/**
 * The `githubRepos` setting: `owner/repo=PREFIX` entries. Malformed entries,
 * a repo listed twice, and a prefix already taken by another repo (two repos'
 * #12 would be one key) are returned as invalid.
 */
export function parseRepos(entries: readonly string[]): { repos: GithubRepo[]; invalid: string[] } {
  const repos: GithubRepo[] = []
  const invalid: string[] = []
  for (const raw of entries) {
    const m = ENTRY.exec(raw.trim())
    const repo = m ? { owner: m[1]!, name: m[2]!, prefix: m[3]!.toUpperCase() } : undefined
    if (!repo || repos.some(r => r.prefix === repo.prefix || fullName(r) === fullName(repo))) invalid.push(raw)
    else repos.push(repo)
  }
  return { repos, invalid }
}

const fullName = (r: { owner: string; name: string }) => `${r.owner}/${r.name}`.toLowerCase()

export const VIEWER_QUERY = 'query { viewer { login } }'

/** The viewer's own issues: assigned to them, updated since; with their parent and the events that move them. */
export const MINE_QUERY = `query($owner: String!, $name: String!, $since: DateTime!, $viewer: String!, $first: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, after: $cursor, filterBy: { since: $since, assignee: $viewer }, orderBy: { field: UPDATED_AT, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title body
        parent { number title body repository { nameWithOwner } }
        timelineItems(first: 50, since: $since, itemTypes: [ASSIGNED_EVENT, CLOSED_EVENT, REOPENED_EVENT]) {
          nodes {
            __typename
            ... on AssignedEvent { id createdAt assignee { ... on User { login } } }
            ... on ClosedEvent { id createdAt }
            ... on ReopenedEvent { id createdAt }
          }
        }
      }
    }
  }
}`

/** Epics closed since: any issue updated since, numbers and close events only (no bodies), so pages stay small. */
export const EPICS_QUERY = `query($owner: String!, $name: String!, $since: DateTime!, $first: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, after: $cursor, filterBy: { since: $since, states: [CLOSED] }, orderBy: { field: UPDATED_AT, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title
        subIssuesSummary { total }
        timelineItems(first: 20, since: $since, itemTypes: [CLOSED_EVENT]) { nodes { ... on ClosedEvent { id createdAt } } }
      }
    }
  }
}`

type Event = { __typename?: string; id?: string; createdAt?: string; assignee?: { login?: string } | null }
type Node = {
  number?: number
  title?: string
  body?: string | null
  parent?: { number?: number; title?: string; body?: string | null; repository?: { nameWithOwner?: string } } | null
  subIssuesSummary?: { total?: number }
  timelineItems?: { nodes?: (Event | null)[] }
}
export type IssuesPage = {
  data?: { repository?: { issues?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: (Node | null)[] } } | null }
  errors?: { message?: string; type?: string }[]
}

const itemOf = (repo: GithubRepo, kind: WorkItem['kind'], n: { number?: number; title?: string; body?: string | null }): WorkItem => ({
  key: `${repo.prefix}-${n.number}`,
  kind,
  title: n.title ?? '',
  description: (n.body ?? '').slice(0, GITHUB.maxDescriptionChars),
})

const eventsOf = (n: Node) => (n.timelineItems?.nodes ?? []).filter((e): e is Event & { id: string; createdAt: string } =>
  !!e && typeof e.id === 'string' && typeof e.createdAt === 'string')

function push(out: WorkTransition[], since: number, item: WorkItem, e: { id: string; createdAt: string }, to: WorkStatus, epic?: WorkItem) {
  const at = Date.parse(e.createdAt)
  if (Number.isFinite(at) && at >= since) out.push({ id: e.id, at, item, to, ...(epic ? { epic } : {}) })
}

/**
 * The viewer's issues as transitions (SPEC 4.1): assigned to the viewer
 * starts one, its close is its Done, a reopen is reported back to to do. Its
 * epic is its parent, mapped through the listed repos (a parent may live in
 * another repo); an issue outside any epic, or whose parent's repo is not
 * listed, is left out (`skipped` says which, for the debug log). An issue
 * that also has sub-issues is still a mission here.
 */
export function missionsOf(repo: GithubRepo, repos: readonly GithubRepo[], viewer: string, page: IssuesPage, since: number): { found: WorkTransition[]; skipped: string[] } {
  const found: WorkTransition[] = []
  const skipped: string[] = []
  for (const n of page.data?.repository?.issues?.nodes ?? []) {
    if (!n || typeof n.number !== 'number' || !n.parent || typeof n.parent.number !== 'number') continue
    const home = n.parent.repository?.nameWithOwner?.toLowerCase() ?? fullName(repo)
    const parentRepo = repos.find(r => fullName(r) === home)
    if (!parentRepo) {
      skipped.push(`${repo.prefix}-${n.number}: its parent is in ${n.parent.repository?.nameWithOwner}, which is not listed`)
      continue
    }
    const item = itemOf(repo, 'issue', n)
    const epic = itemOf(parentRepo, 'epic', n.parent)
    for (const e of eventsOf(n)) {
      if (e.__typename === 'AssignedEvent' && e.assignee?.login === viewer) push(found, since, item, e, 'in_progress', epic)
      else if (e.__typename === 'ClosedEvent') push(found, since, item, e, 'done', epic)
      else if (e.__typename === 'ReopenedEvent') push(found, since, item, e, 'todo', epic)
    }
  }
  return { found, skipped }
}

/** Closed issues with sub-issues as epic Dones (SPEC 4.1: the epic surveyed). */
export function epicsOf(repo: GithubRepo, page: IssuesPage, since: number): WorkTransition[] {
  const found: WorkTransition[] = []
  for (const n of page.data?.repository?.issues?.nodes ?? []) {
    if (!n || typeof n.number !== 'number' || (n.subIssuesSummary?.total ?? 0) === 0) continue
    // Its own id: an issue that is a mission and an epic must not have its mission's Done read as already seen.
    for (const e of eventsOf(n)) push(found, since, { ...itemOf(repo, 'epic', n), description: '' }, { ...e, id: `epic-${e.id}` }, 'done')
  }
  return found
}

export type RunResult = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated?: boolean }
export type GithubIo = {
  repos: readonly GithubRepo[]
  /** Runs a command (`gh`) and resolves its result; rejects when it cannot start or times out. */
  run(argv: readonly string[]): Promise<RunResult>
  log(line: string): void
}

/** A message safe to show and log: the first line of gh's own error, cut short. gh never prints its token. */
function failure(r: RunResult): string {
  // gh starts some of its own lines with `gh: `: dropped, as the message gets that prefix once.
  const line = (r.stderr || r.stdout).split('\n').map(l => l.trim().replace(/^gh:\s*/, '')).find(l => l !== '') ?? `exit ${r.exitCode}`
  return `gh: ${line.slice(0, GITHUB.maxErrorChars)}`
}

async function query(io: GithubIo, query: string, vars: Record<string, string>, ints: Record<string, number> = {}): Promise<IssuesPage & { data?: { viewer?: { login?: string } } }> {
  const argv = ['gh', 'api', 'graphql', '-f', `query=${query}`,
    ...Object.entries(vars).flatMap(([k, v]) => ['-f', `${k}=${v}`]), ...Object.entries(ints).flatMap(([k, v]) => ['-F', `${k}=${v}`])]
  let r: RunResult
  try {
    r = await io.run(argv)
  } catch {
    throw new Error('gh could not be run (not installed, or it timed out)')
  }
  if (r.exitCode !== 0) throw new Error(failure(r))
  if (r.isStdoutTruncated) throw new Error('gh: the response was too large')
  let parsed: IssuesPage & { data?: { viewer?: { login?: string } } }
  try {
    parsed = JSON.parse(r.stdout) as typeof parsed
  } catch {
    throw new Error('gh: the response was not JSON')
  }
  const message = parsed.errors?.[0]?.message
  if (message) throw new Error(`gh: ${message.slice(0, GITHUB.maxErrorChars)}`)
  return parsed
}

/**
 * Every page of one query. `isCapFatal`: reaching the page cap fails the read
 * (the viewer's own issues: a sync that moved on would lose the rest);
 * otherwise what was read is used and the cap is logged.
 */
async function pages(io: GithubIo, repo: GithubRepo, q: string, vars: Record<string, string>, size: number, isCapFatal: boolean, take: (p: IssuesPage) => void) {
  let cursor: string | undefined
  for (let n = 0; n < GITHUB.maxPages; n++) {
    const p = await query(io, q, { owner: repo.owner, name: repo.name, ...vars, ...(cursor ? { cursor } : {}) }, { first: size })
    if (!p.data?.repository) throw new Error(`gh: ${repo.owner}/${repo.name} was not found, or this gh login cannot see it`)
    take(p)
    const info = p.data.repository.issues?.pageInfo
    if (!info?.hasNextPage || !info.endCursor) return
    cursor = info.endCursor
  }
  const what = `more than ${GITHUB.maxPages * size} changed issues in ${repo.owner}/${repo.name} since the last read`
  if (isCapFatal) throw new Error(`gh: ${what}`)
  io.log(`final-commit: github: ${what}; epic closes after them are not read this time`)
}

/**
 * One source per listed repo, named `github:owner/repo`: each keeps its own
 * sync record and fails on its own (a typo, a rename, a login that cannot see
 * it), so one repo never holds back or loses another's changes (SPEC 4.4
 * rule 5).
 */
export function createGithubSources(io: GithubIo): WorkSource[] {
  let viewer: string | undefined
  const whoAmI = async () => {
    if (viewer === undefined) {
      const login = (await query(io, VIEWER_QUERY, {})).data?.viewer?.login
      if (!login) throw new Error('gh: could not read the signed-in user')
      viewer = login
    }
    return viewer
  }
  return io.repos.map(repo => ({
    name: `github:${fullName(repo)}`,
    changedSince: async (since: number) => {
      const who = await whoAmI()
      const iso = new Date(since).toISOString()
      const all: WorkTransition[] = []
      await pages(io, repo, MINE_QUERY, { since: iso, viewer: who }, GITHUB.minePageSize, true, p => {
        const { found, skipped } = missionsOf(repo, io.repos, who, p, since)
        all.push(...found)
        for (const why of skipped) io.log(`final-commit: github: ${why}`)
      })
      await pages(io, repo, EPICS_QUERY, { since: iso }, GITHUB.epicsPageSize, false, p => all.push(...epicsOf(repo, p, since)))
      return all
    },
  }))
}
