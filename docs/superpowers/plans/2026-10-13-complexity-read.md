# Complexity Read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Uncommon puzzle, Complexity Read: a static, local reader works out a function's worst-case Big-O from the code the pane shows (hidden lines checked inert on the raw source) and asks it as a four-choice question.

**Architecture:** A pure cost algebra and shared structure layer (`src/puzzle/complexity.ts`) under three language readers (`complexity-ts.ts`, `complexity-py.ts`, `complexity-php.ts`) that each fail closed on anything not on their closed lists. Adapters report each unit line's file line number; `material.ts` attaches the untrimmed filtered unit (`full`) and a raw-text capability (`hidden`, a closure) to local units only. A builder (`complexity-read.ts`) turns a reading into a `Puzzle`, wired into `buildPuzzle` as an always-built local type.

**Tech Stack:** TypeScript 5.9, Claude Code plugin engine 2.1.291 types, tests with `claude-code/testing` via `claude plugin test .`.

**Spec:** `docs/superpowers/specs/2026-10-13-complexity-read-design.md` (read it in full before any task; section names below refer to it).

## Global Constraints

- Mission FC-25 is active in the user's game. Never run slash commands yourself.
- Public repo: invented code and names only in tests and docs (`NOVA-` keys); no hostnames, usernames, absolute local paths, real work content or PHI-like data. Never copy `CLAUDE.local.md` into tracked files.
- Every tuning number and every builtin list lives in `src/config.ts` (CLAUDE.md rule 2), in a `COMPLEXITY` block.
- No stored shape changes, no schema bump.
- Raw source text never becomes a field of any object: it is reachable only inside the `hidden` closure, which returns a boolean and catches every throw. No error message, log or toast may contain raw text.
- Only `localUnits` carry `full`/`hidden`; prompt units (`units`) never do. Pattern ID prompts are unchanged.
- Fail closed: any shape a reader does not recognize returns `undefined` for that unit. Never guess a cost.
- `$` reaches only top-level functions of the same file (CLAUDE.md): none of these modules use `$`.
- Tests: `claude plugin test .` runs every `tests/*.test.ts`; test files import only relative files and `claude-code/testing`; console output is not shown (throw to see data). Seed all randomness with `createRng(n)`.
- American English in code, comments, docs and commits. Match the surrounding comment density (a short header comment per file citing the SPEC section, one-line doc comments on exports).
- Commit straight to `main` with the repo-local identity; end each commit message with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Do not push.
- Run `npm run typecheck` and `npm test` plain (never piped or redirected) at the end of every task, so the game records them.

## Review Focus

1. A unit whose only blanked line is a trailing `return ', '.join(sorted(out))` after a loop (Python) or `return xs.toSorted() // done` (TS): the player expects no puzzle, never `O(n)`. Pinned in Task 3 and Task 6.
2. A hidden TS line the scanner blanked without its brace (`if ((x + 1) / 2 > t) {` becomes `…`): the player expects no puzzle, never a key read from mis-paired braces. Pinned in Task 2.
3. A loop guarded by a flag (`if (!first) break`) or a size-vs-constant fast path (`if (n > 16) return`): the player expects no puzzle. Pinned in Task 4.
4. A builtin name on an aliased or generic parameter type (`items: Ids`, `T[]` through `T extends`), or on `this.items`: the player expects no puzzle. Pinned in Task 4.
5. Serializing a local unit, a puzzle, a dispute record or a stored encounter never contains raw-only text. Pinned in Task 3.

---

### Task 1: Cost algebra, ladder, category and config

**Files:**
- Create: `src/puzzle/complexity.ts`
- Modify: `src/config.ts` (add `'complexity-read'` to `PuzzleType`; add `COMPLEXITY`; add the type to `DOSSIER.typeOrder` after `'pattern-id'` and to `DOSSIER.typeLabels` as `'Complexity Read'`)
- Modify: `src/puzzle/analyze.ts:8` (`TYPE_LABEL` gains `'complexity-read': 'Complexity Read'`)
- Test: `tests/complexity.test.ts`

**Interfaces:**
- Produces (in `src/puzzle/complexity.ts`):

```ts
/** What a factor came from: the category and the explanation read it. */
export type FactorKind = 'loop' | 'callback' | 'builtin' | 'sort' | 'halving' | 'search'
/** One factor of a term: the size of parameter `size` (or its log), from the site at `at` (an index into the lines read). */
export type Factor = { size: string; log: boolean; kind: FactorKind; at: number; what: string }
/** A product of factors; the empty product is 1. */
export type Term = Factor[]
/** A sum of terms. */
export type Cost = Term[]
export const ONE: Cost                       // [[]]
export const factor: (f: Factor) => Cost      // [[f]]
export function add(a: Cost, b: Cost): Cost
export function mul(a: Cost, b: Cost): Cost
/** Drops every term dominated in every size by another (per size, (power, log count) compared lexicographically), and duplicates by shape. */
export function simplify(c: Cost): Cost
export type Ladder = 'O(1)' | 'O(log n)' | 'O(n)' | 'O(n log n)' | 'O(n²)' | 'O(n³)' | 'O(n·m)' | 'O(n + m)'
export type Category = 'halving' | 'sorting' | 'hidden linear call' | 'two inputs' | 'nested loops' | 'linear scan'
/** A unit's answer: undefined when the cost is constant or off the ladder (spec "Combining"). */
export type Reading = { answer: Ladder; category: Category; n: string; m?: string; numeric: string[]; explanation: string }
/** `cost` simplified and placed on the ladder; `numeric` names number parameters (sized by value); `offset` maps `at` to the pane's line numbers (`at - offset + 1`). */
export function readCost(cost: Cost, numeric: readonly string[], offset: number): Reading | undefined
```

