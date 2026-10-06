import { LATTICE, LATTICE_SHARED, type Tier } from '../config'
import type { Rng } from '../rng'

// SPEC 7.3. Positions are fractions of the bar in [0, 1].

export type LatticeState = {
  tier: Tier
  locks: number
  sealed: number
  centerHits: number
  misses: number
  zoneStart: number
  zoneWidth: number
  position: number
  direction: 1 | -1
  sweepMs: number
  elapsedMs: number
  zoneVisible: boolean
  isDone: boolean
  /** False after a seal until the needle leaves the zone: one seal per pass, so mashing Space cannot win. */
  isArmed: boolean
}

export type PressResult = 'center' | 'hit' | 'miss'

const placeZone = (width: number, rng: Rng) => rng.next() * (1 - width)

function sweepFor(tier: Tier, rng: Rng): number {
  const base = LATTICE[tier].sweepMs
  if (LATTICE[tier].twist !== 'flicker') return base
  return base * (1 + LATTICE_SHARED.erraticJitter * (2 * rng.next() - 1))
}

export function createLattice(tier: Tier, rng: Rng): LatticeState {
  const { locks, zone } = LATTICE[tier]
  return {
    tier, locks, sealed: 0, centerHits: 0, misses: 0,
    zoneStart: placeZone(zone, rng), zoneWidth: zone,
    position: 0, direction: 1, sweepMs: sweepFor(tier, rng),
    elapsedMs: 0, zoneVisible: true, isDone: false, isArmed: true,
  }
}

export function advance(state: LatticeState, dtMs: number, rng: Rng): LatticeState {
  if (state.isDone || dtMs <= 0) return state
  const twist = LATTICE[state.tier].twist
  let { position, direction, sweepMs, zoneVisible } = state
  position += (direction * dtMs) / sweepMs
  while (position > 1 || position < 0) {
    if (position > 1) { position = 2 - position; direction = -1 }
    if (position < 0) { position = -position; direction = 1 }
    sweepMs = sweepFor(state.tier, rng)
  }
  if (twist === 'reverse' && rng.chance((LATTICE_SHARED.reverseChancePerSecond * dtMs) / 1000)) {
    direction = direction === 1 ? -1 : 1
  }
  const elapsedMs = state.elapsedMs + dtMs
  if (twist === 'flicker') {
    const period = LATTICE_SHARED.flickerPeriodMs
    if (Math.floor(elapsedMs / period) !== Math.floor(state.elapsedMs / period)) {
      zoneVisible = rng.chance(LATTICE_SHARED.flickerVisibleFraction)
    }
  }
  // Re-arm once the needle has left the zone; a step longer than the zone is wide must have left it.
  const isInZone = position >= state.zoneStart && position <= state.zoneStart + state.zoneWidth
  const travelled = dtMs / state.sweepMs
  return { ...state, position, direction, sweepMs, zoneVisible, elapsedMs, isArmed: state.isArmed || !isInZone || travelled >= state.zoneWidth }
}

export function press(state: LatticeState, offsetMs: number, rng: Rng): { state: LatticeState; result: PressResult } {
  if (state.isDone) return { state, result: 'miss' }
  const judged = Math.min(1, Math.max(0, state.position - (state.direction * offsetMs) / state.sweepMs))
  const zoneEnd = state.zoneStart + state.zoneWidth
  if (!state.isArmed || judged < state.zoneStart || judged > zoneEnd) {
    const broke = LATTICE[state.tier].twist === 'break' ? Math.max(0, state.sealed - 1) : state.sealed
    return { state: { ...state, misses: state.misses + 1, sealed: broke }, result: 'miss' }
  }
  const mid = state.zoneStart + state.zoneWidth / 2
  const isCenter = Math.abs(judged - mid) <= (state.zoneWidth * LATTICE_SHARED.centerFraction) / 2
  const sealed = state.sealed + 1
  const isDone = sealed >= state.locks
  const zoneStart = LATTICE[state.tier].twist === 'shift' && !isDone ? placeZone(state.zoneWidth, rng) : state.zoneStart
  return {
    state: { ...state, sealed, isDone, zoneStart, isArmed: false, centerHits: state.centerHits + (isCenter ? 1 : 0) },
    result: isCenter ? 'center' : 'hit',
  }
}

export function latticeBonus(state: LatticeState): number {
  const raw =
    (LATTICE_SHARED.lockBonusTotal * state.sealed) / state.locks +
    LATTICE_SHARED.centerHitBonus * state.centerHits -
    LATTICE_SHARED.missPenalty * state.misses
  return Math.min(LATTICE_SHARED.maxBonus, Math.max(0, raw))
}

export function renderBar(state: LatticeState): string {
  const n = LATTICE_SHARED.barCells
  const cells = Array.from({ length: n }, () => '-')
  if (state.zoneVisible) {
    const from = Math.floor(state.zoneStart * n)
    const to = Math.min(n - 1, Math.ceil((state.zoneStart + state.zoneWidth) * n) - 1)
    for (let i = from; i <= to; i += 1) cells[i] = '='
  }
  cells[Math.min(n - 1, Math.floor(state.position * n))] = '|'
  return `[${cells.join('')}]`
}

export function renderLocks(state: LatticeState): string {
  return `Locks [${'#'.repeat(state.sealed)}${'-'.repeat(state.locks - state.sealed)}]`
}
