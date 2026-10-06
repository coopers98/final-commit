import { expect, test } from 'claude-code/testing'
import { STATUS } from '../src/config'
import { bayRows } from '../src/bridge/bay'
import { besideLines } from '../src/bridge/band'
import { chartingText, statusText } from '../src/bridge/status'
import { orphanedCharts } from '../src/runtime'
import type { StarSystem } from '../src/store/schema'

const system = { id: 'sys-1', epicKey: 'NOVA-1', name: 'Kessa Reach', species: [{ id: 'sys-1:f0', name: 'Glimmer' }] } as unknown as StarSystem
const mission = { issueKey: 'NOVA-142', systemId: 'sys-1', startedAt: 0, commits: 0, testRuns: 0, testsGreen: false, tacticalClean: false }
const pending = (tier: 'common' | 'legendary') => ({ id: 'e', systemId: 'sys-1', speciesId: 'sys-1:f0', tier, quality: 0, attempts: 0, createdAt: 0 })

test('status line shows the mission and the system', async () => {
  expect(statusText({ system, mission })).toBe('NOVA-142 · Kessa Reach')
})

test('status line is empty with nothing going on', async () => {
  expect(statusText({})).toBe(undefined)
})

test('a waiting encounter comes first, with its tier glyph, and is never cut', async () => {
  const text = statusText({ system, mission, pending: pending('legendary') })!
  expect(text.startsWith('★ /contain · NOVA-142')).toBe(true)
  expect([...text].length).toBeLessThanOrEqual(STATUS.maxColumns)
})

test('a waiting Common encounter is distinguishable from nothing waiting', async () => {
  expect(statusText({ system, pending: pending('common') })).toContain('/contain')
  expect(statusText({ system })).not.toContain('/contain')
})

test('long system names are cut to fit', async () => {
  const long = { ...system, name: 'The Exceptionally Long Named Cluster' } as StarSystem
  for (const s of [{ system: long }, { system: long, mission }, { system: long, mission, pending: pending('common') }]) {
    expect([...statusText(s)!].length).toBeLessThanOrEqual(STATUS.maxColumns)
  }
})

test('bay rows mark the companion and fit the width', async () => {
  const specimens = [
    { id: 'a', speciesId: 'sys-1:f0', systemId: 'sys-1', tier: 'common' as const, level: 1, xp: 0, stage: 0 as const, containedAt: 0 },
    { id: 'b', speciesId: 'gone', systemId: 'sys-1', tier: 'rare' as const, level: 3, xp: 0, stage: 0 as const, containedAt: 0, attachment: { class: 'minor' as const, item: 'scarf' } },
  ]
  const rows = bayRows(specimens, [system], 'b', 40)
  expect(rows[0]).toBe('  1 · Glimmer L1')
  expect(rows[1]).toBe('> 2 ◆ Unknown L3 +scarf')
  for (const r of bayRows(specimens, [system], null, 12)) expect([...r].length).toBeLessThanOrEqual(12)
})

test('empty bay', async () => {
  expect(bayRows([], [], null, 40)[0]).toContain('No specimens')
})

test('charting shows a turning spinner, the key and whole seconds', async () => {
  expect(chartingText('NOVA-1', 0)).toBe('| charting NOVA-1 0s')
  expect(chartingText('NOVA-1', 400)).toBe('/ charting NOVA-1 0s')
  expect(chartingText('NOVA-1', 42_000)).toBe('/ charting NOVA-1 42s')
  expect(chartingText('NOVA-1', 42_900)).toBe('\\ charting NOVA-1 42s')
})

test('charting comes after a waiting encounter and before the mission, within the width', async () => {
  const charting = { key: 'NOVA-1', elapsedMs: 5_000 }
  expect(statusText({ charting })).toBe('| charting NOVA-1 5s')
  const text = statusText({ system, mission, charting, pending: pending('common') })!
  // The waiting encounter wins the room; the charting text is cut, never the encounter.
  expect(text.startsWith('· /contain · | chart')).toBe(true)
  expect([...text].length).toBeLessThanOrEqual(STATUS.maxColumns)
})

test('a charting marker with nothing running behind it is an orphan', async () => {
  const entries = [{ key: 'NOVA-1', startedAt: 0 }, { key: 'NOVA-2', startedAt: 0 }]
  expect(orphanedCharts(entries, new Set(['NOVA-2']))).toEqual([{ key: 'NOVA-1', startedAt: 0 }])
  expect(orphanedCharts(entries, new Set(['NOVA-1', 'NOVA-2']))).toEqual([])
})

test('the band puts one fact per line beside the sprite, cut to the space left of it', async () => {
  const v = { name: 'Glornaxi Fernwhisker', tier: 'uncommon', mood: 'content', mission: 'NOVA-142' }
  expect(besideLines(v, 24)).toEqual(['Glornaxi Fernwhisker', 'uncommon', 'content', 'NOVA-142'])
  expect(besideLines(v, 8)).toEqual(['Glornaxi', 'uncommon', 'content', 'NOVA-142'])
  expect(besideLines({ ...v, mission: null }, 24)).toEqual(['Glornaxi Fernwhisker', 'uncommon', 'content'])
})
