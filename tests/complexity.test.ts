import { expect, test } from 'claude-code/testing'
import { missionUnits, type MaterialIo } from '../src/puzzle/material'
import { add, factor, hiddenScan, isInert, mul, ONE, readCost, simplify, treeByBraces, treeByIndent, type Factor } from '../src/puzzle/complexity'

// Invented code only (SPEC 15).

const f = (size: string, at: number, kind: Factor['kind'] = 'loop', log = false, what = `loop over ${size}`): Factor => ({ size, log, kind, at, what })

test('nested loops over one input read O(n²), sequential ones keep the dominant term', async () => {
  const nested = mul(factor(f('items', 2)), factor(f('items', 3)))
  expect(readCost(nested, [], 0)?.answer).toBe('O(n²)')
  expect(readCost(add(nested, factor(f('items', 6))), [], 0)?.answer).toBe('O(n²)')
})

test('n log n is dominated by n², but n² and n·m are not comparable and fail', async () => {
  const sort = mul(factor(f('items', 1, 'sort', false, 'sort of items')), factor(f('items', 1, 'sort', true, 'sort of items')))
  const sq = mul(factor(f('items', 2)), factor(f('items', 3)))
  expect(readCost(add(sort, sq), [], 0)?.answer).toBe('O(n²)')
  const nm = mul(factor(f('items', 5)), factor(f('ids', 6)))
  expect(readCost(add(sq, nm), [], 0)).toBe(undefined)
})

test('two inputs: product is n·m, sum is n + m, n is the first size in line order', async () => {
  const r = readCost(mul(factor(f('ids', 4)), factor(f('items', 2))), [], 0)
  expect(r?.answer).toBe('O(n·m)')
  expect(r?.n).toBe('items')
  expect(r?.m).toBe('ids')
  expect(readCost(add(factor(f('items', 2)), factor(f('ids', 5))), [], 0)?.answer).toBe('O(n + m)')
})

test('a constant cost, a third size, or n² log n is no reading', async () => {
  expect(readCost(ONE, [], 0)).toBe(undefined)
  expect(readCost(mul(mul(factor(f('a', 1)), factor(f('b', 2))), factor(f('c', 3))), [], 0)).toBe(undefined)
  const sq = mul(factor(f('a', 1)), factor(f('a', 2)))
  expect(readCost(mul(sq, factor(f('a', 3, 'halving', true))), [], 0)).toBe(undefined)
})

test('an answer in one size names it n', async () => {
  const r = readCost(factor(f('ids', 3)), [], 0)
  expect(r?.answer).toBe('O(n)')
  expect(r?.n).toBe('ids')
  expect(r?.m).toBe(undefined)
})

test('category: halving, sorting, hidden linear call, two inputs, nested loops, linear scan, by precedence', async () => {
  const halving = mul(factor(f('a', 1)), factor(f('a', 2, 'halving', true)))
  expect(readCost(halving, [], 0)?.category).toBe('halving')
  const sorting = mul(factor(f('a', 1, 'sort')), factor(f('a', 1, 'sort', true)))
  expect(readCost(sorting, [], 0)?.category).toBe('sorting')
  expect(readCost(mul(factor(f('a', 1)), factor(f('a', 2, 'builtin', false, 'includes on a'))), [], 0)?.category).toBe('hidden linear call')
  expect(readCost(mul(factor(f('a', 1)), factor(f('a', 2, 'callback'))), [], 0)?.category).toBe('nested loops')
  expect(readCost(mul(factor(f('a', 1)), factor(f('b', 2))), [], 0)?.category).toBe('two inputs')
  expect(readCost(mul(factor(f('a', 1)), factor(f('a', 2))), [], 0)?.category).toBe('nested loops')
  expect(readCost(factor(f('a', 1, 'builtin', false, 'sum of a')), [], 0)?.category).toBe('linear scan')
})

