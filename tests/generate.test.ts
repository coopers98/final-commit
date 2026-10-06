import { expect, test } from 'claude-code/testing'
import { GENERATION, TIERS } from '../src/config'
import { createRng } from '../src/rng'
import { type Complete, generateSystem, isBanned, parseReply } from '../src/world/generate'
import { validateSprite } from '../src/world/validate-art'

const ART = ['     .--.     ', '    ( oo )    ', '    /|==|\\    ', '   / |  | \\   ', '     |  |     ', '    /    \\    ', '   ~~    ~~   ']
const BAD_ART = ['too narrow']
const ANCHORS = { head: { x: 7, y: 0 }, neck: { x: 7, y: 2 }, hand: { x: 3, y: 3 }, orbit: { x: 12, y: 0 } }

const count = (slots: Record<string, number>) => Object.values(slots).reduce((a, b) => a + b, 0)
const FAUNA = count(GENERATION.faunaSlots)
const FLORA = count(GENERATION.floraSlots)

function species(i: number, stages: number, art: string[] = ART) {
  return { name: `Glimmer${String.fromCharCode(97 + (i % 26))}`, readout: 'Hums near vents.', behavior: 'Shy.', stages: Array(stages).fill(art), anchors: ANCHORS }
}

function reply(overrides: Partial<{ fauna: unknown[]; flora: unknown[]; system: unknown }> = {}) {
  return JSON.stringify({
    system: { name: 'Kessa Reach', starClass: 'K2V', lore: 'A quiet system.', biomes: [{ name: 'Ash Flats', description: 'Grey plains.' }] },
    fauna: Array.from({ length: FAUNA }, (_, i) => species(i, GENERATION.faunaStages)),
    flora: Array.from({ length: FLORA }, (_, i) => species(i, GENERATION.floraStages)),
    ...overrides,
  })
}

/** A fake model: answers each call from the list in order and records prompts. */
function fakeModel(answers: Array<{ ok: true; text: string } | { ok: false; reason: string }>) {
  const prompts: { system: string; prompt: string }[] = []
  const complete: Complete = async req => {
    prompts.push(req)
    return answers[Math.min(prompts.length - 1, answers.length - 1)]!
  }
  return { complete, prompts }
}

const EPIC = { key: 'NOVA-9', title: 'Rebuild billing export', description: 'Owner SSN 123-45-6789 must not leak.' }
const run = (complete: Complete, privacy: 'standard' | 'strict' | 'off' = 'standard') =>
  generateSystem({ epic: EPIC, systemId: 'sys1', privacy, complete, rng: createRng(1), now: 100 })

test('a good reply becomes a system with engine-assigned tiers', async () => {
  const { system, notes } = await run(fakeModel([{ ok: true, text: reply() }]).complete)
  expect(system.name).toBe('Kessa Reach')
  expect(system.epicKey).toBe('NOVA-9')
  expect(system.status).toBe('open')
  const fauna = system.species.filter(s => s.kind === 'fauna')
  expect(fauna.length).toBe(FAUNA)
  for (const t of TIERS) expect(fauna.filter(s => s.tier === t).length).toBe(GENERATION.faunaSlots[t])
  expect(system.species.every(s => !s.isProcedural)).toBe(true)
  expect(notes).toEqual([])
})

test('the prompt is filtered and never contains the epic key', async () => {
  const model = fakeModel([{ ok: true, text: reply() }])
  await run(model.complete)
  const sent = model.prompts[0]!.system + model.prompts[0]!.prompt
  expect(sent).not.toContain('123-45-6789')
  expect(sent).not.toContain('NOVA-9')
  expect(sent).toContain('Rebuild billing export')
})

test('the system prompt carries the trademark constraint', async () => {
  const model = fakeModel([{ ok: true, text: reply() }])
  await run(model.complete)
  expect(model.prompts[0]!.system).toContain('Starfleet')
})

test('JSON inside a code fence with prose around it still parses', async () => {
  const fence = '`'.repeat(3)
  expect(parseReply(`Here you go:\n${fence}json\n{"a": 1}\n${fence}\nEnjoy`)).toEqual({ a: 1 })
  expect(parseReply('no json here')).toBe(undefined)
  expect(parseReply('{"a": 1')).toBe(undefined)
})

