import { expect, test } from 'claude-code/testing'
import { filterCode, isPlainLine, scanLiterals, shownLines, stripLiterals } from '../src/puzzle/code-filter'
import { createRng } from '../src/rng'
import { EMPTY_TREE, hasJsx, missionUnits, regularFiles } from '../src/puzzle/material'
import { blockEnd, changedLines, functionName, isSafePath, isUnsafeLine, TS_ADAPTER } from '../src/puzzle/units'

// Invented code only (SPEC 15).

test('literals are blanked and comments removed, line for line', async () => {
  const src = [
    'const greeting = "hello, world" // the greeting',
    "const name = 'Ada'",
    '/* a block',
    '   comment */ const x = `total: ${count}',
    'items`',
    'const url = "http://example.com/a//b"',
  ].join('\n')
  const out = stripLiterals(src).split('\n')
  expect(out).toEqual([
    'const greeting = "…"',
    "const name = '…'",
    '',
    ' const x = `…`',
    '',
    'const url = "…"',
  ])
})

test('the filter replaces value shapes left in code, and leaves code alone with the filter off', async () => {
  const src = 'const id = lookup(XJ482130)\nconst host = "db.internal"\nsend(ops@example.com)'
  expect(filterCode(src, 'strict')).toBe('const id = lookup([id])\n…\nsend([email])')
  expect(filterCode(src, 'off')).toBe(src)
  // A long string never shifts later lines.
  expect(filterCode('a("x\ny")\nb()', 'standard').split('\n').length).toBe(3)
})

test('changed lines are read from a zero-context diff, per file', async () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -3,0 +4,2 @@',
    '+x',
    '+y',
    '@@ -10 +12 @@',
    'diff --git a/old.ts b/old.ts',
    '--- a/old.ts',
    '+++ /dev/null',
    '@@ -1,3 +0,0 @@',
    'diff --git a/src/b.ts b/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -5,2 +5,0 @@',
  ].join('\n')
  const map = changedLines(diff)
  expect([...map.keys()]).toEqual(['src/a.ts'])
  expect([...map.get('src/a.ts')!]).toEqual([4, 5, 12])
})

test('function starts are recognized: declarations, arrows, methods; control flow is not', async () => {
  expect(functionName('export async function totalOf(items: Item[]): number {')).toBe('totalOf')
  expect(functionName('const pick = (list: string[]) => {')).toBe('pick')
  expect(functionName('export const sum = async <T>(xs: T[]): Promise<number> => {')).toBe('sum')
  expect(functionName('  private static parse(text: string): Result {')).toBe('parse')
  expect(functionName('  if (a < b) {')).toBe(undefined)
  expect(functionName('  for (const x of xs) {')).toBe(undefined)
  expect(functionName('const n = compute(1)')).toBe(undefined)
})

test('a block ends at its matching brace', async () => {
  expect(blockEnd(['function f() {', '  if (x) {', '  }', '}', 'g()'], 0)).toBe(3)
  expect(blockEnd(['function f() {', '  never closed'], 0)).toBe(undefined)
})

const FILE = [
  'import { x } from "./x"',
  '',
  'export function totalOf(items: number[]): number {',
  '  let total = 0',
  '  for (const n of items) {',
  '    if (n > 0) total += n',
  '  }',
  '  return total',
  '}',
  '',
  'function untouched(a: number) {',
  '  const b = a + 1',
  '  const c = b * 2',
  '  return c',
  '}',
  '',
  'const tiny = () => {',
  '  return 1',
  '}',
].join('\n')

test('the adapter keeps functions the diff touched, within the size limits, without blank lines or indent', async () => {
  const units = TS_ADAPTER.units(FILE, new Set([6, 18]))
  expect(units.map(u => u.name)).toEqual(['totalOf'])
  expect(units[0]!.lines[0]).toBe('export function totalOf(items: number[]): number {')
  expect(units[0]!.lines.length).toBe(7)
  expect(TS_ADAPTER.units(FILE, new Set([1]))).toEqual([])
})

