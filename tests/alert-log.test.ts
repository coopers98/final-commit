import { expect, test } from 'claude-code/testing'
import { NO_ALERT, redAlert } from '../src/bridge/alert'
import { appendLog, LOG_PROMPT, logLines, stardate } from '../src/bridge/log'
import { statusText } from '../src/bridge/status'
import { wrap } from '../src/bridge/text'
import { CAPTAINS_LOG, RED_ALERT, STATUS } from '../src/config'
import { classifyBash, testRunFailed } from '../src/detect/git'

const base = { tool: 'Bash', isError: false, testFailed: false, mission: 'NOVA-2', now: 1_000, state: NO_ALERT }

test('a failed test run during a mission raises a red alert with a toast', async () => {
  const r = redAlert({ ...base, isError: true, testFailed: true })!
  expect(r.toast).toBe('Red alert! Tests failing on NOVA-2.')
  expect(r.state).toEqual({ until: 1_000 + RED_ALERT.flashMs, lastToastAt: 1_000 })
})

test('a failed non-Bash tool call raises one; a non-zero shell command does not', async () => {
  expect(redAlert({ ...base, tool: 'Edit', isError: true })?.toast).toBe('Red alert! Edit failed on NOVA-2.')
  expect(redAlert({ ...base, tool: 'Bash', isError: true })).toBe(undefined)
})

test('no mission, no alert', async () => {
  expect(redAlert({ ...base, mission: undefined, testFailed: true })).toBe(undefined)
})

test('within the cooldown the status line flashes again but no toast is shown', async () => {
  const first = redAlert({ ...base, testFailed: true })!
  const soon = redAlert({ ...base, testFailed: true, now: 2_000, state: first.state })!
  expect(soon.toast).toBe(undefined)
  expect(soon.state).toEqual({ until: 2_000 + RED_ALERT.flashMs, lastToastAt: 1_000 })
  const later = redAlert({ ...base, testFailed: true, now: 1_000 + RED_ALERT.toastCooldownMs, state: soon.state })!
  expect(later.toast).not.toBe(undefined)
})

test('the status line leads with the alert and stays within its width', async () => {
  const mission = { issueKey: 'NOVA-2', systemId: 's', startedAt: 0, commits: 0, testRuns: 0, testsGreen: false, tacticalClean: false }
  const text = statusText({ mission, isAlert: true })!
  expect(text.startsWith('! RED ALERT')).toBe(true)
  expect([...text].length <= STATUS.maxColumns).toBe(true)
})

test('testRunFailed: by exit status when reliable, else only by a failing summary', async () => {
  expect(testRunFailed(classifyBash('npm test'), true, '')).toBe(true)
  expect(testRunFailed(classifyBash('npm test'), false, '')).toBe(false)
  expect(testRunFailed(classifyBash('npm test | tail -3'), false, ' 2 pass\n 1 fail\n')).toBe(true)
  expect(testRunFailed(classifyBash('npm test | tail -3'), true, 'no summary')).toBe(false)
  expect(testRunFailed(classifyBash('grep x y'), true, '')).toBe(false)
})

test('stardate: two-digit year, day of year, tenth of the day', async () => {
  expect(stardate(new Date(2026, 0, 1, 0, 0).getTime())).toBe('26001.0')
  expect(stardate(new Date(2026, 9, 6, 12, 0).getTime())).toBe('26279.5')
  expect(stardate(new Date(2026, 11, 31, 23, 59).getTime())).toBe('26365.9')
})

test('the log prompt is a plain working instruction', async () => {
  expect(/stardate|captain|diffling|starship/i.test(LOG_PROMPT)).toBe(false)
})

test('log lines drop blanks and are capped; the log keeps the newest entries', async () => {
  const reply = ['- one', '', '- two  ', ...Array.from({ length: 30 }, (_, i) => `- n${i}`)].join('\n')
  const lines = logLines(reply)
  expect(lines.slice(0, 2)).toEqual(['- one', '- two'])
  expect(lines.length).toBe(CAPTAINS_LOG.maxLines)
  let log: { at: number; stardate: string; lines: string[] }[] = []
  for (let i = 0; i < CAPTAINS_LOG.keep + 3; i++) log = appendLog(log, { at: i, stardate: 'x', lines: [] })
  expect(log.length).toBe(CAPTAINS_LOG.keep)
  expect(log[0]!.at).toBe(3)
})

test('report lines wrap at spaces instead of being cut', async () => {
  expect(wrap('- Added the export button to the invoice list page', 20)).toEqual(['- Added the export', '  button to the', '  invoice list page'])
  expect(wrap('short', 20)).toEqual(['short'])
  expect(wrap('averyveryverylongword', 10)).toEqual(['averyvery~'])
})
