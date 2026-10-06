import { expect, test } from 'claude-code/testing'
import { LATTICE_SHARED } from '../src/config'
import { advance, createLattice, latticeBonus, press, renderBar, renderLocks } from '../src/contain/lattice-model'
import { createRng } from '../src/rng'

/** Moves a fresh common lattice's needle to fraction x of the bar (no twist, 2000 ms sweep). */
function needleAt(x: number, seed = 1) {
  const rng = createRng(seed)
  const s = createLattice('common', rng)
  return { rng, state: advance(s, x * s.sweepMs, rng) }
}

test('a new lattice starts at the left, unsealed, zone inside the bar', async () => {
  for (let seed = 0; seed < 200; seed += 1) {
    const s = createLattice('rare', createRng(seed))
    expect(s.position).toBe(0)
    expect(s.sealed).toBe(0)
    expect(s.zoneStart >= 0 && s.zoneStart + s.zoneWidth <= 1).toBe(true)
  }
})

test('the needle moves at sweepMs per bar and bounces', async () => {
  const { state, rng } = needleAt(0.5)
  expect(Math.abs(state.position - (0.5))).toBeLessThan(1e-9)
  const bounced = advance(state, 0.75 * state.sweepMs, rng)
  expect(Math.abs(bounced.position - (0.75))).toBeLessThan(1e-9)
  expect(bounced.direction).toBe(-1)
})

test('a press at the zone center seals with a center hit', async () => {
  const rng = createRng(2)
  let s = createLattice('common', rng)
  const center = s.zoneStart + s.zoneWidth / 2
  s = advance(s, center * s.sweepMs, rng)
  const r = press(s, 0, rng)
  expect(r.result).toBe('center')
  expect(r.state.sealed).toBe(1)
  expect(r.state.isDone).toBe(true)
})

test('a press outside the zone misses and changes nothing else', async () => {
  const rng = createRng(3)
  let s = createLattice('uncommon', rng)
  const outside = s.zoneStart > 0.5 ? s.zoneStart / 2 : (s.zoneStart + s.zoneWidth + 1) / 2
  s = advance(s, outside * s.sweepMs, rng)
  const r = press(s, 0, rng)
  expect(r.result).toBe('miss')
  expect(r.state.sealed).toBe(0)
  expect(r.state.misses).toBe(1)
})

test('latency offset judges the press where the needle was earlier', async () => {
  const rng = createRng(4)
  let s = createLattice('common', rng)
  const center = s.zoneStart + s.zoneWidth / 2
  const lateByMs = 300
  // The needle has moved on by 300 ms; without compensation this would be judged off-center.
  s = advance(s, center * s.sweepMs + lateByMs, rng)
  expect(press(s, lateByMs, rng).result).toBe('center')
})

test('legendary: a miss breaks one sealed lock', async () => {
  const rng = createRng(5)
  let s = createLattice('legendary', rng)
  s = { ...s, sealed: 2 }
  const outside = s.zoneStart > 0.5 ? s.zoneStart / 2 : (s.zoneStart + s.zoneWidth + 1) / 2
  s = { ...s, position: outside, direction: 1 }
  expect(press(s, 0, rng).state.sealed).toBe(1)
})

test('rare: the zone moves after each sealed lock', async () => {
  const rng = createRng(6)
  let s = createLattice('rare', rng)
  const before = s.zoneStart
  s = { ...s, position: s.zoneStart + s.zoneWidth / 2, direction: 1 }
  const r = press(s, 0, rng)
  expect(r.result).not.toBe('miss')
  expect(r.state.zoneStart).not.toBe(before)
})

test('exotic: the needle reverses mid-bar at least once in 10 seconds', async () => {
  const rng = createRng(7)
  let s = createLattice('exotic', rng)
  let midReversal = false
  for (let t = 0; t < 10_000; t += LATTICE_SHARED.frameMs) {
    const next = advance(s, LATTICE_SHARED.frameMs, rng)
    if (next.direction !== s.direction && next.position > 0.05 && next.position < 0.95) midReversal = true
    s = next
  }
  expect(midReversal).toBe(true)
})

test('anomaly: the zone is hidden some of the time', async () => {
  const rng = createRng(8)
  let s = createLattice('anomaly', rng)
  let hidden = 0
  for (let t = 0; t < 10_000; t += LATTICE_SHARED.frameMs) {
    s = advance(s, LATTICE_SHARED.frameMs, rng)
    if (!s.zoneVisible) hidden += 1
  }
  expect(hidden > 0).toBe(true)
})

test('mashing: a second press before the needle leaves the zone misses', async () => {
  const rng = createRng(10)
  let s = createLattice('anomaly', rng)
  s = { ...s, position: s.zoneStart + s.zoneWidth / 2, direction: 1 }
  const first = press(s, 0, rng)
  expect(first.result).not.toBe('miss')
  const second = press(first.state, 0, rng)
  expect(second.result).toBe('miss')
  expect(second.state.sealed).toBe(1)
})

test('the needle re-arms after leaving the zone', async () => {
  const rng = createRng(11)
  let s = createLattice('uncommon', rng)
  s = { ...s, position: s.zoneStart + s.zoneWidth / 2, direction: 1 }
  s = press(s, 0, rng).state
  expect(s.isArmed).toBe(false)
  s = advance(s, s.sweepMs, rng) // a full sweep: out to the edge and back
  expect(s.isArmed).toBe(true)
})

test('misses cost bonus, never below zero', async () => {
  const s = createLattice('rare', createRng(9))
  expect(Math.abs(latticeBonus({ ...s, sealed: 3, centerHits: 0, misses: 2 }) - 0.14)).toBeLessThan(1e-9)
  expect(latticeBonus({ ...s, sealed: 0, centerHits: 0, misses: 9 })).toBe(0)
})

test('bonus: locks plus center hits, capped', async () => {
  const s = createLattice('rare', createRng(9))
  expect(Math.abs(latticeBonus({ ...s, sealed: 3, centerHits: 0 }) - (0.2))).toBeLessThan(1e-9)
  expect(Math.abs(latticeBonus({ ...s, sealed: 3, centerHits: 1 }) - (0.22))).toBeLessThan(1e-9)
  expect(latticeBonus({ ...s, sealed: 3, centerHits: 9 })).toBe(LATTICE_SHARED.maxBonus)
})

test('the bar is fixed-width ASCII with one needle', async () => {
  const { state } = needleAt(0.3)
  const bar = renderBar(state)
  expect(bar.length).toBe(LATTICE_SHARED.barCells + 2)
  expect(bar).toMatch(/^\[[-=|]+\]$/)
  expect(bar.split('|').length - 1).toBe(1)
})

test('a hidden zone draws no zone cells', async () => {
  const { state } = needleAt(0.3)
  expect(renderBar({ ...state, zoneVisible: false })).not.toContain('=')
})

test('locks render as sealed and open marks', async () => {
  const s = createLattice('legendary', createRng(1))
  expect(renderLocks({ ...s, sealed: 1 })).toBe('Locks [#---]')
})
