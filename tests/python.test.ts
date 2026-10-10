import { expect, test } from 'claude-code/testing'
import { PUZZLE } from '../src/config'
import { createRng } from '../src/rng'
import { buildBugHunt } from '../src/puzzle/bug-hunt'
import { missionUnits } from '../src/puzzle/material'
import { filterPython, shownPythonLines } from '../src/puzzle/python-filter'
import { PY_ADAPTER, pythonFunctionName } from '../src/puzzle/units'

// SPEC 8.3 rule 2 and 8.4: the Python adapter. Invented code only (SPEC 15).

test('plain Python lines show as written; any line with a string, comment or backslash is blanked to its indent', async () => {
  const src = ['def total(xs):', '    t = 0', '    name = "Jane"  # owner', '    for x in xs:', '        t = t + x', '    return t'].join('\n')
  expect(filterPython(src, 'standard').split('\n')).toEqual(['def total(xs):', '    t = 0', '    …', '    for x in xs:', '        t = t + x', '    return t'])
  expect(filterPython(src, 'off')).toBe(src)
})

test('a docstring opened where nothing can hide it is followed to its close; the code after shows again', async () => {
  expect(shownPythonLines(['def f(x):', '    """Return x.', "    It's the patient Jane Roe's value.", '    """', '    return x'])).toEqual([true, false, false, false, true])
  expect(shownPythonLines(['def f(x):', "    '''One line.'''", '    return x'])).toEqual([true, false, true])
  expect(shownPythonLines(['def f(x):', '    r"""Raw docstring', '    """', '    return x'])).toEqual([true, false, false, true])
})

test('wherever the scan cannot be sure, the rest of the file is blanked', async () => {
  const unsure = [
    ['x = f"{a}', 'zqA', '"'],
    ['x = f"{y["k"]}"', 'zqB = 1'],
    ['x = "a" """', 'zqC', '"""'],
    ['x = 1 \\', 'zqD'],
    ['x = 1\rzqE = """', 'zqF', '"""'],
    ['s = """', 'zqG \\""" still inside', '"""'],
    ['s = """doc""" + "x"', 'zqH = 2'],
    ["x = 'unterminated", 'zqI'],
    ['x = f"""', 'zqJ', '"""'],
    // Security review: 3.14's template strings, and prefixes a later Python may add.
    ['y = t"{x # "', '} zqK {x', '}"'],
    ['y = T"{x # "', '}zqL{x', '}"'],
    ['x=1', 'y = t"""{x # """', '} zqM', '"""'],
    ['x = 1', 'y = t"""{', '"""', 'zqN', '"""}"""'],
    ['y = rt"""{', '"""', 'zqO = 1', '"""}"""'],
    ['y = q"{x # "', '} zqP {x', '}"'],
  ]
  for (const lines of unsure) {
    const out = filterPython(lines.join('\n'), 'standard')
    expect(/zq/.test(out)).toBe(false)
    expect(out.split('\n').length).toBe(lines.length)
  }
})

test('a # before any quote is a comment, even when it mentions a triple quote', async () => {
  expect(shownPythonLines(['# see """ below', 'x = 1'])).toEqual([false, true])
})

test('fuzz: Python strings and comments in any arrangement never leak', async () => {
  const pieces = [
    "'zqS'", '"zqS"', "'''zqS'''", '"""zqS"""', '"""', "'''", 'r"zqS"', 'b"zqS"', 'f"{zqS}"', 'f"zqS"', "f'''{a}", '# zqS', '"', "'",
    '\\', '\\\\', 'x = 1', 'def f(a):', '    return a', '(', ')', '{', '}', 'zz = 3', '\r', 'rb"\\"zqS"', "u'zqS\\''",
  ]
  const rng = createRng(20261010)
  for (let n = 0; n < 4000; n += 1) {
    const lines: string[] = []
    for (let l = 0, count = 1 + rng.int(5); l < count; l += 1) {
      const parts: string[] = []
      for (let k = 0, m = 1 + rng.int(4); k < m; k += 1) parts.push(rng.pick(pieces))
      lines.push(parts.join(' '))
    }
    const src = lines.join('\n')
    const out = filterPython(src, 'standard')
    if (/zq/.test(out)) throw new Error(`leak: ${JSON.stringify(src)} -> ${JSON.stringify(out)}`)
    expect(out.split('\n').length).toBe(src.split('\n').length)
  }
})

