import type { ChartFailures } from '../../types'
import { CHART_RETRY } from '../config'

// A chart a work source started that failed (SPEC 4.4 rule 5): its epic is
// not charted again at every poll, but after a wait that doubles with each
// failure in a row, and only the first failure is told. Pure.

export const NO_CHART_FAILURES: ChartFailures = {}

/** True while the epic's last chart failed and its wait has not run out. */
export function isChartHeld(failures: ChartFailures, key: string, now: number): boolean {
  const f = failures[key]
  return f !== undefined && now < f.retryAt
}

/** Records a failure; `isFirst` when it starts a run of failures (the one to toast). */
export function chartFailed(failures: ChartFailures, key: string, now: number): { failures: ChartFailures; isFirst: boolean } {
  const count = (failures[key]?.count ?? 0) + 1
  const wait = Math.min(CHART_RETRY.firstMs * 2 ** (count - 1), CHART_RETRY.maxMs)
  return { failures: { ...failures, [key]: { count, retryAt: now + wait } }, isFirst: count === 1 }
}

/** A chart that succeeded ends the run of failures. */
export function chartSucceeded(failures: ChartFailures, key: string): ChartFailures {
  if (!(key in failures)) return failures
  const { [key]: _done, ...rest } = failures
  return rest
}
