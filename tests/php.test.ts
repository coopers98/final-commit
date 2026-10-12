import { expect, test } from 'claude-code/testing'
import { PUZZLE } from '../src/config'
import { createRng } from '../src/rng'
import { buildBugHunt } from '../src/puzzle/bug-hunt'
import { missionUnits } from '../src/puzzle/material'
import { filterPhp, shownPhpLines } from '../src/puzzle/php-filter'
import { runnable } from '../src/puzzle/trace-gate'
import { PHP_ADAPTER, phpFunctionName } from '../src/puzzle/units'

// SPEC 8.3 rule 2 and 8.4: the PHP adapter. Invented code only (SPEC 15).

test('plain PHP lines show as written; a line with a string or comment is blanked to its indent and its code braces', async () => {
  const src = [
    '<?php',
    'function total(array $xs): int',
    '{',
    '    $t = 0;',
    "    if ($xs['owner'] === 'Jane Roe') { // patient",
    '        $t = $t + 1;',
    '    }',
    '    return $t;',
    '}',
  ].join('\n')
  expect(filterPhp(src, 'standard').split('\n')).toEqual([
    '…',
    'function total(array $xs): int',
    '{',
    '    $t = 0;',
    '    … {',
    '        $t = $t + 1;',
    '    }',
    '    return $t;',
    '}',
  ])
  expect(filterPhp(src, 'off')).toBe(src)
})

test('namespaces and attributes are code; docblocks are followed to their close', async () => {
  const lines = ['<?php', 'namespace Nova\\Billing;', 'use Nova\\Models\\Invoice;', '/**', ' * Owner: Jane Roe {', ' */', '#[Pure]', 'final class Ledger {', '    /* note */ public int $n = 0;', '}']
  const shown = shownPhpLines(lines)
  expect(shown.map(s => s.shown)).toEqual([false, true, true, false, false, false, false, true, false, true])
  // A brace in a comment is not structure; one after a comment closes is.
  expect(shown[4]!.braces).toBe('')
  expect(filterPhp(lines.join('\n'), 'standard').split('\n')[8]).toBe('    …')
})

test('wherever the scan cannot be sure, the rest of the file is blanked', async () => {
  const unsure = [
    // Not opened in PHP: inline HTML.
    ['<html>', 'zqA = 1;'],
    ['#!/usr/bin/env php', '<?php', '$zqB = 1;'],
    ['<?phpx', '$zqC = 1;'],
    // A closing tag: what follows is HTML.
    ['<?php', '$a = 1; ?>', 'zqD patient notes'],
    ['<?php', '// see ?> zqE', '$zqF = 1;'],
    ['<?php', "$s = '?>';", '$zqG = 1;'],
    // Strings that run on, or interpolate expressions that may hold quotes.
    ['<?php', "$s = 'run", 'zqH', "';"],
    ['<?php', '$s = "a{$b["k"]}', 'zqI', '";'],
    ['<?php', '$s = "a${b}', 'zqJ', '";'],
    ['<?php', '$s = "\\{$b["k"]} zqK";'],
    ['<?php', '$s = `ls {$d}', 'zqL', '`;'],
    ['<?php', '$s = "a\\"', 'zqM', '";'],
    ['<?php', '$s = "{$a->b(/* } */)} zqT";', '$zqU = 1;'],
    ['<?php', '$s = "{$a # }";', 'zqV', '";'],
    ['<?php', '$s = "{$a[\'k\']}";', 'zqW = 1;'],
    ['<?php', '$s = "{$a->b(<<<E', 'zqX', 'E)}";'],
    // Heredoc and nowdoc.
    ['<?php', '$s = <<<EOT', 'zqN', 'EOT;'],
    ['<?php', "$s = <<<'EOT'", 'zqO', 'EOT;'],
    // Security review: `#[` is a comment after `->` (and before PHP 8), so a `/*` in it opens nothing.
    ['<?php', 'echo $a->#[ see below /*', '    b;', '$x = "*/', 'zqY the deal closes friday', '"; // "'],
    ['<?php', '$a?->', '  #[ x /*', '  b;', '$x = "*/', 'zqZ', '"; // "'],
    ['<?php', '#[ legacy note /*', '$x = "*/', 'zqAA', '"; // "'],
    // Second review: in a `"$a[` index a quote does not end the string (a parse error, still filtered).
    ['<?php', '$x = "$a["] ;', 'zqAD secret words', '";'],
    ['<?php', '$x = `$a[`] ;', 'zqAE', '`;'],
    ['<?php', '$x = "$a[k k]";', 'zqAF = 1;'],
    // Third review: `\{$` is a literal `\{`, then a variable whose index a quote does not end.
    ['<?php', '$x = "\\{$a[}"] ;', 'zqAG secret words', '"; // "', '$y = 1;'],
    // PHP 5's other closing tags.
    ['<?php', '$a = 1; </script>', 'zqAB'],
    ['<?php', '$a = 1; %>', 'zqAC'],
    // Raw data after __halt_compiler.
    ['<?php', '__halt_compiler();', 'zqP'],
    ['<?php', '__HALT_COMPILER(); zqQ'],
    // A lone CR: PHP ends a `//` comment there.
    ['<?php', '// x\r/*', '$zqR = 1;', '*/'],
  ]
  for (const lines of unsure) {
    const out = filterPhp(lines.join('\n'), 'standard')
    expect(/zq/.test(out)).toBe(false)
    expect(out.split('\n').length).toBe(lines.length)
  }
})

