import { expect, test } from 'claude-code/testing'
import { costOf } from '../src/puzzle/complexity'
import type { Unit } from '../src/puzzle/units'

// Invented code only (SPEC 15). Each refusal sits beside an accepted near
// variant, so a test fails until the reader reads the accepted shape.

const php = (...lines: string[]): Unit => ({ lang: 'PHP', name: /function\s+(\w+)/.exec(lines[0]!)![1]!, lines })
const answer = (u: Unit) => costOf(u)?.answer

/** A function `f` with the given parameters and body lines (indented by four), its body opening on its own line. */
const fn = (params: string, ...body: string[]): Unit => php(`function f(${params}): int`, '{', ...body.map((l) => `    ${l}`), '}')
const AB = 'array $items, array $ids'
/** A loop over `$items` whose body is `line`, then `$t++`, inside `f(array $items, array $ids)`. */
const inLoop = (line: string, params = AB): Unit => fn(params, '$t = 0;', 'foreach ($items as $x) {', `    ${line}`, '    $t++;', '}', 'return $t;')
/** A root guard on `test` that returns, before two nested loops over `$items` and `$ids`. */
const guarded = (test: string, params = `${AB}, int $k, bool $b, bool $c`): Unit => fn(params, `if (${test}) {`, '    return 0;', '}', '$t = 0;', 'foreach ($items as $x) {', '    foreach ($ids as $y) {', '        $t++;', '    }', '}', 'return $t;')
/** `$t = 0`, then a guard on `test` around two nested loops over `$items` and `$ids`. */
const around = (test: string, params = `${AB}, int $k, bool $b, bool $c`): Unit => fn(params, '$t = 0;', `if (${test}) {`, '    foreach ($items as $x) {', '        foreach ($ids as $y) {', '            $t++;', '        }', '    }', '}', 'return $t;')

// --- The brief's tests ---------------------------------------------------------

test('foreach, in_array, sorts', async () => {
  expect(answer(php('function f(array $items, array $ids): int', '{', '    $t = 0;', '    foreach ($items as $x) {', '        if (in_array($x, $ids)) {', '            $t++;', '        }', '    }', '    return $t;', '}'))).toBe('O(n·m)')
  expect(answer(php('function f(array $items): array', '{', '    sort($items);', '    return $items;', '}'))).toBe('O(n log n)')
  expect(answer(php('function f(array $items, array $keys): int', '{', '    $t = 0;', '    foreach ($items as $x) {', '        if (isset($keys[$x])) {', '            $t++;', '        }', '    }', '    return $t;', '}'))).toBe('O(n)')
})

test('fails closed on the adversarial review counterexamples', async () => {
  // An unlisted global (substr) inside a loop (round 1, #4).
  expect(answer(php('function f(string $text): array', '{', '    $out = [];', '    for ($i = 0; $i < strlen($text); $i++) {', '        $out[] = substr($text, $i);', '    }', '    return $out;', '}'))).toBe(undefined)
  // array_merge inside a loop (round 1, #9).
  expect(answer(php('function f(array $a, array $b): array', '{', '    $out = [];', '    foreach ($a as $x) {', '        $out = array_merge($out, $b);', '    }', '    return $out;', '}'))).toBe(undefined)
  // Two-argument max is not a scan (round 1, #9).
  expect(answer(php('function f(array $a, int $lo): int', '{', '    $t = 0;', '    foreach ($a as $x) {', '        $t = max($t, $lo);', '    }', '    return $t;', '}'))).toBe('O(n)')
  // A closure outside a callback position.
  expect(answer(php('function f(array $a): int', '{', '    $g = fn($x) => in_array($x, $a);', '    $t = 0;', '    foreach ($a as $x) {', '        $t += $g($x) ? 1 : 0;', '    }', '    return $t;', '}'))).toBe(undefined)
  // By-reference parameter.
  expect(answer(php('function f(array &$a): int', '{', '    $t = 0;', '    foreach ($a as $x) {', '        $t += $x;', '    }', '    return $t;', '}'))).toBe(undefined)
  // Element assignment to a parameter grows it (round 2, #4).
  expect(answer(php('function f(array $a): int', '{', '    foreach ($a as $k => $x) {', '        $a[$k . $k] = $x;', '    }', '    return count($a);', '}'))).toBe(undefined)
})

// --- Signature (gate 3) --------------------------------------------------------

test('the signature: typed parameters (nullable, union) with literal defaults, over several lines, with modifiers', async () => {
  const body = ['$t = 0;', 'foreach ($items as $x) {', '    $t++;', '}', 'return $t;']
  for (const p of ['array $items', '?array $items', 'array|null $items', 'null|array $items', 'array $items = []', 'array $items, int $k = 3', 'array $items, ?int $k = null', 'array $items, bool $b = false', 'array $items, float $r = -1.5', 'array $items,']) {
    expect(answer(fn(p, ...body))).toBe('O(n)')
  }
  expect(costOf(fn('array $items, int $k = 3', ...body))?.params).toEqual(['$items', '$k'])
  expect(answer(php('public static function f(array $items): int', '{', ...body.map((l) => `    ${l}`), '}'))).toBe('O(n)')
  expect(answer(php('function f(array $items): int {', ...body.map((l) => `    ${l}`), '}'))).toBe('O(n)')
  expect(answer(php('function f(', '    array $items,', '    int $k,', '): int {', ...body.map((l) => `    ${l}`), '}'))).toBe('O(n)')
  // By-reference, variadic, promoted, untyped and other-typed iterated parameters fail.
  for (const p of ['array &$items', 'array ...$items', '...$items', 'public array $items', 'private readonly array $items', 'readonly array $items', '$items', 'iterable $items', 'Collection $items', 'array|Collection $items', 'mixed $items', 'string $items', 'array $items, $items', 'array $items = [1]']) {
    expect(answer(fn(p, ...body))).toBe(undefined)
  }
  expect(answer({ lang: 'PHP', name: 'f', lines: ['function &f(array $items): int', '{', ...body.map((l) => `    ${l}`), '}'] })).toBe(undefined)
  // A signature longer than the limit, or a body that does not open with a brace.
  expect(answer(php('function f(', ...Array.from({ length: 12 }, (_, k) => `    int $p${k},`), '    array $items', '): int {', ...body.map((l) => `    ${l}`), '}'))).toBe(undefined)
})

