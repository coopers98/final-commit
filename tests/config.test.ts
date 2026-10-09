import { expect, test } from 'claude-code/testing'
import { ATTACHMENT_ODDS, CONTAINMENT_CAP, LATTICE, SPRITE, TIERS, TIER_SPECS } from '../src/config'
import { sendsCode } from '../src/runtime'

test('tier encounter odds sum to 1', async () => {
  const sum = TIERS.reduce((s, t) => s + TIER_SPECS[t].encounterOdds, 0)
  expect(Math.abs(sum - 1) < 1e-9).toBe(true)
})

test('attachment odds sum to 1', async () => {
  const sum = Object.values(ATTACHMENT_ODDS).reduce((s, x) => s + x, 0)
  expect(Math.abs(sum - 1) < 1e-9).toBe(true)
})

test('every tier has a one-character glyph and a label', async () => {
  for (const t of TIERS) {
    expect([...TIER_SPECS[t].glyph].length).toBe(1)
    expect(TIER_SPECS[t].label.length > 0).toBe(true)
  }
})

test('every tier has Lattice parameters', async () => {
  for (const t of TIERS) expect(LATTICE[t].locks >= 1).toBe(true)
})

test('spec constants', async () => {
  expect(SPRITE.cols).toBe(14)
  expect(SPRITE.rows).toBe(7)
  expect(CONTAINMENT_CAP).toBe(0.98)
})

test('code goes to a model only with puzzles on and a filter other than strict', async () => {
  expect(sendsCode({ puzzles: 'on', privacyMode: 'standard' })).toBe(true)
  expect(sendsCode({ puzzles: 'on', privacyMode: 'off' })).toBe(true)
  expect(sendsCode({ puzzles: 'on', privacyMode: 'strict' })).toBe(false)
  expect(sendsCode({ puzzles: 'local', privacyMode: 'standard' })).toBe(false)
  expect(sendsCode({ puzzles: 'off', privacyMode: 'off' })).toBe(false)
})
