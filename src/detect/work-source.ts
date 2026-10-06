// SPEC 4.4: the tracker behind automatic detection. A backend (Jira over MCP
// or REST, later perhaps GitHub Issues) implements WorkSource; the sync in
// sync.ts turns what it reports into game actions. Nothing here does I/O.

export type WorkStatus = 'todo' | 'in_progress' | 'done'

export type WorkItem = {
  key: string
  kind: 'epic' | 'issue'
  title: string
  /** Raw tracker text. It reaches a prompt only through the privacy filter (SPEC 5.3). */
  description: string
}

export type WorkTransition = {
  /** The tracker's id for this status change; `<item key>:<id>` is the idempotency key (SPEC 4.2). */
  id: string
  /** When it happened, epoch milliseconds. */
  at: number
  item: WorkItem
  to: WorkStatus
  /** The epic an issue belongs to, when it has one. */
  epic?: WorkItem
}

export interface WorkSource {
  readonly name: string
  /** Status changes of the user's own issues at or after `since`, in any order. May reject. */
  changedSince(since: number): Promise<WorkTransition[]>
}

export const transitionKey = (t: WorkTransition) => `${t.item.key}:${t.id}`