- [ ] **Step 1: Write the failing tests** in `tests/complexity.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'
import { add, factor, mul, ONE, readCost, simplify, type Factor } from '../src/puzzle/complexity'

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
```

- [ ] **Step 2: Run** `npm test` and confirm these fail (module missing).

- [ ] **Step 3: Implement** `src/puzzle/complexity.ts` (algebra, `readCost`) and the config.

The config block (exact keys; values copied from the spec's tables and lists):

```ts
// SPEC 8.4, DEFAULT: Complexity Read (spec docs/superpowers/specs/2026-10-13-complexity-read-design.md).
// The question's rule line, the distractors for each answer, and per language the
// builtins the readers know: everything not listed fails closed.
export const COMPLEXITY = {
  maxQuestionChars: 160,
  ruleText: 'Worst case. Built-in operations over a whole collection (search, copy, sum, join, map, filter) cost its size; sorts size × log size; hash lookups and appends 1; other calls 1.',
  distractors: {
    'O(log n)': ['O(1)', 'O(n)', 'O(n log n)'],
    'O(n)': ['O(log n)', 'O(n log n)', 'O(n²)'],
    'O(n log n)': ['O(n)', 'O(n²)', 'O(log n)'],
    'O(n²)': ['O(n)', 'O(n log n)', 'O(n³)'],
    'O(n³)': ['O(n²)', 'O(n log n)', 'O(n)'],
    'O(n·m)': ['O(n + m)', 'O(n²)', 'O(n)'],
    'O(n + m)': ['O(n·m)', 'O(n)', 'O(n²)'],
  } as Record<string, readonly string[]>,
  // Filled by Tasks 4, 6 and 7: { sort, linear, constant, fails, derive, mutate, globals, iterators }
  // per language, each a readonly string[] copied from the spec's "Builtins" section.
  builtins: {} as Record<string, Record<string, readonly string[]>>,
} as const
```

In `readCost`: simplify; one remaining term → per-size `(power, logs)`; one size: `(0,1)` log n, `(1,0)` n, `(1,1)` n log n, `(2,0)` n², `(3,0)` n³; two sizes each `(1,0)` → n·m; two terms each a single `(1,0)` in different sizes → n + m; anything else (including the empty term) → undefined. n = the size of the factor with the lowest `at` among the answer's factors; m the other. Category by the spec's precedence (`callback` counts as a loop; `hidden linear call` is a `builtin` factor of kind other than sort inside a term that also has a `loop`/`callback`/`halving`/`search` factor; `two inputs` when the answer is n·m or n + m; `nested loops` when two or more `loop`/`callback` factors; else `linear scan`). Explanation: factors of the answer's terms sorted by `at`, deduplicated by `(at, what)`, written `Line A: what; line B: what.` then the product (`n`, `m`, `log n`; `×` between factors, ` + ` between terms) and ` = <answer>.`.

- [ ] **Step 4: Run** `npm run typecheck` and `npm test`; all pass.

- [ ] **Step 5: Commit** `Add the Complexity Read cost algebra, ladder and categories`.

---

### Task 2: Structure trees and the inert check

**Files:**
- Modify: `src/puzzle/complexity.ts`
- Test: `tests/complexity.test.ts`

**Interfaces:**
- Consumes: `isBlankedLine` from `src/puzzle/readable.ts`.
- Produces:

```ts
/** A line and the lines nested under it; `at` indexes the lines read. */
export type Block = { at: number; text: string; children: Block[] }
/** TS and PHP: nesting by braces. A line may close (`}` first), open (`{` last), or both (`} else {`). Undefined when the braces do not balance, or a line has an unmatched `{`/`}` anywhere but its ends. The signature line is the root. */
export function treeByBraces(lines: readonly string[]): Block | undefined
/** Python: nesting by indentation, the `def` line the root. Undefined on an unbalanced bracket, a trailing backslash, or a dedent to a level never opened. */
export function treeByIndent(lines: readonly string[]): Block | undefined
/** Where a hidden line sits, for the exit rule. */
export type HiddenPlace = { isInLoop: boolean; isLastAtBodyLevel: boolean; isInGuard: boolean }
/** Spec "What the reader reads", rules 1 to 4. `kept` is the blanked line as shown; `bound` every name bound in the unit plus the unit's own name; `words` the language's builtin and global names. */
export function isInert(raw: string, kept: string, lang: 'TypeScript' | 'Python' | 'PHP', bound: ReadonlySet<string>, words: ReadonlySet<string>, place: HiddenPlace): boolean
```

- [ ] **Step 1: Write the failing tests** (append to `tests/complexity.test.ts`):

```ts
import { isInert, treeByBraces, treeByIndent } from '../src/puzzle/complexity'

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
  expect(isInert("log('done')", '…', 'TypeScript', new Set(['items']), none, out)).toBe(true)
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
  expect(isInert("    log('x')", '    …', 'Python', none, none, out)).toBe(true)
  expect(isInert("      log('x')", '    …', 'Python', none, none, out)).toBe(false)
  expect(isInert("    log('x',", '    …', 'Python', none, none, out)).toBe(false)
})
```

- [ ] **Step 2: Run** `npm test`; the new tests fail.
- [ ] **Step 3: Implement.** Names: identifier tokens (`[A-Za-z_$][\w$]*`, PHP `$name` compared without `$`) anywhere in the raw text, strings and comments included. Words: the loop, closure/definition words of the spec, plus `words`. Spread/unpacking: `...` anywhere; Python `*`/`**` immediately before an identifier or `(` where the previous non-space char is `(`, `,` or line start. Exit words only by `place`.
- [ ] **Step 4: Run** `npm run typecheck` and `npm test`; all pass.
- [ ] **Step 5: Commit** `Read unit structure by braces and indentation; check hidden lines are inert`.

---

### Task 3: Units carry their file lines; local units get `full` and `hidden`

**Files:**
- Modify: `src/puzzle/units.ts` (`Unit` gains optional `fileLines?: number[]`, `dedent?: number`, `full?`, `hidden?`; TS, Python and PHP adapters fill `fileLines` (1-based, one per kept line, after empty lines are dropped) and `dedent` (the indent `dedent()` removed))
- Modify: `src/puzzle/material.ts` (attach `full` and `hidden` to local units after gating; strip `fileLines`/`dedent` from every returned unit)
- Test: `tests/puzzle-units.test.ts`, `tests/complexity.test.ts`

**Interfaces:**
- Produces on `Unit`:

```ts
/** The unit before trimming (filtered text) and where `lines` starts in it. Local units only. */
full?: { lines: string[]; offset: number }
/** Runs `check` on the raw, dedented text of each blanked line of `full` (`at`: its index in `full.lines`); true when every call returns true. Catches any throw and gives false. Local units only; never a field holding raw text. */
hidden?: (check: (raw: string, at: number) => boolean) => boolean
```

- [ ] **Step 1: Write the failing tests.** In `tests/puzzle-units.test.ts`: each of the TS, Python and PHP adapters' units carries `fileLines` matching the source (a fixture with an empty line inside the function proves the skip) and `dedent` (a nested method proves a non-zero value). In `tests/complexity.test.ts`, drive `missionUnits` with a stand-in `MaterialIo` (see existing material tests in `tests/puzzle.test.ts` or `tests/wiring.test.tsx` for the git stand-in shape):

```ts
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
  // … stand-in io returning a diff touching lines 1-5 of nova/pairs.py and `source` for the file …
  const { units, localUnits } = await missionUnits(io, 0, 'strict')
  expect(units.every(u => u.full === undefined && u.hidden === undefined)).toBe(true)
  const local = localUnits[0]!
  expect(local.full?.lines.length).toBe(5)        // untrimmed: the blanked return is kept
  expect(local.lines.length).toBe(4)              // trimmed for the pane
  let seen = ''
  expect(local.hidden?.((raw, at) => { seen = `${at}:${raw.includes(RAW)}`; return true })).toBe(true)
  expect(seen).toBe('4:true')
  expect(local.hidden?.(() => { throw new Error('x') })).toBe(false)
  for (const value of [units, localUnits]) {
    expect(JSON.stringify(value).includes(RAW)).toBe(false)
    expect(JSON.stringify(structuredClone(value.map(({ hidden, ...u }) => u))).includes(RAW)).toBe(false)
    expect(JSON.stringify(value).includes('fileLines')).toBe(false)
  }
})
```

Add the same test shape for a TS fixture whose blanked line sits inside the body, and assert `at` and dedented raw text.

- [ ] **Step 2: Run** `npm test`; they fail.
- [ ] **Step 3: Implement.** In each adapter, track the file line of each kept line before `dedent`, and compute the dedent width. In `missionUnits`, for local units only: build `full` from the pre-gate unit, `offset` = count of leading blanked lines `readableUnit` trimmed; `hidden` closes over the file's raw lines (CR stripped, split like the filtered text), maps `at` → `fileLines[at]`, removes `dedent` leading whitespace (if the raw line's leading whitespace is shorter than `dedent`, the check is false), and wraps the loop in `try/catch` returning false. Delete `fileLines` and `dedent` from every unit returned (prompt and local). Do not add raw text to any closure-free object, and do not log.
- [ ] **Step 4: Run** `npm run typecheck` and `npm test`; all pass (existing adapter tests that compare whole units with `toEqual` may need `fileLines`/`dedent` in their expectations: update them, do not drop assertions).
- [ ] **Step 5: Commit** `Give local units their untrimmed lines and a raw-line check that holds no raw text`.

