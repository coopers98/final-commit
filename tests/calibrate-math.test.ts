import { expect, test } from 'claude-code/testing'
import { CALIBRATION } from '../src/config'
import { beatSchedule, clientKey, medianOffset } from '../src/contain/calibrate-math'

test('beat schedule has the configured count and spacing', async () => {
  const beats = beatSchedule()
  expect(beats.length).toBe(CALIBRATION.beats)
  expect(beats[1]! - beats[0]!).toBe(CALIBRATION.beatIntervalMs)
})

test('median of errors against the nearest beat', async () => {
  const beats = [0, 750, 1500, 2250]
  expect(medianOffset([120, 860, 1610, 2400], beats)).toBe(115)
})

test('one wild press does not move the median', async () => {
  const beats = [0, 750, 1500, 2250, 3000]
  expect(medianOffset([100, 850, 1600, 2350, 3370], beats)).toBe(100)
})

test('offset is clamped', async () => {
  expect(medianOffset([700], [0])).toBe(CALIBRATION.maxAbsOffsetMs)
})

test('no presses gives zero', async () => {
  expect(medianOffset([], [0, 750])).toBe(0)
})

test('client keys are stable and do not contain their inputs', async () => {
  const a = clientKey(['xterm-256color', '203.0.113.9'])
  expect(a).toBe(clientKey(['xterm-256color', '203.0.113.9']))
  expect(a).not.toBe(clientKey(['xterm-256color', '198.51.100.4']))
  expect(a).not.toContain('203.0.113.9')
})