test('a simple interpolated field ({$name}, properties, indexes, calls) is stepped over; the code after shows again', async () => {
  expect(shownPhpLines(['<?php', '$s = "Visit {$id} of {$v->owner->name()} at ${n}";', '$a = 1;']).map(s => s.shown)).toEqual([false, false, true])
  expect(shownPhpLines(['<?php', '$s = `ls {$dir[0]}`;', '$a = 1;']).map(s => s.shown)).toEqual([false, false, true])
  expect(shownPhpLines(['<?php', '$s = "$row[id] $row[0] $row[-1] $row[$k] $é[x]";', '$a = 1;']).map(s => s.shown)).toEqual([false, false, true])
})

test('an attribute line keeps no braces after its `#[`, and a closed one leaves the scan in code', async () => {
  expect(shownPhpLines(['<?php', '$o->#[ {}{{', '$a = 1;'])[1]!.braces).toBe('')
  expect(shownPhpLines(['<?php', "#[Route('/a', methods: ['GET'])]", 'function f() {']).map(s => s.shown)).toEqual([false, false, true])
})

test('a comment marker inside a string is string, and a quote inside a comment is comment', async () => {
  expect(shownPhpLines(['<?php', "$u = 'http://x';", '$a = 1;']).map(s => s.shown)).toEqual([false, false, true])
  expect(shownPhpLines(['<?php', "# it's fine", '$a = 1;']).map(s => s.shown)).toEqual([false, false, true])
  expect(shownPhpLines(['<?php', "// don't /*", '$a = 1;']).map(s => s.shown)).toEqual([false, false, true])
  expect(shownPhpLines(['<?php', '$s = "a /* b";', '$a = 1;']).map(s => s.shown)).toEqual([false, false, true])
  expect(shownPhpLines(['<?php', "$s = 'it\\'s';", '$a = 1;']).map(s => s.shown)).toEqual([false, false, true])
})

test('fuzz: PHP strings and comments in any arrangement never leak', async () => {
  const pieces = [
    "'zqS'", '"zqS"', '`zqS`', '"$zqS"', '"{$zqS}"', '"${zqS}"', '"{$a->b()}"', '{$', '${', '"{$a', '->#[', '$a->', '"$a[', '$a[', ']', '"$a[0]"', '"$a[k]"', '\\{$a[', '"\\{$a[}"', '%>', '</script>', '/* zqS */', '/*', '*/', '// zqS', '# zqS', '#[A]', '"', "'", '`',
    '\\', '\\\\', '$x = 1;', 'function f($a) {', '    return $a;', '}', '{', '(', ')', '<<<EOT', "<<<'EOT'", 'EOT;', '?>', '<?php',
    '\r', "'a\\'zqS'", '"a\\"zqS"', 'zz = 3;', '__halt_compiler();', 'Nova\\Zz',
  ]
  const rng = createRng(20261012)
  for (let n = 0; n < 4000; n += 1) {
    const lines = ['<?php']
    for (let l = 0, count = 1 + rng.int(5); l < count; l += 1) {
      const parts: string[] = []
      for (let k = 0, m = 1 + rng.int(4); k < m; k += 1) parts.push(rng.pick(pieces))
      lines.push(parts.join(' '))
    }
    const src = lines.join('\n')
    const out = filterPhp(src, 'standard')
    if (/zq/i.test(out)) throw new Error(`leak: ${JSON.stringify(src)} -> ${JSON.stringify(out)}`)
    expect(out.split('\n').length).toBe(src.split('\n').length)
  }
})

test('a file with a line over the limit is blanked whole', async () => {
  const out = filterPhp(`<?php\n$x = 1;\n${'a'.repeat(PUZZLE.maxLineChars + 1)}`, 'standard').split('\n')
  expect(out.every(l => l.trim() === '…')).toBe(true)
})

test('PHP functions: modifiers, a by-reference name, closures never', async () => {
  expect(phpFunctionName('    public static function total(array $xs): int')).toBe('total')
  expect(phpFunctionName('function &ref($a) {')).toBe('ref')
  expect(phpFunctionName('    abstract protected function load(int $id): ?Model;')).toBe('load')
  expect(phpFunctionName('    $f = function ($a) {')).toBe(undefined)
  expect(phpFunctionName('    $f = fn($a) => $a + 1;')).toBe(undefined)
})