test('a method never reads $this, and never calls itself', async () => {
  expect(answer(php('public function f(array $items): int', '{', '    $t = 0;', '    foreach ($items as $x) {', '        $t += $this->weight;', '    }', '    return $t;', '}'))).toBe(undefined)
  expect(answer(php('public function f(array $items): int', '{', '    $t = 0;', '    foreach ($items as $x) {', '        $t += $this->score($x);', '    }', '    return $t;', '}'))).toBe(undefined)
  for (const call of ['f($items)', 'F($items)', 'self::f($items)', 'static::F($items)']) {
    expect(answer(php('function f(array $items): int', '{', '    $t = 0;', '    foreach ($items as $x) {', `        $t += ${call};`, '    }', '    return $t;', '}'))).toBe(undefined)
  }
})

// --- The loop table ----------------------------------------------------------

test('foreach over a parameter or a derived value, with or without a key', async () => {
  expect(answer(fn('array $a', '$t = 0;', 'foreach ($a as $k => $x) {', '    $t++;', '}', 'return $t;'))).toBe('O(n)')
  expect(answer(fn('array $a', '$v = array_values($a);', '$t = 0;', 'foreach ($v as $x) {', '    foreach ($a as $y) {', '        $t++;', '    }', '}', 'return $t;'))).toBe('O(n²)')
  expect(answer(fn('array $a, array $b', '$t = 0;', 'foreach ($a as $x) {', '    foreach ($b as $y) {', '        $t++;', '    }', '}', 'return $t;'))).toBe('O(n·m)')
  expect(answer(fn('array $a, array $b', '$t = 0;', 'foreach ($a as $x) {', '    $t++;', '}', 'foreach ($b as $y) {', '    $t++;', '}', 'return $t;'))).toBe('O(n + m)')
  expect(answer(fn('array $a', '$t = 0;', 'foreach ($a as $x) {', '    foreach ($a as $y) {', '        foreach ($a as $z) {', '            $t++;', '        }', '    }', '}', 'return $t;'))).toBe('O(n³)')
  // By reference, over an accumulator, over a string, over an element, a key and value of one name.
  expect(answer(fn('array $a', '$t = 0;', 'foreach ($a as &$x) {', '    $t++;', '}', 'return $t;'))).toBe(undefined)
  expect(answer(fn('array $a', '$out = [];', 'foreach ($a as $x) {', '    $out[] = $x;', '}', '$t = 0;', 'foreach ($out as $y) {', '    $t++;', '}', 'return $t;'))).toBe(undefined)
  expect(answer(fn('string $s', '$t = 0;', 'foreach ($s as $c) {', '    $t++;', '}', 'return $t;'))).toBe(undefined)
  expect(answer(fn('array $a', '$t = 0;', 'foreach ($a as $x) {', '    foreach ($x as $y) {', '        $t++;', '    }', '}', 'return $t;'))).toBe(undefined)
  expect(answer(fn('array $a', '$t = 0;', 'foreach ($a as $x => $x) {', '    $t++;', '}', 'return $t;'))).toBe(undefined)
  // A loop name read after its loop, or reused by a nested loop.
  expect(answer(fn('array $a', '$t = 0;', 'foreach ($a as $x) {', '    $t++;', '}', 'return $x;'))).toBe(undefined)
  expect(answer(fn('array $a', '$t = 0;', 'foreach ($a as $x) {', '    foreach ($a as $x) {', '        $t++;', '    }', '}', 'return $t;'))).toBe(undefined)
})

test('counting for: from 0 or 1, by one, to count, strlen or a number parameter; down from the bound', async () => {
  for (const head of ['$i = 0; $i < count($a); $i++', '$i = 1; $i < count($a); ++$i', '$i = 0; $i <= count($a) - 1; $i += 1', '$i = 0; $i < $n; $i++', '$i = count($a) - 1; $i >= 0; $i--', '$i = count($a); $i > 0; --$i', '$i = 0; $i < strlen($s); $i++']) {
    expect(answer(fn('array $a, int $n, string $s', '$t = 0;', `for (${head}) {`, '    $t++;', '}', 'return $t;'))).toBe('O(n)')
  }
  for (const head of ['$i = 2; $i < count($a); $i++', '$i = 0; $i < count($a); $i += 2', '$i = 0; $i < count($a); $i--', '$i = 0; $i > count($a); $i++', '$i = 0; $j < count($a); $i++', '$i = 0; $i < count($a) * 2; $i++', '$i = count($a) - 3; $i < count($a); $i++', '$i = 0; $i < $x; $i++', '$i = 0, $j = 0; $i < count($a); $i++', ';;', '$i = 0; ; $i++', '$i = 0; $i < count($a); $i++, $t++', '$i = 0; $i < count($a); $i = $i + 1', '$i = 0; $i != count($a); $i++']) {
    expect(answer(fn('array $a, float $x', '$t = 0;', `for (${head}) {`, '    $t++;', '}', 'return $t;'))).toBe(undefined)
  }
  // The index is never written in the body.
  expect(answer(fn('array $a', '$t = 0;', 'for ($i = 0; $i < count($a); $i++) {', '    $i++;', '}', 'return $t;'))).toBe(undefined)
  expect(answer(fn('array $a', '$t = 0;', 'for ($i = 0; $i < count($a); $i++) {', '    $i = 0;', '}', 'return $t;'))).toBe(undefined)
})

test('inner bounds: an enclosing index, or a start from it; never under a halving loop', async () => {
  expect(answer(fn('array $a', '$t = 0;', 'for ($i = 0; $i < count($a); $i++) {', '    for ($j = 0; $j < $i; $j++) {', '        $t++;', '    }', '}', 'return $t;'))).toBe('O(n²)')
  expect(answer(fn('array $a', '$t = 0;', 'for ($i = 0; $i < count($a); $i++) {', '    for ($j = $i + 1; $j < count($a); $j++) {', '        $t++;', '    }', '}', 'return $t;'))).toBe('O(n²)')
  expect(answer(fn('array $a, array $b', '$t = 0;', 'for ($i = 0; $i < count($b); $i++) {', '    for ($j = $i; $j < count($a); $j++) {', '        $t++;', '    }', '}', 'return $t;'))).toBe(undefined)
  expect(answer(fn('int $n', '$t = 0;', 'for ($i = 1; $i < $n; $i *= 2) {', '    for ($j = 0; $j < $i; $j++) {', '        $t++;', '    }', '}', 'return $t;'))).toBe(undefined)
})