---

### Task 4: The TypeScript reader

**Files:**
- Create: `src/puzzle/complexity-ts.ts`
- Modify: `src/puzzle/complexity.ts` (add `costOf(unit: Unit): Reading | undefined`, dispatching by `unit.lang`; Python and PHP return undefined until Tasks 6 and 7)
- Modify: `src/config.ts` (`COMPLEXITY.builtins.TypeScript`)
- Test: `tests/complexity-ts.test.ts`

**Interfaces:**
- Consumes: Task 1 algebra, Task 2 `treeByBraces`, `isInert`, Task 3 `Unit.full`/`hidden`.
- Produces: `export function readTypeScript(unit: Unit): { cost: Cost; numeric: string[]; params: string[] } | undefined` and `export function costOf(unit: Unit): (Reading & { params: string[] }) | undefined` → `readCost(...)` with `offset = unit.full?.offset ?? 0`, reading `unit.full?.lines ?? unit.lines`; `params` are the parameter names for the question (Python without `self`/`cls`, PHP with `$`).

The reader, in order (each "fail" returns undefined):
1. Lines = `full.lines` or `lines`. Any blanked line with no `hidden` → fail.
2. Signature: lines from 0 to the first ending in `{`; one balanced `(...)`; each parameter `name`, `name?`, with `: type` and `= default`; destructured or rest → fail. Record each parameter's declared type text. Typed-receiver classes: array (`T[]`, `readonly T[]`, `Array<…>`, `ReadonlyArray<…>`), `string`, `Set<…>`, `Map<…>`, each optionally `| undefined`/`| null`; `number`/`bigint` → numeric; anything else → other.
3. `treeByBraces`; undefined → fail.
4. Bound names: parameters, every name after `const`/`let`/`var`, every loop variable, every arrow parameter, and the unit's name.
5. Hidden lines: `hidden((raw, at) => isInert(raw, lines[at], 'TypeScript', bound, words, placeOf(at)))` where `words` = every name in `COMPLEXITY.builtins.TypeScript` lists plus `globals`; false → fail.
6. Gates 4–11 of the spec, on shown lines.
7. Walk the tree: loops by the loop table; binary search; iteration-method callbacks (`forEach`, `map`, `filter`, `find`, `findIndex`, `some`, `every`, `reduce`) as loop bodies (inline arrow: the rest of the line; block arrow: its children); builtins by receiver class and the lists; derived values and accumulators; exits; sequential `add`, nested `mul`, branches added.

