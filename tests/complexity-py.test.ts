import { expect, test } from 'claude-code/testing'
import { costOf } from '../src/puzzle/complexity'
import type { Unit } from '../src/puzzle/units'

// Invented code only (SPEC 15). Each refusal sits beside an accepted near
// variant, so a test fails until the reader reads the accepted shape.

const py = (...lines: string[]): Unit => ({ lang: 'Python', name: /def\s+(\w+)/.exec(lines[0]!)![1]!, lines })
const answer = (u: Unit) => costOf(u)?.answer

/** A function `f` with the given parameters and body lines (indented by four). */
const fn = (params: string, ...body: string[]): Unit => py(`def f(${params}) -> int:`, ...body.map((l) => `    ${l}`))
/** A loop over `items` whose body is `line` (then `t += 1`), inside `f(items: list[int], ids: list[int])`. */
const inLoop = (line: string, params = 'items: list[int], ids: list[int]'): Unit => fn(params, 't = 0', 'for x in items:', `    ${line}`, '    t += 1', 'return t')
/** A tiny root guard on `test` that returns, before a loop over items nested in one over ids. */
const guarded = (test: string, params = 'items: list[int], ids: list[int], k: int'): Unit => fn(params, `if ${test}:`, '    return 0', 't = 0', 'for x in items:', '    for y in ids:', '        t += 1', 'return t')

// --- The brief's tests ---------------------------------------------------------

test('loops, membership by annotation, comprehensions', async () => {
  expect(answer(py('def f(items: list[int], ids: list[int]) -> int:', '    t = 0', '    for x in items:', '        if x in ids:', '            t += 1', '    return t'))).toBe('O(n·m)')
  expect(answer(py('def f(items: list[int], ids: set[int]) -> int:', '    t = 0', '    for x in items:', '        if x in ids:', '            t += 1', '    return t'))).toBe('O(n)')
  expect(answer(py('def f(items, ids) -> int:', '    t = 0', '    for x in items:', '        if x in ids:', '            t += 1', '    return t'))).toBe(undefined)
  expect(answer(py('def f(a: list[int]) -> list[int]:', '    out = [x * y for x in a for y in a]', '    return out'))).toBe('O(n²)')
})

test('fails closed on the adversarial review counterexamples', async () => {
  // Growing the list the loop bound reads (round 1, #3).
  expect(answer(py('def f(items: list[int]) -> None:', '    for i in range(len(items)):', '        for j in range(len(items)):', '            items.append(j)'))).toBe(undefined)
  // List repetition in a loop (round 1, #4).
  expect(answer(py('def f(n: int) -> int:', '    t = 0', '    for i in range(n):', '        row = [0] * n', '        t += len(row)', '    return t'))).toBe(undefined)
  // mid reassigned (round 2, #8).
  expect(answer(py('def f(items: list[int], x: int) -> int:', '    lo = 0', '    hi = len(items) - 1', '    while lo <= hi:', '        mid = (lo + hi) // 2', '        mid = lo', '        if items[mid] < x:', '            lo = mid + 1', '        else:', '            hi = mid - 1', '    return lo'))).toBe(undefined)
  // Body on the header line.
  expect(answer(py('def f(a: list[int], b: list[int]) -> int:', '    t = 0', '    for y in b: t += a.index(y)', '    return t'))).toBe(undefined)
  // lambda key.
  expect(answer(py('def f(a: list[int]) -> list[int]:', '    s = sorted(a, key=lambda x: a.index(x))', '    return s'))).toBe(undefined)
})

test('a trimmed return after the loops is hidden and must be inert (round 1, #2; round 2, #2)', async () => {
  const lines = ['def f(items: list[int]):', '    total = 0', '    for x in items:', '        for y in items:', '            total += x * y', '        …']
  const u: Unit = { ...py(...lines), full: { lines, offset: 0 }, hidden: check => check("        return 'done'", 5) }
  expect(answer(u)).toBe(undefined)
  const u2: Unit = { ...py(...lines.slice(0, 5), '    …'), hidden: check => check("    return ', '.join(sorted(out))", 5) }
  expect(answer(u2)).toBe(undefined)
})

// --- Hidden lines ------------------------------------------------------------

test('hidden lines: inert passes, a hidden cost fails, a hidden line without hidden() fails', async () => {
  const lines = ['def f(items: list[int]) -> int:', '    t = 0', '    for x in items:', '        …', '        t += x', '    return t']
  const withRaw = (raw: string): Unit => ({ ...py(...lines), hidden: check => check(raw, 3) })
  expect(answer(withRaw("        log('step')"))).toBe('O(n)')
  expect(answer(withRaw("        t += items.count(x)  # 'x'"))).toBe(undefined)
  expect(answer(withRaw("        assert ready(), 'never'"))).toBe(undefined)
  expect(answer(withRaw("        del cache['k']"))).toBe(undefined)
  expect(answer(withRaw("    log('step')"))).toBe(undefined)
  expect(answer(py(...lines))).toBe(undefined)
  // A hidden guard that returns at the root is fine; a hidden return in a loop is not.
  const guard = ['def f(items: list[int]) -> int:', '    if not items:', '        …', '    t = 0', '    for x in items:', '        t += x', '    return t']
  expect(answer({ ...py(...guard), hidden: check => check("        raise ValueError('empty')", 2) })).toBe('O(n)')
  expect(answer({ ...py(...lines), hidden: check => check("        return 'x'", 3) })).toBe(undefined)
})

test('a hidden block opener is an if whose body costs 1 and never exits', async () => {
  const lines = ['def f(items: list[int], ids: list[int]) -> int:', '    t = 0', '    for x in items:', '        …', '            t += 1', '    return t']
  const at = (raw: string, body: string): Unit => {
    const l = [...lines.slice(0, 4), `            ${body}`, lines[5]!]
    return { ...py(...l), hidden: check => check(raw, 3) }
  }
  expect(answer(at("        if mode == 'fast':", 't += 1'))).toBe('O(n)')
  expect(answer(at("        if mode == 'fast':", 't += ids.count(x)'))).toBe(undefined)
  expect(answer(at("        if mode == 'fast':", 'break'))).toBe(undefined)
  expect(answer(at("        try:  # 'x'", 't += 1'))).toBe(undefined)
})

// --- Signature (gate 3) --------------------------------------------------------