test('halving loops: up by doubling, down by halving', async () => {
  for (const head of ['$i = 1; $i < $n; $i *= 2', '$i = 1; $i <= $n; $i <<= 1', '$i = $n; $i > 0; $i = intdiv($i, 2)', '$i = $n; $i > 0; $i >>= 1', '$i = 1; $i < count($a); $i *= 2']) {
    expect(answer(fn('int $n, array $a', '$t = 0;', `for (${head}) {`, '    $t++;', '}', 'return $t;'))).toBe('O(log n)')
  }
  expect(costOf(fn('int $n', '$t = 0;', 'for ($i = 1; $i < $n; $i *= 2) {', '    $t++;', '}', 'return $t;'))?.category).toBe('halving')
  for (const head of ['$i = 0; $i < $n; $i *= 2', '$i = 1; $i < $n; $i *= 1', '$i = 1; $i < $n; $i *= $n', '$i = $n; $i > 0; $i = intdiv($i, 1)', '$i = $n; $i >= 0; $i >>= 1', '$i = $n; $i > 0; $i = $i / 2', '$i = 1; $i > $n; $i *= 2']) {
    expect(answer(fn('int $n', '$t = 0;', `for (${head}) {`, '    $t++;', '}', 'return $t;'))).toBe(undefined)
  }
})

test('a literal loop is constant; every other while, do and endless loop fails', async () => {
  expect(answer(fn('array $a', '$t = 0;', 'for ($i = 0; $i < 10; $i++) {', '    foreach ($a as $x) {', '        $t++;', '    }', '}', 'return $t;'))).toBe('O(n)')
  expect(answer(fn('array $a', '$t = 0;', 'for ($i = 0; $i < 0; $i++) {', '    foreach ($a as $x) {', '        $t++;', '    }', '}', 'return $t;'))).toBe(undefined)
  expect(answer(fn('array $a', '$t = 0;', 'while ($t < count($a)) {', '    $t++;', '}', 'return $t;'))).toBe(undefined)
  expect(answer(fn('array $a', '$t = 0;', 'while (true) {', '    $t++;', '}', 'return $t;'))).toBe(undefined)
  expect(answer(fn('array $a', '$t = 0;', 'do {', '    $t++;', '} while ($t < count($a));', 'return $t;'))).toBe(undefined)
  // A body on the header line, or a body without braces.
  expect(answer(fn('array $a', '$t = 0;', 'foreach ($a as $x) $t++;', 'return $t;'))).toBe(undefined)
  expect(answer(fn('array $a', '$t = 0;', 'foreach ($a as $x) { $t++; }', 'return $t;'))).toBe(undefined)
  expect(answer(fn('array $a', '$t = 0;', 'foreach ($a as $x)', '{', '    $t++;', '}', 'return $t;'))).toBe(undefined)
  // A statement that spans lines.
  expect(answer(fn('array $a, array $b', '$t = 0;', 'foreach ($a as $x) {', '    $t = $t +', '        count($b);', '}', 'return $t;'))).toBe(undefined)
})

// --- Binary search ------------------------------------------------------------

test('binary search: each mid form, lower bound and inclusive shapes', async () => {
  for (const mid of ['intdiv($lo + $hi, 2)', '($lo + $hi) >> 1']) {
    expect(answer(fn('array $items, int $x', '$lo = 0;', '$hi = count($items) - 1;', 'while ($lo <= $hi) {', `    $mid = ${mid};`, '    if ($items[$mid] < $x) {', '        $lo = $mid + 1;', '    } else {', '        $hi = $mid - 1;', '    }', '}', 'return $lo;'))).toBe('O(log n)')
  }
  expect(answer(fn('array $items, int $x', '$lo = 0;', '$hi = count($items);', 'while ($lo < $hi) {', '    $mid = intdiv($lo + $hi, 2);', '    if ($items[$mid] < $x) {', '        $lo = $mid + 1;', '    } else {', '        $hi = $mid;', '    }', '}', 'return $lo;'))).toBe('O(log n)')
  // lo = mid loops forever; mid reassigned; the wrong hi for the test; another mid form.
  expect(answer(fn('array $items, int $x', '$lo = 0;', '$hi = count($items);', 'while ($lo < $hi) {', '    $mid = intdiv($lo + $hi, 2);', '    if ($items[$mid] < $x) {', '        $lo = $mid;', '    } else {', '        $hi = $mid;', '    }', '}', 'return $lo;'))).toBe(undefined)
  expect(answer(fn('array $items, int $x', '$lo = 0;', '$hi = count($items) - 1;', 'while ($lo <= $hi) {', '    $mid = intdiv($lo + $hi, 2);', '    $mid = $lo;', '    if ($items[$mid] < $x) {', '        $lo = $mid + 1;', '    } else {', '        $hi = $mid - 1;', '    }', '}', 'return $lo;'))).toBe(undefined)
  expect(answer(fn('array $items, int $x', '$lo = 0;', '$hi = count($items) - 1;', 'while ($lo < $hi) {', '    $mid = intdiv($lo + $hi, 2);', '    if ($items[$mid] < $x) {', '        $lo = $mid + 1;', '    } else {', '        $hi = $mid - 1;', '    }', '}', 'return $lo;'))).toBe(undefined)
  expect(answer(fn('array $items, int $x', '$lo = 0;', '$hi = count($items) - 1;', 'while ($lo <= $hi) {', '    $mid = ($lo + $hi) / 2;', '    if ($items[$mid] < $x) {', '        $lo = $mid + 1;', '    } else {', '        $hi = $mid - 1;', '    }', '}', 'return $lo;'))).toBe(undefined)
  // An equality exit reads an untyped element (lessons family 12): it fails.
  expect(answer(fn('array $items, int $x', '$lo = 0;', '$hi = count($items) - 1;', 'while ($lo <= $hi) {', '    $mid = intdiv($lo + $hi, 2);', '    if ($items[$mid] === $x) {', '        return $mid;', '    }', '    if ($items[$mid] < $x) {', '        $lo = $mid + 1;', '    } else {', '        $hi = $mid - 1;', '    }', '}', 'return -1;'))).toBe(undefined)
})