test('the explanation names sites in line order with pane line numbers, and the product', async () => {
  const r = readCost(mul(factor(f('items', 4, 'builtin', false, 'includes on items')), factor(f('items', 2))), [], 1)
  expect(r?.explanation).toBe('Line 2: loop over items; line 4: includes on items. n × n = O(n²).')
})

test('simplify keeps one copy of equal-shaped terms', async () => {
  expect(simplify(add(factor(f('a', 1)), factor(f('a', 5)))).length).toBe(1)
})

test('two-size explanations write n first: n × m and n + m', async () => {
  const prod = readCost(mul(factor(f('ids', 4)), factor(f('items', 2))), [], 0)
  expect(prod?.explanation).toBe('Line 3: loop over items; line 5: loop over ids. n × m = O(n·m).')
  const sum = readCost(add(factor(f('ids', 5)), factor(f('items', 2))), [], 0)
  expect(sum?.explanation).toBe('Line 3: loop over items; line 6: loop over ids. n + m = O(n + m).')
})

test('simplify keeps the equal-shaped term with the earliest site', async () => {
  expect(simplify(add(factor(f('a', 5)), factor(f('a', 1))))[0]?.[0]?.at).toBe(1)
})

const none = new Set<string>()
const out = { isInLoop: false, isLastAtBodyLevel: false, isInGuard: false }

test('treeByBraces nests blocks and else branches, and refuses unbalanced braces', async () => {
  const t = treeByBraces(['function f(a: number[]) {', '  for (const x of a) {', '    g(x)', '  } else {', '  }', '}'])
  expect(t?.children[0]?.text.trim()).toBe('for (const x of a) {')
  expect(t?.children[0]?.children[0]?.text.trim()).toBe('g(x)')
  expect(treeByBraces(['function f() {', '  for (const x of a) {', '    …', '  }', '}', '}'])).toBe(undefined)
  expect(treeByBraces(['function f() {', '  if (a) { b() ', '}'])).toBe(undefined)
})

test('treeByIndent nests by indentation and refuses continued lines', async () => {
  const t = treeByIndent(['def f(a: list):', '    for x in a:', '        g(x)', '    return 1'])
  expect(t?.children.length).toBe(2)
  expect(t?.children[0]?.children[0]?.text.trim()).toBe('g(x)')
  expect(treeByIndent(['def f(a: list):', '    x = g(a,', '        b)'])).toBe(undefined)
  expect(treeByIndent(['def f(a: list):', '    x = 1 + \\', '        2'])).toBe(undefined)
})

test('a hidden line is inert only with the kept braces, no bound name, no listed word', async () => {
  expect(isInert("'done'", '…', 'TypeScript', new Set(['items']), none, out)).toBe(true)
  // Fix round 2: a call is no hidden form (a host builtin or a literal word may raise).
  expect(isInert("log('done')", '…', 'TypeScript', new Set(['items']), none, out)).toBe(false)
  // The scanner blanked the line and dropped its brace: structure differs.
  expect(isInert('if ((x + 1) / 2 > t) {', '…', 'TypeScript', none, none, out)).toBe(false)
  expect(isInert("log('x', items)", '…', 'TypeScript', new Set(['items']), none, out)).toBe(false)
  expect(isInert("log('sorted')", '…', 'TypeScript', none, new Set(['sort', 'sorted']), out)).toBe(false)
  expect(isInert('for (const k of keys) { // go', '… {', 'TypeScript', none, none, out)).toBe(false)
  expect(isInert("emit(...rest, 'x')", '…', 'TypeScript', none, none, out)).toBe(false)
})

test('a hidden exit passes only as the last body statement or inside a guard outside loops', async () => {
  expect(isInert("throw new Error('bad')", '…', 'TypeScript', none, none, { isInLoop: false, isLastAtBodyLevel: false, isInGuard: true })).toBe(true)
  expect(isInert("return 'done'", '…', 'TypeScript', none, none, { isInLoop: false, isLastAtBodyLevel: true, isInGuard: false })).toBe(true)
  expect(isInert("raise NotImplementedError('x')", '…', 'Python', none, none, { isInLoop: false, isLastAtBodyLevel: false, isInGuard: false })).toBe(false)
  expect(isInert("return 'done'", '        …', 'Python', none, none, { isInLoop: true, isLastAtBodyLevel: false, isInGuard: false })).toBe(false)
})