test('a file with a line over the limit is blanked whole', async () => {
  const out = filterPython(`x = 1\n${'a'.repeat(PUZZLE.maxLineChars + 1)}`, 'standard').split('\n')
  expect(out.every(l => l.trim() === '…')).toBe(true)
})

test('Python functions: a one-line def signature, the body by indentation, nested ones on their own', async () => {
  expect(pythonFunctionName('def total(xs: list[int]) -> int:')).toBe('total')
  expect(pythonFunctionName('    async def load(self, id):')).toBe('load')
  expect(pythonFunctionName('def long(a,')).toBe(undefined)
  expect(pythonFunctionName('x = 1')).toBe(undefined)
  const src = [
    'import os',
    '',
    'def first_over(xs, limit):',
    '    i = 0',
    '',
    '    while i < len(xs) and xs[i] <= limit:',
    '        i = i + 1',
    '    if i == len(xs):',
    '        return -1',
    '    return i',
    '',
    'def untouched(a):',
    '    b = a + 1',
    '    c = b * 2',
    '    return c',
  ].join('\n')
  const units = PY_ADAPTER.units(filterPython(src, 'standard'), new Set([7]))
  expect(units.map(u => u.name)).toEqual(['first_over'])
  expect(units[0]!.lines[0]).toBe('def first_over(xs, limit):')
  expect(units[0]!.lines.length).toBe(7)
  expect(units[0]!.lang).toBe('Python')
})

test('the Python adapter claims .py files only', async () => {
  for (const p of ['a.py', 'pkg/b.py']) expect(PY_ADAPTER.claims(p)).toBe(true)
  for (const p of ['a.pyi', 'a.pyc', 'a.ts', 'setup.cfg']) expect(PY_ADAPTER.claims(p)).toBe(false)
})

test('Bug Hunt in Python changes one Python operator; the last line can be the one', async () => {
  const unit = { lang: 'Python', name: 'f', lines: ['def f(xs, limit):', '    i = 0', '    while i < len(xs) and xs[i] <= limit:', '        i = i + 1', '    return i if i != 0 else -1'] }
  let lastSeen = false
  for (let seed = 0; seed < 60; seed += 1) {
    const p = buildBugHunt([unit], createRng(seed))!
    const diff = p.code.map((l, i) => (l === unit.lines[i] ? -1 : i)).filter(i => i >= 0)
    expect(diff.length).toBe(1)
    expect(p.choices[p.answer]).toBe(`Line ${diff[0]! + 1}`)
    expect(p.code[diff[0]!]).not.toMatch(/===|&&|\|\|/)
    if (diff[0] === unit.lines.length - 1) lastSeen = true
  }
  expect(lastSeen).toBe(true)
})

test('mission material reads a changed .py file through the Python filter', async () => {
  const py = ['def score(xs):', '    total = 0', '    note = "Jane Roe"', '    for x in xs:', '        total = total + x', '    return total'].join('\n')
  const io = {
    git: async (args: readonly string[]) => {
      if (args[0] === 'rev-list') return { exitCode: 0, stdout: 'abc\n' }
      if (args.includes('--raw')) return { exitCode: 0, stdout: ':100644 100644 a b M\0app/score.py\0' }
      return { exitCode: 0, stdout: 'diff --git a/app/score.py b/app/score.py\n+++ b/app/score.py\n@@ -5 +5 @@\n' }
    },
    read: async () => py,
  }
  const units = await missionUnits(io, 0, 'strict')
  expect(units.map(u => [u.lang, u.name])).toEqual([['Python', 'score']])
  expect(units[0]!.lines.join('\n')).not.toContain('Jane')
})

test('unit reading stays fast on deeply nested defs', async () => {
  const depth = 450
  const nested = Array.from({ length: depth }, (_, k) => `${' '.repeat(k)}def a():`).join('\n') + '\n' + Array.from({ length: 200 }, () => `${' '.repeat(depth)}x = 1`).join('\n')
  const at = Date.now()
  PY_ADAPTER.units(nested, new Set([depth + 1]))
  expect(Date.now() - at < 100).toBe(true)
})

test('a def inside a template string the scan cannot follow is never a unit', async () => {
  const src = 'x = t"""{\n"""\ndef zq_secret(a):\n    b = a + 1\n    c = b + 1\n    return c\n"""}"""'
  const units = PY_ADAPTER.units(filterPython(src, 'standard'), new Set([3, 4, 5, 6]))
  expect(units.some(u => u.name.startsWith('zq'))).toBe(false)
})