// --- Builtins -----------------------------------------------------------------

test('linear builtins in a loop cost the size; case does not matter', async () => {
  for (const line of ['if (in_array($x, $ids)) {', 'if (IN_ARRAY($x, $ids)) {', 'if (in_array($x, $ids, true)) {', 'if (!in_array($x, $ids)) {']) {
    expect(answer(fn(AB, '$t = 0;', 'foreach ($items as $x) {', `    ${line}`, '        $t++;', '    }', '}', 'return $t;'))).toBe('O(n·m)')
  }
  for (const line of ['$v = array_search($x, $ids);', '$t += array_sum($ids);', '$t += count(array_keys($ids));', '$t += count(array_values($ids));', '$t += count(array_reverse($ids));', '$t += count(array_flip($ids));', '$v = max($ids);', '$v = min($ids);', '$t += count(array_slice($ids, 1));']) {
    expect(costOf(inLoop(line))?.answer).toBe('O(n·m)')
    expect(costOf(inLoop(line))?.category).toBe('hidden linear call')
  }
  // in_array with a non-literal strict flag, or a needle that is a collection.
  expect(answer(inLoop('$v = in_array($x, $ids, $x);'))).toBe(undefined)
  expect(answer(inLoop('$v = in_array($ids, $items);'))).toBe(undefined)
  // array_slice with a length, array_keys with a search value.
  expect(answer(inLoop('$t += count(array_slice($ids, 1, 2));'))).toBe(undefined)
  expect(answer(inLoop('$t += count(array_keys($ids, $x));'))).toBe(undefined)
})

test('constant builtins: count, strlen, isset, array_key_exists, array_key_first, scalar max and min', async () => {
  for (const line of ['$t += count($ids);', '$v = isset($ids[$x]);', '$v = array_key_exists($x, $ids);', '$v = array_key_first($ids);', '$v = array_key_last($ids);', '$t = max($t, 1);', '$t = min($t, 1, 2);', '$t = abs($t);', '$t = intdiv($t, 2);']) {
    expect(answer(inLoop(line))).toBe('O(n)')
  }
  for (const line of ['$t = intdiv($t, 0);', '$t = intdiv($t, $t);', '$t = abs($x);', '$t += strlen($x);', '$t += count($x);', '$t = max($t, $x);', '$t = $t % 0;', '$t = $t / $t;', '$t = $t % 2;']) {
    expect(answer(inLoop(line))).toBe(line === '$t = $t % 2;' ? 'O(n)' : undefined)
  }
})

test('sorts: in place on a parameter, once, as a statement outside loops', async () => {
  for (const s of ['sort', 'rsort', 'asort', 'arsort', 'ksort', 'krsort', 'SORT']) {
    expect(answer(php('function f(array $items): array', '{', `    ${s}($items);`, '    return $items;', '}'))).toBe('O(n log n)')
  }
  expect(costOf(php('function f(array $items): array', '{', '    sort($items);', '    return $items;', '}'))?.category).toBe('sorting')
  for (const s of ['usort', 'uasort', 'uksort']) {
    expect(answer(fn('array $items', `${s}($items, fn($p, $q) => $p <=> $q);`, 'return count($items);'))).toBe('O(n log n)')
  }
  expect(answer(fn('array $items', 'usort($items, fn($p, $q) => $q <=> $p);', 'return count($items);'))).toBe('O(n log n)')
  // A comparator that is not the plain spaceship, or a named one.
  for (const cmp of ['fn($p, $q) => in_array($p, $items) <=> 0', 'fn($p, $q) => $p - $q', 'fn($p, $q) => $p <=> $p', '$cmp', 'function ($p, $q) { return $p <=> $q; }']) {
    expect(answer(fn('array $items, int $cmp', `usort($items, ${cmp});`, 'return count($items);'))).toBe(undefined)
  }
  // Twice, in a loop, on an accumulator, with flags, as a value.
  expect(answer(fn('array $items', 'sort($items);', 'rsort($items);', 'return count($items);'))).toBe(undefined)
  expect(answer(fn('array $items, array $ids', '$t = 0;', 'foreach ($ids as $y) {', '    sort($items);', '}', 'return $t;'))).toBe(undefined)
  expect(answer(fn('array $items', '$out = [];', 'foreach ($items as $x) {', '    $out[] = $x;', '}', 'sort($out);', 'return count($out);'))).toBe(undefined)
  expect(answer(fn('array $items', 'sort($items, 1);', 'return count($items);'))).toBe(undefined)
  expect(answer(fn('array $items', '$ok = sort($items);', 'return count($items);'))).toBe(undefined)
})

