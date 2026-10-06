import { RED_ALERT } from '../config'

// SPEC 9.2 red alert. Pure: the glue keeps the state and draws it.

/** `until`: the status line flashes before this time. `lastToastAt`: the last alert toast, for its cooldown. */
export type AlertState = { until: number; lastToastAt: number | null }
export const NO_ALERT: AlertState = { until: 0, lastToastAt: null }

/**
 * A failed test run, or a failed tool call, during a mission. A Bash call is
 * judged as a test run only: a shell command exiting non-zero (`grep` with no
 * match, `diff`) is routine, not a failure of the tool. Returns the new state
 * and a toast when the cooldown allows one; undefined when nothing is raised.
 */
export function redAlert(s: {
  tool: string
  isError: boolean
  testFailed: boolean
  mission: string | undefined
  now: number
  state: AlertState
}): { state: AlertState; toast?: string } | undefined {
  if (!s.mission) return undefined
  const isToolFailure = s.isError && s.tool !== 'Bash'
  if (!s.testFailed && !isToolFailure) return undefined
  const mayToast = s.state.lastToastAt === null || s.now - s.state.lastToastAt >= RED_ALERT.toastCooldownMs
  const state = { until: s.now + RED_ALERT.flashMs, lastToastAt: mayToast ? s.now : s.state.lastToastAt }
  if (!mayToast) return { state }
  return { state, toast: s.testFailed ? `Red alert! Tests failing on ${s.mission}.` : `Red alert! ${s.tool} failed on ${s.mission}.` }
}