test('Python: raw indent must equal the kept indent, brackets balance, no trailing backslash', async () => {
  expect(isInert('    # x', '    …', 'Python', none, none, out)).toBe(true)
  expect(isInert('      # x', '    …', 'Python', none, none, out)).toBe(false)
  expect(isInert("    log('x',", '    …', 'Python', none, none, out)).toBe(false)
})

test('treeByBraces: blanked lines keep their braces, close-only lines are no blocks, the root must close last', async () => {
  // TypeScript keeps a leading close before the `…`; PHP puts every brace after it.
  const ts = treeByBraces(['function f(a) {', '  …{', '    g(a)', '  }…', '  h(a)', '}'])
  expect(ts?.children.map(b => b.at)).toEqual([1, 4])
  expect(ts?.children[0]?.children[0]?.at).toBe(2)
  const php = treeByBraces(['function f($a) {', '  … {', '    g($a);', '  … }', '}'])
  expect(php?.children.map(b => b.at)).toEqual([1])
  expect(treeByBraces(['  items.forEach(x => {', '    g(x)', '  })', '}'])).toBe(undefined)
  expect(treeByBraces(['function f(a) {', '  a.forEach(x => {', '    g(x)', '  })', '}'])?.children.length).toBe(1)
  expect(treeByBraces(['function f(a) {', '  g(a)', '}', 'h()'])).toBe(undefined)
  expect(treeByBraces(['function f(a) {', '  const o = { k: 1 }', '}'])?.children.length).toBe(1)
  expect(treeByBraces(['function f(a) {', '  x } {', '}'])).toBe(undefined)
  expect(treeByBraces(['function f(a) {', '  if (a) {{', '  }}', '}'])).toBe(undefined)
  // PSR-12: the body's brace on its own line; a signature may run on, but never through a blanked line.
  expect(treeByBraces(['function f($a)', '{', '  g($a);', '}'])?.children.map(b => b.at)).toEqual([2])
  expect(treeByBraces(['function f(', '  $a,', ') {', '  g($a);', '}'])?.children.map(b => b.at)).toEqual([3])
  expect(treeByBraces(['function f(', '  …', ') {', '  g($a);', '}'])).toBe(undefined)
  expect(treeByBraces(['function f(a) }', '}'])).toBe(undefined)
})

test('treeByBraces: a blanked line keeping a lone close only closes, like a shown one', async () => {
  const t = treeByBraces(['function f() {', '  g()', '}…'])
  expect(t?.children.map(b => b.at)).toEqual([1])
  const nested = treeByBraces(['function f(a) {', '  if (a) {', '    g(a)', '  }…', '  h(a)', '  if (a) {', '    … }', '}'])
  expect(nested?.children.map(b => b.at)).toEqual([1, 4, 5])
  expect(nested?.children[0]?.children.map(b => b.at)).toEqual([2])
  expect(nested?.children[2]?.children.length).toBe(0)
})

test('treeByIndent: blanked openers, a dedent to an unopened level, and a deeper line under a plain statement', async () => {
  const t = treeByIndent(['def f(a):', '    …', '        g(a)', '    h(a)'])
  expect(t?.children[0]?.children[0]?.at).toBe(2)
  expect(treeByIndent(['def f(a):', '        g(a)', '    h(a)'])).toBe(undefined)
  expect(treeByIndent(['def f(a):', '    g(a)', '        h(a)'])).toBe(undefined)
  expect(treeByIndent(['def f(a):', '    g(a)', 'h(a)'])).toBe(undefined)
  expect(treeByIndent(['x = 1', '    g(a)'])).toBe(undefined)
  expect(treeByIndent(['def f(a):', '\tg(a)', '    h(a)'])).toBe(undefined)
})