test('callbacks: array_map, array_filter and array_reduce bodies run once per element', async () => {
  expect(answer(fn(AB, '$m = array_map(fn($x) => in_array($x, $ids), $items);', 'return count($m);'))).toBe('O(n·m)')
  expect(costOf(fn(AB, '$m = array_map(fn($x) => in_array($x, $ids), $items);', 'return count($m);'))?.category).toBe('hidden linear call')
  expect(answer(fn(AB, '$m = array_filter($items, fn($x) => in_array($x, $ids));', 'return count($m);'))).toBe('O(n·m)')
  expect(answer(fn(AB, '$m = array_filter($items, fn($x) => !isset($ids[$x]));', '$t = 0;', 'foreach ($m as $x) {', '    foreach ($m as $y) {', '        $t++;', '    }', '}', 'return $t;'))).toBe('O(n²)')
  expect(answer(fn('array $items', '$m = array_filter($items);', '$t = 0;', 'foreach ($m as $x) {', '    foreach ($items as $y) {', '        $t++;', '    }', '}', 'return $t;'))).toBe('O(n²)')
  expect(answer(fn('array $items', '$s = array_reduce($items, fn($c, $x) => $c + 1, 0);', 'return $s;'))).toBe('O(n)')
  expect(answer(fn('array $items', '$m = array_map(fn($x) => $x, $items);', '$t = 0;', 'foreach ($m as $y) {', '    $t++;', '}', 'return $t;'))).toBe('O(n)')
  // Two arrays, a variable or block callback, a callback in the wrong place, a body that reaches what it may not.
  expect(answer(fn(AB, '$m = array_map(fn($x, $y) => $x, $items, $ids);', 'return count($m);'))).toBe(undefined)
  expect(answer(fn(`${AB}, int $cb`, '$m = array_map($cb, $items);', 'return count($m);'))).toBe(undefined)
  expect(answer(fn(AB, '$m = array_map(function ($x) {', '    return $x;', '}, $items);', 'return count($m);'))).toBe(undefined)
  expect(answer(fn(AB, '$m = array_map(function ($x) use ($ids) { return $x; }, $items);', 'return count($m);'))).toBe(undefined)
  expect(answer(fn(AB, '$m = array_filter(fn($x) => in_array($x, $ids), $items);', 'return count($m);'))).toBe(undefined)
  expect(answer(fn(AB, '$m = array_map(fn($x) => $x + 1, $items);', 'return count($m);'))).toBe(undefined)
  expect(answer(fn(AB, '$m = array_map(fn($x) => fn($y) => $y, $items);', 'return count($m);'))).toBe(undefined)
  expect(answer(fn(AB, '$m = array_map(static fn($x) => $x, $items);', 'return count($m);'))).toBe(undefined)
  expect(answer(fn(AB, '$m = array_map(fn(int $x) => $x, $items);', 'return count($m);'))).toBe(undefined)
  expect(answer(fn(AB, '$m = array_map(fn(&$x) => $x, $items);', 'return count($m);'))).toBe(undefined)
  expect(answer(fn('array $items', '$s = array_reduce($items, fn($c, $x) => $c + $x, 0);', 'return $s;'))).toBe(undefined)
  expect(answer(fn('array $items', '$s = array_reduce($items, fn($c, $x) => $c + 1, []);', 'return $s;'))).toBe(undefined)
})

test('predicates take the condition grammar and are never constant (lessons family 10)', async () => {
  const nested = (pred: string): Unit => fn(`${AB}, int $k, bool $b`, `$m = array_filter($items, ${pred});`, '$t = 0;', 'foreach ($m as $x) {', '    foreach ($m as $y) {', '        $t++;', '    }', '}', 'return $t;')
  expect(answer(nested('fn($x) => $k > 0'))).toBe('O(n²)')
  expect(answer(nested('fn($x) => $b && isset($ids[$x])'))).toBe('O(n²)')
  for (const pred of ['fn($x) => false', 'fn($x) => 0 > 1', 'fn($x) => !true', 'fn($x) => $k > 0 && 0 > 1', 'fn($x) => $k > 0 && $k < 0', 'fn($x) => $b && !$b', 'fn($x) => $k > 0 && -0', 'fn($x) => $k > 0 && 1 - 1', 'fn($x) => !($k > 0 || 1 > 0)', 'fn($x) => $x === $k', 'fn($x) => $x', 'fn($x) => in_array($x, $items)', 'fn($x) => in_array($x, $ids) && in_array($x, $ids)', 'fn($x) => $k > 0 ? true : false', 'fn($x) => $k == 1']) {
    expect(answer(nested(pred))).toBe(undefined)
  }
})

test('unlisted global functions refuse, as do the copying and string builtins', async () => {
  for (const call of ['array_merge($ids, $ids)', 'array_unique($ids)', 'array_column($ids, 0)', 'str_repeat($s, 2)', 'implode($s, explode($s, $s))', 'str_split($s)', 'substr($s, 1)', 'strpos($s, $s)', 'str_contains($s, $s)', 'str_replace($s, $s, $s)', 'range(1, 10)', 'helper($x)', 'call_user_func($s)', 'compact($s)', 'func_get_args()', 'array_push($ids, 1)', 'array_pop($ids)', 'array_shift($ids)', 'iterator_to_array($ids)', 'array_fill(0, 3, 0)']) {
    expect(answer(inLoop(`$v = ${call};`, `${AB}, string $s`))).toBe(undefined)
  }
  expect(answer(inLoop('$v = implode($s, $ids);', `${AB}, string $s`))).toBe('O(n·m)')
})

// --- Parameters, copies and accumulators (gate 9, lessons families 14, 15) ------

test('a parameter is never written; an array local is never aliased; accumulators only grow', async () => {
  expect(answer(fn('array $a', '$out = [];', 'foreach ($a as $x) {', '    $out[] = $x;', '}', 'return $out;'))).toBe('O(n)')
  expect(answer(fn('array $a', '$seen = [];', 'foreach ($a as $x) {', '    $seen[$x] = true;', '}', 'return count($seen);'))).toBe('O(n)')
  expect(answer(fn('array $a', '$out = [];', 'foreach ($a as $x) {', '    $out = [];', '}', 'return $out;'))).toBe('O(n)')
  for (const line of ['$a[] = 1;', '$a[0] = 1;', '$a = [];', '$n++;', '$n += 1;', '$n = 0;', 'array_push($a, 1);', 'unset($a[0]);', 'array_pop($a);', 'array_splice($a, 0, 1);', '$b = $a;', '$b = $out;', '$out = $a;', '$out[] = $out;', '$out[$out] = 1;', '$out += $a;', '$out = $out + $a;']) {
    expect(answer(fn('array $a, int $n', '$out = [];', 'foreach ($a as $x) {', `    ${line}`, '}', 'return count($out);'))).toBe(undefined)
  }
  // A local's first write must run before every read.
  expect(answer(fn('array $a, int $k', '$t = 0;', 'if ($k > 0) {', '    $u = 1;', '}', 'foreach ($a as $x) {', '    $t += $u;', '}', 'return $t;'))).toBe(undefined)
  expect(answer(fn('array $a', 'foreach ($a as $x) {', '    $t++;', '}', 'return 0;'))).toBe(undefined)
})

// --- Receivers (lessons family 9) ---------------------------------------------

