import { expect, test } from 'claude-code/testing'
import { CHART_RETRY } from '../src/config'
import { NO_CHART_FAILURES, chartFailed, chartSucceeded, isChartHeld } from '../src/detect/chart-retry'

// A failed chart a work source started: retried after a growing wait, told once. Invented keys (NOVA-).

test('a first failure holds the epic for the first wait, and is the one told', () => {
  const r = chartFailed(NO_CHART_FAILURES, 'NOVA-1', 1_000)
  expect(r.isFirst).toBe(true)
  expect(isChartHeld(r.failures, 'NOVA-1', 1_000 + CHART_RETRY.firstMs - 1)).toBe(true)
  expect(isChartHeld(r.failures, 'NOVA-1', 1_000 + CHART_RETRY.firstMs)).toBe(false)
  expect(isChartHeld(r.failures, 'NOVA-2', 1_000)).toBe(false)
})

test('each failure in a row doubles the wait, up to the cap, and is not told', () => {
  let failures = NO_CHART_FAILURES
  const waits: number[] = []
  const told: boolean[] = []
  for (let i = 0; i < 6; i++) {
    const r = chartFailed(failures, 'NOVA-1', 0)
    failures = r.failures
    waits.push(failures['NOVA-1']!.retryAt)
    told.push(r.isFirst)
  }
  expect(waits).toEqual([1, 2, 4, 8, 16, 32].map(n => Math.min(CHART_RETRY.firstMs * n, CHART_RETRY.maxMs)))
  expect(waits.at(-1)).toBe(CHART_RETRY.maxMs)
  expect(told).toEqual([true, false, false, false, false, false])
})

test('a chart that succeeds ends the run: the next failure is told again', () => {
  const failed = chartFailed(chartFailed(NO_CHART_FAILURES, 'NOVA-1', 0).failures, 'NOVA-1', 0).failures
  const cleared = chartSucceeded(failed, 'NOVA-1')
  expect(cleared).toEqual({})
  expect(chartFailed(cleared, 'NOVA-1', 0).isFirst).toBe(true)
  expect(chartSucceeded(cleared, 'NOVA-9')).toBe(cleared)
})

test('failures of one epic leave another alone', () => {
  const both = chartFailed(chartFailed(NO_CHART_FAILURES, 'NOVA-1', 0).failures, 'NOVA-20', 0).failures
  expect(chartSucceeded(both, 'NOVA-1')).toEqual({ 'NOVA-20': both['NOVA-20']! })
})