test('the signature: plain parameters with annotations and literal defaults; self and cls are not parameters', async () => {
  expect(costOf(py('def f(self, items: list[int], k: int = 3) -> int:', '    t = 0', '    for x in items:', '        t += x', '    return t'))?.params).toEqual(['items', 'k'])
  expect(answer(py('def f(cls, items: list[int]) -> int:', '    t = 0', '    for x in items:', '        t += x', '    return t'))).toBe('O(n)')
  for (const params of ['*args', '**kw', 'items: list[int], *rest', 'items: list[int], *, k: int', 'items: list[int], /', 'items: list[int] = []', 'items: list[int] = {}', 'items: list[int], self']) {
    expect(answer(py(`def f(${params}) -> int:`, '    t = 0', '    for x in items:', '        t += x', '    return t'))).toBe(undefined)
  }
  // self is never read.
  expect(answer(py('def f(self, items: list[int]) -> int:', '    t = 0', '    for x in items:', '        t += self.weight', '    return t'))).toBe(undefined)
  expect(answer(py('async def f(items: list[int]) -> int:', '    t = 0', '    for x in items:', '        t += x', '    return t'))).toBe(undefined)
})

test('annotations: each listed collection, bare or subscripted, optionally Optional or | None', async () => {
  for (const type of ['list[int]', 'List[int]', 'Sequence[int]', 'tuple[int, ...]', 'list', 'Optional[list[int]]', 'list[int] | None', 'None | list[int]', 'str', 'set[int]', 'frozenset[int]', 'dict[int, int]', 'Mapping[int, int]', 'dict']) {
    expect(answer(fn(`items: ${type}`, 't = 0', 'for x in items:', '    t += 1', 'return t'))).toBe('O(n)')
  }
  // A fixed tuple, an untyped, union, named or literal type is no loop source.
  for (const type of ['tuple[int, int]', 'Iterable[int]', 'Repo', 'list[int] | set[int]', 'Literal[1, 2]', 'int', 'float', 'bool']) {
    expect(answer(fn(`items: ${type}`, 't = 0', 'for x in items:', '    t += 1', 'return t'))).toBe(undefined)
  }
  expect(answer(fn('items', 't = 0', 'for x in items:', '    t += 1', 'return t'))).toBe(undefined)
})

// --- The loop table ----------------------------------------------------------

test('for-each sources: a parameter, enumerate, reversed, a dict view', async () => {
  expect(answer(fn('a: list[int]', 't = 0', 'for i, x in enumerate(a):', '    t += i + x', 'return t'))).toBe('O(n)')
  expect(answer(fn('a: list[int]', 't = 0', 'for x in reversed(a):', '    t += x', 'return t'))).toBe('O(n)')
  expect(answer(fn('d: dict[int, int]', 't = 0', 'for k, v in d.items():', '    t += k + v', 'return t'))).toBe('O(n)')
  expect(answer(fn('d: dict[int, int]', 't = 0', 'for v in d.values():', '    t += v', 'return t'))).toBe('O(n)')
  expect(answer(fn('d: dict[int, int]', 't = 0', 'for k in d.keys():', '    t += k', 'return t'))).toBe('O(n)')
  // A view anywhere else, enumerate with a start, or a tuple target elsewhere.
  expect(answer(fn('d: dict[int, int], x: int', 'if x in d.values():', '    return 1', 't = 0', 'for k in d:', '    t += k', 'return t'))).toBe(undefined)
  expect(answer(fn('a: list[int]', 't = 0', 'for i, x in enumerate(a, 1):', '    t += i', 'return t'))).toBe(undefined)
  expect(answer(fn('a: list[int]', 't = 0', 'for i, x in a:', '    t += i', 'return t'))).toBe(undefined)
})

test('range: counting up from 0 or 1 with a literal step, down from B - 1, reversed; anything else fails', async () => {
  for (const head of ['range(len(a))', 'range(0, len(a))', 'range(1, len(a))', 'range(len(a) - 1)', 'range(0, len(a), 2)', 'range(len(a) - 1, -1, -1)', 'reversed(range(len(a)))', 'range(n)', 'range(1, n + 1)']) {
    expect(answer(fn('a: list[int], n: int', 't = 0', `for i in ${head}:`, '    t += i', 'return t'))).toBe('O(n)')
  }
  for (const head of ['range(2, len(a))', 'range(0, len(a), k)', 'range(0, len(a), 0)', 'range(len(a) - 2)', 'range(len(a), 0, -2)', 'range(k, len(a))', 'range(x)', 'range(len(a) * 2)', 'range(len(a) // 2)']) {
    expect(answer(fn('a: list[int], k: int, x: float', 't = 0', `for i in ${head}:`, '    t += i', 'return t'))).toBe(undefined)
  }
})

test('nested, sequential and literal loops', async () => {
  expect(answer(fn('a: list[int], b: list[int]', 't = 0', 'for x in a:', '    for y in b:', '        t += x * y', 'return t'))).toBe('O(n·m)')
  expect(answer(fn('a: list[int], b: list[int]', 't = 0', 'for x in a:', '    t += x', 'for y in b:', '    t += y', 'return t'))).toBe('O(n + m)')
  expect(answer(fn('a: list[int]', 't = 0', 'for x in a:', '    for y in a:', '        for z in a:', '            t += 1', 'return t'))).toBe('O(n³)')
  expect(answer(fn('a: list[int]', 't = 0', 'for i in range(10):', '    for x in a:', '        t += x', 'return t'))).toBe('O(n)')
  // A third size is no puzzle.
  expect(answer(fn('a: list[int], b: list[int], c: list[int]', 't = 0', 'for x in a:', '    for y in b:', '        for z in c:', '            t += 1', 'return t'))).toBe(undefined)
})

test('an inner bound that is an enclosing index reads the enclosing factor; over another size it fails', async () => {
  expect(answer(fn('a: list[int]', 't = 0', 'for i in range(len(a)):', '    for j in range(i):', '        t += a[j]', 'return t'))).toBe('O(n²)')
  expect(answer(fn('a: list[int]', 't = 0', 'for i in range(len(a)):', '    for j in range(i + 1, len(a)):', '        t += a[i] * a[j]', 'return t'))).toBe('O(n²)')
  expect(answer(fn('a: list[int], b: list[int]', 't = 0', 'for i in range(len(b)):', '    for j in range(i, len(a)):', '        t += 1', 'return t'))).toBe(undefined)
  // An element is no index.
  expect(answer(fn('a: list[int]', 't = 0', 'for x in a:', '    for j in range(x):', '        t += 1', 'return t'))).toBe(undefined)
  // A loop name rebound by a nested loop, or read after its loop.
  expect(answer(fn('a: list[int]', 't = 0', 'for x in a:', '    for x in a:', '        t += 1', 'return t'))).toBe(undefined)
  expect(answer(fn('a: list[int]', 't = 0', 'for x in a:', '    t += 1', 'return t + x'))).toBe(undefined)
  // A loop name assigned in the body.
  expect(answer(fn('a: list[int]', 't = 0', 'for i in range(len(a)):', '    i = 0', '    t += 1', 'return t'))).toBe(undefined)
})