test('a method on a variable refuses; a static call on a class costs 1 with no lvalue argument', async () => {
  expect(answer(inLoop('$v = Repo::find(1);'))).toBe('O(n)')
  expect(answer(inLoop('$v = Repo::find($t + 1);'))).toBe('O(n)')
  for (const line of ['$v = Repo::find($x);', '$v = Repo::find($t);', '$v = Repo::find($ids);', '$v = $ids->count();', '$v = $x->id;', '$v = $x->score();', '$v = $x?->id;', '$v = $x::find(1);', '$v = Repo::$cache;', '$v = Repo::LIMIT;', '$v = Process::kill(1);', '$v = Repo::terminate(1);', '$v = Repo::find(...$ids);', '$v = Repo::find(id: 1);']) {
    expect(answer(inLoop(line))).toBe(undefined)
  }
})

// --- Opaque elements (lessons family 8) ------------------------------------------

test('an element is opaque: compared, used as a key or appended, and nothing else', async () => {
  for (const line of ['$seen[$x] = 1;', '$out[] = $x;', '$v = isset($seen[$x]);', '$v = in_array($x, $ids);']) {
    expect(answer(fn(AB, '$seen = [];', '$out = [];', '$v = 0;', 'foreach ($items as $x) {', `    ${line}`, '}', 'return $v;'))).not.toBe(undefined)
  }
  for (const line of ['$v = $v + $x;', '$v += $x;', '$v = $x * 2;', '$v = -$x;', '$v = $x[0];', '$v = count($x);', '$v = strlen($x);', '$v = in_array(1, $x);', '$v = $x . $x;', '$v = abs($x);', '$v = max($x);', '$x++;', '$x = 1;']) {
    expect(answer(fn(AB, '$seen = [];', '$out = [];', '$v = 0;', 'foreach ($items as $x) {', `    ${line}`, '}', 'return $v;'))).toBe(undefined)
  }
})

// --- Arithmetic and strings (lessons families 5, 6, 19) ---------------------------

test('arithmetic takes proven numbers only; concatenation and string building refuse', async () => {
  expect(answer(inLoop('$t = $t * 2 - 1;'))).toBe('O(n)')
  for (const line of ['$t .= $t;', '$t = $t . 1;', '$t = $t ** 2;', '$t = $t << 1;', '$t = $t & 1;', '$t = $t | 1;', '$t = ~$t;', '$t = (int) $t;', '$t = $t ?? 0;', '$t ??= 0;', '$t = $t ? 1 : 0;', '$t = $t ?: 1;', '$t *= 2;', '$t = @count($ids);', '$t = $t <=> 1;', '$t = $t == 1;', '$t = $t xor 1;', '$t = $t and 1;', '$t = $t + [];', '$t = $t + null;', '$t = PHP_INT_MAX;']) {
    expect(answer(inLoop(line))).toBe(undefined)
  }
})

// --- Conditions (gate 10, lessons families 2, 3, 4) -------------------------------

test('root guards: int and bool parameters, sizes of parameters, size-free locals', async () => {
  for (const g of ['$k > 0', '$k > 0 && $b', '!$b', '$b || $c', '$k === 5', '$k !== 0']) expect(answer(guarded(g))).toBe('O(n·m)')
  expect(answer(fn(`${AB}, int $k`, '$j = $k + 1;', 'if ($j > 5) {', '    return 0;', '}', '$t = 0;', 'foreach ($items as $x) {', '    $t++;', '}', 'return $t;'))).toBe('O(n)')
  for (const g of ['count($items) > 16', 'count($items) < count($ids)', 'min(count($items), count($ids)) > 3', 'in_array(1, $items)', 'Repo::ready()', 'isset($items[0])', '$items', 'count($items) > $k', 'array_sum($items) > 0']) {
    expect(answer(guarded(g))).toBe(undefined)
  }
  // A size through a local (round 2, #7), and a local from a call or written in a loop.
  expect(answer(fn(AB, '$n = count($items);', 'if ($n > 16) {', '    return -1;', '}', '$t = 0;', 'foreach ($items as $x) {', '    foreach ($items as $y) {', '        $t++;', '    }', '}', 'return $t;'))).toBe(undefined)
  expect(answer(fn(AB, '$n = Repo::limit();', 'if ($n > 16) {', '    return -1;', '}', '$t = 0;', 'foreach ($items as $x) {', '    $t++;', '}', 'return $t;'))).toBe(undefined)
  expect(answer(fn(AB, '$n = 0;', 'foreach ($ids as $y) {', '    $n++;', '}', 'if ($n > 16) {', '    return -1;', '}', '$t = 0;', 'foreach ($items as $x) {', '    $t++;', '}', 'return $t;'))).toBe(undefined)
})

test('tiny guards that exit: count of 0 or 1, empty', async () => {
  for (const g of ['count($items) === 0', 'count($items) < 2', 'count($items) <= 1', 'empty($items)', 'count($ids) === 0']) expect(answer(guarded(g))).toBe('O(n·m)')
  // Not an exit, or not tiny.
  expect(answer(fn(AB, '$t = 0;', 'if (count($items) === 0) {', '    $t = 1;', '}', 'foreach ($items as $x) {', '    $t++;', '}', 'return $t;'))).toBe(undefined)
  expect(answer(guarded('count($items) < 3'))).toBe(undefined)
  expect(answer(guarded('count($items) == 0'))).toBe(undefined)
})

test('the read-once grammar: no constant guard, no value read twice, no ternary or loose test', async () => {
  for (const g of ['$k > 0 || 1 > 0', '$k > 0 || -1', '$k > 0 || true', '!($k > 0 && 0 > 1)', '$b || !$b', '$b === true || $b === false', '$b || $c || !$b', '$k > 0 || !(0 < $k)', '$k === $k', '($k > 0 ? 1 : 2) > 0', '$k > 0 ? true : true', '$k == 1', '$k != 1', '$k <> 1', '$k > 0.5', '1 > 0', 'true', '$k + 1 > 0', '$k * 2 > 0']) {
    expect(answer(guarded(g))).toBe(undefined)
  }
  for (const g of ['$k > 0 && 0 > 1', '$k > 0 && 1 - 1', '$k > 0 && -0', '!($k > 0 || 1 > 0)', '$k > 0 && $k < 0']) {
    expect(answer(around(g))).toBe(undefined)
  }
  expect(answer(around('$k > 0'))).toBe('O(n·m)')
})

