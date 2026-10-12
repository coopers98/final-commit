import { expect, test } from 'claude-code/testing'
import { PUZZLE } from '../src/config'
import { createRng } from '../src/rng'
import { buildBugHunt, mutationSites, mutationsFor } from '../src/puzzle/bug-hunt'
import { filterMarkdown, shownMarkdownLines } from '../src/puzzle/markdown-filter'
import { missionUnits } from '../src/puzzle/material'
import { buildPatternId, checkerPrompt, generatorPrompt, PATTERN_CATEGORIES } from '../src/puzzle/pattern-id'
import { runnable } from '../src/puzzle/trace-gate'
import { ADAPTERS, headingName, MD_ADAPTER, type Unit } from '../src/puzzle/units'
import type { Complete } from '../src/world/generate'

// SPEC 8.3 rule 2 and 8.4: the Markdown adapter. Invented content only (SPEC 15).

const md = (...lines: string[]) => lines.join('\n')
const filter = (src: string, mode: 'standard' | 'strict' | 'off' = 'standard') => filterMarkdown(src, mode).split('\n')

test('prose lines go through the prose filter; with the filter off they are as written', async () => {
  const src = md('# Rollout', 'Ask Kessa Vane before the cutover.', 'See https://example.com/plan or mail ops@example.com about NOVA-12.')
  expect(filter(src, 'strict')).toEqual(['# [name]', '[name] [name] [name] before the cutover.', '[name] [url] or mail [email] about [key].'])
  expect(filter(src, 'standard')).toEqual(['# Rollout', 'Ask Kessa Vane before the cutover.', 'See [url] or mail [email] about [key].'])
  expect(filterMarkdown(src, 'off')).toBe(src)
})

test('fenced code is blanked, fence lines included, for backticks, tildes and longer fences', async () => {
  expect(filter(md('Intro', '```ts', 'const zqA = 1', '```', 'After'))).toEqual(['Intro', '…', '…', '…', 'After'])
  expect(filter(md('~~~', 'zqB', '~~~', 'After'))).toEqual(['…', '…', '…', 'After'])
  // A closer must be the same character and at least as long.
  expect(filter(md('````', '```', 'zqC', '~~~~', '````', 'After'))).toEqual(['…', '…', '…', '…', '…', 'After'])
  expect(filter(md('~~~', 'zqD', '~~~~~', 'After'))).toEqual(['…', '…', '…', 'After'])
  // A fence in a list item closes at its own column.
  expect(filter(md('- step', '  ```', '  zqE', '  ```', 'After'))).toEqual(['- step', '  …', '  …', '  …', 'After'])
  // Blank lines inside stay empty.
  expect(filter(md('```', '', 'zqF', '```'))).toEqual(['…', '', '…', '…'])
})

test('an unclosed fence, front matter or HTML comment blanks the rest of the file', async () => {
  for (const src of [
    md('Intro', '```', 'zqA', '', '# zqB', 'zqC'),
    md('---', 'title: zqA', '', '# zqB', 'zqC'),
    md('Intro', '<!-- zqA', '', '# zqB', 'zqC'),
    md('<script>', 'zqA', '', '# zqB'),
  ]) {
    const out = filterMarkdown(src, 'standard')
    expect(/zq/.test(out)).toBe(false)
    expect(out.split('\n').length).toBe(src.split('\n').length)
  }
})

test('a closer a renderer could read as a new opener never closes a fence', async () => {
  // Left of a list item's fence (the item ended), at another quote depth, or indented past the fence.
  for (const src of [
    md('- step', '  ```', '  code', '```', 'zqA'),
    md('> ```', '> code', '```', 'zqB'),
    md('```', 'code', '    ```', 'zqC'),
    md('> ```', 'zqD', '> ```', 'zqE'),
  ]) expect(/zq/.test(filterMarkdown(src, 'standard'))).toBe(false)
})

test('a line that is one whole comment is blanked alone; any other comment blanks the rest of the file', async () => {
  expect(filter(md('<!-- zqA -->', 'Next'))).toEqual(['…', 'Next'])
  expect(filter(md('Plan <!-- zqA --> text', 'Next'))).toEqual(['…', '…'])
  expect(filter(md('<!--', 'zqB', '-->', 'Next'))).toEqual(['…', '…', '…', '…'])
  expect(filter(md('a <!-- x --> b <!-- zqC', 'zqD -->', 'Next'))).toEqual(['…', '…', '…'])
})