test('while is a binary search only, with a // mid; for…else and while…else fail', async () => {
  const search = (mid: string, cmp = '<=', hi = 'len(items) - 1', lo = 'lo = mid + 1', hiSet = 'hi = mid - 1'): Unit => fn('items: list[int], x: int', 'lo = 0', `hi = ${hi}`, `while lo ${cmp} hi:`, `    mid = ${mid}`, '    if items[mid] == x:', '        return mid', '    if items[mid] < x:', `        ${lo}`, '    else:', `        ${hiSet}`, 'return -1')
  expect(answer(search('(lo + hi) // 2'))).toBe('O(log n)')
  expect(answer(search('lo + (hi - lo) // 2'))).toBe('O(log n)')
  expect(answer(search('(lo + hi) // 2', '<', 'len(items)', 'lo = mid + 1', 'hi = mid'))).toBe('O(log n)')
  expect(costOf(search('(lo + hi) // 2'))?.category).toBe('halving')
  // lo = mid can loop forever; hi = mid under <= too; a mid by >> or / is not listed.
  expect(answer(search('(lo + hi) // 2', '<', 'len(items)', 'lo = mid', 'hi = mid'))).toBe(undefined)
  expect(answer(search('(lo + hi) // 2', '<=', 'len(items) - 1', 'lo = mid + 1', 'hi = mid'))).toBe(undefined)
  expect(answer(search('(lo + hi) >> 1'))).toBe(undefined)
  expect(answer(search('int((lo + hi) / 2)'))).toBe(undefined)
  // Any other while.
  expect(answer(fn('items: list[int]', 'i = 0', 'while i < len(items):', '    i += 1', 'return i'))).toBe(undefined)
  expect(answer(fn('items: list[int]', 'while True:', '    break', 'return 0'))).toBe(undefined)
  expect(answer(fn('items: list[int]', 't = 0', 'for x in items:', '    t += x', 'else:', '    t = 0', 'return t'))).toBe(undefined)
  expect(answer(fn('items: list[int]', 't = 0', 'async for x in items:', '    t += x', 'return t'))).toBe(undefined)
})

test('binary search: an exit by return only outside loops, break anywhere; inside a loop over the same input it is n log n', async () => {
  const inner = (exit: string): Unit => fn('items: list[int], v: int', 't = 0', 'for x in items:', '    lo = 0', '    hi = len(items) - 1', '    while lo <= hi:', '        mid = (lo + hi) // 2', '        if items[mid] == v:', `            ${exit}`, '        if items[mid] < x:', '            lo = mid + 1', '        else:', '            hi = mid - 1', '    t += 1', 'return t')
  expect(answer(inner('break'))).toBe('O(n log n)')
  expect(answer(inner('return 1'))).toBe(undefined)
  // A comparison of an int element with a str value raises: the orderings need one kind on both sides.
  expect(answer(fn('items: list[str], x: int', 'lo = 0', 'hi = len(items) - 1', 'while lo <= hi:', '    mid = (lo + hi) // 2', '    if items[mid] < x:', '        lo = mid + 1', '    else:', '        hi = mid - 1', 'return lo'))).toBe(undefined)
})

// --- Comprehensions ----------------------------------------------------------

test('comprehensions and generator expressions are loops; a filter guards only constant work', async () => {
  expect(answer(fn('a: list[int]', 'return sum(x * 2 for x in a)'))).toBe('O(n)')
  expect(answer(fn('a: list[int]', 's = {x for x in a}', 'return len(s)'))).toBe('O(n)')
  expect(answer(fn('a: list[int], b: list[int]', 'out = [b.count(x) for x in a]', 'return len(out)'))).toBe('O(n·m)')
  expect(answer(fn('a: list[int]', 'd = {x: x * 2 for x in a if x > 0}', 'return len(d)'))).toBe('O(n)')
  expect(costOf(fn('a: list[int]', 'out = [x * y for x in a for y in a]', 'return len(out)'))?.category).toBe('nested loops')
  // A loop or a linear builtin behind a filter that varies.
  expect(answer(fn('a: list[int], b: list[int]', 'out = [y for x in a if x > 0 for y in b]', 'return len(out)'))).toBe(undefined)
  expect(answer(fn('a: list[int], b: list[int]', 'out = [b.count(x) for x in a if x > 0]', 'return len(out)'))).toBe(undefined)
  // A generator anywhere but as the one argument of sum, min or max; sum over strings.
  expect(answer(fn('a: list[int]', 'g = (x for x in a)', 'return 0'))).toBe(undefined)
  expect(answer(fn('a: list[int]', 'return list(x for x in a)'))).toBe(undefined)
  expect(answer(fn('a: list[str]', 'return sum(x for x in a)'))).toBe(undefined)
  // An element of a nested list is opaque: no loop over it.
  expect(answer(fn('a: list[list[int]]', 'return sum(y for x in a for y in x)'))).toBe(undefined)
  // A comprehension name reused inside itself.
  expect(answer(fn('a: list[int]', 'out = [x for x in a for x in a]', 'return len(out)'))).toBe(undefined)
})

// --- Builtins ----------------------------------------------------------------