test('inert names: unicode escapes, compatibility forms, PHP variables and case, dotted words', async () => {
  const items = new Set(['items'])
  expect(isInert('log(\\u0069tems)', '…', 'TypeScript', items, none, out)).toBe(false)
  expect(isInert('log(\\u{69}tems)', '…', 'TypeScript', items, none, out)).toBe(false)
  expect(isInert('    log(ｉtems)', '    …', 'Python', items, none, out)).toBe(false)
  expect(isInert('log($items);', '…', 'PHP', items, none, out)).toBe(false)
  expect(isInert("log('$items');", '…', 'PHP', items, none, out)).toBe(false)
  expect(isInert('FOREACH ($a as $b) {', '… {', 'PHP', none, none, out)).toBe(false)
  expect(isInert('COUNT($x);', '…', 'PHP', none, new Set(['count']), out)).toBe(false)
  expect(isInert('Object.keys(o)', '…', 'TypeScript', none, new Set(['Object.keys']), out)).toBe(false)
  expect(isInert("log('café')", '…', 'TypeScript', new Set(['café']), none, out)).toBe(false)
  expect(isInert('log(a) items', '…', 'TypeScript', none, none, out)).toBe(false)
  expect(isInert('log(x)', 'log(x)', 'TypeScript', none, none, out)).toBe(false)
})

test('inert words: closures, Python unpacking, exits in strings', async () => {
  expect(isInert('cb = (x) => x', '…', 'TypeScript', none, none, out)).toBe(false)
  expect(isInert('    g(*args)', '    …', 'Python', none, none, out)).toBe(false)
  expect(isInert('    g(a, **kw)', '    …', 'Python', none, none, out)).toBe(false)
  expect(isInert('    x = [*a]', '    …', 'Python', none, none, out)).toBe(false)
  expect(isInert('    return *a, b', '    …', 'Python', none, none, { isInLoop: false, isLastAtBodyLevel: true, isInGuard: false })).toBe(false)
  expect(isInert('    log(a * b, 2 ** c)', '    …', 'Python', none, none, out)).toBe(false)
  expect(isInert("log('return')", '…', 'TypeScript', none, none, out)).toBe(false)
  expect(isInert("'done' // c", '…', 'TypeScript', none, none, { isInLoop: true, isLastAtBodyLevel: false, isInGuard: false })).toBe(true)
  expect(isInert('break', '…', 'TypeScript', none, none, { isInLoop: true, isLastAtBodyLevel: false, isInGuard: true })).toBe(false)
  // Soft keywords: `match` and `case` take an unpacking subject or pattern.
  expect(isInert('        case *rest, x:  # n', '        …', 'Python', new Set(['v']), none, out)).toBe(false)
  expect(isInert('    match *a, b:  # n', '    …', 'Python', new Set(['v']), none, out)).toBe(false)
  expect(isInert('    with *a:  # n', '    …', 'Python', none, none, out)).toBe(false)
})