test('front matter is blanked to its close, YAML or TOML; only on the first line', async () => {
  expect(filter(md('---', 'owner: zqA', '---', '# Plan'))).toEqual(['…', '…', '…', '# Plan'])
  expect(filter(md('---', 'owner: zqA', '...', 'Text'))).toEqual(['…', '…', '…', '…'])
  expect(filter(md('+++', 'owner = zqB', '+++', 'Text'))).toEqual(['…', '…', '…', 'Text'])
  expect(filter(md('Text', '---', 'More'))).toEqual(['Text', '---', 'More'])
})

test('indented code is blanked where it cannot continue a paragraph', async () => {
  expect(filter(md('Intro', '', '    zqA = 1', '    zqB = 2', '', '\tzqC', 'Back'))).toEqual(['Intro', '', '    …', '    …', '', '\t…', 'Back'])
  expect(filter(md('# Head', '    zqD'))).toEqual(['# Head', '    …'])
  // A line is shown only when no tab or run of four spaces comes before its text: two-space nesting shows, four-space does not.
  expect(filter(md('- item', '  - nested', '    - deeper'))).toEqual(['- item', '  - nested', '    …'])
})

test('a line that starts with a tag, or holds a raw-text element, blanks the rest of the file', async () => {
  expect(filter(md('<div>', 'zqA', '', 'Back'))).toEqual(['…', '…', '', '…'])
  expect(filter(md('<pre>', 'zqB', '', 'zqC', '</pre>', 'Back'))).toEqual(['…', '…', '', '…', '…', '…'])
  expect(filter(md('- <span>zqD</span>', '', 'Back'))).toEqual(['…', '', '…'])
})

test('a fence marker the scan cannot account for blanks the rest of the file', async () => {
  expect(filter(md('Use ```zqA``` here', 'Next'))).toEqual(['…', '…'])
  expect(filter(md('``` info with ` tick', 'Next'))).toEqual(['…', '…'])
})

test('the security review\'s counterexamples: code a renderer shows never reads as prose', async () => {
  // A long lowercase secret the prose filter would let through.
  const S = 'db_password = zq' + 'x'.repeat(90)
  const cases: string[][] = [
    ['```', 'x', '   ```', '```', S, '```'], // A: a closer right of the opener's column
    ['- item', '    ```', '    a', '     ```', '    ```', '  ' + S, '  ```'], // B: the same in a list
    ['>\t```', '> ' + S, '>\t```'], // C: a tab after the quote marker
    ['- item', '', '    ```', '  ' + S, '    ```'], // D: a fence inside a list item
    ['text <!--', '```', '-->', S, '```'], // E: a fence that interrupts an inline comment
    ['<3 notes', '```', '', S, '```'], // F: no HTML block, so a fence
    ['+++', '```', '+++', S, '```'], // L: front matter a renderer may not know
    ['\uFEFF```', S, '```'], // G: a byte order mark before the fence
    ['***', '    ' + S], // H: after a thematic break
    ['Title', '===', '    ' + S], // I: after a setext underline
    ['>', '    ' + S], // J: after an empty quote line
    ['[a]: /x', '    ' + S], // K: after a link reference definition
    ['| a | b |', '| --- | --- |', '    ' + S], // a table delimiter row
  ]
  for (const lines of cases) for (const mode of ['standard', 'strict'] as const) expect(/zq/.test(filterMarkdown(lines.join('\n'), mode))).toBe(false)
})

test('the second review\'s counterexamples: no tab or four-space run before a line\'s text, and no fence opened past one', async () => {
  const S = 'db_password = zq' + 'x'.repeat(90)
  const cases: string[][] = [
    ['-     ' + S], ['1.     ' + S], ['-\t\t' + S], // M: a list item that starts with indented code
    ['para', '>     ' + S], ['> para', '> >     ' + S], ['para', '-     ' + S], // N: a new container line
    ['   >\t  ' + S], // O: a tab after the quote marker
    ['- ***', '      ' + S], ['- [a]: /x', '      ' + S], // P: after a break or a definition in a list item
    ['   >\t ```', '>  ```', '> ' + S, '>  ```'], // Q: a fence opened past a tab
    ['| a | b |', '|---|---|', '| 1 | 2 |', '    ' + S], // R: after a table body row
  ]
  for (const lines of cases) for (const mode of ['standard', 'strict'] as const) expect(/zq/.test(filterMarkdown(lines.join('\n'), mode))).toBe(false)
})