test('sorts: sorted and an in-place sort of a parameter outside loops cost n log n', async () => {
  expect(answer(fn('a: list[int]', 's = sorted(a)', 'return s[0]'))).toBe(undefined)
  expect(answer(fn('a: list[int]', 's = sorted(a)', 'return len(s)'))).toBe('O(n log n)')
  expect(answer(fn('a: list[int]', 's = sorted(a, reverse=True)', 'return len(s)'))).toBe('O(n log n)')
  expect(answer(fn('a: list[int]', 'a.sort()', 'return 0'))).toBe('O(n log n)')
  expect(costOf(fn('a: list[int]', 'a.sort()', 'return 0'))?.category).toBe('sorting')
  // In a loop, a key, a non-literal reverse, a tuple or Sequence in place, elements that may not order.
  expect(answer(fn('a: list[int], b: list[int]', 'for x in b:', '    a.sort()', 'return 0'))).toBe(undefined)
  expect(answer(fn('a: list[int]', 's = sorted(a, key=abs)', 'return len(s)'))).toBe(undefined)
  expect(answer(fn('a: list[int], r: bool', 's = sorted(a, reverse=r)', 'return len(s)'))).toBe(undefined)
  expect(answer(fn('a: tuple[int, ...]', 'a.sort()', 'return 0'))).toBe(undefined)
  expect(answer(fn('a: list[Foo]', 's = sorted(a)', 'return len(s)'))).toBe(undefined)
  expect(answer(fn('a: list', 's = sorted(a)', 'return len(s)'))).toBe(undefined)
})

test('linear builtins on a typed parameter: sum, min, max, list, set, tuple, copy, count', async () => {
  for (const call of ['sum(a)', 'min(a)', 'max(a)', 'len(list(a))', 'len(set(a))', 'len(tuple(a))', 'len(a.copy())', 'a.count(k)']) {
    expect(answer(fn('a: list[int], k: int', `return ${call}`))).toBe('O(n)')
  }
  expect(costOf(fn('a: list[int], b: list[int]', 't = 0', 'for x in a:', '    t += b.count(x)', 'return t'))?.category).toBe('hidden linear call')
  // index raises when absent, any and all stop early, pop(0), insert and remove shift, slices copy.
  for (const call of ['a.index(k)', 'any(a)', 'all(a)', 'a.pop(0)', 'a.pop()', 'len(a[1:])', 'len(a[:])', 'sum(a, 0)', 'min(a, default=0)', 'max(a, key=abs)']) {
    expect(answer(fn('a: list[int], k: int', 't = 0', 'for x in a:', '    t += x', `return ${call}`))).toBe(undefined)
  }
  for (const stmt of ['a.insert(0, k)', 'a.remove(k)', 'a.append(k)', 'a.extend(a)', 'a.reverse()', 'a.clear()']) {
    expect(answer(fn('a: list[int], k: int', 't = 0', 'for x in a:', '    t += x', stmt, 'return t'))).toBe(undefined)
  }
  // On str, every method fails; sum over strings fails; a set of a string's characters or of booleans is bounded.
  expect(answer(fn('a: str, k: str', 'return a.count(k)'))).toBe(undefined)
  expect(answer(fn('a: list[str]', 'return sum(a)'))).toBe(undefined)
  expect(answer(fn('a: str', 's = set(a)', 't = 0', 'for c in s:', '    t += 1', 'return t'))).toBe(undefined)
  expect(answer(fn('a: list[bool]', 's = set(a)', 't = 0', 'for c in s:', '    t += 1', 'return t'))).toBe(undefined)
  expect(answer(fn('a: list[int]', 's = set(a)', 't = 0', 'for c in s:', '    t += c', 'return t'))).toBe('O(n)')
})

test('constant builtins: len, abs, int, float, bool, min and max of scalars', async () => {
  expect(answer(inLoop('t = max(t, abs(x) + min(int(x), 3) + len(ids))'))).toBe('O(n)')
  expect(answer(inLoop('t += float(x) + bool(x)'))).toBe('O(n)')
  // Any other builtin, and a builtin name taken as a value.
  for (const line of ['t += round(x)', 'print(x)', 't += hash(x)', 'f = len', 't += len(str(x))', 't += divmod(x, 2)']) {
    expect(answer(inLoop(line))).toBe(undefined)
  }
})

// --- Derived values and accumulators --------------------------------------------

test('a derived value keeps its parameter\'s size; an accumulator only grows', async () => {
  expect(answer(fn('a: list[int], b: list[int]', 's = set(b)', 't = 0', 'for x in a:', '    if x in s:', '        t += 1', 'return t'))).toBe('O(n + m)')
  expect(answer(fn('a: list[int]', 's = sorted(a)', 't = 0', 'for x in s:', '    t += x', 'return t'))).toBe('O(n log n)')
  expect(answer(fn('a: list[int]', 'out = []', 'for x in a:', '    out.append(x)', 'return out'))).toBe('O(n)')
  expect(answer(fn('a: list[int]', 'seen = set()', 't = 0', 'for x in a:', '    if x not in seen:', '        seen.add(x)', '        t += 1', 'return t'))).toBe('O(n)')
  expect(answer(fn('a: list[int]', 'd = {}', 'for x in a:', '    d[x] = 1', 'return d'))).toBe('O(n)')
  // A derived value written again, or inside a loop; an accumulator iterated, sized in a test, read by key, popped, or searched.
  expect(answer(fn('a: list[int]', 's = sorted(a)', 's = sorted(a)', 't = 0', 'for x in s:', '    t += x', 'return t'))).toBe(undefined)
  expect(answer(fn('a: list[int]', 'out = []', 'for x in a:', '    out.append(x)', 't = 0', 'for y in out:', '    t += y', 'return t'))).toBe(undefined)
  expect(answer(fn('a: list[int]', 'out = []', 'for x in a:', '    out.append(x)', '    if len(out) > 3:', '        t = 1', 'return 0'))).toBe(undefined)
  expect(answer(fn('a: list[int]', 'd = {}', 't = 0', 'for x in a:', '    t += d[x]', 'return t'))).toBe(undefined)
  expect(answer(fn('a: list[int]', 'out = []', 'for x in a:', '    out.pop()', 'return 0'))).toBe(undefined)
  expect(answer(fn('a: list[int]', 'out = []', 't = 0', 'for x in a:', '    if x in out:', '        t += 1', 'return t'))).toBe(undefined)
  expect(answer(fn('a: list[int]', 'out = []', 'for x in a:', '    out.append(x)', 'return sorted(out)'))).toBe(undefined)
  // A local taking a whole parameter, or growing by +.
  expect(answer(fn('a: list[int]', 'b = a', 'for x in b:', '    a.append(x)', 'return 0'))).toBe(undefined)
  expect(answer(fn('a: list[int]', 'out = []', 'for x in a:', '    out = out + [x]', 'return out'))).toBe(undefined)
  expect(answer(fn('a: list[int]', 'out = []', 'for x in a:', '    out += [x]', 'return out'))).toBe(undefined)
})