test('fix round 1: a hidden line is one of a closed set of forms (a raise or an exit cuts a loop short)', async () => {
  const py = (raw: string, place = out): boolean => isInert(raw, '    …', 'Python', none, none, place)
  const ts = (raw: string, kept = '…', place = out): boolean => isInert(raw, kept, 'TypeScript', none, none, place)
  // Admitted: comments, string statements, literal-argument calls, a literal to a fresh name, structure.
  for (const raw of ['    # note', "    '''Doc.'''", '    """Sum."""  # n', '    pass  # c', '    else:  # c']) expect([raw, py(raw)]).toEqual([raw, true])
  for (const raw of ['// note', "'use strict'", '/* note */']) expect([raw, ts(raw)]).toEqual([raw, true])
  // Fix round 2: no call and no assignment (a literal word or host builtin raises when called; a name may shadow a helper).
  for (const raw of ["    log('step')", "    log.info('x', 1, True, None)  # c", "    z = 'a'", '    z = -3  # c', '    None()  # c', "    int('x')  # c", '    NotImplemented(1)  # c', '    log = 1  # c']) expect([raw, py(raw)]).toEqual([raw, false])
  for (const raw of ["log('step');", "lib.log('x', 1, true) // c", "const z = 'a' // c", 'undefined() // c', "atob('*') // c", 'Buffer.alloc(-1) // c', "require('zz-nope') // c", 'Foo() // c', 'NaN(1) // c', 'const lib = 1 // c']) expect([raw, ts(raw)]).toEqual([raw, false])
  expect(ts('} // end', '}…')).toBe(true)
  expect(ts('} else { // c', '}…{')).toBe(true)
  // Refused: anything that may raise, exit or compute.
  for (const raw of ['    z = 1 / 0  # boom', '    os._exit(1)  # stop', '    sys.exit(1)  # stop', '    z = [][0]  # c', "    z = {}['k']  # c", "    z = 'a' + 1  # c", "    z = qqq + 'a'  # c", '    log(x)  # c', "    log(f'{x}')", '    z = q.r  # c', '    abort()  # c', "    kill('x')"]) expect([raw, py(raw)]).toEqual([raw, false])
  expect(isInert('    if 1 / 0:  # c', '    …', 'Python', none, none, out)).toBe(false)
  for (const raw of ['const z = (1 as any).x.y // c', 'process.exit(1) // stop', "throw_it('x') + 1", 'const z = `${q}` // c', 'z = 1 // c', 'z.y = 1 // c']) expect([raw, ts(raw)]).toEqual([raw, false])
  expect(ts("if (mode() === 'a') {", '…{')).toBe(false)
  // Exit forms keep their places.
  expect(py("    raise ValueError('bad')", { isInLoop: false, isLastAtBodyLevel: false, isInGuard: true })).toBe(true)
  expect(py('    sys.exit(1)  # stop', { isInLoop: false, isLastAtBodyLevel: true, isInGuard: false })).toBe(true)
  expect(py('    os._exit(1)  # stop', { isInLoop: true, isLastAtBodyLevel: false, isInGuard: false })).toBe(false)
  expect(py("    raise ValueError('a' + q)", { isInLoop: false, isLastAtBodyLevel: false, isInGuard: true })).toBe(false)
  expect(py('    return q.r', { isInLoop: false, isLastAtBodyLevel: true, isInGuard: false })).toBe(false)
})

test('fix round 1: a string over several hidden lines is read in order, and only over blank lines', async () => {
  const lines = ['def f():', '    …', '    …', '', '    …', '    x = 1']
  const run = (raws: Record<number, string>): boolean => {
    const scan = hiddenScan(lines)
    return Object.entries(raws).every(([at, raw]) => isInert(raw, lines[Number(at)]!, 'Python', none, none, out, scan, Number(at))) && scan.open === undefined
  }
  expect(run({ 1: '    """Sum the items.', 2: '    More (text).', 4: '    """' })).toBe(true)
  expect(run({ 1: '    """Sum the items.', 2: '    More text.', 4: '    """ + q' })).toBe(false)
  // Left open: the string would run into a shown line.
  expect(run({ 1: '    """Sum the items.', 2: '    More text.', 4: '    end' })).toBe(false)
  // Code after the close.
  expect(run({ 1: '    """Sum.', 2: '    """; z = 1 / 0', 4: '    # c' })).toBe(false)
})

test('PHP variable variables fail: a name reached without being written', async () => {
  const items = new Set(['items'])
  expect(isInert("log(${'it'.'ems'}); // n", '…', 'PHP', items, none, out)).toBe(false)
  expect(isInert('log($$n); // n', '…', 'PHP', items, none, out)).toBe(false)
  expect(isInert("'x'; // n", '…', 'PHP', items, none, out)).toBe(true)
})