test('the adapter claims TypeScript and JavaScript sources, not declarations or other files', async () => {
  for (const p of ['a.ts', 'e.cts', 'f.mts']) expect(TS_ADAPTER.claims(p)).toBe(true)
  for (const p of ['a.d.ts', 'b.tsx', 'f.jsx', 'c.js', 'd.mjs', 'g.cjs', 'b.php', 'c.md', 'tsconfig.json']) expect(TS_ADAPTER.claims(p)).toBe(false)
})

test('mission material: the diff against the last commit before the start, read and filtered per claimed file', async () => {
  const calls: string[][] = []
  const files: Record<string, string> = { 'src/total.ts': FILE.replace('let total = 0', 'let total = 0 // owner: ops@example.com') }
  const io = (base: string) => ({
    git: async (args: readonly string[]) => {
      calls.push([...args])
      if (args[0] === 'rev-list') return { exitCode: 0, stdout: base }
      if (args.includes('--raw')) return { exitCode: 0, stdout: ':100644 100644 aaa bbb M\0src/total.ts\0:100644 100644 ccc ddd M\0README.md\0' }
      return { exitCode: 0, stdout: 'diff --git a/src/total.ts b/src/total.ts\n+++ b/src/total.ts\n@@ -5 +6 @@\ndiff --git a/README.md b/README.md\n+++ b/README.md\n@@ -1 +1 @@\n' }
    },
    read: async (path: string) => files[path],
  })
  const units = await missionUnits(io('abc123\n'), Date.UTC(2026, 0, 2), 'strict')
  expect(units.map(u => u.name)).toEqual(['totalOf'])
  expect(units[0]!.lines.join('\n')).not.toContain('example.com')
  expect(calls[0]).toEqual(['rev-list', '-1', '--before=2026-01-02T00:00:00.000Z', 'HEAD'])
  expect(calls[1]!.at(-1)).toBe('abc123')
  expect(calls[2]).toContain('--no-textconv')
  expect(calls[2]!.slice(0, 2)).toEqual(['-c', 'core.fsmonitor=false'])
  // No commit before the start: everything since the repository began.
  calls.length = 0
  await missionUnits(io(''), 0, 'strict')
  expect(calls[1]!.at(-1)).toBe(EMPTY_TREE)
})

test('mission material: outside a repository there is none', async () => {
  const io = { git: async () => ({ exitCode: 128, stdout: '' }), read: async () => undefined }
  expect(await missionUnits(io, 0, 'strict')).toEqual([])
})

// Security review findings (FC-15): each one a test.

test('a quote inside a regular expression never lets a later string through', async () => {
  const secrets = [
    "s.split(/'/).join('apikey SECRETVALUE patient Jane')",
    'x.replace(/"/g, "Acme Hospital internal password hunter2")',
    'const re = /acme-payroll-secret/i',
    'if (ok) return /[/"]x/.test(s) && "Jane Roe"',
  ]
  for (const line of secrets) {
    const out = filterCode(line, 'standard')
    for (const word of ['SECRETVALUE', 'Jane', 'Acme', 'hunter2', 'payroll']) expect(out).not.toContain(word)
  }
  expect(stripLiterals('const re = /a"b/g; const t = "Jane"')).toBe('const re = /…/; const t = "…"')
  // Division stays code.
  expect(stripLiterals('const half = total / 2 / count')).toBe('const half = total / 2 / count')
})

test('a line the scanner cannot be sure of is blanked whole, keeping its indent', async () => {
  // Second security review: each of these once let a literal's contents through.
  const leaks: [string, string[]][] = [
    ['const r = counts[k]! / total; log("/patients/JaneDoe/chart")', ['JaneDoe', 'patients']],
    ['n = i++ / 2; s = "hello / SECRETB tail"', ['SECRETB']],
    ['if (ok) /"/.test(a), y = "SECRET_A text"', ['SECRET_A']],
    ["s = `${ '}' + `INNER_SECRET` } tail`", ['INNER_SECRET']],
    ['x = a\n  / "q/w" + "SECRETC"', ['SECRETC']],
    ['const s = "line one \\\nSECRETD continues"', ['SECRETD']],
  ]
  for (const [src, words] of leaks) {
    const out = filterCode(src, 'standard')
    for (const w of words) expect(out).not.toContain(w)
    expect(out.split('\n').length).toBe(src.split('\n').length)
  }
  expect(filterCode('    if (ok) /x/.test(a)', 'standard')).toBe('    …')
  // Sure lines stay readable.
  expect(scanLiterals('const half = total / 2\nconst re = /a"b/g').uncertain.size).toBe(0)
})