test('a local is read only where its first assignment has run', async () => {
  expect(answer(fn('a: list[int]', 'for x in a:', '    t += x', 'return 0'))).toBe(undefined)
  expect(answer(fn('a: list[int], k: int', 'if k > 0:', '    t = 0', 'for x in a:', '    t += x', 'return 0'))).toBe(undefined)
  expect(answer(fn('a: list[int]', 'for x in a:', '    last = x', 'return last'))).toBe(undefined)
  expect(answer(fn('a: list[int]', 'for x in a:', '    last = x', '    t = last', 'return 0'))).toBe('O(n)')
})

test('numbers that grow without bound in a loop fail (Python integers are arbitrary precision)', async () => {
  expect(answer(inLoop('t += x * x'))).toBe('O(n)')
  for (const line of ['t *= 2', 't += t', 't = t * 2', 't = t + 1', 't <<= 1', 't = 2 ** x', 't = x << 3']) {
    expect(answer(inLoop(line))).toBe(undefined)
  }
  // Two accumulators feeding each other.
  expect(answer(fn('a: list[int]', 'p = 1', 'q = 1', 'for x in a:', '    p += q', '    q += p', 'return q'))).toBe(undefined)
  // A temporary from bounded values is fine; a cycle through temporaries is not.
  expect(answer(fn('a: list[int]', 't = 0', 'for x in a:', '    d = x - 1', '    t += d', 'return t'))).toBe('O(n)')
  expect(answer(fn('a: list[int]', 'u = 1', 'v = 1', 'for x in a:', '    u = v * 2', '    v = u * 2', 'return v'))).toBe(undefined)
  expect(answer(fn('a: list[int]', 't = 0', 'for x in a:', '    t = max(t, x)', 'return t'))).toBe('O(n)')
})

test('a raise the input cannot avoid fails: division by a local, a position read off its walk', async () => {
  expect(answer(inLoop('t += x / 2'))).toBe('O(n)')
  expect(answer(inLoop('t += 2 // x'))).toBe('O(n)')
  for (const line of ['t += x % 0', 't += x // (x - x)']) expect(answer(inLoop(line))).toBe(undefined)
  expect(answer(fn('items: list[int]', 'c = 0', 't = 0', 'for x in items:', '    t += x / c', 'return t'))).toBe(undefined)
  expect(answer(fn('items: list[int]', 't = 0', 'for i in range(len(items)):', '    t += items[i] / i', 'return t'))).toBe(undefined)
  expect(answer(fn('a: list[int], b: list[int]', 't = 0', 'for i in range(len(a)):', '    t += a[i]', 'return t'))).toBe('O(n)')
  expect(answer(fn('a: list[int], b: list[int]', 't = 0', 'for i in range(len(a)):', '    t += b[i]', 'return t'))).toBe(undefined)
  expect(answer(fn('a: list[int]', 't = 0', 'for i in range(len(a)):', '    t += a[i + 1]', 'return t'))).toBe(undefined)
  expect(answer(fn('a: list[int], d: dict[int, int]', 't = 0', 'for x in a:', '    t += d[x]', 'return t'))).toBe(undefined)
  expect(answer(fn('a: list[int], d: dict[int, int]', 't = 0', 'for x in a:', '    t += d.get(x, 0)', 'return t'))).toBe('O(n)')
})

test('self-review: bitwise operators raise on a float, so they fail', async () => {
  expect(answer(inLoop('t += x - 1', 'items: list[float], ids: list[int]'))).toBe('O(n)')
  for (const line of ['t += ~x', 't += x & 1', 't += x | 1', 't += x ^ 1', 't += x >> 1']) {
    expect(answer(inLoop(line, 'items: list[float], ids: list[int]'))).toBe(undefined)
    expect(answer(inLoop(line))).toBe(undefined)
  }
})

test('self-review: a test that may never hold guards no costly work (each name once on a path)', async () => {
  const root = (...pre: string[]): Unit => fn('items: list[int], k: int, j: int, g: float, flag: bool, mode: Literal[1, 2]', ...pre, 't = 0', 'for x in items:', '    for y in items:', '        t += 1', 'return t')
  const behind = (test: string): Unit => root(`if ${test}:`, '    return 0')
  expect(answer(behind('k > 3'))).toBe('O(n²)')
  expect(answer(behind('k > 3 and j < 2'))).toBe('O(n²)')
  expect(answer(behind('flag'))).toBe('O(n²)')
  expect(answer(behind('not flag or g > 2'))).toBe('O(n²)')
  for (const test of ['mode == 3', 'flag == 2', 'k * 0 > 1', 'k % 2 == 3', 'k + 1 > 3', 'not (k > 3 or k < 5)', 'k > 3 and k < 2', 'k == 3.5', 'abs(k) < 0']) {
    expect(answer(behind(test))).toBe(undefined)
  }
  // The same through a size-free local, through an earlier guard, and around a loop.
  expect(answer(root('c = k * 0', 'if c > 1:', '    return 0'))).toBe(undefined)
  expect(answer(root('c = 5', 'if c > 1:', '    return 0'))).toBe(undefined)
  expect(answer(root('c = k + 1', 'if k > 0:', '    return 0', 'if c > 5:', '    return 0'))).toBe(undefined)
  const inner = (test: string): Unit => fn('items: list[int], ids: list[int], k: int, mode: Literal[1, 2]', 't = 0', 'for x in items:', `    if ${test}:`, '        t += ids.count(x)', 'return t')
  expect(answer(inner('k > 0'))).toBe('O(n·m)')
  expect(answer(inner('mode == 3'))).toBe(undefined)
  expect(answer(inner('k * 0 == 1'))).toBe(undefined)
  expect(answer(fn('items: list[int], ids: list[int], k: int', 't = 0', 'if k > 0:', '    for x in items:', '        if k < 0:', '            t += ids.count(x)', 'return t'))).toBe(undefined)
})