/** A stand-in repository: one file changed on `lines`, read as `source`. */
const ioOf = (path: string, source: string, lines: string): MaterialIo => ({
  git: async args => {
    if (args[0] === 'rev-list') return { exitCode: 0, stdout: 'abc123\n' }
    if (args.includes('--raw')) return { exitCode: 0, stdout: `:100644 100644 aaa bbb M\0${path}\0` }
    return { exitCode: 0, stdout: `diff --git a/${path} b/${path}\n+++ b/${path}\n@@ -0,0 +${lines} @@\n` }
  },
  read: async p => (p === path ? source : undefined),
})

/** Neither `units` nor `localUnits` hold `raw`, `fileLines` or `dedent` in any field. */
function expectNoRaw(value: { units: unknown[]; localUnits: unknown[] }, raw: string) {
  for (const list of [value.units, value.localUnits] as { hidden?: unknown }[][]) {
    expect(JSON.stringify(list).includes(raw)).toBe(false)
    expect(JSON.stringify(structuredClone(list.map(({ hidden, ...u }) => u))).includes(raw)).toBe(false)
    expect(JSON.stringify(list).includes('fileLines')).toBe(false)
    expect(JSON.stringify(list).includes('dedent')).toBe(false)
  }
}

test('local units carry full and hidden; prompt units never do; raw text is in no field', async () => {
  const RAW = 'NOVA_RAW_ONLY_7731'
  const source = [
    'def pairs(items: list):',
    '    out = []',
    '    for x in items:',
    '        out.append(x)',
    `    return ', '.join(sorted(out))  # ${RAW}`,
    '',
  ].join('\n')
  const result = await missionUnits(ioOf('nova/pairs.py', source, '1,5'), 0, 'strict')
  const { units, localUnits } = result
  expect(units.length).toBe(1)
  expect(units.every(u => u.full === undefined && u.hidden === undefined)).toBe(true)
  const local = localUnits[0]!
  expect(local.full?.lines.length).toBe(5)
  expect(local.full?.offset).toBe(0)
  expect(local.lines.length).toBe(4)
  let seen = ''
  expect(local.hidden?.((raw, at) => { seen = `${at}:${raw.includes(RAW)}`; return true })).toBe(true)
  expect(seen).toBe('4:true')
  expect(local.hidden?.(() => false)).toBe(false)
  expect(local.hidden?.(() => { throw new Error('x') })).toBe(false)
  expectNoRaw(result, RAW)
})

test('hidden hands each blanked line inside a nested body its raw text, dedented as the unit is', async () => {
  const RAW = 'NOVA_RAW_TS_4410'
  const source = [
    'class Tally {',
    '  countOf(items: number[]): number {',
    '    // ' + RAW,
    '    let n = 0',
    '',
    '    for (const x of items) {',
    `      log("${RAW}") // note`,
    '      n += x',
    '    }',
    '    return n',
    '  }',
    '}',
  ].join('\r\n')
  const result = await missionUnits(ioOf('nova/tally.ts', source, '2,10'), 0, 'strict')
  const local = result.localUnits[0]!
  expect(local.name).toBe('countOf')
  // A function's unit opens on its signature, so nothing is trimmed from its start.
  expect(local.full?.offset).toBe(0)
  expect(local.full?.lines).toEqual(['countOf(items: number[]): number {', '  …', '  let n = 0', '  for (const x of items) {', '    …', '    n += x', '  }', '  return n', '}'])
  const seen: string[] = []
  expect(local.hidden?.((raw, at) => (seen.push(`${at}:${raw}`), true))).toBe(true)
  expect(seen).toEqual([`1:  // ${RAW}`, `4:    log("${RAW}") // note`])
  // Stops at the first false.
  let calls = 0
  expect(local.hidden?.(() => (calls += 1, false))).toBe(false)
  expect(calls).toBe(1)
  expectNoRaw(result, RAW)
})