test('control characters never reach the pane or a prompt, in any mode', async () => {
  const esc = 'const a = 1\u001b[31m\r\nconst b = 2\u0007'
  for (const mode of ['strict', 'standard', 'off'] as const) {
    const out = filterCode(esc, mode)
    expect(/[\u0000-\u0008\u000b-\u001f\u007f]/.test(out)).toBe(false)
    expect(out.split('\n').length).toBe(2)
  }
})

test('a changed line that looks like a file header cannot name a file', async () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,0 +2,1 @@',
    '+++ /home/someone/other/billing.ts',
    '@@ -10,0 +12,30 @@',
  ].join('\n')
  const map = changedLines(diff)
  expect([...map.keys()]).toEqual(['src/a.ts'])
  expect(map.get('src/a.ts')!.has(12)).toBe(true)
})

test('only relative, plain paths inside the folder are read', async () => {
  for (const p of ['src/a.ts', 'a.ts']) expect(isSafePath(p)).toBe(true)
  for (const p of ['/etc/x.ts', '../x.ts', 'src/../../x.ts', '"src/we\\"ird.ts"', 'C:/x.ts', '']) expect(isSafePath(p)).toBe(false)
})

test('the raw listing keeps regular files added or modified: no symlinks, submodules or deletions', async () => {
  const raw = [
    ':100644 100644 a b M', 'src/ok.ts',
    ':000000 100755 a b A', 'bin/new.js',
    ':120000 120000 a b M', 'src/link.ts',
    ':160000 160000 a b M', 'vendor/sub',
    ':100644 000000 a b D', 'src/gone.ts',
    ':100644 100644 a b M', '../escape.ts',
  ].join('\0') + '\0'
  expect([...regularFiles(raw)]).toEqual(['src/ok.ts', 'bin/new.js'])
})

test('a symlink the diff names is never read', async () => {
  let reads = 0
  const io = {
    git: async (args: readonly string[]) => {
      if (args[0] === 'rev-list') return { exitCode: 0, stdout: 'abc\n' }
      if (args.includes('--raw')) return { exitCode: 0, stdout: ':120000 120000 a b M\0src/total.ts\0' }
      return { exitCode: 0, stdout: 'diff --git a/src/total.ts b/src/total.ts\n+++ b/src/total.ts\n@@ -0,0 +1 @@\n' }
    },
    read: async () => (reads += 1, FILE),
  }
  expect(await missionUnits(io, 0, 'standard')).toEqual([])
  expect(reads).toBe(0)
})

test('units with JSX or a code fence are never taken', async () => {
  for (const l of ['  return <p>Call Jane</p>', '  <Header title={t} />', '  const s = ```', 'const el = (<div>', '  </div>', '    <>', '    </>', '    </…/']) expect(isUnsafeLine(l)).toBe(true)
  for (const l of ['  if (a < b && c > d) return a', '  const xs: Array<string> = []', '  return total', '  const f = (x: number) => x']) expect(isUnsafeLine(l)).toBe(false)
  const jsx = 'function Card(p: Props) {\n  const name = p.name\n  const n = name.length\n  return <p>Jane Roe</p>\n}'
  expect(TS_ADAPTER.units(jsx, new Set([2]))).toEqual([])
})

// Third security review: every counterexample, then a seeded fuzz over the
// constructs that broke earlier versions. Sentinels must never survive.

