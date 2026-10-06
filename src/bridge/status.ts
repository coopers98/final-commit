import { CHARTING, STATUS, TIER_SPECS } from '../config'
import type { Mission, PendingEncounter, StarSystem } from '../store/schema'

const fit = (text: string, width: number) => {
  const chars = [...text]
  return chars.length <= width ? text : `${chars.slice(0, Math.max(0, width - 1)).join('')}~`
}

/** `/ charting NOVA-1 42s`: a spinner that turns with elapsed time, the key, the seconds so far. */
export function chartingText(key: string, elapsedMs: number): string {
  const frame = CHARTING.frames[Math.floor(Math.max(0, elapsedMs) / CHARTING.spinnerMs) % CHARTING.frames.length]
  return `${frame} charting ${key} ${Math.floor(Math.max(0, elapsedMs) / 1000)}s`
}

/**
 * SPEC 9 status line, compact: the engine prefixes the plugin's name (about
 * 18 cells), so the text itself gets STATUS.maxColumns. Priority: a waiting
 * encounter, then a system being charted, then the mission, then the system
 * name (cut to what is left).
 */
export function statusText(s: {
  system?: StarSystem
  mission?: Mission
  pending?: PendingEncounter
  charting?: { key: string; elapsedMs: number }
}): string | undefined {
  const head = [
    s.pending ? `${TIER_SPECS[s.pending.tier].glyph} /contain` : undefined,
    s.charting ? chartingText(s.charting.key, s.charting.elapsedMs) : undefined,
    s.mission?.issueKey,
  ].filter((p): p is string => p !== undefined)
  if (head.length === 0 && !s.system) return undefined
  const max = STATUS.maxColumns
  const joined = head.join(' · ')
  if (!s.system) return fit(joined, max)
  const room = max - [...joined].length - (head.length ? 3 : 0)
  if (room < 4) return fit(joined, max)
  return head.length ? `${joined} · ${fit(s.system.name, room)}` : fit(s.system.name, max)
}
