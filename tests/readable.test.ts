import { expect, test } from 'claude-code/testing'
import { PUZZLE_VIEW } from '../src/config'
import { isBlankedLine, isReadableLine, placeholderShare, readableUnit } from '../src/puzzle/readable'
import type { Unit } from '../src/puzzle/units'

// Invented content only (SPEC 15).

test('a blanked line holds a … and nothing but the punctuation the filters keep', async () => {
  expect(['…', '  …', '…;', '  } …', '(…),'].map(isBlankedLine)).toEqual([true, true, true, true, true])
  expect(['}', '', '  return total', "foo('…')", '[name] …'].map(isBlankedLine)).toEqual([false, false, false, false, false])
})

test('placeholder share counts words holding a filter token', async () => {
  expect(placeholderShare('')).toBe(0)
  expect(placeholderShare('take the [quoted] flag')).toBe(1 / 4)
  expect(placeholderShare('[name] [name] rules ([date])')).toBe(3 / 4)
  expect(placeholderShare('keys: [secret], [url]')).toBe(2 / 3)
})

test('a readable line is not blanked and at most a third placeholders', async () => {
  expect(isReadableLine('- Never remove the backup step.')).toBe(true)
  expect(isReadableLine('  …')).toBe(false)
  // 1 of 3 words: at the edge, readable.
  expect(isReadableLine('send [url] now')).toBe(true)
  // 2 of 4: past it.
  expect(isReadableLine('[name] sends [url] now')).toBe(false)
})

const unit = (lines: string[]): Unit => ({ lang: 'Markdown', name: 'Notes', lines })

test('readableUnit trims blanked lines from both ends, then re-checks the size', async () => {
  const u = unit(['## Notes', '- one fact here', '- two facts here', '- three facts here', '…', '…'])
  expect(readableUnit(u)!.lines).toEqual(['## Notes', '- one fact here', '- two facts here', '- three facts here'])
  // Four lines before trimming, three after: too small.
  expect(readableUnit(unit(['## Notes', '- one fact', '- two facts', '…']))).toBe(undefined)
  // Nothing to trim: the same unit back.
  const whole = unit(['## Notes', '- a', '- b', '- c'])
  expect(readableUnit(whole)).toBe(whole)
})

test('readableUnit skips a unit mostly blanked or mostly placeholders', async () => {
  // 3 of 6 blanked: at the edge (0.5), kept.
  expect(readableUnit(unit(['## Notes', '- a fact', '…', '…', '…', '- last fact']))).toBeDefined()
  // 4 of 7 blanked: past it.
  expect(readableUnit(unit(['## Notes', '- a fact', '…', '…', '…', '…', '- last fact']))).toBe(undefined)
  // Placeholder soup, as a strict prompt unit reads.
  expect(readableUnit(unit(['## [name] rules ([date])', '- A [quoted] gets [quoted]', '- [name] [quoted] [quoted]', '- [name] the [quoted] [quoted]']))).toBe(undefined)
  expect(PUZZLE_VIEW.maxPlaceholderShare).toBe(1 / 3)
})

test('code keeps its closing brace: a lone } is not trimmed', async () => {
  const code: Unit = { lang: 'TypeScript', name: 'f', lines: ['function f(a: number) {', '  const b = a + 1', '  return b', '}'] }
  expect(readableUnit(code)).toBe(code)
})