test('a failed model call charts a fully procedural system', async () => {
  const { system, notes } = await run(fakeModel([{ ok: false, reason: 'api-error' }]).complete)
  expect(system.species.length).toBe(FAUNA + FLORA)
  expect(system.species.every(s => s.isProcedural)).toBe(true)
  expect(system.name.length > 0).toBe(true)
  expect(notes.join(' ')).toContain('api-error')
})

test('truncated JSON charts a procedural system', async () => {
  const { system, notes } = await run(fakeModel([{ ok: true, text: reply().slice(0, 200) }]).complete)
  expect(system.species.every(s => s.isProcedural)).toBe(true)
  expect(notes.length > 0).toBe(true)
})

test('too few species: missing slots are procedural', async () => {
  const text = reply({ fauna: [species(0, GENERATION.faunaStages)] })
  const { system } = await run(fakeModel([{ ok: true, text }, { ok: false, reason: 'x' }]).complete)
  const fauna = system.species.filter(s => s.kind === 'fauna')
  expect(fauna.length).toBe(FAUNA)
  expect(fauna.filter(s => !s.isProcedural).length).toBe(1)
})

test('bad art is retried in batches, then falls back, at most maxArtRetries extra calls', async () => {
  const fauna = Array.from({ length: FAUNA }, (_, i) => species(i, GENERATION.faunaStages, i === 0 ? BAD_ART : ART))
  const model = fakeModel([{ ok: true, text: reply({ fauna }) }, { ok: true, text: '{"species": []}' }])
  const { system } = await run(model.complete)
  expect(model.prompts.length).toBe(1 + 2)
  const first = system.species.find(s => s.id === 'sys1:f0')!
  expect(first.isProcedural).toBe(true)
  for (const s of first.stages) expect(validateSprite(s.rows)).toEqual({ ok: true })
})

test('a retry that returns good art is used', async () => {
  const fauna = Array.from({ length: FAUNA }, (_, i) => species(i, GENERATION.faunaStages, i === 0 ? BAD_ART : ART))
  const fixed = JSON.stringify({ species: [{ id: 'sys1:f0', stages: Array(GENERATION.faunaStages).fill(ART) }] })
  const model = fakeModel([{ ok: true, text: reply({ fauna }) }, { ok: true, text: fixed }])
  const { system } = await run(model.complete)
  expect(model.prompts.length).toBe(2)
  expect(system.species.find(s => s.id === 'sys1:f0')!.isProcedural).toBe(false)
})

test('banned, non-ASCII and overlong names are replaced', async () => {
  const fauna = Array.from({ length: FAUNA }, (_, i) => species(i, GENERATION.faunaStages))
  fauna[0] = { ...fauna[0]!, name: 'Starfleet Hound' }
  fauna[1] = { ...fauna[1]!, name: 'Ñandú' }
  fauna[2] = { ...fauna[2]!, name: 'X'.repeat(40) }
  const { system } = await run(fakeModel([{ ok: true, text: reply({ fauna }) }]).complete)
  for (const id of ['sys1:f0', 'sys1:f1', 'sys1:f2']) {
    expect(system.species.find(s => s.id === id)!.name).toMatch(/^[A-Z][a-z]{3,11}$/)
  }
})

test('banned terms are caught through separators and case, short words only whole', async () => {
  for (const t of ['Warpcore Beast', 'Star-Fleet Hound', 'HOLO deck', 'the gorn', 'Kirk Prime', 'Tri corder']) expect(isBanned(t)).toBe(true)
  for (const t of ['Target Moth', 'Border Crab', 'Shirk Beetle', 'Trekker']) expect(isBanned(t)).toBe(false)
})

test('a system name with a banned term is replaced', async () => {
  const text = reply({ system: { name: 'Holodeck Prime', starClass: 'G2V', lore: 'x', biomes: [] } })
  const { system } = await run(fakeModel([{ ok: true, text }]).complete)
  expect(system.name.toLowerCase()).not.toContain('holodeck')
})

test('fields of the wrong type do not crash', async () => {
  const text = reply({ fauna: [42, null, 'x', { name: 7, stages: 'no' }] })
  const { system } = await run(fakeModel([{ ok: true, text }, { ok: false, reason: 'x' }]).complete)
  expect(system.species.filter(s => s.kind === 'fauna').length).toBe(FAUNA)
})