test('self-review: a hidden exit in a root guard stands before the code after it', async () => {
  const lines = ['def f(items: list[int], k: int) -> int:', '    if k > 0:', '        …', '    t = 0', '    if k > 5:', '        for x in items:', '            t += x', '    return t']
  expect(answer({ ...py(...lines), hidden: (check) => check("        raise ValueError('bad')", 2) })).toBe(undefined)
  const other = lines.map((l) => l.replace('if k > 5', 'if t > 5').replace('t = 0', 't = 9'))
  expect(answer({ ...py(...other), hidden: (check) => check("        log('bad')", 2) })).toBe(undefined)
  expect(answer({ ...py(...lines.slice(0, 4), '    for x in items:', '        t += x', '    return t'), hidden: (check) => check("        raise ValueError('bad')", 2) })).toBe('O(n)')
})

test('self-review: a literal range runs at least once, or its body is dead', async () => {
  const around = (head: string): Unit => fn('a: list[int]', 't = 0', `for i in ${head}:`, '    for x in a:', '        t += x', 'return t')
  expect(answer(around('range(3)'))).toBe('O(n)')
  expect(answer(around('range(0, 10, 20)'))).toBe('O(n)')
  for (const head of ['range(0)', 'range(5, 2)', 'range(3, 3)', 'reversed(range(0))']) expect(answer(around(head))).toBe(undefined)
})

test('self-review: no sort of what the unit already sorted (Timsort reads a sorted run in linear time)', async () => {
  expect(answer(fn('a: list[int]', 's = list(a)', 'u = sorted(s)', 'return len(u)'))).toBe(undefined)
  expect(answer(fn('a: list[int]', 's = sorted(a)', 'u = sorted(s)', 'return len(u)'))).toBe(undefined)
  expect(answer(fn('a: list[int]', 's = sorted(a)', 't = 0', 'for x in sorted(s):', '    t += x', 'return t'))).toBe(undefined)
  expect(answer(fn('a: list[int]', 'a.sort()', 'u = sorted(a)', 'return len(u)'))).toBe(undefined)
  expect(answer(fn('a: list[int]', 'a.sort()', 'a.sort(reverse=True)', 'return 0'))).toBe(undefined)
  expect(answer(fn('a: list[int]', 'u = sorted(a)', 'return len(u)'))).toBe('O(n log n)')
})

test('self-review: == on an opaque value may compare whole containers', async () => {
  expect(answer(fn('items: list[list[int]]', 't = 0', 'for x in items:', '    for y in items:', '        if x == y:', '            t += 1', 'return t'))).toBe(undefined)
  expect(answer(fn('items: list[list[int]]', 't = 0', 'for x in items:', '    for y in items:', '        if x is None:', '            t += 1', 'return t'))).toBe('O(n²)')
})

// --- Lessons families (task-6-lessons.md) ------------------------------------------

test('family 1: indices and keys are never elements; a position reads an element only on its own walk', async () => {
  const exit = (head: string, test: string, params = 'a: list[int], b: list[int], v: int'): Unit => fn(params, 't = 0', `for ${head}:`, '    t += b.count(v)', `    if ${test}:`, '        break', 'return t')
  expect(answer(exit('x in a', 'x == v'))).toBe('O(n·m)')
  expect(answer(exit('i in range(len(a))', 'a[i] == v'))).toBe('O(n·m)')
  expect(answer(exit('i, x in enumerate(a)', 'x == v'))).toBe('O(n·m)')
  expect(answer(exit('i, x in enumerate(a)', 'i == v'))).toBe(undefined)
  expect(answer(exit('i in range(len(a))', 'i == v'))).toBe(undefined)
  expect(answer(exit('i in range(len(a))', 'b[i] == v'))).toBe(undefined)
  expect(answer(exit('i in range(1, len(a))', 'a[i] == v'))).toBe(undefined)
  expect(answer(exit('k in d', 'k == v', 'd: dict[int, int], b: list[int], v: int'))).toBe(undefined)
  expect(answer(exit('k, w in d.items()', 'w == v', 'd: dict[int, int], b: list[int], v: int'))).toBe(undefined)
  expect(answer(exit('x in sorted(a)', 'x == v'))).toBe(undefined)
  expect(answer(exit('x in list(a)', 'x == v'))).toBe(undefined)
})

test('family 2: a condition outside loops holds only literals, number parameters, len of a parameter and size-free locals', async () => {
  expect(answer(guarded('k > 3'))).toBe('O(n·m)')
  for (const test of ['items[0] == 1', 'helper(k)', 'k in items', 'sum(items) > 3', 'any(items)', 'len(set(items)) > 3', 'items.count(1) > 0', 'repo.ready()', '(k := 3) > 2', 'k is None', 'x > 3']) {
    expect(answer(guarded(test))).toBe(undefined)
  }
  // A size-free local, and one that is not (from a call, or written in a loop).
  expect(answer(fn('items: list[int], ids: list[int], k: int', 'j = k + 1', 'if j > 3:', '    return 0', 't = 0', 'for x in items:', '    for y in ids:', '        t += 1', 'return t'))).toBe('O(n·m)')
  expect(answer(fn('items: list[int], ids: list[int], k: int', 'j = abs(k)', 'if j > 3:', '    return 0', 't = 0', 'for x in items:', '    for y in ids:', '        t += 1', 'return t'))).toBe(undefined)
})

test('family 3 and gate 10: tiny guards pass; a size against anything but an index, or two sizes, fails', async () => {
  for (const test of ['not items', 'len(items) == 0', 'len(items) < 2', 'len(items) <= 1', 'k > 3 or not items']) {
    expect(answer(guarded(test))).toBe('O(n·m)')
  }
  for (const test of ['not items or not ids', 'len(items) > 16', 'len(items) == len(ids)', 'len(items) < k < len(ids)', 'min(len(items), len(ids)) > 0', 'len(items) + len(ids) > 3', 'items', 'len(items)']) {
    expect(answer(guarded(test))).toBe(undefined)
  }
  // A tiny guard that does costly work before leaving, or does not leave.
  expect(answer(fn('items: list[int], ids: list[int]', 'if not items:', '    return sum(ids)', 't = 0', 'for x in items:', '    t += x', 'return t'))).toBe(undefined)
  expect(answer(fn('items: list[int], ids: list[int]', 't = 0', 'if not items:', '    t = 1', 'for x in items:', '    t += x', 'return t'))).toBe(undefined)
  // A number parameter that bounds a loop is a size.
  expect(answer(fn('n: int', 'if n <= 1:', '    return 0', 't = 0', 'for i in range(n):', '    t += i', 'return t'))).toBe('O(n)')
  expect(answer(fn('n: int', 'if n > 99:', '    return 0', 't = 0', 'for i in range(n):', '    t += i', 'return t'))).toBe(undefined)
  // In a loop: an index against a size passes; an element or a counter against a size fails.
  expect(answer(fn('a: list[int]', 't = 0', 'for i in range(len(a)):', '    if i < len(a) - 1:', '        t += 1', 'return t'))).toBe('O(n)')
  expect(answer(fn('a: list[int]', 't = 0', 'for x in a:', '    if x < len(a):', '        t += 1', 'return t'))).toBe(undefined)
  expect(answer(fn('a: list[int]', 't = 0', 'for x in a:', '    if t > len(a):', '        break', '    t += 1', 'return t'))).toBe(undefined)
})

