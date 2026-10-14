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
   `raise`, `exit`, `die`) passes only on the last statement at body level,
   or inside an `if` block that is outside every loop (a guard; its
   condition is shown and goes through gate 10).

The answer then holds under the stated rule, since hidden lines add only
constant work and cannot cut a loop short.

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
| halving: `for (let i = 1; i < B; i *= 2)` (start a positive literal; or `<<= 1`), `for (let i = B; i > 0; i = Math.floor(i / 2))` / `i >>= 1` / `intdiv($i, 2)` (Python has no halving `for`) | log size(B) |
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
A counted builtin name on any other receiver (an untyped parameter, a
parameter of a named, aliased, generic or other type such as `Repo`,
`Ids`, `T`, `Iterable`, a local that is not derived, a property such as
`this.items`, or a call's result) **fails the unit**; a constant-list
name there costs 1, and any other method there costs 1 by the rule.
Iterating an untyped parameter with a for-each is allowed (size of p).
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
    `array_flip`, `array_column`, `max($S)`, `min($S)` (one argument),
    `implode($sep, $S)`, `array_slice` with no length, `array_map($cb,
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
  and builtin call site, at n = 8, 16, 32 (and m alike); the growth ratio
  must match the key's class. Catches classes of error, not only listed
  cases.
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