- [ ] **Step 1: Write the failing tests** in `tests/complexity-ts.test.ts`. A helper builds a `Unit` from lines (no `full`, no `hidden`) and one with a `hidden` stub over given raw lines. Each case asserts `costOf(unit)?.answer` (or `toBe(undefined)`):

```ts
import { expect, test } from 'claude-code/testing'
import { costOf } from '../src/puzzle/complexity'
import type { Unit } from '../src/puzzle/units'

// Invented code only (SPEC 15).

const ts = (...lines: string[]): Unit => ({ lang: 'TypeScript', name: /function\s+(\w+)/.exec(lines[0]!)![1]!, lines })
const answer = (u: Unit) => costOf(u)?.answer

test('for-of, counting and nested loops', async () => {
  expect(answer(ts('function f(items: number[]): number {', '  let t = 0', '  for (const x of items) {', '    t += x', '  }', '  return t', '}'))).toBe('O(n)')
  expect(answer(ts('function f(items: number[]): number {', '  let t = 0', '  for (let i = 0; i < items.length; i++) {', '    for (let j = i + 1; j < items.length; j++) {', '      t += items[i] * items[j]', '    }', '  }', '  return t', '}'))).toBe('O(n²)')
  expect(answer(ts('function f(items: number[], ids: number[]): number {', '  let t = 0', '  for (const x of items) {', '    for (const y of ids) {', '      t += x * y', '    }', '  }', '  return t', '}'))).toBe('O(n·m)')
})

test('a linear builtin inside a loop, and a sort', async () => {
  expect(answer(ts('function f(items: number[], ids: number[]): number {', '  let t = 0', '  for (const x of items) {', '    if (ids.includes(x)) {', '      t += 1', '    }', '  }', '  return t', '}'))).toBe('O(n·m)')
  expect(answer(ts('function f(items: number[]): number[] {', '  const s = items.toSorted((a, b) => a - b)', '  return s', '}'))).toBe('O(n log n)')
})

test('halving loops and the binary search shape', async () => {
  expect(answer(ts('function f(n: number): number {', '  let t = 0', '  for (let i = 1; i < n; i *= 2) {', '    t += i', '  }', '  return t', '}'))).toBe('O(log n)')
  expect(answer(ts('function find(items: number[], x: number): number {', '  let lo = 0', '  let hi = items.length - 1', '  while (lo <= hi) {', '    const mid = (lo + hi) >> 1', '    if (items[mid] === x) {', '      return mid', '    }', '    if (items[mid] < x) {', '      lo = mid + 1', '    } else {', '      hi = mid - 1', '    }', '  }', '  return -1', '}'))).toBe('O(log n)')
  // lo = mid can loop forever.
  expect(answer(ts('function find(items: number[], x: number): number {', '  let lo = 0', '  let hi = items.length', '  while (lo < hi) {', '    const mid = (lo + hi) >> 1', '    if (items[mid] < x) {', '      lo = mid', '    } else {', '      hi = mid', '    }', '  }', '  return lo', '}'))).toBe(undefined)
})

test('fails closed on the adversarial review counterexamples', async () => {
  // Derived value grown by push (round 2, #4).
  expect(answer(ts('function f(items: number[]): number {', '  const acc = items.slice()', '  for (const x of items) {', '    for (const y of items) {', '      acc.push(x * y)', '    }', '  }', '  let t = 0', '  for (const a of acc) {', '    t += a', '  }', '  return t', '}'))).toBe(undefined)
  // Growing the bound while looping (round 1, #3).
  expect(answer(ts('function f(items: number[]): number {', '  for (let i = 0; i < items.length; i++) {', '    items.push(i)', '  }', '  return 0', '}'))).toBe(undefined)
  // Spread into push costs m and is refused (round 1, #4).
  expect(answer(ts('function f(groups: number[], extra: number[]): number[] {', '  const out: number[] = []', '  for (const g of groups) {', '    out.push(...extra)', '  }', '  return out', '}'))).toBe(undefined)
  // A closure called in a loop (round 1, #5).
  expect(answer(ts('function f(items: number[]): number {', '  const count = (x: number) => {', '    let c = 0', '    for (const y of items) {', '      c += y === x ? 1 : 0', '    }', '    return c', '  }', '  let best = 0', '  for (const x of items) {', '    best = Math.max(best, count(x))', '  }', '  return best', '}'))).toBe(undefined)
  // A start that is not 0 or 1 (round 1, #6).
  expect(answer(ts('function f(items: number[]): number {', '  let t = 0', '  for (let i = items.length - 3; i < items.length; i++) {', '    t += items.indexOf(items[i])', '  }', '  return t', '}'))).toBe(undefined)
  // Every branch exits: the loop runs once (round 1, #7).
  expect(answer(ts('function f(items: number[], ids: number[]): boolean {', '  for (const x of items) {', '    if (ids.includes(x)) {', '      return true', '    } else {', '      return false', '    }', '  }', '  return false', '}'))).toBe(undefined)
  // A flag exit (round 2, #6).
  expect(answer(ts('function f(items: number[], ids: number[]): number {', '  let first = true', '  let t = 0', '  for (const x of items) {', '    if (!first) {', '      break', '    }', '    first = false', '    t += ids.indexOf(x)', '  }', '  return t', '}'))).toBe(undefined)
  // A size guard through a local (round 2, #7).
  expect(answer(ts('function f(items: number[]): number {', '  const n = items.length', '  if (n > 16) {', '    return -1', '  }', '  let t = 0', '  for (const x of items) {', '    for (const y of items) {', '      t += x * y', '    }', '  }', '  return t', '}'))).toBe(undefined)
  // A builtin name on a named, aliased or property receiver (round 1, #11; round 2, #5).
  expect(answer(ts('function f(items: Ids, x: number): number {', '  let t = 0', '  for (const y of items) {', '    t += items.indexOf(y)', '  }', '  return t', '}'))).toBe(undefined)
  // Unlisted method on a typed string inside a loop (round 2, #5).
  expect(answer(ts('function f(words: string[], text: string): number {', '  let t = 0', '  for (const w of words) {', '    if (text.toLowerCase() === w) {', '      t += 1', '    }', '  }', '  return t', '}'))).toBe(undefined)
  // Body on the header line (round 1, #10).
  expect(answer(ts('function f(a: number[]): number {', '  let t = 0', '  for (const x of a) t += x', '  for (const y of a) {', '    t += y', '  }', '  return t', '}'))).toBe(undefined)
  // Recursion.
  expect(answer(ts('function walk(items: number[]): number {', '  let t = 0', '  for (const x of items) {', '    t += walk(items)', '  }', '  return t', '}'))).toBe(undefined)
  // A comparator that is not constant (round 1, #5).
  expect(answer(ts('function f(items: number[]): number[] {', '  const s = items.toSorted((a, b) => items.indexOf(a) - items.indexOf(b))', '  return s', '}'))).toBe(undefined)
  // No loop and no counted builtin: constant, no puzzle.
  expect(answer(ts('function f(a: number, b: number): number {', '  const c = a + b', '  return c * 2', '}'))).toBe(undefined)
})

test('a callback is a loop body, and its cost multiplies', async () => {
  expect(answer(ts('function f(items: number[], ids: number[]): number[] {', '  const out = items.filter(x => ids.includes(x))', '  return out', '}'))).toBe('O(n·m)')
  expect(costOf(ts('function f(items: number[]): number {', '  let t = 0', '  items.forEach(x => {', '    t += items.indexOf(x)', '  })', '  return t', '}'))?.category).toBe('hidden linear call')
})

test('hidden lines: inert passes, a hidden cost fails, a hidden line without hidden() fails', async () => {
  const lines = ['function f(items: number[]): number {', '  let t = 0', '  for (const x of items) {', '    …', '    t += x', '  }', '  return t', '}']
  const raw: Record<number, string> = { 3: "    log('step')" }
  const withHidden = (r: Record<number, string>): Unit => ({ ...ts(...lines), hidden: check => Object.entries(r).every(([at, text]) => check(text, Number(at))) })
  expect(answer(withHidden(raw))).toBe('O(n)')
  expect(answer(withHidden({ 3: "    t += items.indexOf(x) // 'x'" }))).toBe(undefined)
  expect(answer(ts(...lines))).toBe(undefined)
})
```

