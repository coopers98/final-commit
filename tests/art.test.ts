import { expect, test } from 'claude-code/testing'
import { createRng } from '../src/rng'
import { DEFAULT_ANCHORS, assembleSprite, proceduralName } from '../src/world/parts-library'
import { isSpriteChar, validateAnchors, validateSprite } from '../src/world/validate-art'

const good = [
  '     .--.     ',
  '    ( oo )    ',
  '    /|==|\\    ',
  '   / |  | \\   ',
  '     |  |     ',
  '    /    \\    ',
  '   ~~    ~~   ',
]

test('a 14x7 ASCII sprite passes', async () => {
  expect(validateSprite(good)).toEqual({ ok: true })
})

test('wrong row count fails', async () => {
  const r = validateSprite(good.slice(0, 6))
  expect(r.ok).toBe(false)
})

test('a row of the wrong width fails and names the row', async () => {
  const r = validateSprite([...good.slice(0, 6), 'too short'])
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.errors.join(' ')).toContain('row 7')
})

test('wide and ambiguous-width glyphs fail', async () => {
  for (const glyph of ['█', '─', '漢', '😀', '·']) {
    const rows = [...good]
    rows[0] = glyph + rows[0]!.slice(1)
    expect(validateSprite(rows).ok).toBe(false)
  }
})

test('tabs and control characters fail', async () => {
  const rows = [...good]
  rows[3] = '\t' + rows[3]!.slice(1)
  expect(validateSprite(rows).ok).toBe(false)
})

test('an empty silhouette fails', async () => {
  expect(validateSprite(Array(7).fill(' '.repeat(14))).ok).toBe(false)
})

test('non-array input fails without throwing', async () => {
  for (const bad of [null, undefined, 'abc', 42, [1, 2, 3], {}]) expect(validateSprite(bad).ok).toBe(false)
})

test('isSpriteChar accepts printable ASCII only', async () => {
  expect(isSpriteChar('a')).toBe(true)
  expect(isSpriteChar(' ')).toBe(true)
  expect(isSpriteChar('~')).toBe(true)
  expect(isSpriteChar('\u007f')).toBe(false)
  expect(isSpriteChar('é')).toBe(false)
})

test('anchors must lie inside the grid', async () => {
  expect(validateAnchors(DEFAULT_ANCHORS)).toEqual({ ok: true })
  expect(validateAnchors({ ...DEFAULT_ANCHORS, orbit: { x: 14, y: 0 } }).ok).toBe(false)
  expect(validateAnchors({ head: { x: 1, y: 1 } }).ok).toBe(false)
})

test('every procedural sprite validates, for 500 seeds and both kinds', async () => {
  for (let seed = 0; seed < 500; seed += 1) {
    for (const kind of ['fauna', 'flora'] as const) {
      const { stages, anchors } = assembleSprite(createRng(seed), kind, kind === 'fauna' ? 3 : 1)
      expect(stages.length).toBe(kind === 'fauna' ? 3 : 1)
      for (const s of stages) expect(validateSprite(s.rows)).toEqual({ ok: true })
      expect(validateAnchors(anchors)).toEqual({ ok: true })
    }
  }
})

test('evolution stages differ from each other', async () => {
  const { stages } = assembleSprite(createRng(4), 'fauna', 3)
  expect(stages[0]!.rows.join()).not.toBe(stages[1]!.rows.join())
  expect(stages[1]!.rows.join()).not.toBe(stages[2]!.rows.join())
})

test('procedural names are capitalized ASCII words of 4 to 12 letters', async () => {
  for (let seed = 0; seed < 200; seed += 1) {
    expect(proceduralName(createRng(seed))).toMatch(/^[A-Z][a-z]{3,11}$/)
  }
})