test('costly work behind a test that varies by iteration fails', async () => {
  expect(answer(inLoop('if ($k > 0) { $t += count(array_keys($ids)); }', `${AB}, int $k`))).toBe(undefined)
  expect(answer(fn(`${AB}, int $k`, '$t = 0;', 'foreach ($items as $x) {', '    if ($k > 0) {', '        $t += array_sum($ids);', '    }', '}', 'return $t;'))).toBe('O(n·m)')
  for (const test of ['in_array($x, $ids)', '$t > 0', '$x === $k']) {
    expect(answer(fn(`${AB}, int $k`, '$t = 0;', 'foreach ($items as $x) {', `    if (${test}) {`, '        $t += array_sum($ids);', '    }', '}', 'return $t;'))).toBe(undefined)
  }
  // Behind a short-circuit, or after a continue on a varying test.
  expect(answer(fn(`${AB}, array $more`, '$t = 0;', 'foreach ($items as $x) {', '    if (isset($ids[$x]) && in_array($x, $more)) {', '        $t++;', '    }', '}', 'return $t;'))).toBe(undefined)
  expect(answer(fn(`${AB}, int $k`, '$t = 0;', 'foreach ($items as $x) {', '    if (in_array($x, $ids) && $k > 0) {', '        $t++;', '    }', '}', 'return $t;'))).toBe('O(n·m)')
  // One membership per test (read-once: the element is in both).
  expect(answer(fn(`${AB}, array $more`, '$t = 0;', 'foreach ($items as $x) {', '    if (in_array($x, $more) && isset($ids[$x])) {', '        $t++;', '    }', '}', 'return $t;'))).toBe(undefined)
  expect(answer(fn(AB, '$t = 0;', 'foreach ($items as $x) {', '    if (isset($ids[$x])) {', '        continue;', '    }', '    $t += array_sum($ids);', '}', 'return $t;'))).toBe(undefined)
})

// --- Exits (lessons family 12) -----------------------------------------------------

test('exits: a positive === on a string character keeps the worst case; anything else fails', async () => {
  const search = (test: string, exit = 'return $i;'): Unit => fn('string $s, string $c, array $items, int $k', `for ($i = 0; $i < strlen($s); $i++) {`, `    if (${test}) {`, `        ${exit}`, '    }', '}', 'return -1;')
  expect(answer(search('$s[$i] === $c'))).toBe('O(n)')
  expect(answer(search('$c === $s[$i]', 'break;'))).toBe('O(n)')
  for (const test of ['$s[$i] == $c', '$s[$i] !== $c', '$s[$i] < $c', '$s[$i] === $s[$i]', '$i === $k', '$s[$i] === $s', '$s[$i] === 1']) {
    expect(answer(search(test))).toBe(undefined)
  }
  // An element of an array is untyped, so it never exits (and neither does a membership).
  expect(answer(fn('array $items, int $k', 'foreach ($items as $i => $x) {', '    if ($x === $k) {', '        return $i;', '    }', '}', 'return -1;'))).toBe(undefined)
  expect(answer(fn(AB, 'foreach ($items as $x) {', '    if (in_array($x, $ids)) {', '        return true;', '    }', '}', 'return false;'))).toBe(undefined)
  // Unconditional, every branch, after the exit, a flag.
  expect(answer(fn('array $items', 'foreach ($items as $x) {', '    return 1;', '}', 'return 0;'))).toBe(undefined)
  expect(answer(search('$s[$i] === $c', 'return $i;'))).toBe('O(n)')
  expect(answer(fn('string $s, string $c', 'for ($i = 0; $i < strlen($s); $i++) {', '    if ($s[$i] === $c) {', '        return $i;', '    } else {', '        return -1;', '    }', '}', 'return -1;'))).toBe(undefined)
  expect(answer(fn('string $s, string $c', 'for ($i = 0; $i < strlen($s); $i++) {', '    if ($s[$i] === $c) {', '        return $i;', '        $c = $s;', '    }', '}', 'return -1;'))).toBe(undefined)
})

test('exit words and forms refuse: exit, die, goto, break N, continue N, exit-named calls', async () => {
  for (const line of ['exit;', 'exit(1);', 'Exit(1);', 'die();', 'DIE;', 'goto end;', 'break 2;', 'continue 2;', '$v = Proc::abort(1);', '$v = Repo::dieRoll(1);', '$v = pcntl_signal(1);']) {
    expect(answer(inLoop(line))).toBe(undefined)
  }
})

// --- Dynamic and reflective forms (lessons family 16) ---------------------------

test('dynamic, reflective and unlisted statement forms refuse', async () => {
  for (const line of ['$v = $$x;', '$v = ${x};', '$v = $g($x);', '$v = $ids->$m();', 'global $g;', 'static $c = 0;', '$y = &$x;', 'list($p, $q) = $ids;', '[$p, $q] = $ids;', '$v = new Repo();', '$v = clone $x;', '$v = match ($t) { 1 => 2 };', 'switch ($t) {', 'try {', '$v = yield $x;', 'include $x;', 'require $x;', 'echo $t;', 'print $t;', '$v = eval($x);', '$v = $x instanceof Repo;', '$t++; $t++;', 'declare(strict_types=1);', '$v = __LINE__;', '$v = function_exists($x);', '$v = (function () { return 1; })();']) {
    expect(answer(inLoop(line))).toBe(undefined)
  }
})

// --- Hidden lines (lessons family 13) ----------------------------------------------