Add, in the same style, one passing and one failing test per remaining rule in the spec's TS lists (each counted builtin, each constant builtin, each failing name, each gate 4–11, each exit rule including the ordinary search `if (items[i] === x) return i` that keeps O(n), each accepted mid form, the inner bound under a halving loop failing, the descending loop, the inner `j < i`). Keep each test name a sentence.

- [ ] **Step 2: Run** `npm test`; they fail.
- [ ] **Step 3: Implement** `complexity-ts.ts` and the `TypeScript` builtin lists in config (copied from the spec, as `sort`, `linear`, `constant`, `fails`, `derive`, `mutate`, `globals`, `iterators`). Keep functions small: `readSignature`, `classifyLoop`, `costOfLine`, `costOfBlock`, `checkGates`, `checkExits`, `isBinarySearch`.
- [ ] **Step 4: Run** `npm run typecheck` and `npm test`; all pass.
- [ ] **Step 5: Commit** `Read TypeScript functions' worst-case cost, failing closed`.

---

### Task 5: Empirical growth check for the TypeScript reader

**Files:**
- Create: `tests/complexity-growth.test.ts`

**Interfaces:**
- Consumes: `costOf`, `readTypeScript` (Task 4).

- [ ] **Step 1: Write the test.** A corpus of at least 20 invented TS functions the reader accepts (assert `costOf` gives each corpus entry's stated answer first), covering every answer on the ladder and every category, each with a generator of inputs by size (`(n, m) => [args]`) and written in erasable TypeScript (types stripped by a small regex in the test, or written so `new Function` accepts the body after removing `: type` annotations; keep the corpus simple enough for that). Counting is independent of the reader: (a) the test inserts `__c.n++` as the first statement of every block opened by a line matching `^\s*(for|while)\b` or an iteration method call (`.forEach(`, `.map(`, `.filter(`, `.find(`, `.findIndex(`, `.some(`, `.every(`, `.reduce(`) ending in `{`, and wraps inline arrow callbacks' bodies likewise; (b) array inputs are instances of a test-local `class Counted extends Array` whose `includes`, `indexOf`, `lastIndexOf`, `slice`, `concat`, `join`, `toSorted`, `sort`, `toReversed` add `this.length` (sorts: `this.length * Math.log2(this.length + 1)`) to `__c.n` before calling `super`. Run with `new Function('__c', ...)` at n = 64, 128, 256 (m held at 64 then varied for two-input answers). Assert the ratio of counts between doublings matches the class within tolerance: log n → difference ≈ constant (ratio < 1.3), n → ≈2, n log n → between 2 and 2.4, n² → ≈4, n³ → ≈8, n·m → ≈2 in each variable, n + m → < 2 in each.
- [ ] **Step 2: Run** `npm test`; fix the reader (never the corpus's expectations) where a ratio disagrees.
- [ ] **Step 3: Run** `npm run typecheck` and `npm test`; all pass.
- [ ] **Step 4: Commit** `Check the TypeScript reader's answers against measured growth`.

---

### Task 6: The Python reader

**Files:**
- Create: `src/puzzle/complexity-py.ts`
- Modify: `src/puzzle/complexity.ts` (`costOf` dispatches `Python`)
- Modify: `src/config.ts` (`COMPLEXITY.builtins.Python`)
- Test: `tests/complexity-py.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3, `treeByIndent`, `isInert`.
- Produces: `export function readPython(unit: Unit): { cost: Cost; numeric: string[]; params: string[] } | undefined`.

Rules as Task 4, Python's way: `def` signature on the first line (`self`, `cls` skipped; `*args`, `**kw` fail); annotations `list`, `List`, `Sequence`, `tuple`, `str`, `set`, `frozenset`, `dict`, `Mapping`, bare or subscripted, optionally `Optional[...]` or `X | None`; `for x in S:`, `range(...)` per the loop table; single-line comprehensions and generator expressions as loops; `x in S` by annotation (sequence n, set/dict 1, `str` or untyped fails); `lambda` (also `key=`) fails; `while` only as binary search with `//` mid forms; `async for`, `for … else`, `while … else` fail.

- [ ] **Step 1: Write the failing tests** in `tests/complexity-py.test.ts`, same helper shape with `lang: 'Python'`:

```ts
const py = (...lines: string[]): Unit => ({ lang: 'Python', name: /def\s+(\w+)/.exec(lines[0]!)![1]!, lines })

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
```

Add one passing and one failing test per remaining Python rule in the spec, as in Task 4.

- [ ] **Step 2: Run** `npm test`; they fail.
- [ ] **Step 3: Implement** `complexity-py.ts` and the Python lists in config.
- [ ] **Step 4: Run** `npm run typecheck` and `npm test`; all pass.
- [ ] **Step 5: Commit** `Read Python functions' worst-case cost, failing closed`.

---

### Task 7: The PHP reader

**Files:**
- Create: `src/puzzle/complexity-php.ts`
- Modify: `src/puzzle/complexity.ts` (`costOf` dispatches `PHP`)
- Modify: `src/config.ts` (`COMPLEXITY.builtins.PHP`)
- Test: `tests/complexity-php.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3, `treeByBraces`, `isInert`.
- Produces: `export function readPhp(unit: Unit): { cost: Cost; numeric: string[]; params: string[] } | undefined`.

Rules as Task 4, PHP's way: signature over up to `PUZZLE.maxSignatureLines` lines to the `{`; parameters `$name` with types (nullable, union) and defaults; `&$p`, `...$p`, promoted (`public`/`private`/`protected`/`readonly` before a parameter) fail; array-typed (`array`, `?array`) parameters take counted builtins; `foreach ($S as …)`, counting `for` with `count($S)`/`strlen($S)`; global functions are a closed list (any unlisted global call fails; `->` and `::` calls cost 1 unless a counted name on an untyped receiver); callback positions (`array_map($cb, $S)`, `array_filter($S, $cb)`, `array_reduce($S, $cb)`, `usort($S, $cb)`); `fn`, `function` closures fail outside those positions; `break N`, `continue N`, `goto`, `exit`, `die` per the gates.

- [ ] **Step 1: Write the failing tests** in `tests/complexity-php.test.ts`:

```ts
const php = (...lines: string[]): Unit => ({ lang: 'PHP', name: /function\s+(\w+)/.exec(lines[0]!)![1]!, lines })

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
```

Add one passing and one failing test per remaining PHP rule in the spec, as in Task 4.

- [ ] **Step 2: Run** `npm test`; they fail.
- [ ] **Step 3: Implement** `complexity-php.ts` and the PHP lists in config.
- [ ] **Step 4: Run** `npm run typecheck` and `npm test`; all pass.
- [ ] **Step 5: Commit** `Read PHP functions' worst-case cost, failing closed`.

---

### Task 8: The puzzle, its wiring, and the docs

**Files:**
- Create: `src/puzzle/complexity-read.ts`
- Modify: `src/puzzle/puzzle.ts` (`built` gains `'complexity-read'` before `'trace'`; the loop handles it like Bug Hunt, with `categoryWeights(req.stats, 'complexity-read')`)
- Modify: `docs/SPEC.md` (8's Types line: Uncommon is Complexity Read, and the new Common and Rare fallbacks; 8.2's "the one type whose category the game picks" becomes Bug Hunt and Complexity Read; 8.4: a **Complexity Read (FC-25)** entry summarizing the spec in SPEC's style, the Dossier group list, the "Not yet" list loses Complexity Read and gains "Complexity Read for SQL")
- Modify: `CLAUDE.md` (current phase: Complexity Read done (FC-25), code only)
- Test: `tests/puzzle.test.ts`

**Interfaces:**
- Consumes: `costOf`, `Reading`, `COMPLEXITY`, `categoryWeights`.
- Produces: `export function buildComplexityRead(units: readonly Unit[], rng: Rng, weightOf?: (category: string) => number): Puzzle | undefined`.

- [ ] **Step 1: Write the failing tests** in `tests/puzzle.test.ts`:

```ts
import { buildComplexityRead } from '../src/puzzle/complexity-read'
import { COMPLEXITY } from '../src/config'

const NESTED: Unit = { lang: 'TypeScript', name: 'pairs', lines: ['function pairs(items: number[], ids: number[]): number {', '  let t = 0', '  for (const x of items) {', '    for (const y of ids) {', '      t += x * y', '    }', '  }', '  return t', '}'] }

test('Complexity Read asks the Big-O with the size line and rule, and four choices from the table', async () => {
  const p = buildComplexityRead([NESTED], createRng(7))!
  expect(p.type).toBe('complexity-read')
  expect(p.question).toBe(`What is the time complexity of pairs(items, ids)?\nn = size of items, m = size of ids. ${COMPLEXITY.ruleText}`)
  expect(p.choices[p.answer]).toBe('O(n·m)')
  expect([...p.choices].sort()).toEqual(['O(n + m)', 'O(n)', 'O(n²)', 'O(n·m)'].sort())
  expect(p.code).toEqual(NESTED.lines)
  expect(p.category).toBe('two inputs')
})

test('Complexity Read reads full, shows lines, and numbers its explanation as the pane does', async () => {
  const full = ['def f(items: list[int]) -> int:', '    t = 0', '    for x in items:', '        t += x', '    …']
  const u: Unit = { lang: 'Python', name: 'f', lines: full.slice(0, 4), full: { lines: full, offset: 0 }, hidden: check => check("    log('done')", 4) }
  const p = buildComplexityRead([u], createRng(1))
  expect(p?.code).toEqual(u.lines)
  expect(p?.explanation).toBe('Line 3: loop over items. n = O(n).')
  const inner = ['function f(items: number[]): number {', '  …', '  let t = 0', '  for (const x of items) {', '    t += x', '  }', '  return t', '}']
  const v: Unit = { lang: 'TypeScript', name: 'f', lines: inner, full: { lines: inner, offset: 0 }, hidden: check => check("  log('start')", 1) }
  expect(buildComplexityRead([v], createRng(1))?.explanation).toBe('Line 4: loop over items. n = O(n).')
})

test('Complexity Read picks a weak category first when weights are given', async () => {
  const SORT: Unit = { lang: 'TypeScript', name: 's', lines: ['function s(items: number[]): number[] {', '  const out = items.toSorted()', '  return out', '}'] }
  const counts: Record<string, number> = {}
  for (let seed = 1; seed <= 200; seed += 1) {
    const p = buildComplexityRead([NESTED, SORT], createRng(seed), c => (c === 'sorting' ? 9 : 1))!
    counts[p.category] = (counts[p.category] ?? 0) + 1
  }
  expect((counts.sorting ?? 0) > (counts['two inputs'] ?? 0) * 4).toBe(true)
})

test('Complexity Read gives none when no unit has a cost; buildPuzzle falls through', async () => {
  expect(buildComplexityRead([FLAT], createRng(1))).toBe(undefined)
  const p = await buildPuzzle({ units: [UNIT], tier: 'uncommon', rng: createRng(3) })
  expect(p?.type).toBe('bug-hunt')
})

test('tiers: Uncommon asks Complexity Read; with puzzles local, Common does too; with no runner, Rare does', async () => {
  expect(puzzleTypeFor('uncommon', ['pattern-id', 'complexity-read', 'trace', 'bug-hunt'])).toBe('complexity-read')
  expect(puzzleTypeFor('common', ['complexity-read', 'trace', 'bug-hunt'])).toBe('complexity-read')
  expect(puzzleTypeFor('rare', ['complexity-read', 'bug-hunt'])).toBe('complexity-read')
  const p = await buildPuzzle({ units: [NESTED], tier: 'uncommon', rng: createRng(3) })
  expect(p?.type).toBe('complexity-read')
})
```

- [ ] **Step 2: Run** `npm test`; they fail.
Note: `readableUnit` trims only blanked lines from the ends, so the signature is always shown and `offset` is 0 in practice (trimming happens at the end); the reader still honors `offset`.

- [ ] **Step 3: Implement** `buildComplexityRead`: readings for each unit (`costOf`); category first by `weightOf` among those present when any weight is positive (Bug Hunt's rule), then a unit of that category with `rng.pick`; question line 1 `What is the time complexity of ${name}(${params.join(', ')})?` cut to `COMPLEXITY.maxQuestionChars` (cut the parameter list, keep `?`); line 2 the size line (`n = size of items`, `n = count` for a numeric n, `, m = …` when m) then a space and `COMPLEXITY.ruleText`; choices `[answer, ...COMPLEXITY.distractors[answer]]` shuffled with the rng (Fisher-Yates using `rng.int`); `answer` its index; `code` the shown `lines`; `lang`; the reading's explanation. Wire into `buildPuzzle`. Update SPEC and CLAUDE.md.
- [ ] **Step 4: Run** `npm run typecheck`, `npm run validate` and `npm test`; all pass.
- [ ] **Step 5: Commit** `Ask Complexity Read for Uncommon encounters; document it`.

---

## After the tasks

- Whole-branch review (subagent-driven-development's final review), then a `tactical` security review of the branch's changes, focused on the `hidden` closure and raw text (Global Constraints). Fix findings until CLEAN.
- Final `npm run typecheck` and `npm test`, plain.
- Do not push; the user says when.
