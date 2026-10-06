import { CAPTAINS_LOG } from '../config'
import type { LogEntry } from '../store/schema'

// SPEC 9.2 captain's log. The stardate and the framing are the game's; the
// prompt is a plain working instruction (CLAUDE.md rule 1).

export const LOG_PROMPT = [
  'Summarize this session as standup notes for the developer: what was done, what is in progress, and any blockers.',
  `Plain text, one short point per line starting with "- ", at most ${CAPTAINS_LOG.maxLines} lines.`,
  'Do not call tools. Leave out secrets, credentials and personal data.',
].join(' ')

/** `26279.4`: two-digit year, day of the year, tenth of the day (host local time). */
export function stardate(now: number): string {
  const d = new Date(now)
  const start = new Date(d.getFullYear(), 0, 1).getTime()
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const day = Math.round((midnight - start) / 86_400_000) + 1
  const tenth = Math.min(9, Math.floor(((now - midnight) / 86_400_000) * 10))
  return `${String(d.getFullYear() % 100).padStart(2, '0')}${String(day).padStart(3, '0')}.${tenth}`
}

/** The reply's non-empty lines, at most CAPTAINS_LOG.maxLines. */
export function logLines(reply: string): string[] {
  return reply.split('\n').map(l => l.trimEnd()).filter(l => l.trim() !== '').slice(0, CAPTAINS_LOG.maxLines)
}

/** The log with `entry` added, keeping the newest CAPTAINS_LOG.keep. */
export function appendLog(entries: LogEntry[], entry: LogEntry): LogEntry[] {
  return [...entries, entry].slice(-CAPTAINS_LOG.keep)
}
