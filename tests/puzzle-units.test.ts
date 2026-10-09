import { expect, test } from 'claude-code/testing'
import { filterCode, hasStrayQuote, stripLiterals } from '../src/puzzle/code-filter'
import { EMPTY_TREE, missionUnits, regularFiles } from '../src/puzzle/material'
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
  expect(filterCode(src, 'strict')).toBe('const id = lookup([id])\nconst host = "…"\nsend([email])')
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
  for (const p of ['a.ts', 'b.tsx', 'c.js', 'd.mjs', 'e.cts', 'f.jsx']) expect(TS_ADAPTER.claims(p)).toBe(true)
  for (const p of ['a.d.ts', 'b.php', 'c.md', 'tsconfig.json']) expect(TS_ADAPTER.claims(p)).toBe(false)
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

test('a line the scanner cannot account for is blanked whole, keeping its indent', async () => {
  expect(hasStrayQuote('const a = "…" + \'…\' + `…`')).toBe(false)
  expect(hasStrayQuote('const a = "…" + oops"leak')).toBe(true)
  expect(hasStrayQuote("  it's prose")).toBe(true)
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
  for (const l of ['  return <p>Call Jane</p>', '  <Header title={t} />', '  const s = ```', 'const el = (<div>', '  </div>']) expect(isUnsafeLine(l)).toBe(true)
  for (const l of ['  if (a < b && c > d) return a', '  const xs: Array<string> = []', '  return total', '  const f = (x: number) => x']) expect(isUnsafeLine(l)).toBe(false)
  const jsx = 'function Card(p: Props) {\n  const name = p.name\n  const n = name.length\n  return <p>Jane Roe</p>\n}'
  expect(TS_ADAPTER.units(jsx, new Set([2]))).toEqual([])
})