const COUNTEREXAMPLES = [
  'export default /zq4/',
  'export default /zq5 is secret/g',
  'class A extends /zq13/.constructor {}',
  "const r = obj.of / 2, p = '/', s = 'zq1' // '",
  'let of = 4; const r = of / 2, p = "/\'", s = \'zq3\' // \'',
  'if (c.in / a - (a) - c.in) arr[0] /* zq1 ` */',
  'x = (a) / 2; s = "/`";\ny = 1; t = `\nzq6 // `;',
  "x = `${ '}' + `b//` }\nzq7\n`",
  'x = `${ /* } */ `b//` }\nzq8\n`',
  'r = obj.of / 2 + `/`\nq = 3; u = `\nzq14 // `',
  'x = 1 <!-- zq1 secret html comment',
  'x = 1\n--> zq2 tail',
  'const r = counts[k]! / total; log("/patients/zqJane/chart")',
  'n = i++ / 2; s = "hello / zqB tail"',
  'if (ok) /"/.test(a), y = "zqA text"',
  'const s = "line one \\\nzqD continues"',
  '/* open\nzqC\n*/ zqE()',
  'a = "x" /* still open\nzqF\n',
  'x = 1 /* c */ y = 2 /* zqG',
  // Fourth review.
  "a = '`'; b = `start\nzqH words\nend`",
  'a = "`"; b = `s\nzqI\ne`',
  'r = /`/; b = `s\nzqJ\ne`',
  '/* ` */ b = `s\nzqK\ne`',
  "const files = glob('src/**/*.sql')\nconst q = `\n  SELECT name FROM t /* idx hint\n  */\n  WHERE zqL = 1\n`",
  "x = '/*'\nq = `\n/* a\n*/\nzqM\n`",
  '// see /*\nq = `\n*/\nzqN\n`',
  '#!node zqO words\nconst a = 1',
  // Fifth review.
  '// note\rb = `\nzqP plain\n`\n',
  'a = 1 // note\rb = `start\nzqQ words here\n`\n',
  'x = 1 // c\r/* x\nzqR words\n*/\n',
  'x = 1 <!-- /* note\nv = `start */\nzqS2 words here\n`\n',
  'x = 1\n--> /* note\nv = `start */\nzqT words here\n`\n',
  // Sixth review.
  '#!/usr/bin/env node\r/*\nzqU patient words\n*/',
  '#!/usr/bin/env node\rconst t = `\nzqV words\n`',
  '#!/usr/bin/env node\u2028/*\nzqW\n*/',
  // Seventh review.
  '\uFEFF#!node zqX words\nconst a = 1',
  'const el = < a title="\n  zqY Jane Roe\n" / //c\n>',
]

test('none of the reviews\' counterexamples leaks a sentinel, and line counts hold', async () => {
  for (const src of COUNTEREXAMPLES) {
    for (const mode of ['strict', 'standard'] as const) {
      const out = filterCode(src, mode)
      expect(/zq/.test(out)).toBe(false)
      expect(out.split('\n').length).toBe(src.split('\n').length)
    }
  }
})

test('fuzz: literals and comments in any arrangement never leak', async () => {
  const pieces = [
    // A regex only where the grammar makes one (after an identifier, a slash is a division and its neighbors are code).
    "'zqS'", '"zqS"', '`zqS`', '`a${b}zqS`', '`${ "}" }zqS`', '= /zqS/g', '(/[/"]zqS/', '// zqS', '/* zqS */', '/* zqS', '*/',
    'a / b', 'x! / y', 'i++ / 2', '(a) / 2', 'obj.of / 2', '; return /zqS/', '; default /zqS/', '<!-- zqS', '-->', '\\',
    '`', '"', "'", '/', '{', '}', '(', ')', ';', 'x = 1', '<p>zqS</p>', '<>zqS</>', '\u2028', 'const q = 3',
  ]
  const rng = createRng(20261008)
  for (let n = 0; n < 4000; n += 1) {
    const lines: string[] = []
    const count = 1 + rng.int(4)
    for (let l = 0; l < count; l += 1) {
      const parts: string[] = []
      for (let k = 0, m = 1 + rng.int(5); k < m; k += 1) parts.push(rng.pick(pieces))
      lines.push(parts.join(' '))
    }
    const src = lines.join('\n')
    const out = filterCode(src, 'standard')
    if (/zq/.test(out)) throw new Error(`leak: ${JSON.stringify(src)} -> ${JSON.stringify(out)}`)
    expect(out.split('\n').length).toBe(src.split('\n').length)
  }
})

