import { QUALITY } from '../config'

/** Mission quality in [0, 1] (SPEC 6.2): tests passing and a clean Tactical review. */
export function missionQuality(m: { testsGreen: boolean; tacticalClean: boolean }): number {
  return (m.testsGreen ? QUALITY.testsGreenWeight : 0) + (m.tacticalClean ? QUALITY.tacticalCleanWeight : 0)
}