test('hidden lines: comments and structure pass; PHP forms that run code fail', async () => {
  const lines = ['function f(array $items): int', '{', '    $t = 0;', '    foreach ($items as $x) {', '        …', '        $t++;', '    }', '    return $t;', '}']
  const withRaw = (raw: string): Unit => ({ ...php(...lines), hidden: (check) => check(raw, 4) })
  for (const raw of ['        // step', '        # step', '        /* step */', '        // a $ sign']) expect(answer(withRaw(raw))).toBe('O(n)')
  for (const raw of ['        #[Pure]', "        // ?><?php sleep(9);", "        # ?> <?php touch('x');", '        $note = <<<EOT', "        $t += in_array($x, $items); // 'x'", '        $t ??= 0;', '        log_step(1);', '        $u = 1;', '        return 1;', '        break;', "        throw new StepError('x');", '        exit(1);', '        die;', '        // foreach item', '        // count them', '        // $x']) {
    expect(answer(withRaw(raw))).toBe(undefined)
  }
  expect(answer(php(...lines))).toBe(undefined)
  // A string with an interpolation runs code; at the end of the function a plain literal return is an exit form.
  const end = ['function f(array $items): int', '{', '    $t = 0;', '    foreach ($items as $x) {', '        $t++;', '    }', '    …', '}']
  const atEnd = (raw: string): Unit => ({ ...php(...end), hidden: (check) => check(raw, 6) })
  expect(answer(atEnd("    return 'done';"))).toBe('O(n)')
  expect(answer(atEnd('    return "done $t";'))).toBe(undefined)
  expect(answer(atEnd('    return "done {$t}";'))).toBe(undefined)
  expect(answer(atEnd("    RETURN 'done';"))).toBe('O(n)')
  expect(answer(atEnd("    exit('done');"))).toBe('O(n)')
  expect(answer(atEnd('    return <<<EOT'))).toBe(undefined)
  expect(answer(atEnd("    return <<<'EOT'"))).toBe(undefined)
  // A hidden exit in a guard is no tail.
  const guard = ['function f(array $items): int', '{', '    if (empty($items)) {', '        …', '    }', '    $t = 0;', '    foreach ($items as $x) {', '        $t++;', '    }', '    return $t;', '}']
  expect(answer({ ...php(...guard), hidden: (check) => check("        throw new EmptyError('none');", 3) })).toBe(undefined)
})

test('a hidden opener is only an else, whose body costs 1 and never exits', async () => {
  const lines = (body: string): string[] => ['function f(array $items, array $ids, int $k): int', '{', '    $t = 0;', '    if ($k > 0) {', '        $t++;', '    } … {', `        ${body}`, '    }', '    foreach ($items as $x) {', '        $t++;', '    }', '    return $t;', '}']
  const at = (raw: string, body: string): Unit => ({ ...php(...lines(body)), hidden: (check) => check(raw, 5) })
  expect(answer(at('    } else { // other', '$t--;'))).toBe('O(n)')
  expect(answer(at('    } ELSE {', '$t--;'))).toBe('O(n)')
  expect(answer(at('    } else {', '$t += array_sum($ids);'))).toBe(undefined)
  expect(answer(at('    } else {', 'return 0;'))).toBe(undefined)
  expect(answer(at("    } elseif ($k < 0) { // 'x'", '$t--;'))).toBe(undefined)
  expect(answer(at("    } else if ($k < 0) { // 'x'", '$t--;'))).toBe(undefined)
})

// --- Probe findings (pinned) ------------------------------------------------------

test('keys are no positions for an inner bound; keywords and functions ignore case; implode takes a parameter separator', async () => {
  expect(answer(fn('array $items', '$t = 0;', 'foreach ($items as $i => $x) {', '    for ($j = 0; $j < $i; $j++) {', '        $t++;', '    }', '}', 'return $t;'))).toBe(undefined)
  expect(answer(fn('array $items', '$t = 0;', 'foreach ($items as $i => $x) {', '    $v = $items[$i];', '}', 'return $t;'))).toBe('O(n)')
  expect(answer(fn('array $items', '$t = 0;', 'FOREACH ($items AS $x) {', '    $t++;', '}', 'RETURN $t;'))).toBe('O(n)')
  expect(answer(inLoop('$t = COUNT($ids);'))).toBe('O(n)')
  expect(answer(fn(`${AB}, string $s`, '$v = $s;', 'foreach ($items as $x) {', '    $v = implode($v, $ids);', '}', 'return 0;'))).toBe(undefined)
  expect(answer(inLoop('$t = strlen(implode($s, $ids));', `${AB}, string $s`))).toBe('O(n·m)')
})

test('a membership atom reads an element bound over a parameter, in another parameter; an accumulator is no source', async () => {
  expect(answer(fn(AB, '$seen = [];', '$t = 0;', 'foreach ($items as $x) {', '    if (!isset($seen[$x])) {', '        $seen[$x] = true;', '    }', '}', 'return count($seen);'))).toBe(undefined)
  expect(answer(fn(AB, '$m = array_map(fn($x) => 1, $items);', '$t = 0;', 'foreach ($m as $y) {', '    if (in_array($y, $ids)) {', '        $t++;', '    }', '}', 'return $t;'))).toBe(undefined)
  expect(answer(fn(AB, '$m = array_filter($ids, fn($y) => !in_array($y, $items));', 'return count($m);'))).toBe('O(n·m)')
})

test('if chains: elseif, and an else on its own line; else if refuses', async () => {
  expect(answer(fn('array $items, int $k, bool $b', '$t = 0;', 'if ($k > 0) {', '    $t = 1;', '} elseif ($b) {', '    foreach ($items as $x) {', '        $t++;', '    }', '}', 'return $t;'))).toBe('O(n)')
  expect(answer(fn('array $items, int $k', '$t = 0;', 'if ($k > 0) {', '    $t = 1;', '}', 'else {', '    $t = 2;', '}', 'foreach ($items as $x) {', '    $t++;', '}', 'return $t;'))).toBe('O(n)')
  expect(answer(fn('array $items, int $k', '$t = 0;', 'if ($k > 0) {', '    $t = 1;', '} else if ($k < -5) {', '    $t = 2;', '}', 'foreach ($items as $x) {', '    $t++;', '}', 'return $t;'))).toBe(undefined)
  expect(answer(fn('array $items, int $k', '$t = 0;', 'if ($k > 0) {', '    $t = 1;', '} elseif ($k < -5) {', '    $t = 2;', '}', 'foreach ($items as $x) {', '    $t++;', '}', 'return $t;'))).toBe(undefined)
})

test('the explanation names PHP parameters with their $', async () => {
  const r = costOf(php('function f(array $items, array $ids): int', '{', '    $t = 0;', '    foreach ($items as $x) {', '        if (in_array($x, $ids)) {', '            $t++;', '        }', '    }', '    return $t;', '}'))
  expect(r?.n).toBe('$items')
  expect(r?.m).toBe('$ids')
  expect(r?.explanation).toBe('Line 4: loop over $items; line 5: in_array on $ids. n × m = O(n·m).')
})