test('family 4: a local is a number only when every write is one', async () => {
  expect(answer(inLoop('t += x'))).toBe('O(n)')
  expect(answer(fn('items: list[int]', 'best = None', 'for x in items:', '    best = x', 'return best'))).toBe('O(n)')
  expect(answer(fn('items: list[int]', 'best = None', 'for x in items:', '    best = x', '    t = best + 1', 'return 0'))).toBe(undefined)
  expect(answer(fn('items: list[int]', 't = 0', 'for x in items:', '    v = helper(x)', '    t += v', 'return t'))).toBe(undefined)
  expect(answer(fn('items: list[int]', 't = []', 'for x in items:', '    t += x', 'return t'))).toBe(undefined)
  expect(answer(fn('items: list[int]', 't = 0', 'for x in items:', '    t = [x]', 'return t'))).toBe(undefined)
  expect(answer(fn('items: list[int]', 'r = [1]', 'for x in items:', '    r = r', 'return 0'))).toBe(undefined)
})

test('family 5: +, *, % and the rest take only numbers', async () => {
  expect(answer(inLoop('t += x * 3 - x % 2'))).toBe('O(n)')
  expect(answer(fn('words: list[str]', 't = 0', 'for w in words:', '    t += len(w)', 'return t'))).toBe('O(n)')
  for (const line of ['t += w', 's = w * 3', 's = w + w', 's = w % 3', 'u = -w']) {
    expect(answer(fn('words: list[str]', 't = 0', 'for w in words:', `    ${line}`, 'return t'))).toBe(undefined)
  }
  expect(answer(fn('words: list[str], n: int', 'return len([0] * n)'))).toBe(undefined)
  expect(answer(fn('a: set[int], b: set[int]', 'c = a - b', 'return len(c)'))).toBe(undefined)
  expect(answer(fn('a: list[int], b: list[int]', 'c = a + b', 'return len(c)'))).toBe(undefined)
})

test('family 6: a counted size is not size-free', async () => {
  expect(answer(fn('items: list[int]', 'c = 0', 'for x in items:', '    c += 1', 'if c > 16:', '    return 0', 't = 0', 'for x in items:', '    for y in items:', '        t += 1', 'return t'))).toBe(undefined)
  expect(answer(fn('items: list[int]', 'c = sum(items)', 'if c > 3:', '    return 0', 't = 0', 'for x in items:', '    for y in items:', '        t += 1', 'return t'))).toBe(undefined)
  expect(answer(fn('items: list[int]', 'c = len(items)', 'if c > 3:', '    return 0', 't = 0', 'for x in items:', '    for y in items:', '        t += 1', 'return t'))).toBe(undefined)
  expect(answer(fn('items: list[int], k: int', 'c = k', 'if c > 3:', '    return 0', 't = 0', 'for x in items:', '    for y in items:', '        t += 1', 'return t'))).toBe('O(n²)')
})

test('family 7: an element of a non-primitive type is opaque: compared, appended, never handed on', async () => {
  expect(answer(fn('items: list[list[int]]', 'out = []', 'for x in items:', '    out.append(x)', 'return out'))).toBe('O(n)')
  expect(answer(fn('items: list[Foo], k: int', 't = 0', 'for x in items:', '    if x.size == k:', '        t += 1', 'return t'))).toBe(undefined)
  expect(answer(fn('items: list[Foo], k: int', 'best = None', 'for x in items:', '    best = x.size', 'return best'))).toBe('O(n)')
  for (const line of ['t += len(x)', 'for y in x:', 'x.append(1)', 's = sorted(x)', 'seen.add(x)', 't += x', 'helper(x)', 't += len(x.tags)', 'x.tags.append(1)', 't += x[0]']) {
    const body = line.endsWith(':') ? [`    ${line}`, '        t += 1'] : [`    ${line}`]
    expect(answer(fn('items: list[list[int]]', 't = 0', 'seen = set()', 'for x in items:', ...body, '    t += 1', 'return t'))).toBe(undefined)
  }
  // An opaque value as a set key may be unhashable, and as a test its truth runs code.
  expect(answer(fn('items: list[Foo]', 'seen = set()', 't = 0', 'for x in items:', '    if x in seen:', '        t += 1', 'return t'))).toBe(undefined)
  expect(answer(fn('items: list[Foo]', 't = 0', 'for x in items:', '    if x:', '        t += 1', 'return t'))).toBe(undefined)
  // An alias of an opaque value stays opaque.
  expect(answer(fn('items: list[Foo]', 'best = None', 'for x in items:', '    best = x', 'return len(best)'))).toBe(undefined)
})

test('family 8: refused outright', async () => {
  const base = ['t = 0', 'for x in items:', '    t += x']
  expect(answer(fn('items: list[int]', ...base, 'return t'))).toBe('O(n)')
  for (const extra of ['global t', 'nonlocal t', 'del t', 'assert t > 0', 'yield t', 'await go()', 'raise ValueError()', 'import os', 'with go():', 'try:', 'class A:', 'def g():', 'g = lambda y: y', 'u = [*items]', 'u = exec(t)', 'u = eval(t)', 'u = getattr(t, t)', 'u = locals()', 'u = vars()', 'u = globals()', 'u = t.__class__', 'setattr(t, t, t)', 'u = (v := 3)', 'match t:', 'f(items)', 'u = [1, 2][0]', 't = 1; t = 2', 'u: int = 3']) {
    const block = extra.endsWith(':') ? [extra, '    pass'] : [extra]
    expect(answer(fn('items: list[int]', ...base, ...block, 'return t'))).toBe(undefined)
  }
  // Recursion and a decorator name are refused too.
  expect(answer(py('def f(items: list[int]) -> int:', '    t = 0', '    for x in items:', '        t += f(items[1:])', '    return t'))).toBe(undefined)
})

