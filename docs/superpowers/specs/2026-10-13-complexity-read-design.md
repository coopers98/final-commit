# Complexity Read (design)

Date: 2026-10-13. Mission FC-25, epic FC-14. Status: approved after a self
review and two adversarial review rounds (17 + 15 findings, all taken;
see "Review outcome" at the end).

## Problem

SPEC 8 lists Complexity Read as the Uncommon puzzle ("Big-O of a function
from the diff", skill: cost analysis), and 8.4 lists it under "Not yet".
Today an Uncommon encounter falls back to Pattern ID, and with puzzles
`local` (the strict filter) to Trace or Bug Hunt. The player never trains
cost analysis.

## Decisions taken (with the user, 2026-10-13)

1. **Static and local.** The answer is worked out on the machine. No model
   call, no runner. The key is mechanical (SPEC 8.1): known by construction
   under the rule the question states.
2. **Code only.** TypeScript, Python and PHP. SQL and Markdown make none;
   SQL's version ("index use or full scan") is a later mission.
3. **Calls the reader cannot see are constant, by a stated rule**, and the
   built-in operations it knows are counted at their cost. Anything it
   cannot place fails closed: the function is skipped, never guessed.

## Goals

- A correct key every time, under the stated rule.
- Fires on ordinary diff code often enough to be worth having.
- Same pane, keys, accuracy record and dossier as the other types.

Non-goals: SQL, Markdown, recursion, space complexity, gutter marks, any
change to what the filters show.

## The puzzle

```
What is the time complexity of dedupe(items, ids)?
n = size of items, m = size of ids. Worst case. Built-in operations over
a whole collection (search, copy, sum, join, map, filter) cost its size;
sorts size × log size; hash lookups and appends 1; other calls 1.

  1) O(n·m)
  2) O(n + m)
  3) O(n²)
  4) O(n)
```

- **Line 1** names the unit by its name and its parameter names, without
  types, defaults or `$`-less changes (`merge($a, $b)`), cut to 160
  characters.
- **Line 2** defines every size the choices use: `n = size of items` (one
  input) or `n = size of items, m = size of ids`; for a number parameter,
  `n = count` (its value). A size is a collection's or string's length.
  Then the fixed rule text (config).
- **The ladder:** `O(log n)`, `O(n)`, `O(n log n)`, `O(n²)`, `O(n³)`,
  `O(n·m)`, `O(n + m)` as answers; `O(1)` only as a distractor. A cost that
  is constant, or does not reduce to one ladder entry, is no puzzle.
- **n and m:** n is the parameter the first size-dependent factor (in line
  order) depends on, m the other. A third parameter in the cost: no
  puzzle. An answer in m alone is renamed to n (the question then names
  only that parameter).
- **Choices:** the answer and three fixed neighbors (config), shuffled by
  the seeded rng:

  | Answer | Distractors |
  |---|---|
  | O(log n) | O(1), O(n), O(n log n) |
  | O(n) | O(log n), O(n log n), O(n²) |
  | O(n log n) | O(n), O(n²), O(log n) |
  | O(n²) | O(n), O(n log n), O(n³) |
  | O(n³) | O(n²), O(n log n), O(n) |
  | O(n·m) | O(n + m), O(n²), O(n) |
  | O(n + m) | O(n·m), O(n), O(n²) |

- **Explanation:** one line naming the sites that set the dominant term
  in line order (unit line index + 1, as the pane counts), e.g. `The loop
  on line 3 calls includes on items (line 5): n × n = O(n²).`

## What the reader reads

The pane's code is the filtered unit (`localUnits`). All three filters
blank a whole line holding a string literal or a comment (to `…` plus the
braces, or the indent, they proved to be code), and `readableUnit` trims
blanked lines from both ends. So most real functions have hidden lines.

**The reader reads the untrimmed unit.** Adapters return, with each unit,
the file line number of each of its lines. After gating, `material.ts`
attaches to each local unit:

```ts
/** The unit before trimming (filtered text: safe to keep), and where the shown lines start in it. */
full?: { lines: string[]; offset: number }
/** Runs `check` on the raw text of each blanked line of `full` (`at`: its index in `full.lines`);
 *  true when every call returned true. Any throw is caught and gives false. */
hidden?: (check: (raw: string, at: number) => boolean) => boolean
```

The reader analyzes `full.lines` (or `lines` when there is no `full`);
every blanked line, trimmed or not, sits at its real position and its
depth comes from its kept braces or indent. Sites are always shown lines
(hidden lines are inert, so never sites), and the explanation numbers
them as the pane does (`at - offset + 1`).

**Privacy.** The raw text is reachable only inside `hidden`: never a
field, so it does not serialize into the store, a prompt, the pane or a
dispute record, and only a boolean comes back. Checks never put raw text
in an error or a log, and `hidden` returns false on any throw. Only
`localUnits` carry `full` and `hidden`; prompt units never do. A unit
without `hidden` that has a blanked line (in `full`, or in `lines`) fails.

A hidden line passes only when it is **inert**:

1. **Structure:** TS and PHP: its raw text holds exactly the braces its
   blanked line kept, in the same order (braces inside its strings
   count: over-strict, so safe). Python: its raw indent equals the kept
   indent, its brackets balance, and it does not end in a backslash.
2. **Names:** it names nothing bound in the unit: no parameter, no local
   assigned on any line of the unit, no loop or comprehension variable,
   and not the unit's own name. Words inside its strings and comments
   count too.
3. **Words:** none of the loop words (`for`, `foreach`, `while`, `do`),
   closure or definition words (`=>`, `function`, `fn`, `lambda`, `def`,
   `class`, `yield`, `goto`), any builtin name on the lists below (counted,
   constant or failing) or any global builtin name of its language, and
   no spread or unpacking (`...`, `*` or `**` before a name).
4. **Exits:** an exit word (`return`, `break`, `continue`, `throw`,
   `raise`, `exit`, `die`) or an exit form passes only as the last
   statement of the function body at the root, after every loop (task 6
   fix round 3: never in a guard, since two guards with hidden exits may
   be complementary and always fire).
5. **Forms** (task 6 fix rounds 1 to 3): with its comments dropped, it
   is one of a closed set, so it can neither raise nor exit but where rule
   4 allows: empty (a comment); `pass`, an `else` or a close; in Python
   one plain string token (no `b`, `f` or `t` prefix, no implicit
   concatenation, no `\N{…}` escape; a docstring read across hidden lines
   in order, over blank lines only); and, under rule 4, `return` of
   nothing or a literal, `raise Name(literals)` / `throw new
   Name(literals)`, `break`, `continue`, or a call of an exit name with
   literal arguments. TS and PHP take no string statement: after an
   expression a template (or a string then a template) is a tagged
   template call. A hidden Python `else` must close a shown `if`, `for`
   or `while` at its indent. Anything else fails, calls and assignments
   included: a literal word or a host builtin raises when called
   (`None()`, `int('x')`, `atob('*')`), and a hidden name may shadow a
   helper the shown code calls (`log = 1`). So do arithmetic, subscripts,
   attribute reads, f-strings, template interpolation, and openers with a
   test (a hidden opener is only an `else`).

The answer then holds under the stated rule: a hidden line is a comment,
plain structure, a plain Python string, or an exit at the function's end,
so it does no work that could raise or cut a loop short.

## The reader (`src/puzzle/complexity.ts`)

Pure. `costOf(unit): Cost | undefined`: the answer, category, n and m
names, and the sites. One reader per language over a shared combiner. It
recognizes a closed set of shapes; **anything that could cost more than
constant and is not on the lists fails the unit**.

### Whole-unit gates

Skip the unit when:

1. its language is not TypeScript, Python or PHP;
2. a hidden line is not inert, or there is no `hidden` and a line is
   blanked;
3. the signature (lines from the first to the one that opens the body)
   does not hold one balanced parameter list of plain parameters: TS
   `name`, `name?`, with a type and default; Python `name` with an
   annotation and default; PHP `$name` with a type (nullable, union) and
   default. Destructured, rest (`...p`, `*args`, `**kw`), by-reference
   (`&$p`) and promoted constructor parameters fail. Python `self` and
   `cls` are not parameters (never sizes);
4. any line after the first holds `name(` for the unit's own name,
   whatever comes before it (recursion; a false match only skips);
5. it holds a closure or definition that is not the callback argument of
   a listed iteration builtin (below): TS `function`, `class`, or `=>`
   elsewhere; Python `def`, `class`, `lambda` (also as a `key=`); PHP
   `function`, `fn`, `class`;
6. it holds `goto`, `yield`, `await` in a loop header, `async for`,
   `eval`, `do`, `while (true)`/`while True`/`for (;;)`, a labeled
   statement, PHP `break N`/`continue N`, or a `for`/`while` with an
   `else` (Python);
7. a statement spans lines: a visible line that ends in `(`, `[`, `,`, a
   binary operator or `\`, or the next line starts with `.`, `?.` or
   `->`; in Python also a line with an unbalanced bracket. Lines ending
   in `{` open a block and are fine;
8. a loop has its body on its header line (`for (…) x++`, `for y in b:
   t += y`);
9. any assignment to a parameter (`=`, `+=`, `++`, `[] =`, element or
   key assignment `p[k] = …` / `$p[$k] = …`, slice assignment, `unset`), or a
   mutating call on one (`push`, `pop`, `shift`, `unshift`, `splice`,
   `sort` in place, `reverse`, `fill`, `append`, `extend`, `insert`,
   `remove`, `update`, `add`, `delete`, `set`, `clear`, `array_push`,
   `array_pop`, `array_shift`, `array_unshift`, `array_splice`, PHP's
   in-place sorts): the sizes would change under the loops. The in-place
   sort of a parameter is allowed only as a whole statement outside every
   loop, and costs n log n;
10. a condition compares a size (a bound B, a number parameter, or a
    local assigned from one, which is itself a size) with anything other
    than another parameter's size or an enclosing loop's index, except a
    guard that is true only for sizes at most 1 and exits:
    `p.length === 0`, `< 1`, `<= 1`, `< 2`, `!p.length`, `not p`,
    `empty($p)`, `count($p) === 0`, `len(p) == 0` and the like;
11. no loop and no counted builtin remains (no constant puzzles).

### Nesting and exits

- TS and PHP nest by braces (`blockEnds`); Python by indentation. A body
  without braces (TS/PHP) fails the unit.
- **Exits.** A loop with a `return`, `break`, `throw`, `raise`, `exit`
  or `die` at any depth of its body fails the unit when that exit is
  unconditional, or sits in an `if`/`elif`/`else` chain whose every branch
  exits, or in a `switch` whose `default` exits, or its condition reads
  anything but the loop's element (`x`, or `p[i]`, `p[mid]`: an element
  read through an index, never the index itself), parameters, derived
  values, and calls on them. Other conditional exits (a search that may
  find its target) keep the worst case. A callback's `return` is not an
  exit.

### Loops

| Shape | Factor |
|---|---|
| for-each over a size source S: `for (const x of S)`, `for (const k in S)`, `for x in S:`, `foreach (S as …)` | size(S) |
| counting up: one index named in all three clauses, starts at literal `0` or `1`, or at an enclosing loop's index ± a literal; condition `i < B` or `i <= B` (with `B - 1` allowed); step `i++`, `++i`, `i += 1`, `$i++`; Python `range(B)`, `range(A, B)` with A as above, `range(A, B, k)` with literal k ≥ 1 | size(B) |
| counting down: starts at `B` or `B - 1`, condition `i > L` / `i >= L` with literal L, step `i--`, `--i`, `i -= 1`; Python `range(B - 1, -1, -1)` and `reversed(range(…))` as above | size(B) |
| inner bound that is an enclosing counting or for-each loop's index (`j < i`, `range(i)`, `range(i + 1, n)` with n as above); never under a halving loop | the enclosing loop's factor |
| halving: `for (let i = 1; i < B; i *= 2)` (start a positive literal), `for (let i = B; i > 0; i = Math.floor(i / 2))` / `intdiv($i, 2)` (Python has no halving `for`); never a shift step (`<<=`, `>>=`, `>>>=`: a shift wraps, task 7 fix round 1) | log size(B) |
| binary search (below) | log size(S) |
| both ends literal | 1 |
| anything else (another `while`, an index assigned in the body, a step or a direction that does not match its condition, any other bound) | fails the unit |

A **size source** S is a parameter, a derived value, `Object.keys/values
/entries(S)`, `S.keys()/values()/entries()`, `S.items()`, `enumerate(S)`,
`reversed(S)`, `range(len(S))`. A **bound** B is `S.length`, `S.size`,
`len(S)`, `count(S)`, `strlen(S)` or a number parameter.

**Binary search:** `while (lo <= hi)` with `lo = 0`, `hi = len - 1` just
before it, or `while (lo < hi)` with `hi = len`; `mid` set first in the
body as one of `(lo + hi) >> 1`, `lo + ((hi - lo) >> 1)`, `Math.floor((lo
+ hi) / 2)` (TS; this line is often blanked by the filter, then the unit
fails), `(lo + hi) // 2`, `lo + (hi - lo) // 2`, `intdiv($lo + $hi, 2)`,
`($lo + $hi) >> 1`, where `len` is a bound B of the loop table; `mid` is
assigned exactly once in the body, and `lo`, `hi` and `mid` nowhere else
in the unit (callbacks included); every assignment to `lo` is `lo = mid + 1`; to `hi`
is `hi = mid - 1` (with `<=`) or `hi = mid` (with `<`); every path
through the body assigns `lo` or `hi`, or exits. Anything else fails.

A loop costs `factor × body`. A header that calls a counted builtin
(`for x in sorted(p)`) adds that cost once before the loop.

### Builtins

A **derived** value is a local assigned exactly once in the unit (in
every language: no other assignment, augmented assignment, element, key
or slice assignment, `[] =`, or mutating call on it, including TS
`const`), outside every loop, from one parameter by
a builtin that returns at most its size and takes no limit argument:
`filter`, `map`, `slice()` with no arguments, `toSorted`, `toReversed`,
`Array.from(p)`, `[...p]`, `Object.keys/values/entries(p)`, `sorted(p)`,
`list(p)`, `set(p)`, `p.copy()`, `array_filter`, `array_map` (one
array), `array_values`, `array_keys`, `array_reverse`.
Its size is its parameter's, reached in the worst case. An **accumulator**
is a local that starts empty (`[]`, `{}`, `new Set()`, `new Map()`, `set()`,
`dict()`, `[]` in PHP) and only grows by constant-cost appends; it is
never a size source, and anything but the listed constant operations on
it fails the unit.

**The size convention** (task 7 fix round 1). A size is a parameter's
element count: for an array, its length as passed (in PHP `count()` of the
array, whatever holes it was built with), and for a string, its length.
Comparing, hashing or copying one element costs 1, whatever the element
holds; so a key over arrays of arrays or of long strings understates by the
element size. That is a stated convention of the question, not a reading.
A number parameter's value is a finite size.

**Fixed-cost operands (ruling D′, task 7 fix round 2; it replaces fix
round 1's denylist of string parameters).** In every reader, an operand of
an equality or ordering comparison (`===`, `==`, `!==`, `!=`, `<`, `>`,
`<=`, `>=`, `<=>`), a membership needle (`in_array`, `array_search`,
`includes`, `indexOf`, `in`, `has`) or a key (`isset($m[k])`,
`$m[k] = …`, `m.get(k)`, `m.set(k, …)`, `d[k]`, `s.add(k)`) costs 1 only
when it is one of:

1. a number literal (within the cap below) or a plain string literal;
2. a parameter whose declared type is exactly a number type: TypeScript
   `number` (and `bigint`, which the reader reads as no number), Python
   `int`, `float` or `bool`, PHP `int`, `float` or `bool`, each optionally
   nullable;
3. a proven number local or a loop counter (a binary search's lo, hi and
   mid included);
4. an element (or a dict or array key) bound by a loop, or a listed
   callback's element parameter, directly over a parameter (never over a
   derived collection);
5. a read at a position that walks a parameter (`$s[$i]`, `s.charAt(i)`,
   `s[i]`, `p[i]`, a search's `S[mid]`);
6. arithmetic over 1 to 5, or `count`, `strlen`, `.length`, `.size` or
   `len` of a parameter.

Anything else refuses the unit: untyped, `mixed`, `any`, `unknown`, union,
alias, intersection, branded and literal types, `string` in any spelling,
an element's property, an opaque local, and elements of a derived
collection. A derived collection's callback (PHP `array_map` and
`array_filter`, TypeScript `map` and `filter`, every Python comprehension's
element, value and filters) names only its own parameters or targets,
literals and fixed-cost operands: `array_map(fn($y) => $s, $items)`,
`items.filter(x => ids.includes(x))` and `[y for y in a if y in b]` refuse
(a map's body is an expression, never a block; a comprehension's later
`for` clauses may still iterate other sources).

Every reader also refuses a
number literal beyond `COMPLEXITY.maxLiteral` (2^31 - 1) in magnitude, in
any form (float, exponent, hex, octal, binary): beyond a type's range a
literal is constant against it (PHP's 64-bit ints, TypeScript's `1e400`,
which is Infinity, any Python int below `1e400`), so a guard on it would be
always or never true.

**Typed receivers.** A method builtin counts only on a receiver whose
type the reader knows: a TS parameter typed as an array (`T[]`,
`readonly T[]`, `Array<T>`, `ReadonlyArray<T>`), `string`, `Set<T>`,
`Map<K, V>` (optionally `| undefined`/`| null`), or a derived value; a
Python parameter annotated `list`, `List`, `Sequence`, `tuple`, `str`,
`set`, `frozenset`, `dict`, `Mapping` (bare or subscripted, optionally
`Optional[...]` or `X | None`), or a derived value; a PHP parameter
typed `array` or `?array`. Each receiver type has a **closed method
list** (counted and constant below). On such a receiver, any other method
name fails the unit; on a `string` / `str` receiver only `length`, `at`,
`charAt`, `charCodeAt`, `codePointAt` and indexing are allowed (each 1).
A method on any other value of the function's own (an untyped
parameter, a parameter of a named, aliased, generic, union or other type
such as `Repo`, `Ids`, `T`, `Iterable`, `String`, a property such as
`this.items`, or a call's result) **fails the unit**, but the closed
O(1) list on a string or number value or a string or number literal
union (TypeScript ruling C below). Cost 1 by the rule applies only to
calls through unbound module names (`repo.fetch(x)`) and helpers, and in
PHP to `Class::method(…)` (a method on any `$variable` fails, and a PHP
helper is a global function, which is a closed list: see the PHP stricter
readings).
Iterating an untyped parameter with a for-each is allowed (size of p;
TypeScript only: the Python reader refuses it, see its stricter readings);
a literal-typed parameter (`'ab' | 'cd'`, `1 | 2`) is never a size,
a loop source or a `.length` size.
Global builtins are closed lists in every language: any call to a TS
global (`String`, `Number`, `Array`, `Object`, `JSON`, `Set`, `Map`,
`parseInt` and the rest of the ECMAScript globals), a Python builtin
function or a PHP global function that is not listed here fails the
unit; `Math.*` on scalars (no spread), `Number(x)`, `parseInt(x)`,
`Math.floor` and Python `abs`, `int`, `float`, `bool`, `len` cost 1.

Costs (S a typed parameter or derived value; n = size(S)):

- **Sort, n log n:** TS `S.sort(`, `S.toSorted(`; Python `sorted(S)`,
  `S.sort(`; PHP `sort($S)`, `rsort`, `asort`, `arsort`, `ksort`, `krsort`.
  A comparator or `key=` must be a constant-cost callback (no counted
  builtin, no loop) or the unit fails; PHP's `usort`, `uasort`, `uksort`
  take theirs second and follow the same rule.
- **Linear, n**, on an array-typed or derived S:
  - TS: `includes`, `indexOf`, `lastIndexOf`, `find`, `findIndex`,
    `findLast`, `findLastIndex`, `filter`, `map`, `reduce`, `reduceRight`,
    `some`, `every`, `forEach`, `slice()` with no arguments, `concat` with
    no arguments, `join`, `toReversed`, `entries`, `keys`, `values`;
    `Array.from(S)`, `Object.keys/values/entries(S)`, `new Set(S)`,
    `new Map(S)`, `[...S]`, `{...S}`, `JSON.stringify(S)`, `Math.max(...S)`,
    `Math.min(...S)`.
  - Python: `x in S` / `not in` with S typed `list`, `List`, `Sequence`
    or `tuple`; `S.index(`, `S.count(`, `S.copy()`, `S[:]`, `list(S)`,
    `set(S)`, `dict(S)`, `tuple(S)`, `sum(S)`, `min(S)`, `max(S)` (one
    argument), `any(S)`, `all(S)`.
  - PHP: `in_array($x, $S)`, `array_search($x, $S)`, `array_keys($S)`
    (one argument), `array_values`, `array_sum`, `array_reverse`,
    `array_flip`, `max($S)`, `min($S)` (one argument),
    `array_slice` with no length, `array_map($cb,
    $S)` (one array), `array_filter($S, $cb)`, `array_reduce($S, $cb)`.
  - The callback of `forEach`, `map`, `filter`, `find`, `findIndex`,
    `some`, `every`, `reduce` (TS), `array_map`, `array_filter`,
    `array_reduce` (PHP), and a single-line Python comprehension or
    generator expression whose `for` clauses each iterate a size source,
    is a loop body: the call costs n × the callback's cost, and counts as
    a loop for the category.
- **Constant, 1:** TS `.has`, `.get`, `.set`, `.add`, `.delete`, `.push`
  (of non-spread values), `.pop`, `.at`, `.length`, `.size`, `Math.*` on
  scalars; Python `len`, `.append`, `.add`, `.get`, `.pop()` with no
  argument, `.discard`, `x in S` with S typed `set`, `frozenset`, `dict`
  or `Mapping`, indexing `S[i]`; PHP `count`, `isset`, `array_key_exists`,
  `array_key_first`, `array_key_last`, `$x[] =`, `max`/`min` of scalars.
- **Fails the unit:** a listed name on a receiver as above; `flat`,
  `flatMap`, `split`, `replace`, `replaceAll`, `splice`, `indexOf` or
  `includes` on a `string`-typed S with a non-literal needle; Python
  `in` on `str`, or on an untyped or non-parameter operand; Python list
  repetition (`* k` where an operand is a list literal or sequence), list
  `+`/`+=`; `.pop(i)`, `.pop(0)`, `.insert(`, `.remove(` (Python);
  `Object.assign`, `JSON.parse`, `structuredClone`, `.flat`; PHP: any
  call to a global function (no `->`, `::` or `new`) not listed here,
  and `array_map` with more than one array; spread or unpacking of
  anything but a typed parameter or derived value, and any spread or
  unpacking into a call that grows a value (`push(...S)`, `extend(S)`,
  `array_push($x, ...$S)`, `array_merge`), `array_unique`; `+=` on a
  string-typed value inside a loop.
- Every other call (a helper, a method of a known non-collection type, a
  library function in TS or Python called through a module) costs 1 by
  the rule.

### Stricter readings (TypeScript reader, Task 4)

Where the rules above leave room, or a counterexample showed a wrong
key, the TypeScript reader takes the stricter reading. Each is a test.

- **Closed statement set.** Each shown line is a declaration (one name,
  `const`/`let`), an expression, `return`, `throw`, `break`, `continue`,
  or the header of `if`/`else`, `for`, a binary search `while`, or a
  block callback (`… => {` closed by a lone `})`). `switch`, `try`, `var`,
  destructuring declarations and object or method definitions fail.
- **Exits** must stand behind a test the input can make false at every
  iteration: `e === v` with `e` an element (or `p[i]`) and `v` a literal
  or a value from another source (another parameter, or the same source
  at an index that counts up from `i + 1`), or `S.includes(e)`/`S.has(e)`
  with S another parameter. `!==`, orderings and helper results do not
  qualify. A short-circuit callback (`find`, `findIndex`, `some`) needs the
  same of its test, `every` membership; a block body or a helper there
  fails. Elements of every enclosing loop count as elements.
- **Costly work behind a test** inside a loop counts at every iteration
  only when the tests on its path can all hold at once at every
  iteration: tests that do not vary (parameters, derived values), tests
  that avoid values (`!==`, not a member), or one test that chooses them
  (`===` on a source that may repeat, an ordering against another value,
  membership), and then no exit from those loops. Indices, locals, flags,
  helpers and hidden tests there fail. A branch that leaves a loop, a tiny
  guard's branch and a hidden if's body must cost 1. Code after an if
  whose branch may leave stands behind that branch's test being false.
- **Dead code.** A statement that always leaves (or an if/else whose
  every branch does) must be last in its body.
- **Sizes.** A number parameter is a size only where it can bound a loop
  (a counting header, or a local holding it, such as a search's `hi`);
  elsewhere it is a value. Tuple and object-literal types are never
  sizes. An untyped or other-typed parameter is iterated only outside
  every loop (it may be a one-shot iterator). A parameter of a string or
  number literal type or union is never a size, a loop source or a
  `.length` size (fix round 5). A count that starts at an
  enclosing index needs that loop to run over the same size.
- **Builtins.** `entries`, `keys` and `values` of an array are lazy:
  counted only as a for-of source. `includes`, `indexOf`, `lastIndexOf`
  and `join` take at most one argument (no start index; a `join`
  separator is a literal of constant length, never a string parameter, task
  7 fix round 1); `findLast` and
  `findLastIndex` fail. A `filter` gives a derived value only when its
  test can hold for every element. No mutating call reaches a parameter
  through an element, a loop variable or a call's result. Names may not
  shadow a global, a parameter or a visible loop name.
- **Conditions** with no names, a value compared with itself, or `a || !a`
  / `a && !a` fail. Two tests that do not vary and name the same value on
  one path, at any depth (`k > 0` then `k < 0`, or both in one `&&`), fail.
  Residual: a tautology the reader cannot see still counts its branch; an
  unknown name or helper in a test is read as able to take any value.

Allowlists (fix rounds 1 and 2). Each family names what is accepted;
everything else fails.

- **Exit and choose tests** read only an element bound directly by a loop
  or callback over a parameter, or over a filter of one, or its
  properties (`x`, `p[i]`, `x.id`). Elements of a map, copy, spread,
  `Array.from`, `Object.values` or any other derived collection, indices
  (`for…in`, `keys()`, `Object.keys`, an entry's first name, a callback's
  index) and whole entries are never atoms.
- **Conditions outside loops** (an if's test, and a `?:`, `&&` or `||`
  test guarding costly work) hold only literals, number and boolean
  parameters, `.length`/`.size` of a bare parameter, size-free locals and
  operators. A size-free local is declared outside loops from such a
  value and never written inside a loop or callback, nor with anything
  else. Any call, index, `in` or other member read there fails.
- **Reads by position** (`p[e]`, `.at`, `charAt`, `charCodeAt`,
  `codePointAt`, `e in p`) on a size source, a closed local, an array
  accumulator or any call's result take a loop's index (or `mid`, a key,
  a callback index) plus or minus a literal; a literal loop's index is a
  fixed position. `.length`/`.size` of anything but a parameter, a derived
  value or an element is a size the reader cannot name, and fails any test.
- **Sizes**: no test names two size sources, in any form, and no
  comparison has a size on both sides.
- **Contradictions**: two tests that do not vary and name the same value
  on one path, at any depth (or in one `&&`), fail.
- **Locals** are proven scalar (a number, boolean or string) or numeric
  where declared, by their initializer or a `number`/`string` annotation:
  literals, number and boolean parameters, sizes, primitive elements and
  indices, `Math.*`, `Number`, `parseInt`, the index searches, comparisons
  and arithmetic. Every later write must keep the proof. Any other local
  is closed-list: lookups and appends only (`has`, `get`, `at`, `push`,
  `add`, `set`, `delete`, `pop`), on itself and on anything reached
  through it (no mutating call there); its bare value is only tested,
  compared or returned. A local holding something reached through a
  parameter or loop name (not a fresh Set, Map or copy) is never mutated.
- **`+` and `+=`** take only proven numbers: number literals and
  parameters, numeric locals, indices, elements whose type is `number`,
  `.length`/`.size`, numeric calls, a reduce's accumulator from a number
  start, and arithmetic of these. A reduce starts from a number or an
  empty collection. NaN is no value a test can choose.
- **Opaque values**: an element whose type is not a primitive (`{…}[]`,
  `Foo[]`, a tuple, an untyped or other-typed parameter's, a Map's
  non-primitive values, a whole entry), its properties (not
  `.length`/`.size`) and its elements are opaque. One may be compared,
  used as a key (`has`, `get`, `add`, `set`, an accumulator's index) or
  pushed; it never takes a method call or `+`, is never handed to another
  call, spread or iterated. An alias of one (a declaration or assignment)
  is a closed local. A map's results are opaque.

Fix round 3 (default-refuse rules):

- **Element positions (A).** `p[i]` is an element of `p` only when `i`
  is the index of a counting loop from 0 while `i < p.length` by 1, or
  the index of `p.keys()`, `p.entries()` or a callback on `p` itself.
  Any other index (another source's, a literal, a start other than 0)
  reads no element.
- **No `async` or `await` (B).** Async functions, `await`, `yield` and
  generators fail.
- **Plain values (B).** A value is plain only when proven: a literal, a
  number or boolean parameter, element or element read, `.length`/`.size`,
  a proven-scalar local or loop number, and arithmetic or comparisons of
  these (`-`, `+`, `!`, `~`, `typeof` over such operands). Everything else,
  call results included, is opaque. A call is proven scalar only on a
  known collection kind whose listed method returns a number or boolean.
- **Methods on strings and numbers (C).** A string or number value
  (literal, scalar local, parameter, element) takes only `charAt`,
  `charCodeAt`, `codePointAt`, `at`, and `toFixed` with a literal
  argument. A value that is neither a known collection nor such a value
  takes no method. An unbound name (a module) keeps the rule: other calls
  cost 1. That rule covers only calls through unbound names and helpers.
  A method called on a parameter, a local, a loop element or a literal
  matches a known collection kind's listed builtins, or the closed list
  above on a string- or number-typed value or a string or number literal
  union (`'a' | 'b'`, `1 | 2`); any other receiver (a tuple or object
  type, an untyped or named type, `String`, any other union) refuses
  (fix round 4). Property reads are unchanged.
- **reduce (D).** The accumulator is a number only when its start is a
  number and every return of the callback is proven a number, assuming
  the accumulator is.
- **Element exits (E).** An exit counts only as `===`/`==` on a number or
  string element itself against a literal or a value from another
  source. `!==`, orderings, membership, properties, booleans, literal
  unions, named and other types fail. Several `===` exits on one element
  may be avoided together.
- **Binary search (F).** After `mid`: an optional equality exit (`S[mid]
  === v`, S any number or string source, v a literal or another
  parameter; a lone return or break), then one if/else on a comparison
  reading `mid` whose branches set exactly `lo` and `hi`, one each. Any
  other body fails.

Task 6 fix round 1 (raises and exits the input cannot avoid):

- **Property reads and writes** throw on null or undefined, so a read
  (`.length` and `.size` included) or a property or index write takes
  only a receiver that is never either: a typed collection parameter or
  derived value, an accumulator, a number, boolean or literal parameter,
  a loop's index or primitive element, an element of an object or array
  type (an object literal type, or a capitalized named type of two
  letters or more that is no global), a declared non-optional property
  of an object literal element type (`x.tags.length`), an element read of
  such a parameter, a local every write of which is never null (a
  literal, a fresh collection, a builtin's copy, index or string method
  result), or a helper's or module's result. Never a local that may hold
  null or an opaque value, a lookup's result (`m.get(k).a`), a chain
  through another property, `this`, or an untyped or other-typed
  parameter.
- **Exit calls.** No call whose function or method name holds an exit
  part, any case (`process.exit`, `process.reallyExit`, `lib.abort`,
  `lib.dieRoll`: the list is in config), or is an exit word.
- **Hidden lines** are closed forms (rule 5 under "What the reader
  reads"); a hidden opener is only an `else`.

Task 6 fix round 2:

- **Index reads** take the same receivers as property reads (never a
  null local: `v[x]`, `v['a']`). **Writes** to a property or index take
  only an accumulator or a local that only ever holds a fresh object or
  array (never a primitive: strict mode throws), and never `.length` or
  `.size`.
- **`toFixed`** takes a literal from 0 to 20 (beyond, a RangeError).
- **A name the signature uses as a type** (`Foo` in `items: Foo[]`) is
  never called (a class throws without `new`).

Task 6 fix round 3:

- **Conditions** with a literal (or fresh array, object, `new` or arrow)
  operand of `||`, `&&`, `??` or `!` fail (`k > 0 || true` always holds),
  in ifs and ternaries; outside loops no comparison names one value on
  both sides (`k !== k + 1`).
- **Bracket writes** take a number key on an array accumulator or a local
  that only ever holds an array literal: no string or template key
  (`v['length'] = -1`), no write on a Map, Set or object.
- **Scalar methods** match the receiver's proven type: `toFixed` on
  proven numbers, `charAt` and the other string methods on proven strings.
  A bigint (type or `10n` literal) is no number: mixing the two throws.
- **Exit names** fail as constructors too (`new Exit()`), and are matched
  after NFKC normalization (`lib.ｅxit`, `lib.ſignal`).

Task 6 fix round 4 (a condition grammar, so no guard is constant):

- **The grammar.** A test that guards an exit, costly work or a size
  takes it: every if or else-if test outside loops; inside loops, every
  test of a chain one of whose branches leaves, costs more than 1, holds a
  loop or callback, or names a size; a `while` test; a `?:` test whose
  arm costs more than 1 or names a size; the left operand of `&&` or `||`
  whose right does (`??` there fails); and the test of `find`,
  `findIndex`, `some` and `every`. Such a test is `&&`, `||` and `!`
  (parenthesized freely) over atoms. An atom is a bare boolean (a boolean
  parameter, element or local), a bare `.length`/`.size`, an element's
  membership in another source (as the exit rule reads it), or `A op B`
  with op `===`, `!==`, `==`, `!=`, `<`, `<=`, `>` or `>=`. Each side is
  one named value or one literal, and at least one side is named. Named
  values are a number, boolean or string parameter, a typed element, an
  element read `p[i]` at a loop's index, a loop number, a binary search's
  `lo`, `hi` or `mid`, a `.length`/`.size` of a source or string element,
  or a local never written after its declaration that holds one of these
  (a number plus or minus an integer literal), read through to it. A
  literal is an integer, signed or not, that is finite (not `1e400`, no
  float, no `Infinity` or `NaN`), or a string; its type matches the named
  side's (number with number, string with string), and two named sides
  share a type. A boolean takes no literal (`b === true` fails; write
  `b`) and only the equality operators. Ternaries, `typeof`, arithmetic
  (`1 - 1`, `k * 2`), calls other than membership, property chains
  (`x[0]`, `x.id`), `null`, `undefined` and every other form fail.
- **Read-once.** No named value, read through locals, is in two atoms of
  one test (`b || c || !b`, `items.length < 2 || items.length === 0`,
  `const m = k + 1` then `m > k`). Atoms that each vary over distinct
  values make a test that no input leaves always true or always false.
  The rules above still hold: root tests, size-free locals, no two sizes.

Task 6 fix round 5:

- **Predicates.** A `filter` test takes the grammar and the triviality
  check like a short-circuit test, wherever the filter stands: a filter
  that keeps nothing (`x => k > 0 && 0 > 1`) would otherwise be read as a
  full-size derived value. A predicate callback (`filter`, `find`,
  `findIndex`, `some`, `every`) with a block body or a named function
  fails, since its test cannot be read.
- **Logical assignments.** `&&=`, `||=` and `??=` fail: each is a hidden
  guard on its target (`t &&= ids.indexOf(k)` never calls when `t` is 0).
  Hidden lines already admit no assignment, in TypeScript and PHP alike.

Task 7 fix rounds 1 and 2:

- **No shift step** (`<<=`, `>>=`, `>>>=`): a 32-bit shift wraps.
- **Fixed-cost operands** (ruling D′ above, replacing fix round 1's
  string-parameter rule): every comparison operand, `in` needle,
  `includes`/`indexOf`/`lastIndexOf`/`has`/`get`/`set`/`add`/`delete`
  argument and index or bracket key is a finite number or plain string
  literal, a `number` parameter, a number local, loop number or search
  variable, an element bound directly over a parameter (not a derived
  value's, not a property), `p[i]`, `s.charAt(i)` (and `charCodeAt`,
  `codePointAt`, `at`) at an index that walks the parameter or a search's
  mid, or arithmetic over these or `.length`/`.size` of a parameter. A
  `boolean` or literal-union parameter is no operand. `map` and `filter`
  take an expression body naming only their own parameters (and methods of
  them) and fixed-cost operands.

### Stricter readings (Python reader, Task 6)

The Python reader applies the TypeScript families above as allowlists
from the start, and adds three hazards of its own: an exception the
input cannot avoid is an exit, integers grow without bound, and a local
read before its first assignment raises. Each is a test.

- **Closed statement set.** Each shown line is `name = value`,
  `name += value` or `-=`, `acc[key] = value`, a call, `return`, `break`,
  `continue`, `pass`, or the header of `if`/`elif`/`else`, `for` (one
  name, or two for `enumerate`/`items()`) or a binary search `while`.
  Tuple, chained and annotated assignment, `*=` and the other augmented
  operators, conditional expressions, `lambda`, walrus, slices, starred
  values, tuples, chained comparisons, strings, comments, `;`, `@`,
  dunder names, `raise`, `del`, `assert`, `global`, `nonlocal`, `with`,
  `try`, `match`, `import`, `yield`, `await`, `async` and nested
  definitions fail. `self` and `cls` are never read.
- **Sources.** Only a parameter annotated as a listed collection, or a
  derived value, is a size source or a loop source; an untyped,
  other-typed, `Literal`, fixed-tuple or number parameter is not (its
  iteration may run code or be single-use). `x in S` reads S's
  annotation: a list, `Sequence` or variable tuple of primitive elements
  costs its size, a set, frozenset or dict 1; a str, any other value and
  a list accumulator fail.
- **Builtins.** `index` (it raises when absent), `any` and `all` (they
  stop early), `pop`, `insert`, `remove`, slices, `key=`, `default=`, a
  start for `sum`, and every builtin not listed fail. `sorted`, `.sort()`,
  `min` and `max` need primitive elements (other elements may not order);
  `sum` numbers; `set(S)` int, float or str elements of a non-str S (a
  set of booleans or of a string's characters is bounded). A sort reads a
  parameter that is sorted in place at most once: never a derived value or
  a sorted run again (Timsort reads one in linear time). A dict's views
  are loop sources only. Methods: `count` (list, `Sequence`, tuple),
  `copy` (list, set, dict parameter), `get` (dict parameter), an in-place
  `.sort()` of a list parameter as a statement outside loops; on an
  accumulator `append` (list), `add` and `discard` (set), `get` and key
  writes (dict). Nothing else takes a method; str and number values take
  none. A helper or a module's function takes numbers, strings and None
  only, and its result is opaque.
- **Locals.** A local's first assignment is `name = value`, and every
  read and later write comes after it, inside its block. An accumulator
  starts empty and is written only empty again or by key; a derived value
  is written once, outside loops; any other local is a number, a str,
  opaque (a mix of scalars, None, or an element alias) or a closed
  collection (only returned or sized), by a fixpoint over all its writes.
- **Raises the input cannot avoid.** A read by position takes a loop's
  index that its range or `enumerate` proves in range for that sequence
  (or a binary search's mid); no dict is read by subscript; a divisor is
  a nonzero literal, a number parameter or a number element over a
  parameter; orderings compare numbers with numbers or strs with strs;
  bitwise operators and `~` fail (a float raises). A helper or module
  call returns, by the rule, but no call is read whose function or method
  name holds (any case) `exit`, `kill`, `abort`, `quit`, `die`, `signal`,
  `segv`, `crash`, `panic` or `terminate`, or is an exit word, in any
  reader, shown or hidden; no name the signature uses as a type is called.
  Hidden lines are closed forms (rule 5 above). A condition with a literal
  operand of `and`, `or` or `not` (or a literal condition) fails, in ifs
  and comprehension filters (fix round 3). An attribute is read only on a loop's element of a class type
  of the code's own (a capitalized name, no typing or collection name) or
  on a helper's or module's result: never on None, a `get` result, a
  container, a primitive or another attribute.
- **Growth.** `**` and `<<` fail. In a loop a number local is either an
  accumulator (`+=`, `-=`, or `t = max(t, v)`/`min`) whose added values
  read no accumulator, or a temporary whose writes read only other
  temporaries, with no cycle.
- **Tests.** A test outside loops, and a test guarding costly work inside
  one, is stable: `and`, `or` and `not` over a bool parameter, or a
  comparison of an int or float parameter or size-free local with another
  or an integer literal (at the root also `len(p)` and `not p`, which gate
  10 reads). A size-free local is written outside loops as a parameter
  plus or minus a literal. Every name on a path, through size-free locals,
  appears in one stable test at most, so the tests can hold together.
  Costly work behind any test that varies by iteration fails (stricter than
  the TypeScript choose/avoid reading), and no `==` takes an opaque value
  (it may compare whole containers).
  This is the TypeScript condition grammar of fix round 4, already in
  force: a stable test is read-once over typed atoms (a number side
  compares with a number or an integer literal; a bool parameter stands
  bare or under `not`), and conditional expressions, arithmetic, calls,
  strings, floats and `True`/`False` operands fail (fix round 4 checked
  every TypeScript counterexample's Python form).
- **Loops.** A literal range runs at least once. An exit by `return` from
  a binary search's equality test only outside loops. At the root, a
  branch holding a hidden line may leave, so the code after it stands
  behind its test.

- **Fixed-cost operands** (task 7 fix round 2): ruling D′ above holds:
  comparison operands, `in` needles, `count` arguments, `get`, `add` and
  `discard` keys and dict key writes are fixed-cost operands, and a
  comprehension's element, value and filters name only its own targets and
  fixed-cost operands.

### Stricter readings (PHP reader, Task 7)

The PHP reader applies the TypeScript and Python families above as
allowlists from the start (it reuses `treeByBraces`, `isInert`,
`hiddenForm`, `isExitName` and `keyOf`), and adds PHP's own hazards:
arrays are values (a write to a shared array copies it whole), an
`array`'s elements are untyped, function names and keywords ignore case,
`==` coerces, and names, calls and properties can be reached at run time.
Each is a test.

- **Closed statement set.** Each shown line is `$v = value;`, `$v += value;`
  or `-=`, `$v++`/`$v--` (either side), `$acc[] = value;`,
  `$acc[key] = value;`, a call, `return`, `break;`, `continue;`, or the
  header of `if`/`elseif`/`else`, `foreach ($S as [$k =>] $v)`, a counting
  or halving `for` (one index in all three clauses, no commas) or a binary
  search `while`; a line may begin with the `}` that closes the block before
  an `elseif` or `else`. `else if`, the alternative syntax (`:` and
  `endforeach`), `switch`, `match`, `try`, `do`, `goto`, `global`, `static`,
  `echo`, `print`, `unset`, `list()` and `[...] =` destructuring, `new`,
  `clone`, `yield`, `include`, `require`, `declare`, `instanceof`,
  references (`&$x`, `=&`, `foreach (… as &$v)`), `@`, casts, `$$x`, `${…}`,
  `$f()`, `->`, `?->`, `Class::$prop`, `Class::CONST`, `$this`, magic
  constants, bare constants, namespaced names (`\count`), named arguments
  and spreads fail. Expressions hold no ternary, `?:`, `??`, `.`, `**`,
  `<<`, bitwise operator, `xor`/`and`/`or`, or loose comparison (`==`,
  `!=`, `<>`); `<=>` stands only in a comparator.
- **Signature.** `[public|private|protected|static|final] function name(…)`
  (fix round 1: any other modifier, `abstract` included, fails)
  over at most `PUZZLE.maxSignatureLines` lines to the body's `{`; each
  parameter `[?type | union] $name [= literal or []]`. `array` (`?array`,
  `array|null`) is a sized array, `string` sized by `strlen`, `int` sized by
  value where it bounds a loop, `float` and `bool` values; untyped, `mixed`,
  `iterable`, class and other union types are no sources. `&`, `...`,
  promoted (a modifier before the type) and `function &name` fail.
  Parameter names keep their `$` in the question.
- **Gate 4** matches the unit's name in any case, through `self::` and
  `static::` too.
- **Sources and positions.** Only an `array` parameter or a derived value
  (`array_keys`, `array_values`, `array_reverse` of one parameter,
  `array_filter($p[, fn])`, `array_map(fn, $p)`, assigned once outside
  loops) is a `foreach` source; a `string` parameter is only a `strlen`
  bound. `$S[$i]` is read only at a position its loop proves present: a
  counting index bounded by `count($S)` / `strlen($s)` from 0 or 1 (`<`, or
  `<= B - 1`), a `foreach` key over `$S`, or the search's mid. A `foreach`
  key is never an element and never a bound for an inner loop (keys may be
  any integers). An accumulator is never iterated, searched or sorted.
- **Copies (PHP arrays are values).** No write of any kind to a parameter
  (element, append, `unset`, `array_push` and the rest) but one in-place sort
  of an `array` parameter as a statement outside loops (`sort`, `rsort`,
  `asort`, `arsort`, `ksort`, `krsort` with no flags; `usort`, `uasort`,
  `uksort` with exactly `fn($p, $q) => $p <=> $q` or its reverse), at most
  once per parameter. No local is assigned a bare array (`$b = $a`,
  `$b = $acc`): an accumulator starts `[]`, is only reset to `[]`, and grows
  by `[] =` or a key write of a non-array value; a derived value is written
  once; any other array local is fresh from a builtin, only returned or
  counted.
- **Elements are untyped**, so opaque: one may be compared with `===`
  against a proven scalar, used as a key (`isset($m[$x])`, `$m[$x] = …`),
  appended, passed as `in_array`'s needle, or returned. No arithmetic,
  method, index, `count`, `strlen`, iteration or ordering on one, and no two
  opaque values compared. No test on an array element is an exit or a
  stable test.
- **Builtins** are a closed list (`COMPLEXITY.builtins.PHP`), names
  case-folded. Cost 1: `count` (of an array name or a builtin's result),
  `strlen` (of a string), `isset($a[$k])`, `empty`, `array_key_exists`,
  `array_key_first`, `array_key_last`, `abs`, `intdiv` by a nonzero
  literal, `max`/`min` of two or more numbers. Size: `in_array` and
  `array_search` (strict flag only as the literal `true`), `array_keys`,
  `array_values`, `array_reverse`, `array_flip`, `array_sum`, `max($S)`,
  `min($S)` (one argument), `array_slice($S, $off)` (no length),
  `array_filter`, `array_map` (one array), `array_reduce`
  (a number literal start, a number body). Every other global function
  refuses, `implode` (fix round 1: its cost grows with the separator's
  length, and a separator must be a literal, which a shown line never
  holds), `array_merge`, `array_unique`, `array_column`, `range`,
  `str_repeat`, `explode`, `str_split`, `substr`, `strpos`, `str_contains`,
  `str_replace`, `call_user_func*`, `compact`, `extract`, `eval` and
  `func_get_args` included. Arithmetic is `+`, `-`, `*` on proven numbers,
  `/` and `%` by a nonzero literal, `>> 1`.
- **Callbacks.** A closure is only `fn($x) => expr` (plain parameters that
  shadow nothing) as the callback of `array_map`, `array_filter`,
  `array_reduce` or a user sort; `function (…) {…}`, `static fn`, a typed or
  by-reference parameter, a variable or string callable fails. Its body is a
  loop body over the source. A filter's body is a predicate: the grammar
  below and the triviality check.
- **Receivers.** A method on any `$variable` fails. `Class::method(args)`
  costs 1 by the rule when neither name holds an exit part and each
  argument is a number, string or null that is no variable or element (a
  by-reference parameter could write it).
- **Conditions.** Every if and elseif test, `&&`/`||` operand and filter
  predicate takes the read-once grammar of TypeScript fix round 4: atoms are
  a bool parameter, `empty($S)`, `A op B` (`===`, `!==`, an ordering) of two
  named values of one type or a named number and an integer literal, or one
  membership (`in_array($x, $S)`, `isset($S[$x])`,
  `array_key_exists($x, $S)`) of an element bound over a parameter in
  another parameter. Named values: int, float and bool parameters (never a
  string parameter: ruling D′ above), a
  `for` index, a search's lo, hi and mid, `count`/`strlen` of a source, a
  character `$s[$i]` at a valid position, and a local written once outside
  loops as one of these plus or minus a literal. `&&` and `||` stand only in
  conditions. Root tests, size-free locals, no two sizes, consistency on a
  path and costly work only behind stable tests follow the Python reader.
  So a membership in an accumulator (`isset($seen[$x])`) is no atom.
- **Exits.** An exit from a loop stands behind a positive `===` between a
  character `$s[$i]` of a string parameter its loop walks (from 0 by 1 to
  `strlen($s)`) and a character of another string parameter walked by its
  own loop (fix round 1: never the whole other string).
  `exit`, `die`, `goto`, `break N`, `continue N` and any call whose function,
  class or method name holds an exit part (case-folded) fail. The binary
  search takes `intdiv($lo + $hi, 2)` or `($lo + $hi) >> 1` and one if/else
  on `$S[$mid]` against a number parameter or literal; it has no equality
  exit (the elements are untyped).
- **Hidden lines** are the shared closed forms. PHP adds: a `#[` attribute,
  a heredoc or nowdoc, a double-quoted string holding `$`, and any PHP, ASP
  or script tag (`?>` ends a `//` or `#` comment, so `// ?><?php touch()`
  runs code) fail; `#` and `/* */` comments pass; keywords compare
  case-folded (`RETURN 'done';` at the end is a tail exit). A hidden opener
  is only `} else {`, after a shown if with no else, whose body costs 1 and
  never leaves.

- **Fixed-cost operands** (fix round 2, ruling D′ above, replacing fix
  round 1's string-parameter rule): every comparison operand, needle
  (`in_array`, `array_search`) and key (`isset`, `array_key_exists`,
  `$acc[k] =`) is a number literal, an int, float or bool parameter, a
  proven number local or counter, an element or key bound over a parameter,
  `$p[$i]` at a walking position, or arithmetic or `count`/`strlen` of a
  parameter over these. `array_map` and `array_filter` bodies name only
  their own parameters and fixed-cost operands. The binary search compares
  only a parameter's elements.

### Combining

- Sequential costs add; nested costs multiply; branches count as all
  taken.
- Drop every term dominated in every size by another (`n log n` by `n²`,
  `n` by `n·m`). What is left must be one term on the ladder or exactly
  `n + m`; otherwise (`n² + n·m`, `n² + m`, `n² log n`, `log n · m`,
  three sizes) the unit fails.
- A cost of `1` fails (gate 11).

### Category (SPEC 8.2, D4)

From the non-constant factors of the dominant term, where an iteration
callback or comprehension counts as a loop:

1. `halving`: a log factor from a halving loop or binary search;
2. `sorting`: a log factor from a sort;
3. `hidden linear call`: a factor of n from a linear builtin inside a loop
   (not a callback);
4. `two inputs`: `O(n·m)` or `O(n + m)` from loops alone;
5. `nested loops`: two or three size-dependent loops nested;
6. `linear scan`: anything else.

The first that applies; sites for the explanation are taken in line
order.

## The puzzle builder (`src/puzzle/complexity-read.ts`)

`buildComplexityRead(units, rng, weightOf?)`, shaped like `buildBugHunt`:
keeps units with a cost, picks a category first by `weightOf` among those
the units can give (Bug Hunt's rule), then a unit of that category evenly.
Returns a `Puzzle` with `type: 'complexity-read'`, the unit's lines as
`code`, the four shuffled choices and the explanation.

## Wiring

- `units.ts`: `Unit` gains optional `full` and `hidden` (above); the TS,
  Python and PHP adapters return each unit line's file line number (and
  the dedent offset), so `material.ts` can attach both to local units
  after gating. Prompt units never carry them.
- `config.ts`: `PuzzleType` gains `'complexity-read'`; a `COMPLEXITY`
  block holds the rule text, the ladder, the distractor table, the
  categories, and the builtin lists per language; `DOSSIER.typeOrder` and
  `typeLabels` gain it after Pattern ID.
- `puzzle.ts`: `complexity-read` is always built (local, like Bug Hunt),
  listed in `built` before Trace and Bug Hunt. `PUZZLE.typeOrder` already
  places it, so: Uncommon asks it; with Pattern ID not built, Common falls
  to it (the lowest built type above) instead of Trace; with no runner,
  Rare falls to it (the nearest built type below) instead of Pattern ID.
  A unit set with no cost gives way to the others in `built` order.
- `analyze.ts`: the type label. No gutter marks.
- Store: `PuzzleStat.type` and disputes take a new value; no stored shape
  changes, so no schema bump (rule 3 is for shape changes).
- SPEC: 8's Types line (Uncommon, fallbacks), 8.2 ("Bug Hunt, the one type
  whose category the game picks" becomes two), 8.4 (a Complexity Read
  entry; "Not yet"), the Dossier paragraph's group list; CLAUDE.md
  (current phase).

## Testing

- `complexity.test.ts`, per language: every loop table row, each builtin
  list (counted, constant, failing), each gate, exits, binary search
  (each accepted mid form; `lo = mid` fails), combining (dominated terms,
  off-ladder results), typed and untyped receivers, derived values and
  accumulators, n and m naming, category precedence. **Every
  counterexample from the adversarial review is a test**, with its right
  answer or a skip.
- `hidden`: a unit whose hidden lines are inert gets a puzzle; one with a
  loop, a parameter or an exit inside a loop on a hidden line gets none;
  the trimmed-trailing case (`return ', '.join(sorted(out))` after a loop)
  gets none; the raw text appears in no field of any unit, puzzle or
  stored value (serialize and search).
- **Empirical check (TS):** a test corpus of TS functions the reader
  accepts is run in node with an iteration counter inserted at each loop
  and builtin call site, at n = 64, 128, 256 (and m alike); the growth
  ratio must match the key's class. Catches classes of error, not only
  listed cases. The corpus and its keys live in
  `tests/complexity-growth-corpus.ts` (keys checked by
  `complexity-growth.test.ts`); the measuring runs in
  `scripts/growth-check.mjs`, since the plugin's tests disallow code
  generation from strings.
- `complexity-read.test.ts`: choices from the table, shuffled with a
  seed; the question's size line; the explanation; weighting with a
  stubbed `weightOf`; no unit with a cost gives none.
- `puzzle.test.ts`: tier mapping and fallbacks with the new type
  (Common, Uncommon, Rare, with and without Pattern ID and Trace).

## Risks

- **Yield** stays modest: the gates are strict by design. If it rarely
  fires, loosen one rule at a time with a test per counterexample, never
  by guessing.
- **The rule against intuition.** A player may count a helper's cost; the
  rule is in the question, and the dispute key keeps a bad key out of the
  record.

## Review outcome

Round 2 (15 findings): a hidden TS line could move the shown braces, a
trimmed Python line was wrongly taken as outside every loop, the inert
check tracked too few names, TS derived values could still grow, unknown
and aliased types and unlisted methods cost 1, the exit rules rejected
ordinary searches and missed flags, the size guard could be bypassed
through a local, `mid` could be reassigned, an inner index bound under a
halving loop was wrong, the `at` mapping was undefined, a throw could
carry raw text, the rule text reused n, some rules were dead
(`extend(S)`), and the category had no fallback. Each is addressed above
and is a test.

Round 1:

The adversarial review (2026-10-13) found the first draft's question
contradicted its own key (builtins are "other functions"), trimmed and
blanked lines hid costs, growth of parameters and derived values went
unmodeled, linear builtins missing from the lists cost 1, closures and
comparators escaped, loop starts, exits, small-input guards and the
binary search shape admitted wrong or endless loops, combining was
ambiguous, builtin names on non-collections were miscounted, n and m were
undefined in the question, the filters were misdescribed, and the
fallback changes for Rare were missed. Each is addressed above and is a
test.