test('the third review\'s counterexamples: HTML after any markers, and comments inside an HTML block, are never shown', async () => {
  const S = 'var dbpw = zq' + 'x'.repeat(90)
  const cases: string[][] = [
    ['- > <script>', '  > ' + S, '  > </script>'], // T: a quote after a list marker
    ['1. > <pre>', '   > ' + S, '   > </pre>'], // T2
    ['> - > <script>', '>   > ' + S], // V
    ['<script>', '<!--', '-->', S, '</script>'], // U: a comment does not end a script block
    ['<div>', '<!--', '-->', S, '</div>'], // U2: nor a block that ends at a blank line
    ['<textarea>', '<!-- -->', '<!--', '-->', S, '</textarea>'], // U3
  ]
  for (const lines of cases) for (const mode of ['standard', 'strict'] as const) expect(/zq/.test(filterMarkdown(lines.join('\n'), mode))).toBe(false)
})

test('the fourth review\'s counterexamples: HTML the scan does not follow blanks the rest of the file', async () => {
  const S = 'var dbpw = zq' + 'x'.repeat(90)
  const cases: string[][] = [
    ['<script><!--', '-->', S, '</script>'], ['<pre><!-- -->', S, '</pre>'], ['<div><!-- -->', S, '', 'x' + S], // W
    ['<3 notes', '<script>', '', S, '</script>'], ['para', '<span>', '<style>', '', S, '</style>'], ['<div>', '<pre>', '', S, '</pre>'], // X
    ['text <!--', '<script>', '-->', '', S, '</script>'], ['text <!--', '<div>', '-->', S], // Y
  ]
  for (const lines of cases) for (const mode of ['standard', 'strict'] as const) expect(/zq/.test(filterMarkdown(lines.join('\n'), mode))).toBe(false)
  // A line that is one whole comment is blanked alone; inline tags and a `<` in prose stay prose.
  expect(filter(md('<!-- toc -->', 'After'))).toEqual(['…', 'After'])
  expect(filter(md('- <!-- note --> ', 'After'))).toEqual(['…', 'After'])
  expect(filter(md('Use <b>bold</b> and Map<string> here', '<3 notes', 'After'))).toEqual(['Use <b>bold</b> and Map<string> here', '<3 notes', 'After'])
  expect(filter(md('Text <script>x</script>', 'After'))).toEqual(['…', '…'])
})

test('the fifth review\'s counterexamples: HTML in front matter, split code spans, inline code elements', async () => {
  const S = 'var dbpw = zq' + 'x'.repeat(90)
  const cases: string[][] = [
    ['---', '<script>', '---', S, '</script>'], // front matter a renderer reads as Markdown
    ['---', 'title: x', '...', S], // `...` does not close it here: the rest is blanked
    ['Set `db_password =', 'zqhunter2pw` here'], // a code span over two lines
    ['text <code>' + S + '</code> more'], ['press <kbd>' + S + '</kbd>'], // inline code elements
    ['use ``' + S + '`` here'], // a double-backtick span
  ]
  for (const lines of cases) for (const mode of ['standard', 'strict'] as const) expect(/zq/.test(filterMarkdown(lines.join('\n'), mode))).toBe(false)
  // Backticks a renderer skips (escaped, in an autolink, in a tag) cannot be counted: such a line blanks the rest.
  for (const lines of [
    ['Note \\`a `db_password = zqhunter', 'two_secret` b \\`'],
    ['see <http://a`b> `db_password = zqhunter', 'more` <http://c`d>'],
    ['a <b title="`">x</b> `db_password = zqhunter', 'more` <i title="`">y</i>'],
  ]) for (const mode of ['standard', 'strict'] as const) expect(/zq|secret/.test(filterMarkdown(lines.join('\n'), mode))).toBe(false)
  // A span's opening backtick is never taken by the quote or URL rule first.
  for (const line of ['Run "b ` x" db_password = zqhunter2pw ` end', 'See http://x`y db_password = zqhunter2pw ` z'])
    for (const mode of ['standard', 'strict'] as const) expect(/zq/.test(filterMarkdown(line, mode))).toBe(false)
  // A single-backtick span closed on its line is quoted by the prose filter and the line shows.
  expect(filter(md('Run `npm test` first', 'After'))).toEqual(['Run [quoted] first', 'After'])
  expect(filter(md('Use ``a`` here', 'After'))).toEqual(['…', 'After'])
})