test('family 9: no method on a str or an int; list builtins at their cost', async () => {
  for (const line of ['t += len(w.upper())', 's = w.join(w)', 's = w.split()', 's = w.replace(w, w)', 't += w.count(w)', 't += w.find(w)', 's = w * k', 's = w.ljust(k)', 't += k.bit_length()', 't += len(w.strip())']) {
    expect(answer(fn('words: list[str], k: int', 't = 0', 'for w in words:', `    ${line}`, '    t += 1', 'return t'))).toBe(undefined)
  }
  expect(answer(fn('words: list[str], k: int', 't = 0', 'for w in words:', '    t += len(w)', 'return t'))).toBe('O(n)')
})

test('family 10: an exit counts only as a positive == on an int, float or str element', async () => {
  const exit = (test: string, type = 'list[int]'): Unit => fn(`a: ${type}, b: list[int], v: int`, 't = 0', 'for x in a:', '    t += b.count(v)', `    if ${test}:`, '        break', 'return t')
  expect(answer(exit('x == v'))).toBe('O(n·m)')
  expect(answer(exit('x == 3'))).toBe('O(n·m)')
  expect(answer(exit('v == x'))).toBe('O(n·m)')
  expect(answer(exit('x == 3', 'list[float]'))).toBe('O(n·m)')
  for (const test of ['x != v', 'x < v', 'x > 3', 'x is v', 'x in b', 'x', 'not x', 'x == v or x != v', 'x == x', 't == 3', 'x == t']) {
    expect(answer(exit(test))).toBe(undefined)
  }
  expect(answer(exit('x == True', 'list[bool]'))).toBe(undefined)
  expect(answer(exit('x == 1', 'list[Literal[1, 2]]'))).toBe(undefined)
  expect(answer(exit('x == 1', 'list[Color]'))).toBe(undefined)
  // Unconditional, or in an if/else whose every branch leaves; dead code after a return.
  expect(answer(fn('a: list[int], b: list[int]', 't = 0', 'for x in a:', '    t += b.count(x)', '    break', 'return t'))).toBe(undefined)
  expect(answer(fn('a: list[int], b: list[int], v: int', 't = 0', 'for x in a:', '    t += b.count(x)', '    if x == v:', '        break', '    else:', '        return 0', 'return t'))).toBe(undefined)
  expect(answer(fn('a: list[int]', 't = 0', 'for x in a:', '    t += x', 'return t', 't = 1'))).toBe(undefined)
  // Costly work behind the exit's test, or in the branch that leaves.
  expect(answer(fn('a: list[int], b: list[int], v: int', 't = 0', 'for x in a:', '    if x == v:', '        break', '    t += b.count(x)', 'return t'))).toBe(undefined)
  expect(answer(fn('a: list[int], b: list[int], v: int', 't = 0', 'for x in a:', '    t += x', '    if x == v:', '        return sum(b)', 'return t'))).toBe(undefined)
})

test('family 11: a Literal parameter is never a size or a loop source', async () => {
  expect(answer(fn('mode: Literal[1, 2], a: list[int]', 't = 0', 'for x in a:', '    if mode == 1:', '        t += 1', 'return t'))).toBe('O(n)')
  expect(answer(fn('mode: Literal[1, 2]', 't = 0', 'for i in range(mode):', '    t += 1', 'return t'))).toBe(undefined)
  expect(answer(fn('mode: Literal[1, 2], a: list[int]', 't = 0', 'for x in a:', '    t += len(mode)', 'return t'))).toBe(undefined)
})

test('family 12: unknown calls cost 1 only through module names and helpers', async () => {
  expect(answer(inLoop('repo.save(x)'))).toBe('O(n)')
  expect(answer(inLoop('helper(x, 3)'))).toBe('O(n)')
  expect(answer(inLoop('t += math.floor(x)'))).toBe(undefined)
  expect(answer(inLoop('u = math.floor(x)'))).toBe('O(n)')
  for (const line of ['helper(items)', 'helper(x, key=1)', 'repo.db.save(x)', 'u = repo.size', 'items.foo()', 'x.bit_length()', 'list.append(ids, x)', 'self.save(x)']) {
    expect(answer(inLoop(line))).toBe(undefined)
  }
  expect(answer(fn('items: list[int]', 't = 0', 'for x in repo.rows():', '    t += 1', 'return t'))).toBe(undefined)
  expect(answer(fn('items: list[int]', 't = 0', 'for i in range(repo.size()):', '    t += 1', 'return t'))).toBe(undefined)
  // A bare module name or constant as a value.
  expect(answer(inLoop('t += LIMIT'))).toBe(undefined)
})

test('family 13: nothing changes a loop\'s source or bound', async () => {
  expect(answer(inLoop('ids.count(x)'))).toBe('O(n·m)')
  for (const line of ['items.append(x)', 'items.extend(ids)', 'items.pop()', 'items.remove(x)', 'items += [x]', 'items[0] = x', 'ids = items']) {
    expect(answer(inLoop(line))).toBe(undefined)
  }
})

// --- Naming, category, explanation ---------------------------------------------

test('n and m, a number parameter by value, the explanation names shown lines', async () => {
  const r = costOf(fn('items: list[int], ids: list[int]', 't = 0', 'for x in items:', '    t += ids.count(x)', 'return t'))
  expect(r?.answer).toBe('O(n·m)')
  expect(r?.n).toBe('items')
  expect(r?.m).toBe('ids')
  expect(r?.explanation).toBe('Line 3: loop over items; line 4: count on ids. n × m = O(n·m).')
  const c = costOf(fn('n: int', 't = 0', 'for i in range(n):', '    t += i', 'return t'))
  expect(c?.numeric).toEqual(['n'])
  // Constant work is no puzzle.
  expect(answer(fn('a: int, b: int', 'c = a + b', 'return c * 2'))).toBe(undefined)
})

test('blanked lines in the untrimmed unit are read at their place; the explanation counts from the shown offset', async () => {
  const lines = ['def f(items: list[int]) -> int:', '    …', '    t = 0', '    for x in items:', '        t += x', '    return t']
  const u: Unit = { lang: 'Python', name: 'f', lines: lines.slice(2), full: { lines, offset: 2 }, hidden: check => check('    """Sum."""', 1) }
  expect(costOf(u)?.explanation).toBe('Line 2: loop over items. n = O(n).')
})