test('PHP units: brace on the signature line or the next (PSR-12), multi-line signatures, abstract methods skipped', async () => {
  const src = [
    '<?php',
    'abstract class Scores',
    '{',
    '    abstract public function name(): string;',
    '',
    '    public function firstOver(',
    '        array $xs,',
    '        int $limit,',
    '    ): int {',
    '        $i = 0;',
    '        while ($i < count($xs) && $xs[$i] <= $limit) {',
    '            $i = $i + 1;',
    '        }',
    '        return $i === count($xs) ? -1 : $i;',
    '    }',
    '',
    '    private function untouched(int $a): int',
    '    {',
    '        $b = $a + 1;',
    '        $c = $b * 2;',
    '        return $c;',
    '    }',
    '}',
  ].join('\n')
  const filtered = filterPhp(src, 'standard')
  const units = PHP_ADAPTER.units(filtered, new Set([12]))
  expect(units.map(u => u.name)).toEqual(['firstOver'])
  expect(units[0]!.lines[0]).toBe('public function firstOver(')
  expect(units[0]!.lines.at(-1)).toBe('}')
  expect(units[0]!.lang).toBe('PHP')
  expect(PHP_ADAPTER.units(filtered, new Set([20])).map(u => [u.name, u.lines[1]])).toEqual([['untouched', '{']])
  // An abstract method never takes the next method's body.
  expect(PHP_ADAPTER.units(filtered, new Set([4, 12])).map(u => u.name)).toEqual(['firstOver'])
})

test('a body with blanked lines still closes where it should, by the braces they keep', async () => {
  const src = [
    '<?php',
    'function label(int $n): string',
    '{',
    "    if ($n === 0) { return 'none'; }",
    '    $m = $n * 2;',
    "    return $m > 9 ? 'many' : 'few';",
    '}',
    'function after(int $a): int',
    '{',
    '    return $a;',
    '}',
  ].join('\n')
  const units = PHP_ADAPTER.units(filterPhp(src, 'standard'), new Set([5]))
  expect(units.map(u => [u.name, u.lines.length])).toEqual([['label', 6]])
  expect(units[0]!.lines[2]).toBe('    … {}')
})

test('the PHP adapter claims .php files, not Blade templates', async () => {
  for (const p of ['a.php', 'app/Http/b.php']) expect(PHP_ADAPTER.claims(p)).toBe(true)
  for (const p of ['resources/views/a.blade.php', 'a.phtml', 'a.inc', 'a.ts']) expect(PHP_ADAPTER.claims(p)).toBe(false)
})

test('Bug Hunt in PHP changes one PHP operator and never the closing brace', async () => {
  const unit = { lang: 'PHP', name: 'f', lines: ['function f(array $xs, int $limit): int', '{', '    $i = 0;', '    while ($i < count($xs) && $xs[$i] <= $limit) {', '        $i = $i + 1;', '    }', '    return $i !== 0 ? $i : -1;', '}'] }
  for (let seed = 0; seed < 60; seed += 1) {
    const p = buildBugHunt([unit], createRng(seed))!
    const diff = p.code.map((l, i) => (l === unit.lines[i] ? -1 : i)).filter(i => i >= 0)
    expect(diff.length).toBe(1)
    expect(p.choices[p.answer]).toBe(`Line ${diff[0]! + 1}`)
    expect(diff[0]).not.toBe(unit.lines.length - 1)
  }
})

test('Trace does not run PHP yet', async () => {
  expect(runnable({ lang: 'PHP', name: 'f', lines: ['function f(int $a): int', '{', '    return $a + 1;', '}'] })).toBe(undefined)
})

test('mission material reads a changed .php file through the PHP filter', async () => {
  const php = ['<?php', 'function score(array $xs): int', '{', '    $total = 0;', "    $note = 'Jane Roe';", '    foreach ($xs as $x) {', '        $total = $total + $x;', '    }', '    return $total;', '}'].join('\n')
  const io = {
    git: async (args: readonly string[]) => {
      if (args[0] === 'rev-list') return { exitCode: 0, stdout: 'abc\n' }
      if (args.includes('--raw')) return { exitCode: 0, stdout: ':100644 100644 a b M\0app/score.php\0' }
      return { exitCode: 0, stdout: 'diff --git a/app/score.php b/app/score.php\n+++ b/app/score.php\n@@ -7 +7 @@\n' }
    },
    read: async () => php,
  }
  const units = await missionUnits(io, 0, 'strict')
  expect(units.map(u => [u.lang, u.name])).toEqual([['PHP', 'score']])
  expect(units[0]!.lines.join('\n')).not.toContain('Jane')
})

test('a function inside a heredoc is never a unit', async () => {
  const src = '<?php\n$s = <<<EOT\nfunction zq_secret($a)\n{\n    $b = $a + 1;\n    return $b;\n}\nEOT;'
  const units = PHP_ADAPTER.units(filterPhp(src, 'standard'), new Set([3, 4, 5, 6, 7]))
  expect(units.length).toBe(0)
})