test('a long run of dotted words before an at sign is read in linear time', async () => {
  const line = 'a.'.repeat(990) + '@'
  const started = Date.now()
  filterMarkdown(Array(130).fill(line).join('\n'), 'standard')
  expect(Date.now() - started).toBeLessThan(1_000)
})

test('a long line of spaces and dashes is read in linear time, in every mode', async () => {
  const line = '-' + ' \t'.repeat(130_000) + 'x'
  for (const mode of ['standard', 'strict', 'off'] as const) {
    const started = Date.now()
    filterMarkdown(md('Intro', line, 'After'), mode)
    MD_ADAPTER.units(filterMarkdown(md('# Head', line, 'After'), mode), new Set([1, 2, 3]))
    expect(Date.now() - started).toBeLessThan(500)
  }
})

test('a heading ending in a line separator is read in linear time', async () => {
  const line = '#' + ' '.repeat(100_000) + '\u2028'
  const started = Date.now()
  headingName(line)
  expect(Date.now() - started).toBeLessThan(500)
})

test('control characters are removed; line breaks the split does not see blank the rest', async () => {
  expect(filter(md('Ready\u0007 now', 'Next'))).toEqual(['Ready now', 'Next'])
  for (const brk of ['\r', '\u2028', '\u2029', '\u000b', '\u000c', '\u0085']) {
    const src = `Intro${brk}\`\`\`\nzqA\n\`\`\``
    const out = filterMarkdown(src, 'standard')
    expect(/zq/.test(out)).toBe(false)
    expect(out.split('\n').length).toBe(3)
  }
})

test('line count is kept, CRLF included; a line over the limit is blanked', async () => {
  const src = 'One\r\n```\r\ncode\r\n```\r\nTwo\r\n'
  const out = filterMarkdown(src, 'standard')
  expect(out.split('\n')).toEqual(['One', '…', '…', '…', 'Two', ''])
  const long = 'a'.repeat(PUZZLE.maxLineChars + 1)
  // A line too long to read cheaply blanks the rest of the file.
  expect(filter(md('Short', long, 'After'))).toEqual(['Short', '…', '…'])
})

test('fuzz: a fence at the file start, or an HTML comment anywhere, never shows whatever follows', async () => {
  const pieces = ['```', '~~~', '````', '<!--', '-->', '---', '    ', '> ', '- ', '<div>', '', 'text', '# Head', '\t', '`', '<pre>', '</pre>', '\r', '1. ']
  const rng = createRng(20261012)
  for (let n = 0; n < 3000; n += 1) {
    const lines: string[] = []
    for (let l = 0, count = 1 + rng.int(8); l < count; l += 1) {
      const parts: string[] = []
      for (let k = 0, m = 1 + rng.int(3); k < m; k += 1) parts.push(rng.pick(pieces))
      lines.push(parts.join(''))
    }
    // A secret in a fence that opens the file (anything after cannot reach back), and one in an inline comment.
    const at = rng.int(lines.length + 1)
    lines.splice(at, 0, `text <!-- zqC --> text`)
    const src = ['```', 'zqF', '```', ...lines].join('\n')
    const shown = shownMarkdownLines(src.split('\n'))
    expect(shown[1]).toBe(false)
    expect(shown[at + 3]).toBe(false)
    expect(filterMarkdown(src, 'standard').split('\n').length).toBe(src.split('\n').length)
  }
})

const DOC = md(
  'Preamble that is not a section.',
  'Setext title',
  '============',
  '',
  '# Payments plan',
  '',
  'We must ship the ledger first.',
  'Reads are allowed before the cutover.',
  'The batch size can increase later.',
  '',
  '## Rollout ##',
  'Enable the flag for staff.',
  'Then add the rest of the users.',
  'Errors above the minimum page the team.',
  'A rollback is always possible.',
  '',
  '## Tiny',
  'One line.',
)