test('plain code shows as written; blanked lines keep their braces', async () => {
  expect(isPlainLine('  const half = total / 2 / count')).toBe(true)
  expect(isPlainLine('  return a / b')).toBe(true)
  expect(isPlainLine('  return /x/.test(s)')).toBe(false)
  expect(isPlainLine('  x = xs[0] / 2')).toBe(true)
  expect(filterCode('function f(a: number) {\n  if (a === "x") {\n    return 1\n  }\n}', 'standard').split('\n')).toEqual([
    'function f(a: number) {', '  …{', '    return 1', '  }', '}',
  ])
  // A one-line JSDoc comment is fine; code after a comment's end is not trusted.
  expect(shownLines(['/** doc */', 'const a = 1'])).toEqual([false, true])
  expect(shownLines(['/**', ' * text', ' */', 'const a = 1'])).toEqual([false, false, false, true])
  expect(shownLines(['/* c', '*/ const a = 1', 'const b = 2'])).toEqual([false, false, true])
  expect(shownLines(['/* c', "*/ x = 'a'", 'const b = 2'])).toEqual([false, false, false])
  // Comments with quotes or backticks are just comments: the scan stays sure.
  expect(shownLines(["/** The player's `cell` */", '// uses `x` and "y"', 'const c = 3'])).toEqual([false, false, true])
  expect(shownLines(['x = a // `odd', 'const d = 4'])).toEqual([false, true])
})

test('blanked lines carry only spaces, tabs, braces and the blank mark', async () => {
  const out = filterCode('\u000b\u000c\u2028x = "a" {\n\t y = \'b\' }', 'standard')
  for (const line of out.split('\n')) expect(/^[ \t]*[{}]*…[{}]*$/.test(line)).toBe(true)
})

test('a file with JSX gives no units, even outside .tsx and .jsx', async () => {
  const src = 'function Card(n: number) {\n  const a = n + 1\n  const b = a + 2\n  return (\n    <p>\n      Jane Roe was admitted\n    </p>\n  )\n}'
  expect(TS_ADAPTER.units(filterCode(src, 'standard'), new Set([2]))).toEqual([])
})

test('JSX is found in the code as written, quoted attributes and closing tags included', async () => {
  expect(hasJsx('const el = (\n  <p title="card">\n    Jane Roe was admitted\n  </p>\n)')).toBe(true)
  expect(hasJsx('return <>x</>')).toBe(true)
  expect(hasJsx('const br = <br/>')).toBe(true)
  expect(hasJsx('if (a < b && c > d) return a\nconst xs: Array<number> = []')).toBe(false)
})

test('JSX in a .js file is found in any spelling: after an arrow, in brackets, with space before the slash', async () => {
  expect(hasJsx('const el = () => <p>\n  Jane\n< /p>', 'src/card.js')).toBe(true)
  expect(hasJsx('const xs = [<li>\n  Ann\n<\n/li>]', 'src/list.mjs')).toBe(true)
  expect(hasJsx('if (a < b && c > d) return a', 'src/x.js')).toBe(false)
  // In TypeScript, generics are types, not tags.
  expect(hasJsx('const xs: Array<number> = []\nfunction f<T>(x: T) {}', 'src/x.ts')).toBe(false)
})

test('braces from inside a literal never show on a blanked line', async () => {
  expect(filterCode("x = class extends /a'/.constructor { m() { return '{{{ secret }}}' } }", 'standard')).not.toContain('{{{')
})

test('a file with a minified line is blanked whole, fast', async () => {
  const src = `const a = 1\n${'a/'.repeat(64_000)}\nconst b = 2`
  const at = Date.now()
  const out = filterCode(src, 'standard').split('\n')
  expect(Date.now() - at < 1_000).toBe(true)
  expect(out.every(l => l.trim() === '…')).toBe(true)
  expect(out.length).toBe(3)
})

test('braces from inside literals never show, even where a scan misreads', async () => {
  for (const src of [
    'x = 1 // c\ry = `\n}}{{\n`',
    'x = 1 // c\u2028y = `\n{{}}\n`',
    '#!node `\nconst y = `\n{ x }}\n`',
    "let of = 4\nx = of / 2; s = '/{{'; // '",
  ]) {
    const out = filterCode(src, 'standard').split('\n')
    // Only the first line of each may keep braces of its own; none of these has any.
    for (const line of out.slice(1)) expect(/[{}]/.test(line)).toBe(false)
  }
})

