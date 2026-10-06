import { CALIBRATION } from '../config'

/** Beat times in ms from the start of calibration. */
export function beatSchedule(): number[] {
  return Array.from({ length: CALIBRATION.beats }, (_, i) => (i + 1) * CALIBRATION.beatIntervalMs)
}

/** Median signed error between each press and its nearest beat, clamped. */
export function medianOffset(presses: number[], beats: number[]): number {
  if (presses.length === 0 || beats.length === 0) return 0
  const errors = presses
    .map(p => beats.reduce((best, b) => (Math.abs(p - b) < Math.abs(p - best) ? b : best), beats[0]!))
    .map((beat, i) => presses[i]! - beat)
    .sort((a, b) => a - b)
  const mid = Math.floor(errors.length / 2)
  const median = errors.length % 2 === 1 ? errors[mid]! : (errors[mid - 1]! + errors[mid]!) / 2
  const max = CALIBRATION.maxAbsOffsetMs
  return Math.max(-max, Math.min(max, median))
}

/** FNV-1a hash of the parts: identifies a client without storing what identifies it. */
export function clientKey(parts: string[]): string {
  let h = 0x811c9dc5
  for (const ch of parts.join('\u0000')) {
    h ^= ch.codePointAt(0)!
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