test('sections run from an ATX heading to the next of any level; closing hashes go', async () => {
  expect(headingName('## Rollout ##')).toBe('Rollout')
  expect(headingName('# C# notes')).toBe('C# notes')
  expect(headingName('#nohash')).toBe(undefined)
  expect(headingName('##')).toBe('')
  expect(headingName('    # code')).toBe(undefined)
  const all = new Set(DOC.split('\n').map((_, k) => k + 1))
  const units = MD_ADAPTER.units(filterMarkdown(DOC, 'off'), all)
  // The preamble, the tiny section and the setext heading give no unit.
  expect(units.map(u => u.name)).toEqual(['Payments plan', 'Rollout'])
  expect(units[0]!.lines).toEqual(['# Payments plan', 'We must ship the ledger first.', 'Reads are allowed before the cutover.', 'The batch size can increase later.'])
  expect(units[0]!.lang).toBe('Markdown')
  // Only the touched section.
  expect(MD_ADAPTER.units(filterMarkdown(DOC, 'off'), new Set([13])).map(u => u.name)).toEqual(['Rollout'])
  expect(MD_ADAPTER.units(filterMarkdown(DOC, 'off'), new Set([1]))).toEqual([])
})

test('a section over the size limit, or with an empty or blanked heading, gives no unit', async () => {
  const long = md('# Long', ...Array.from({ length: PUZZLE.unitMaxLines + 1 }, (_, k) => `Line ${k}.`))
  expect(MD_ADAPTER.units(long, new Set([2]))).toEqual([])
  const empty = md('#', 'a', 'b', 'c', 'd')
  expect(MD_ADAPTER.units(empty, new Set([2]))).toEqual([])
  const fenced = md('```', '# zqA', '```', 'b', 'c', 'd')
  expect(MD_ADAPTER.units(filterMarkdown(fenced, 'standard'), new Set([2, 4]))).toEqual([])
})

test('the Markdown adapter claims .md and .markdown, not .mdx', async () => {
  for (const p of ['README.md', 'docs/plan.markdown']) expect(MD_ADAPTER.claims(p)).toBe(true)
  for (const p of ['a.mdx', 'a.md.ts', 'a.txt']) expect(MD_ADAPTER.claims(p)).toBe(false)
  expect(ADAPTERS.includes(MD_ADAPTER)).toBe(true)
})

const flipOf = (line: string) => mutationsFor('Markdown').flatMap(m => mutationSites(m, line).map(s => line.slice(0, s.at) + m.to + line.slice(s.at + s.length)))

test('contradictions flip whole lowercase words, each category both ways', async () => {
  expect(flipOf('we must ship')).toEqual(['we must not ship'])
  expect(flipOf('we must not ship')).toEqual(['we must ship'])
  expect(flipOf('it should  not fail')).toEqual(['it should fail'])
  expect(flipOf('it can run')).toEqual(['it cannot run'])
  expect(flipOf('it cannot run')).toEqual(['it can run'])
  expect(flipOf("it can't run")).toEqual([])
  expect(flipOf('it can not run')).toEqual([])
  expect(flipOf('always on')).toEqual(['never on'])
  expect(flipOf('set to true')).toEqual(['set to false'])
  expect(flipOf('run after the job')).toEqual(['run before the job'])
  expect(flipOf('the last step')).toEqual(['the first step'])
  expect(flipOf('fewer rows')).toEqual(['more rows'])
  expect(flipOf('decrease it')).toEqual(['increase it'])
  expect(flipOf('the maximum')).toEqual(['the minimum'])
  expect(flipOf('below it')).toEqual(['above it'])
  expect(flipOf('disable it')).toEqual(['enable it'])
  expect(flipOf('remove it')).toEqual(['add it'])
  expect(flipOf('deny it')).toEqual(['allow it'])
  expect(flipOf('optional field')).toEqual(['required field'])
  // Word boundaries only; lowercase only; not hyphenated.
  for (const line of ['the address', 'Must ship', 'enabled', 'canary', 'first-class', 'MORE', 'scan', 'allowed']) expect(flipOf(line)).toEqual([])
  expect(new Set(mutationsFor('Markdown').map(m => m.category))).toEqual(new Set(['negation', 'order', 'quantity', 'scope']))
})