test('the filter and unit reading stay fast on hostile shapes within the size limits', async () => {
  const time = (f: () => unknown) => {
    const at = Date.now()
    f()
    return Date.now() - at
  }
  const many = Array.from({ length: 131 }, () => `${'a'.repeat(999)}+${'b/'.repeat(499)}`).join('\n')
  expect(time(() => filterCode(many, 'standard')) < 3_000).toBe(true)
  const regexes = '(/a/'.repeat(60_000)
  expect(time(() => filterCode(regexes.replace(/(.{1900})/g, '$1\n'), 'standard')) < 3_000).toBe(true)
  expect(time(() => hasJsx('\n'.repeat(262_143), 'src/x.ts')) < 1_000).toBe(true)
  const sig = Array.from({ length: 130 }, () => `const a = b :${' '.repeat(1980)}`).join('\n')
  expect(time(() => TS_ADAPTER.units(sig, new Set([1]))) < 2_000).toBe(true)
  const openers = 'function a(){\n'.repeat(9_000) + '}\n'.repeat(9_000)
  expect(time(() => TS_ADAPTER.units(openers, new Set([1]))) < 2_000).toBe(true)
})

test('eighth review: a guessed regex hiding a quote ends trust; HTML-like comments keep no braces; signatures stay fast at the cap', async () => {
  for (const src of [
    'const el = (a) / < b c="\n  zqZ1 Jane Roe }\n" / //c\n>',
    'const el = of / < b c="\n  zqZ2 Jane Roe }\n"',
  ]) expect(/zq/.test(filterCode(src, 'standard'))).toBe(false)
  for (const src of ['function f() {\n  x = 1 <!-- } { {\n  y = 2\n}', 'x = 1\n--> }}} {\ny = 2']) {
    const out = filterCode(src, 'standard').split('\n')
    expect(out.filter(l => l.includes('…')).every(l => !/[{}]/.test(l))).toBe(true)
  }
  const at = Date.now()
  const pad = (head: string) => head + ' '.repeat(299 - head.length)
  for (let k = 0; k < 300; k += 1) for (const head of ['const a = b :', 'foo(a, b) :', 'const a = (x) :']) functionName(pad(head))
  expect(Date.now() - at < 1_000).toBe(true)
  expect(functionName('const pick = (list: string[]) => {')).toBe('pick')
  expect(functionName('export const sum = async <T>(xs: T[]): Promise<number> => {')).toBe('sum')
  expect(functionName('const n = (a: number) => a + 1')).toBe(undefined)
  expect(functionName('  private static parse(text: string): Result {')).toBe('parse')
})

test('ninth review: a slash after a type\'s closing > is unsure; callbacks are not units; a triple-slash directive is not JSX', async () => {
  for (const src of ["const y = x as Array<number> / 2; const s = '/{'; // '", "const y = x as Array<number> / 2; const s = '/}}'; // '", "const y = f<string> / 2, r = /a{/, z = 1 / 2"]) {
    expect(/[{}]/.test(filterCode(src, 'standard'))).toBe(false)
  }
  expect(functionName("test('x', async () => {")).toBe(undefined)
  expect(functionName("on('x', async ($, e, next) => {")).toBe(undefined)
  expect(functionName('const kept = plan.tasks.filter(t => {')).toBe(undefined)
  expect(functionName('const pick = (list: string[]) => {')).toBe('pick')
  expect(functionName('const twice = x => {')).toBe('twice')
  expect(functionName('  async load(id: number): Promise<void> {')).toBe('load')
  expect(hasJsx('/// <reference path="./types.d.ts" />\nconst a: Array<number> = []', 'src/a.ts')).toBe(false)
  const at = Date.now()
  for (let k = 0; k < 900; k += 1) for (const head of ['static', 'a', 'const a = b :']) functionName(`${head}${' '.repeat(297 - head.length)}{`)
  expect(Date.now() - at < 1_000).toBe(true)
})