test('TypeScript and Python mutations are unchanged: plain text, overlapping places counted', async () => {
  const lt = mutationsFor('TypeScript').find(m => m.from === ' < ')!
  expect(mutationSites(lt, 'a < < b')).toEqual([{ at: 1, length: 3 }, { at: 3, length: 3 }])
  expect(mutationsFor('TypeScript').some(m => m.match)).toBe(false)
  expect(mutationsFor('Python').some(m => m.match)).toBe(false)
})

const SECTION: Unit = {
  lang: 'Markdown',
  name: 'Rollout',
  lines: ['## Rollout', 'Enable the flag for staff.', '…', 'Then add the rest of the users.', 'Errors above the limit page the team.', 'A rollback is always possible.', '42'],
}

test('Bug Hunt on a section: one contradiction in one body line, the question says so', async () => {
  for (let seed = 0; seed < 40; seed += 1) {
    const p = buildBugHunt([SECTION], createRng(seed))!
    const diff = p.code.map((l, i) => (l === SECTION.lines[i] ? -1 : i)).filter(i => i >= 0)
    expect(diff.length).toBe(1)
    expect(p.choices[p.answer]).toBe(`Line ${diff[0]! + 1}`)
    expect(p.question).toBe('One line was changed to contradict the document. Which one?')
    // Never the heading, a blanked line or one without a letter.
    for (const c of ['Line 1', 'Line 3', 'Line 7']) expect(p.choices.includes(c)).toBe(false)
    expect(['negation', 'order', 'quantity', 'scope'].includes(p.category)).toBe(true)
    expect(p.explanation).toContain(SECTION.lines[diff[0]!]!.trim())
  }
  // Code keeps its own question.
  const ts: Unit = { lang: 'TypeScript', name: 'f', lines: ['function f(a: number) {', '  if (a === 1) a()', '  b()', '  c()', '  d()', '}'] }
  expect(buildBugHunt([ts], createRng(1))!.question).toBe('One line was changed to bring in a bug. Which one?')
})

test('Pattern ID prompts for a section ask about its approach; code keeps its wording', async () => {
  const g = generatorPrompt(SECTION)
  expect(g).toContain('Here is a section of a Markdown document.')
  expect(g).toContain('which approach or strategy this section mainly takes')
  expect(g).not.toContain('function')
  expect(checkerPrompt(SECTION, 'Q?', ['a', 'b', 'c', 'd'])).toContain('a section of a Markdown document')
  const code: Unit = { lang: 'TypeScript', name: 'f', lines: ['function f() {', '}'] }
  expect(generatorPrompt(code)).toContain('Here is a TypeScript function.')
  expect(generatorPrompt(code)).toContain('which pattern or technique this function mainly uses')
  for (const c of ['phased rollout', 'fallback', 'migration', 'trade-off', 'incremental delivery', 'feature flag']) expect((PATTERN_CATEGORIES as readonly string[]).includes(c)).toBe(true)
  const systems: string[] = []
  const complete: Complete = async req => {
    systems.push(req.system)
    return { ok: false, reason: 'offline' }
  }
  await buildPatternId([SECTION], createRng(1), complete)
  expect(systems[0]).toContain('plan or design document')
})

test('Trace never takes a Markdown section', async () => {
  expect(runnable({ lang: 'Markdown', name: 'f', lines: ['function f(n: number) {', '  return n', '}'] })).toBe(undefined)
})

test('mission material reads a changed .md file through the Markdown filter', async () => {
  const doc = md('# Ledger plan', 'Owner: Kessa Vane.', 'We must migrate first.', '```', 'const zqSecret = 1', '```', 'Then remove the old table.')
  const io = {
    git: async (args: readonly string[]) => {
      if (args[0] === 'rev-list') return { exitCode: 0, stdout: 'abc\n' }
      if (args.includes('--raw')) return { exitCode: 0, stdout: ':100644 100644 a b M\0docs/ledger.md\0' }
      return { exitCode: 0, stdout: 'diff --git a/docs/ledger.md b/docs/ledger.md\n+++ b/docs/ledger.md\n@@ -3 +3 @@\n' }
    },
    read: async () => doc,
  }
  const units = await missionUnits(io, 0, 'strict')
  expect(units.map(u => [u.lang, u.name])).toEqual([['Markdown', '[name] plan']])
  const text = units[0]!.lines.join('\n')
  expect(text).not.toContain('Kessa')
  expect(text).not.toContain('zqSecret')
  expect(units[0]!.lines).toContain('[name] must migrate first.')
})
