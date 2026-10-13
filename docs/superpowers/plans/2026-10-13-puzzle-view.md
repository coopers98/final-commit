# Puzzle View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cramped, cut-off Analyze step with a wide, scrollable Analyze pane that shows readable puzzles.

**Architecture:** Pure geometry (`src/puzzle/layout.ts`) and readability gates (`src/puzzle/readable.ts`) are new files. A local Markdown filter mode keeps backtick spans for puzzles that never leave the machine; missions build a prompt unit set and a local unit set. The Analyze pane itself lives in `src/contain/lattice.tsx` beside the report and Containment panes, because each opens the next and `$` cannot cross an import.

**Tech Stack:** TypeScript, Claude Code plugin engine 2.1.296 (`claude-code` hooks, JSX panes), tests with `claude-code/testing` via `claude plugin test .`.

**Spec:** `docs/superpowers/specs/2026-10-13-puzzle-view-design.md`

## Global Constraints

- Mission: the user starts `/mission FC-24` before Task 1 (the game credits commits only while a mission is active). Never run slash commands yourself.
- Public repo: invented data only in tests and docs (`NOVA-` keys); no hostnames, usernames, absolute local paths, real work content or PHI-like data. Never copy `CLAUDE.local.md` into tracked files.
- Every tuning number lives in `src/config.ts` (CLAUDE.md rule 2): `PUZZLE_VIEW.dockShare` 0.6, `minTranscriptColumns` 40, `twoColumnMin` 80, `panelColumns` 30, `minCodeRows` 3, `inputRows` 1, `panelReserveRows` 8, `inlineReserveRows` 6, `maxBlankShare` 0.5, `maxPlaceholderShare` 1/3.
- No store change and no schema bump (spec section 6).
- Anything sent to a model is filtered exactly as today (CLAUDE.md rule 4). Local text reaches only Bug Hunt and Trace.
- `$` reaches only top-level functions of the same file: all `$`-using code for the Analyze pane goes in `src/contain/lattice.tsx`.
- Tests: `claude plugin test .` runs every test file; test files import only relative files and `claude-code`/`claude-code/testing`; console output is not shown (throw to see data). Seed all randomness.
- American English in code, comments, docs and commits. Match the surrounding comment density and naming.
- Commit straight to `main` with the repo-local identity; end each commit message with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Do not push.
- The last step of the plan runs `npm run typecheck` and `npm test` plain (never piped or redirected), so the game records them.

## Review Focus

1. A Markdown line where a double quote straddles a backtick span (`"Jane `x` Smith"`): the reader expects the quoted text still redacted in the local view. Pinned in Task 2.
2. A puzzle whose code has one line longer than the whole window at 40 columns: the reader expects to scroll through every wrapped row and never lose the panel. Pinned in Task 5.
3. `/contain` while a Containment pane from an earlier attempt is still open: the reader expects only the Analyze pane afterwards. Pinned in Task 6.
4. Answering after closing and reopening the Analyze pane more than a minute later: the reader expects no fast bonus. Pinned in Task 6.
5. A unit that is all `…` after trimming, or a Markdown section full of placeholders: the reader expects no puzzle from it, not an unreadable one. Pinned in Task 1 and Task 3.

---

### Task 1: Tuning block and readability gates

**Files:**
- Modify: `src/config.ts` (add `PUZZLE_VIEW` after the `PUZZLE` block)
- Create: `src/puzzle/readable.ts`
- Test: `tests/readable.test.ts`

**Interfaces:**
- Consumes: `PUZZLE.unitMinLines` (4), `Unit` from `src/puzzle/units.ts` (`{ lang: string; name: string; lines: string[] }`).
- Produces:
  - `PUZZLE_VIEW` (config, `as const`).
  - `isBlankedLine(line: string): boolean`
  - `placeholderShare(text: string): number`
  - `isReadableLine(line: string): boolean`
  - `readableUnit(unit: Unit): Unit | undefined`

- [ ] **Step 1: Write the failing test**

Create `tests/readable.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'
import { PUZZLE_VIEW } from '../src/config'
import { isBlankedLine, isReadableLine, placeholderShare, readableUnit } from '../src/puzzle/readable'
import type { Unit } from '../src/puzzle/units'

// Invented content only (SPEC 15).

test('a blanked line holds a … and nothing but the punctuation the filters keep', async () => {
  expect(['…', '  …', '…;', '  } …', '(…),'].map(isBlankedLine)).toEqual([true, true, true, true, true])
  expect(['}', '', '  return total', "foo('…')", '[name] …'].map(isBlankedLine)).toEqual([false, false, false, false, false])
})

test('placeholder share counts words holding a filter token', async () => {
  expect(placeholderShare('')).toBe(0)
  expect(placeholderShare('take the [quoted] flag')).toBe(1 / 4)
  expect(placeholderShare('[name] [name] rules ([date])')).toBe(3 / 4)
  expect(placeholderShare('keys: [secret], [url]')).toBe(2 / 3)
})

test('a readable line is not blanked and at most a third placeholders', async () => {
  expect(isReadableLine('- Never remove the backup step.')).toBe(true)
  expect(isReadableLine('  …')).toBe(false)
  // 1 of 3 words: at the edge, readable.
  expect(isReadableLine('send [url] now')).toBe(true)
  // 2 of 4: past it.
  expect(isReadableLine('[name] sends [url] now')).toBe(false)
})

const unit = (lines: string[]): Unit => ({ lang: 'Markdown', name: 'Notes', lines })

test('readableUnit trims blanked lines from both ends, then re-checks the size', async () => {
  const u = unit(['## Notes', '- one fact here', '- two facts here', '- three facts here', '…', '…'])
  expect(readableUnit(u)!.lines).toEqual(['## Notes', '- one fact here', '- two facts here', '- three facts here'])
  // Four lines before trimming, three after: too small.
  expect(readableUnit(unit(['## Notes', '- one fact', '- two facts', '…']))).toBe(undefined)
  // Nothing to trim: the same unit back.
  const whole = unit(['## Notes', '- a', '- b', '- c'])
  expect(readableUnit(whole)).toBe(whole)
})

test('readableUnit skips a unit mostly blanked or mostly placeholders', async () => {
  // 3 of 6 blanked: at the edge (0.5), kept.
  expect(readableUnit(unit(['## Notes', '- a fact', '…', '…', '…', '- last fact']))).toBeDefined()
  // 4 of 7 blanked: past it.
  expect(readableUnit(unit(['## Notes', '- a fact', '…', '…', '…', '…', '- last fact']))).toBe(undefined)
  // Placeholder soup, as a strict prompt unit reads.
  expect(readableUnit(unit(['## [name] rules ([date])', '- A [quoted] gets [quoted]', '- [name] [quoted] [quoted]', '- [name] the [quoted] [quoted]']))).toBe(undefined)
  expect(PUZZLE_VIEW.maxPlaceholderShare).toBe(1 / 3)
})

test('code keeps its closing brace: a lone } is not trimmed', async () => {
  const code: Unit = { lang: 'TypeScript', name: 'f', lines: ['function f(a: number) {', '  const b = a + 1', '  return b', '}'] }
  expect(readableUnit(code)).toBe(code)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `claude plugin test .`
Expected: FAIL in `tests/readable.test.ts` (cannot resolve `../src/puzzle/readable`, and `PUZZLE_VIEW` is not exported).

- [ ] **Step 3: Add the tuning block**

In `src/config.ts`, directly after the closing `} as const` of `export const PUZZLE = {`, add:

```ts
/** SPEC 8: the Analyze pane's size and layout, and the readability gates on puzzle units. */
export const PUZZLE_VIEW = {
  /** Share of the terminal's columns the dock is asked for: at least `twoColumnMin`, leaving the transcript `minTranscriptColumns`. */
  dockShare: 0.6,
  minTranscriptColumns: 40,
  /** Body columns from which the code and the panel sit side by side; the panel's width there. */
  twoColumnMin: 80,
  panelColumns: 30,
  /** Rows the code window keeps when the panel sits beneath it. */
  minCodeRows: 3,
  /** Rows the panel's Input takes. */
  inputRows: 1,
  /** Inline: rows asked for beyond the code and choices (heading, question, result, hints), and rows left to the prompt. */
  panelReserveRows: 8,
  inlineReserveRows: 6,
  /** A unit is skipped past these shares of blanked lines or placeholder words; Bug Hunt changes no line past the second. */
  maxBlankShare: 0.5,
  maxPlaceholderShare: 1 / 3,
} as const
```

- [ ] **Step 4: Write the gates**

Create `src/puzzle/readable.ts`:

```ts
import { PUZZLE, PUZZLE_VIEW } from '../config'
import type { Unit } from './units'

// SPEC 8.3: whether a filtered unit is worth showing. A unit the filters
// mostly blanked or replaced is no puzzle: it is trimmed, or skipped. Pure.

/** The privacy filters' replacement tokens. */
const PLACEHOLDER = /\[(?:quoted|name|url|email|ip|host|key|ssn|date|phone|id|age|number|secret)\]/

/** A line a filter blanked: a `…` with nothing beside it but punctuation the filters keep (`…;`, `} …`). */
export const isBlankedLine = (line: string): boolean => line.includes('…') && line.replace(/[\s…;,{}()[\]]/g, '') === ''

/** Words (runs of non-space) holding a placeholder, over all words; 0 when there are none. */
export function placeholderShare(text: string): number {
  const words = text.split(/\s+/).filter(w => w !== '')
  return words.length === 0 ? 0 : words.filter(w => PLACEHOLDER.test(w)).length / words.length
}

/** A line worth naming in a puzzle: not blanked, and not mostly placeholders. */
export const isReadableLine = (line: string): boolean => !isBlankedLine(line) && placeholderShare(line) <= PUZZLE_VIEW.maxPlaceholderShare

/**
 * `unit` with blanked lines trimmed from both ends, or undefined when what
 * is left is too small, mostly blanked, or mostly placeholders.
 */
export function readableUnit(unit: Unit): Unit | undefined {
  let from = 0
  let to = unit.lines.length
  while (from < to && isBlankedLine(unit.lines[from]!)) from += 1
  while (to > from && isBlankedLine(unit.lines[to - 1]!)) to -= 1
  const lines = unit.lines.slice(from, to)
  if (lines.length < PUZZLE.unitMinLines) return undefined
  if (lines.filter(isBlankedLine).length / lines.length > PUZZLE_VIEW.maxBlankShare) return undefined
  if (placeholderShare(lines.join(' ')) > PUZZLE_VIEW.maxPlaceholderShare) return undefined
  return from === 0 && to === unit.lines.length ? unit : { ...unit, lines }
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `claude plugin test .` then `npm run typecheck`
Expected: all pass; no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/puzzle/readable.ts tests/readable.test.ts
git commit -m "Add the puzzle view's tuning block and the readability gates

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The local Markdown filter

**Files:**
- Modify: `src/puzzle/markdown-filter.ts` (imports; `filterMarkdown` at the end of the file)
- Test: `tests/markdown.test.ts` (append)

**Interfaces:**
- Consumes: `filterProse(text, mode)` and `filterValues(text)` from `src/puzzle/privacy-filter.ts`; `CONTROL` from `src/puzzle/code-filter.ts`.
- Produces:
  - `filterMarkdown(source: string, mode: PrivacyMode, opts?: { local?: boolean }): string` (same line count as today).
  - `filterSpan(text: string): string` (exported for tests).

- [ ] **Step 1: Write the failing tests**

Append to `tests/markdown.test.ts`:

```ts
// The local filter (puzzle view spec, section 4): for the pane only, never a prompt.
const local = (src: string, mode: 'standard' | 'strict' = 'strict') => filterMarkdown(src, mode, { local: true }).split('\n')

test('locally, backtick spans and capitalized words are shown; the prompt filter is unchanged', async () => {
  const src = '# Engine rules\n\n- A `Client` gets keys only after a mouse click; never pass `$` across an import.'
  expect(local(src)[2]).toBe('- A `Client` gets keys only after a mouse click; never pass `$` across an import.')
  expect(filterMarkdown(src, 'strict').split('\n')[2]).toContain('[quoted]')
  expect(local(src)[0]).toBe('# Engine rules')
})

test('locally, value shapes and secrets inside a span are still replaced', async () => {
  expect(local('- Call `https://nova.example.com/x` first.')[0]).toBe('- Call `[url]` first.')
  expect(local('- Mail `ops@nova.example` now.')[0]).toBe('- Mail `[email]` now.')
  expect(local('- Not `123-45-6789` here.')[0]).toBe('- Not `[ssn]` here.')
  for (const s of ['ghp_AbCdEf123456', 'sk_live_51HxQz', 'xoxb-1234-abcd', 'AKIAIOSFODNN7EXAMPL', 'AIzaSyA1234567890abcdefghijklmnopqrs', 'a1b2c3d4e5f6g7h8i9j0k1']) {
    expect(local(`- Use \`${s}\` here.`)[0]).toBe('- Use `[secret]` here.')
  }
  expect(local('- Set `DB_PASS=Tr0ub4dor&3` once.')[0]).toBe('- Set `DB_PASS=[secret]` once.')
})

test('locally, quotes and values that straddle a span are caught whole', async () => {
  expect(local('- Ask "Jane `x` Smith" first.')[0]).toBe('- Ask [quoted] first.')
  // A URL running into a span swallows it rather than leaving a backtick behind.
  expect(local('- See https://nova.example.com/a`b` now.')[0]).toBe('- See [url] now.')
  // Outside spans the prose filter still runs: double quotes, Dr. names.
  expect(local('- Ask "the lead" or Dr. Roe.')[0]).toBe('- Ask [quoted] or [name].')
})

test('locally, a private-use character in the source is dropped, and lines are kept', async () => {
  expect(local('- A  `x` mark.')[0]).toBe('- A  `x` mark.')
  const src = ['# Head', '', '```', 'code', '```', '- after `y`'].join('\n')
  expect(local(src).length).toBe(src.split('\n').length)
  // Fenced code stays blanked locally too.
  expect(local(src)[3]).toBe('…')
})

test('locally, under standard only the spans change', async () => {
  expect(local('- Keep `Alpha` and Beta.', 'standard')[0]).toBe('- Keep `Alpha` and Beta.')
  expect(filterMarkdown('- Keep `Alpha` and Beta.', 'standard')).toBe('- Keep [quoted] and Beta.')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `claude plugin test .`
Expected: FAIL: the new tests see `[quoted]` where spans should be kept (the third argument is ignored).

- [ ] **Step 3: Implement the local filter**

In `src/puzzle/markdown-filter.ts`, change the privacy import to:

```ts
import { filterProse, filterValues, type PrivacyMode } from './privacy-filter'
```

Replace the existing `filterMarkdown` (the last function in the file) with:

```ts
/** Private-use code points: a span's place while the prose filter runs. Dropped from the source first. */
const PRIVATE = /[-]/g
const SPAN_MARK = ''
const FIRST_SPAN = 0xe100

/** Token shapes a span may hold: known prefixes, secret assignments (the name is kept), long runs mixing letters and digits. */
const SECRET_RULES: readonly { pattern: RegExp; to: string }[] = [
  { pattern: /\b(?:gh[oprsu]_|github_pat_|sk_|pk_|rk_|sk-|xox[abprs]-|AKIA|AIza)[\w-]{6,}/g, to: '[secret]' },
  { pattern: /\b([\w.-]*(?:key|token|secret|pass)[\w.-]*)([ \t]*[=:][ \t]*)\S+/gi, to: '$1$2[secret]' },
  { pattern: /\b(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{20,}/g, to: '[secret]' },
]

/** A backtick span's text as the pane shows it: secret shapes, then the value shapes (URLs, emails, IDs, ...). */
export function filterSpan(text: string): string {
  let out = text
  for (const { pattern, to } of SECRET_RULES) out = out.replace(pattern, to)
  return filterValues(out).text
}

/**
 * A shown prose line for the pane only, never a prompt: backtick spans kept
 * through `filterSpan`, the rest through the prose filter without strict's
 * capitalized-word rule. Each span waits as a private-use mark while the
 * prose filter runs, so a quote around a span is still caught whole, and a
 * mark a rule swallowed is not put back.
 */
function localProse(line: string, mode: PrivacyMode): string {
  const spans: string[] = []
  const marked = line.replace(CONTROL, '').replace(PRIVATE, '').replace(/`([^`]*)`/g, (_, text: string) => {
    spans.push(text)
    return SPAN_MARK + String.fromCharCode(FIRST_SPAN + spans.length - 1)
  })
  const prose = filterProse(marked, mode === 'strict' ? 'standard' : mode).text
  return prose.replace(/([-])/g, (_, c: string) => `\`${filterSpan(spans[c.charCodeAt(0) - FIRST_SPAN] ?? '')}\``).replace(PRIVATE, '')
}

/**
 * SPEC 8.3: Markdown ready for a prompt and the pane. `off` sends it as
 * written, less control characters. `local` (puzzle view spec, section 4)
 * is for text that never leaves the machine: spans and capitalized words
 * are shown, everything else is filtered as for a prompt.
 */
export function filterMarkdown(source: string, mode: PrivacyMode, opts: { local?: boolean } = {}): string {
  const lines = source.replace(/\r(?=\n)/g, '').split('\n')
  if (mode === 'off') return lines.map(l => l.replace(CONTROL, '')).join('\n')
  const shown = shownMarkdownLines(lines)
  const blank = (l: string) => (/^[ \t]*$/.test(l) ? '' : `${/^[ \t]*/.exec(l)![0].slice(0, PUZZLE.maxLineChars)}${BLANK}`)
  // A shown line's backtick spans are single, paired and free of escapes and `<` (backtickRuns), so a renderer pairs them
  // left to right, as this does: each is quoted before the prose filter, whose other rules could take an opening backtick.
  const prose = opts.local ? (l: string) => localProse(l, mode) : (l: string) => filterProse(l.replace(CONTROL, '').replace(/`[^`]*`/g, '[quoted]'), mode).text
  return lines.map((l, i) => (shown[i] && l.length <= PUZZLE.maxLineChars ? prose(l) : blank(l))).join('\n')
}
```

- [ ] **Step 4: Run tests**

Run: `claude plugin test .`
Expected: PASS, including every existing `markdown.test.ts` test and fuzz (the prompt path is unchanged). If a secret-shape case fails, fix the rule, not the test: each listed shape must become `[secret]`.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` (expected: clean).

```bash
git add src/puzzle/markdown-filter.ts tests/markdown.test.ts
git commit -m "Add a local Markdown filter that keeps code spans for the pane

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Two unit sets, gated; Pattern ID reads only prompt units

**Files:**
- Modify: `src/puzzle/units.ts` (`ContentAdapter` type; `MD_ADAPTER`)
- Modify: `src/puzzle/material.ts` (`missionUnits`)
- Modify: `src/puzzle/puzzle.ts` (`buildPuzzle`)
- Modify: `hooks/register.tsx` (`preparePuzzle`)
- Modify callers in tests: `tests/python.test.ts:141`, `tests/markdown.test.ts` (any `missionUnits` use)
- Test: `tests/puzzle.test.ts` (append), `tests/wiring.test.tsx` (append)

**Interfaces:**
- Consumes: `filterMarkdown(source, mode, { local: true })` (Task 2), `readableUnit` (Task 1).
- Produces:
  - `ContentAdapter.filterLocal?(source: string, mode: PrivacyMode): string`
  - `missionUnits(io, startedAt, mode): Promise<MissionUnits>` where `export type MissionUnits = { units: Unit[]; localUnits: Unit[] }`
  - `buildPuzzle(req: { units; localUnits?: readonly Unit[]; tier; rng; complete?; trace?; stats? })`: Pattern ID reads `units`; Bug Hunt and Trace read `localUnits ?? units`.

- [ ] **Step 1: Write the failing unit test**

Append to `tests/puzzle.test.ts`:

```ts
test('Pattern ID is made from prompt units only; Bug Hunt from local units', async () => {
  const prompt: Unit = { ...UNIT, lines: UNIT.lines.map(l => l.replace('limit', '[quoted]')) }
  const asked: string[] = []
  const recording: Complete = async req => {
    asked.push(req.prompt)
    return undefined
  }
  const p = await buildPuzzle({ units: [prompt], localUnits: [UNIT], tier: 'common', rng: createRng(1), complete: recording })
  expect(asked.length > 0).toBe(true)
  expect(asked.some(a => a.includes('limit'))).toBe(false)
  // The model gave nothing: Bug Hunt, from the local unit.
  expect(p!.type).toBe('bug-hunt')
  expect(p!.code.join('\n')).toContain('limit')
})
```

Check the real `Complete` signature in `src/world/generate.ts` before running; if it is not `(req: { prompt: string; ... }) => Promise<string | undefined>`, adapt `recording` to it (the test's intent: record each prompt, answer nothing).

- [ ] **Step 2: Run to verify it fails**

Run: `claude plugin test .`
Expected: FAIL (`localUnits` is not a known property; or Bug Hunt shows `[quoted]`).

- [ ] **Step 3: Teach adapters a local filter**

In `src/puzzle/units.ts`, add to `ContentAdapter` after `filter`:

```ts
  /** The text the pane alone shows (puzzle view spec, section 4), line for line with `filter`'s; `filter` when absent. */
  filterLocal?(source: string, mode: PrivacyMode): string
```

and in `MD_ADAPTER`, after `filter: filterMarkdown,`:

```ts
  filterLocal: (source, mode) => filterMarkdown(source, mode, { local: true }),
```

- [ ] **Step 4: Build both sets in `missionUnits`**

In `src/puzzle/material.ts`, add the import `import { readableUnit } from './readable'`, export the result type, and replace the loop's tail and the return:

```ts
/** A mission's units: `units` for a prompt, `localUnits` for the pane alone (puzzle view spec, section 4). */
export type MissionUnits = { units: Unit[]; localUnits: Unit[] }

const gated = (units: readonly Unit[]) => units.flatMap(u => readableUnit(u) ?? [])
```

Change the signature to `Promise<MissionUnits>`, the two early `return []` to `return { units: [], localUnits: [] }`, declare `const localUnits: Unit[] = []` next to `units`, and replace from `const filtered = adapter.filter(text, mode)` to the end of the function with:

```ts
    const filtered = adapter.filter(text, mode)
    const shown = adapter.filterLocal ? adapter.filterLocal(text, mode) : filtered
    // Line numbers from the diff must still point at the same lines, in both texts.
    const lines = text.replace(/\r(?=\n)/g, '').split('\n').length
    if (filtered.split('\n').length !== lines || shown.split('\n').length !== lines) continue
    units.push(...gated(adapter.units(filtered, changed)))
    localUnits.push(...gated(adapter.units(shown, changed)))
    if (units.length >= PUZZLE.maxUnits && localUnits.length >= PUZZLE.maxUnits) break
  }
  return { units: units.slice(0, PUZZLE.maxUnits), localUnits: localUnits.slice(0, PUZZLE.maxUnits) }
}
```

Update the doc comment above `missionUnits` to: `/** Filtered units from the code changed since \`startedAt\`, gated for readability: at most \`PUZZLE.maxUnits\` of each set. */`

- [ ] **Step 5: `buildPuzzle` takes both sets**

In `src/puzzle/puzzle.ts`, add to the `req` type after `units`:

```ts
  /** The units as the pane alone shows them (puzzle view spec, section 4): Bug Hunt and Trace; `units` when absent. */
  localUnits?: readonly Unit[]
```

and change the body's start and the two local types:

```ts
  const local = req.localUnits ?? req.units
  if (req.units.length === 0 && local.length === 0) return undefined
  const built: PuzzleType[] = [...(req.complete && req.units.length > 0 ? ['pattern-id' as const] : []), ...(req.trace ? ['trace' as const] : []), 'bug-hunt']
```

then in the loop use `buildBugHunt(local, ...)` and `req.trace(local, req.rng)`; `buildPatternId(req.units, ...)` is unchanged. Update the function's doc comment: Pattern ID is made from `units`, never `localUnits`.

- [ ] **Step 6: Wire `preparePuzzle`**

In `hooks/register.tsx` `preparePuzzle`, replace the `units` and `trace` lines and the `buildPuzzle` call's first argument line:

```ts
    const { units, localUnits } = mission ? await missionUnits(io, mission.startedAt, settings.privacyMode) : { units: [], localUnits: [] }
    const trace = localUnits.length > 0 ? await traceVia($) : undefined
    const puzzle = await buildPuzzle({
      units, localUnits, tier: pending.tier, rng: await rngOf($), stats: await repo.puzzleStats(),
```

- [ ] **Step 7: Fix test callers**

Run: `grep -rn "missionUnits(" tests` and change each `const units = await missionUnits(...)` to `const { units } = await missionUnits(...)` (or `.localUnits` where the test is about what the pane shows; keep `.units` otherwise).

- [ ] **Step 8: Write the end-to-end isolation test**

Append to `tests/wiring.test.tsx` (after the existing puzzle tests; it reuses `world`, `run`, `chart`, `PANE`, `START`):

```ts
// Puzzle view spec, section 4: local text never reaches a prompt.
const NOTES_MD = [
  '# Release notes',
  '- Always add the `zqLocalOnly` flag before a deploy.',
  '- Never remove the backup step.',
  '- Run more checks when the queue is above its limit.',
  '- Enable the alert once the job is required.',
].join('\n')

const docsGit: Gh = argv => {
  if (argv[1] === 'rev-list') return { exitCode: 0, stdout: 'abc123\n' }
  if (argv.includes('diff') && argv.includes('--raw')) return { exitCode: 0, stdout: ':100644 100644 aaa bbb M\0docs/notes.md\0' }
  if (argv.includes('diff')) return { exitCode: 0, stdout: 'diff --git a/docs/notes.md b/docs/notes.md\n+++ b/docs/notes.md\n@@ -2 +2 @@\n' }
  return { exitCode: 0, stdout: 'main\n' }
}

test('with the standard filter, Pattern ID is asked with spans quoted, and the pane shows them', { options: { puzzles: 'on', privacyMode: 'standard' } }, async ($, on) => {
  const w = world(on, { git: docsGit })
  on('tool.call', () => ({ result: { stdout: '' } }) as never)
  on('fs.read', (_$, e) => (e.path.endsWith('docs/notes.md') ? { value: NOTES_MD } : Promise.reject(new Error('ENOENT'))) as never)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'mission', 'NOVA-2')
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' } as never)
  await run($, 'mission', 'complete anyway')
  await w.clock.settle()
  const asked = w.prompts.filter(p => p.includes('Release notes'))
  expect(asked.length > 0).toBe(true)
  expect(asked.some(p => p.includes('[quoted]'))).toBe(true)
  expect(w.prompts.some(p => p.includes('zqLocalOnly'))).toBe(false)
  // The model answered nothing, so the puzzle is a Bug Hunt from the local text.
  expect((await run($, 'contain')).text).toBe('Opened containment, with a puzzle first.')
  const pane = await $.ui.mount(PANE('fc-lattice', 100))
  expect((await pane.findAll({ type: 'Text' })).map(t => t.text).join('\n')).toContain('zqLocalOnly')
  await pane.unmount()
})
```

(Task 6 moves the puzzle to the `fc-analyze` pane and updates this mount with the others.)

- [ ] **Step 9: Run tests and typecheck**

Run: `claude plugin test .` then `npm run typecheck`
Expected: all pass. If the isolation test finds no prompt with `Release notes`, the seed's tier did not try Pattern ID: change `world(on, { git: docsGit })` to pass `seed` values `'1'`, `'2'`, ... until `asked.length > 0`, and keep that seed with a comment `/** Seed N rolls a tier that tries Pattern ID first. */`.

- [ ] **Step 10: Commit**

```bash
git add src/puzzle/units.ts src/puzzle/material.ts src/puzzle/puzzle.ts hooks/register.tsx tests
git commit -m "Build prompt and local unit sets, gated for readability

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Bug Hunt changes only readable lines, never inside a span, and explains in one line

**Files:**
- Modify: `src/puzzle/bug-hunt.ts` (`mutationsOf`, site pick, `explanation`)
- Test: `tests/puzzle.test.ts` (one existing assertion; append), `tests/markdown.test.ts` (append)

**Interfaces:**
- Consumes: `isReadableLine` (Task 1).
- Produces: Bug Hunt's `explanation` is `` Line N: `from` became `to`. ``; choices stay `Line N` (Task 5 parses them).

- [ ] **Step 1: Update and add tests**

In `tests/puzzle.test.ts`, in the test `Bug Hunt changes exactly one line, and its answer names that line`, replace

```ts
    expect(p.explanation).toContain(UNIT.lines[diff[0]!]!.trim())
```

with

```ts
    expect(p.explanation).toMatch(new RegExp(`^Line ${diff[0]! + 1}: \`[^\`]+\` became \`[^\`]+\`\\.$`))
```

Append to `tests/puzzle.test.ts`:

```ts
test('Bug Hunt never changes a line that is mostly placeholders', async () => {
  const soup: Unit = {
    lang: 'TypeScript',
    name: 'pick',
    lines: [
      'function pick(a: number, b: number): number {',
      '  if ([quoted] === [quoted] && [name] === [id]) return 1',
      '  const c = a + 1',
      '  const d = b - 1',
      '  return c < d ? c : d',
      '}',
    ],
  }
  for (let seed = 0; seed < 40; seed += 1) {
    const p = buildBugHunt([soup], createRng(seed))
    if (!p) continue
    expect(p.code[1]).toBe(soup.lines[1])
  }
})
```

Append to `tests/markdown.test.ts` (add `import { buildBugHunt } from '../src/puzzle/bug-hunt'` and `import { createRng } from '../src/rng'` at the top if missing):

```ts
test('a document Bug Hunt never flips a word inside a backtick span', async () => {
  const unit = {
    lang: 'Markdown',
    name: 'Steps',
    lines: ['## Steps', '- Run `git add` then `remove-cache` first.', '- Add more checks before a deploy.', '- Never remove the backup step.', '- Enable the alert once it is required.'],
  }
  for (let seed = 0; seed < 60; seed += 1) {
    const p = buildBugHunt([unit], createRng(seed))!
    expect(p.code[1]!.includes('`git add`') && p.code[1]!.includes('`remove-cache`')).toBe(true)
  }
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `claude plugin test .`
Expected: FAIL: the explanation format, and the span test (a seed flips `add` in `` `git add` ``).

- [ ] **Step 3: Implement**

In `src/puzzle/bug-hunt.ts`, add `import { isReadableLine } from './readable'`, then replace `mutationsOf` with:

```ts
/** A line's backtick spans, as [start, end) with the backticks: in a document they are code, and a flip there makes a bad puzzle. */
function spanRanges(line: string): [number, number][] {
  const out: [number, number][] = []
  const re = /`[^`]*`/g
  for (let m = re.exec(line); m; m = re.exec(line)) out.push([m.index, m.index + m[0].length])
  return out
}

/** Where `mutation` can apply in `unit`'s `line`: outside backtick spans in a document. */
function sitesIn(unit: Unit, mutation: Mutation, line: string): { at: number; length: number }[] {
  const sites = mutationSites(mutation, line)
  if (unit.lang !== 'Markdown') return sites
  const spans = spanRanges(line)
  return sites.filter(s => !spans.some(([a, b]) => s.at < b && s.at + s.length > a))
}

/** The mutations for `unit`'s language that can change `line`; none for a line that is not readable (mostly placeholders or blanked). */
const mutationsOf = (unit: Unit, line: string) => (isReadableLine(line) ? (MUTATIONS_BY_LANG[unit.lang] ?? []).filter(m => sitesIn(unit, m, line).length > 0) : [])
```

Replace `const site = rng.pick(mutationSites(mutation, original))` with `const site = rng.pick(sitesIn(unit, mutation, original))`, and the explanation with:

```ts
    explanation: `Line ${target + 1}: \`${mutation.from.trim()}\` became \`${mutation.to.trim()}\`.`,
```

- [ ] **Step 4: Run tests and typecheck**

Run: `claude plugin test .` then `npm run typecheck`
Expected: PASS. Any other test asserting the old explanation (`read \``) is updated to the new format: `grep -rn "read \\\\\`" tests`.

- [ ] **Step 5: Commit**

```bash
git add src/puzzle/bug-hunt.ts tests
git commit -m "Keep Bug Hunt off unreadable lines and code spans; explain in one line

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Marks and the pane's geometry

**Files:**
- Modify: `types/index.d.ts` (`AnalyzeView`)
- Modify: `src/puzzle/analyze.ts` (`analyzeView`, new `marksOf`)
- Create: `src/puzzle/layout.ts`
- Test: `tests/layout.test.ts` (new), `tests/puzzle.test.ts` (the `analyzeView` assertions)

**Interfaces:**
- Consumes: `PUZZLE_VIEW` (Task 1), `wrap(text, width): string[]` from `src/bridge/text.ts`, Bug Hunt's `Line N` choices (Task 4).
- Produces (all in `src/puzzle/layout.ts` unless noted):
  - `AnalyzeView` gains `marks: (number | null)[]` and `offset: number | null`; `code` is the raw lines.
  - `marksOf(puzzle: Pick<Puzzle, 'type' | 'code' | 'choices'>): (number | null)[]` (in `analyze.ts`)
  - `gutterWidth(lines: number): number`
  - `wrapCode(lines: readonly string[], marks: readonly (number | null)[], width: number): { rows: string[]; firstRow: number[] }`
  - `clampOffset(offset: number, total: number, visible: number): number`
  - `type CodeWindow = { rows: string[]; more: string | undefined; offset: number; visible: number; total: number }`
  - `codeWindow(rows: readonly string[], height: number, offset: number): CodeWindow`
  - `type PanelLine = { text: string; kind: 'heading' | 'label' | 'question' | 'choice' | 'result' | 'hint' }`
  - `panelLines(view: AnalyzeView, hints: readonly string[], width: number, maxRows?: number): PanelLine[]`
  - `type PuzzleLayout = { isColumns: boolean; codeWidth: number; panel: PanelLine[]; code: CodeWindow; start: number }`
  - `puzzleLayout(view: AnalyzeView, hints: readonly string[], size: { columns: number; rows: number | undefined }): PuzzleLayout`
  - `dockColumns(terminal: number): number`
  - `paneSize(view: AnalyzeView, terminal: { columns: number | undefined; rows: number | undefined }): { columns?: number; rows?: number }`
  - `scrollKey(c: string): number | 'page' | '-page' | undefined`
  - `isOverCode(at: { isColumns: boolean; codeColumns: number; codeRows: number; bodyOffset: number }, pointer: { column: number; row: number }): boolean`

- [ ] **Step 1: Write the failing tests**

In `tests/puzzle.test.ts`, replace

```ts
  expect(v.code[0]).toBe(` 1| ${p.code[0]}`)
```

with

```ts
  expect(v.code).toEqual(p.code)
  expect(v.offset).toBe(null)
  // Bug Hunt's choices name their lines: each marks its line with its own number.
  expect(p.choices.map(c => v.marks[Number(c.slice(5)) - 1])).toEqual([0, 1, 2, 3])
  expect(v.marks.filter(m => m !== null).length).toBe(4)
```

Create `tests/layout.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'
import type { AnalyzeView } from '../types'
import { PUZZLE_VIEW } from '../src/config'
import { marksOf } from '../src/puzzle/analyze'
import { clampOffset, codeWindow, dockColumns, gutterWidth, isOverCode, panelLines, paneSize, puzzleLayout, scrollKey, wrapCode } from '../src/puzzle/layout'

// Invented content only (SPEC 15).

const view = (over: Partial<AnalyzeView> = {}): AnalyzeView => ({
  heading: '◆ Gnaw (Rare)',
  tier: 'rare',
  label: 'Analyze Specimen · Bug Hunt · TypeScript',
  question: 'One line was changed to bring in a bug. Which one?',
  code: ['function f(a: number) {', '  const b = a + 1', '  if (b > 2) return b', '  return a', '}'],
  marks: [null, 0, 1, 2, null],
  choices: ['1  Line 2', '2  Line 3', '3  Line 4'],
  result: null,
  offset: null,
  ...over,
})

test('marks come only from a Bug Hunt choice naming a line inside the code', async () => {
  const code = ['a', 'b', 'c', 'd']
  expect(marksOf({ type: 'bug-hunt', code, choices: ['Line 2', 'Line 4', 'Line 9', 'Line x'] })).toEqual([null, 0, null, 1])
  expect(marksOf({ type: 'pattern-id', code, choices: ['Line 3', 'b', 'c', 'd'] })).toEqual([null, null, null, null])
})

test('the gutter numbers each line or marks a candidate, and long lines wrap under a hanging indent', async () => {
  expect(gutterWidth(9)).toBe(5)
  expect(gutterWidth(12345)).toBe(6)
  const w = wrapCode(['short', 'x'.repeat(30)], [null, 1], 20)
  expect(w.rows).toEqual(['   1 short', '[2]> xxxxxxxxxxxxxxx', '       xxxxxxxxxxxxx', '       xx'])
  expect(w.firstRow).toEqual([0, 1])
  for (const r of w.rows) expect([...r].length <= 20).toBe(true)
})

test('the window clamps, says what is above and below, and fits when it can', async () => {
  const rows = ['a', 'b', 'c', 'd', 'e', 'f']
  expect(codeWindow(rows, 10, 3)).toEqual({ rows, more: undefined, offset: 0, visible: 6, total: 6 })
  expect(codeWindow(rows, 3, 0)).toEqual({ rows: ['a', 'b'], more: '↓ 4 more', offset: 0, visible: 2, total: 6 })
  expect(codeWindow(rows, 3, 2)).toEqual({ rows: ['c', 'd'], more: '↑ 2 more  ↓ 2 more', offset: 2, visible: 2, total: 6 })
  expect(codeWindow(rows, 3, 99).offset).toBe(4)
  expect(codeWindow(rows, 3, -5).offset).toBe(0)
  expect(clampOffset(7, 6, 2)).toBe(4)
})

test('a line taller than the window is still reachable row by row', async () => {
  const long = wrapCode(['y'.repeat(400)], [0], 40).rows
  expect(long.length > 10).toBe(true)
  // Continuation rows can read alike, so coverage is counted by row index.
  const seen = new Set<number>()
  for (let at = 0; at < long.length; at += 1) {
    const w = codeWindow(long, 4, at)
    for (let k = 0; k < w.visible; k += 1) seen.add(w.offset + k)
  }
  expect(seen.size).toBe(long.length)
})

test('two columns from 80 body columns, stacked below; the window opens on the first candidate', async () => {
  const wide = puzzleLayout(view(), ['1-3: answer'], { columns: 80, rows: 20 })
  expect(wide.isColumns).toBe(true)
  expect(wide.codeWidth).toBe(80 - PUZZLE_VIEW.panelColumns - 1)
  const narrow = puzzleLayout(view(), ['1-3: answer'], { columns: 79, rows: 20 })
  expect(narrow.isColumns).toBe(false)
  expect(narrow.codeWidth).toBe(79)
  const many = view({ code: Array.from({ length: 30 }, (_, i) => `line ${i}`), marks: Array.from({ length: 30 }, (_, i) => (i === 12 ? 0 : null)) })
  const at = puzzleLayout(many, [], { columns: 140, rows: 10 })
  expect(at.start).toBe(12)
  expect(at.code.offset).toBe(12)
  expect(at.code.rows[0]).toContain('[1]>')
  // Once the reader scrolls, their offset wins.
  expect(puzzleLayout({ ...many, offset: 3 }, [], { columns: 140, rows: 10 }).code.offset).toBe(3)
  // At 40 columns stacked, the code keeps at least minCodeRows.
  expect(puzzleLayout(many, ['1-3: answer', 's: skip'], { columns: 40, rows: 6 }).code.rows.length + 1 >= PUZZLE_VIEW.minCodeRows).toBe(true)
  // No rows (mobile): the code is drawn whole.
  expect(puzzleLayout(many, [], { columns: 40, rows: undefined }).code.rows.length).toBe(30)
})

test('a panel taller than the body cuts the explanation first, never the choices, hints or verdict', async () => {
  const answered = view({ result: { lines: ['Not this time: the answer was 2, Line 3.', 'Line 3: `>` became `>=`. '.repeat(10)] } })
  const lines = panelLines(answered, ['Enter: on to containment', 'd: dispute this puzzle'], 30, 14)
  expect(lines.length <= 14 - PUZZLE_VIEW.inputRows).toBe(true)
  const text = lines.map(l => l.text).join('\n')
  for (const must of ['1  Line 2', '3  Line 4', 'Not this time', 'Enter: on to', 'd: dispute']) expect(text).toContain(must)
  expect(lines.some(l => l.text === '…')).toBe(true)
  // With room, everything shows, the heading first.
  expect(panelLines(answered, ['Enter'], 30)[0]).toEqual({ text: '◆ Gnaw (Rare)', kind: 'heading' })
})

test('the dock asks for a share of the terminal, at least two columns, leaving the transcript room', async () => {
  expect(dockColumns(200)).toBe(120)
  expect(dockColumns(130)).toBe(PUZZLE_VIEW.twoColumnMin)
  expect(dockColumns(110)).toBe(110 - PUZZLE_VIEW.minTranscriptColumns)
  expect(paneSize(view(), { columns: undefined, rows: undefined })).toEqual({})
  expect(paneSize(view(), { columns: 200, rows: 50 })).toEqual({ columns: 120, rows: 5 + 3 + PUZZLE_VIEW.panelReserveRows })
  expect(paneSize(view(), { columns: 200, rows: 12 }).rows).toBe(12 - PUZZLE_VIEW.inlineReserveRows)
})

test('j and k move a row, space and b a page; other keys are not scroll keys', async () => {
  expect(['j', 'k', ' ', 'b', 'd', 's', '1'].map(scrollKey)).toEqual([1, -1, 'page', '-page', undefined, undefined, undefined])
})

test('the wheel is over the code inside its window only', async () => {
  const cols = { isColumns: true, codeColumns: 49, codeRows: 20, bodyOffset: 0 }
  expect(isOverCode(cols, { column: 10, row: 5 })).toBe(true)
  expect(isOverCode(cols, { column: 60, row: 5 })).toBe(false)
  const stacked = { isColumns: false, codeColumns: 40, codeRows: 4, bodyOffset: 2 }
  expect(isOverCode(stacked, { column: 3, row: 1 })).toBe(true)
  expect(isOverCode(stacked, { column: 3, row: 2 })).toBe(false)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `claude plugin test .`
Expected: FAIL (no `src/puzzle/layout.ts`, no `marksOf`, `AnalyzeView` lacks `marks`).

- [ ] **Step 3: Change the view type**

In `types/index.d.ts`, replace the `AnalyzeView` body's `code: string[]` line with:

```ts
  /** The unit's lines as shown, without numbers: the pane draws the gutter. */
  code: string[]
  /** For each code line, the Bug Hunt choice (0-based) that names it, else null. */
  marks: (number | null)[]
```

and add after `result`:

```ts
  /** The first wrapped code row shown; null until the reader scrolls (the window opens on the first candidate). */
  offset: number | null
```

- [ ] **Step 4: Marks in `analyze.ts`**

In `src/puzzle/analyze.ts`, replace `analyzeView` with:

```ts
export function analyzeView(puzzle: Puzzle, heading: string, tier: Tier): AnalyzeView {
  return {
    heading, tier,
    label: `Analyze Specimen · ${TYPE_LABEL[puzzle.type]} · ${puzzle.lang}`,
    question: puzzle.question,
    code: [...puzzle.code],
    marks: marksOf(puzzle),
    choices: puzzle.choices.map((c, i) => `${i + 1}  ${c}`),
    result: null,
    offset: null,
  }
}

/**
 * Bug Hunt's candidate lines: for each code line, the choice that names it
 * (`Line 8`), else null. Read from the choices, so a saved puzzle needs no
 * new field; another type's choices (a model's) mark nothing.
 */
export function marksOf(puzzle: Pick<Puzzle, 'type' | 'code' | 'choices'>): (number | null)[] {
  const marks: (number | null)[] = puzzle.code.map(() => null)
  if (puzzle.type !== 'bug-hunt') return marks
  for (const [i, c] of puzzle.choices.entries()) {
    const n = /^Line (\d+)$/.exec(c)?.[1]
    const at = n === undefined ? -1 : Number(n) - 1
    if (at >= 0 && at < marks.length) marks[at] = i
  }
  return marks
}
```

Update the file's header comment's second sentence to: `Pure; the pane lays it out (src/puzzle/layout.ts).`

- [ ] **Step 5: Write `layout.ts`**

Create `src/puzzle/layout.ts`:

```ts
import type { AnalyzeView } from '../../types'
import { PUZZLE_VIEW } from '../config'
import { wrap } from '../bridge/text'

// SPEC 8, the Analyze pane's geometry (puzzle view spec, section 2). Pure:
// sizes are in wrapped rows; the pane draws what this returns.

/** The gutter's width: the widest of the line numbers and `[n]>`, and a space. */
export const gutterWidth = (lines: number): number => Math.max(String(lines).length, 4) + 1

/**
 * `lines` wrapped to `width` cells: each line's first row starts with its
 * number, or `[n]>` where `marks` names choice n - 1; the rows it wraps
 * onto are indented two cells past the gutter, so no text is cut.
 */
export function wrapCode(lines: readonly string[], marks: readonly (number | null)[], width: number): { rows: string[]; firstRow: number[] } {
  const g = gutterWidth(lines.length)
  const first = Math.max(1, width - g)
  const rest = Math.max(1, first - 2)
  const rows: string[] = []
  const firstRow: number[] = []
  for (const [i, line] of lines.entries()) {
    firstRow.push(rows.length)
    const mark = marks[i] ?? null
    let text = [...line]
    rows.push(`${(mark === null ? String(i + 1) : `[${mark + 1}]>`).padStart(g - 1)} ${text.slice(0, first).join('')}`)
    text = text.slice(first)
    while (text.length > 0) {
      rows.push(`${' '.repeat(g + 2)}${text.slice(0, rest).join('')}`)
      text = text.slice(rest)
    }
  }
  return { rows, firstRow }
}

export const clampOffset = (offset: number, total: number, visible: number): number => Math.max(0, Math.min(offset, total - visible))

/** A window over wrapped rows: the rows shown and, when not all fit, a last row saying how many are above and below. */
export type CodeWindow = { rows: string[]; more: string | undefined; offset: number; visible: number; total: number }

export function codeWindow(rows: readonly string[], height: number, offset: number): CodeWindow {
  const total = rows.length
  if (total <= height) return { rows: [...rows], more: undefined, offset: 0, visible: total, total }
  const visible = Math.max(1, height - 1)
  const at = clampOffset(offset, total, visible)
  const below = total - at - visible
  const more = [at > 0 ? `↑ ${at} more` : '', below > 0 ? `↓ ${below} more` : ''].filter(s => s !== '').join('  ')
  return { rows: rows.slice(at, at + visible), more, offset: at, visible, total }
}

export type PanelLine = { text: string; kind: 'heading' | 'label' | 'question' | 'choice' | 'result' | 'hint' }

/**
 * The panel's lines at `width`, leaving `maxRows` room for the Input too.
 * Essentials last and never cut: question, choices, the result's first line
 * (right or not) and the hints. When they do not all fit, the explanation
 * is cut first, ending in `…`; then the heading and label go.
 */
export function panelLines(view: AnalyzeView, hints: readonly string[], width: number, maxRows = Number.POSITIVE_INFINITY): PanelLine[] {
  const of = (texts: readonly string[], kind: PanelLine['kind']) => texts.flatMap(t => wrap(t, width)).map(text => ({ text, kind }))
  const head = [...of([view.heading], 'heading'), ...of([view.label], 'label')]
  const question = of([view.question], 'question')
  const choices = of(view.choices, 'choice')
  const verdict = of(view.result?.lines.slice(0, 1) ?? [], 'result')
  const more = of(view.result?.lines.slice(1) ?? [], 'result')
  const keys = of(hints, 'hint')
  const room = maxRows - PUZZLE_VIEW.inputRows
  const essential = question.length + choices.length + verdict.length + keys.length
  const shownHead = essential + head.length <= room ? head : []
  const left = room - essential - shownHead.length
  const shownMore = more.length <= left ? more : left <= 0 ? [] : [...more.slice(0, left - 1), { text: '…', kind: 'result' as const }]
  return [...shownHead, ...question, ...choices, ...verdict, ...shownMore, ...keys]
}

export type PuzzleLayout = { isColumns: boolean; codeWidth: number; panel: PanelLine[]; code: CodeWindow; start: number }

/**
 * The pane at `size` body cells. `rows` undefined (no Input to scroll with,
 * as on mobile): the code is drawn whole. Two columns from
 * `twoColumnMin`: code left, the panel right with a one-cell gap; below
 * that, stacked: the code window on top, the panel under it.
 */
export function puzzleLayout(view: AnalyzeView, hints: readonly string[], size: { columns: number; rows: number | undefined }): PuzzleLayout {
  const isColumns = size.columns >= PUZZLE_VIEW.twoColumnMin
  const panelWidth = isColumns ? PUZZLE_VIEW.panelColumns : size.columns
  const codeWidth = isColumns ? size.columns - PUZZLE_VIEW.panelColumns - 1 : size.columns
  const wrapped = wrapCode(view.code, view.marks, codeWidth)
  const first = view.marks.findIndex(m => m !== null)
  const start = first < 0 ? 0 : wrapped.firstRow[first]!
  if (size.rows === undefined) {
    return { isColumns, codeWidth, panel: panelLines(view, hints, panelWidth), code: codeWindow(wrapped.rows, wrapped.rows.length, 0), start }
  }
  const panel = panelLines(view, hints, panelWidth, isColumns ? size.rows : size.rows - PUZZLE_VIEW.minCodeRows)
  const height = isColumns ? size.rows : Math.max(PUZZLE_VIEW.minCodeRows, size.rows - panel.length - PUZZLE_VIEW.inputRows)
  return { isColumns, codeWidth, panel, code: codeWindow(wrapped.rows, height, view.offset ?? start), start }
}

/** The dock width to ask for beside a transcript `terminal` columns wide. */
export function dockColumns(terminal: number): number {
  const wanted = Math.max(PUZZLE_VIEW.twoColumnMin, Math.round(terminal * PUZZLE_VIEW.dockShare))
  return Math.max(1, Math.min(wanted, terminal - PUZZLE_VIEW.minTranscriptColumns))
}

/** What `$.ui.open` asks for: a dock width, and inline rows for the code and choices plus the panel, leaving the prompt room. */
export function paneSize(view: AnalyzeView, terminal: { columns: number | undefined; rows: number | undefined }): { columns?: number; rows?: number } {
  const out: { columns?: number; rows?: number } = {}
  if (terminal.columns !== undefined) out.columns = dockColumns(terminal.columns)
  if (terminal.rows !== undefined) {
    const wanted = view.code.length + view.choices.length + PUZZLE_VIEW.panelReserveRows
    out.rows = Math.max(PUZZLE_VIEW.minCodeRows, Math.min(wanted, terminal.rows - PUZZLE_VIEW.inlineReserveRows))
  }
  return out
}

/** A scroll key typed into the pane's Input: rows to move, or a page either way. */
export function scrollKey(c: string): number | 'page' | '-page' | undefined {
  return c === 'j' ? 1 : c === 'k' ? -1 : c === ' ' ? 'page' : c === 'b' ? '-page' : undefined
}

/** Whether a wheel at `pointer` (cells from the body's first showing row) is over the code window. */
export function isOverCode(at: { isColumns: boolean; codeColumns: number; codeRows: number; bodyOffset: number }, pointer: { column: number; row: number }): boolean {
  const row = pointer.row + at.bodyOffset
  return row >= 0 && row < at.codeRows && pointer.column >= 0 && (!at.isColumns || pointer.column < at.codeColumns)
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `claude plugin test .` then `npm run typecheck`
Expected: `tests/layout.test.ts` and `tests/puzzle.test.ts` pass. `npm run typecheck` reports errors in `src/contain/lattice.tsx` only if it builds an `AnalyzeView` without `marks`/`offset` (it uses `analyzeView`, so it should not). The wiring tests that parse ` 1| ` code rows now fail; leave them for Task 6, which rewrites them. Note which fail.

- [ ] **Step 7: Commit**

```bash
git add types/index.d.ts src/puzzle/analyze.ts src/puzzle/layout.ts tests/layout.test.ts tests/puzzle.test.ts
git commit -m "Lay out the Analyze pane: wrapped code with marks, a window, a panel

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The Analyze pane

**Files:**
- Modify: `src/contain/lattice.tsx` (module state, `open`, `proceed`, `onAnalyzeKeys`, hooks in `wireLattice`)
- Test: `tests/wiring.test.tsx` (`World`/`world`, `PANE`, the puzzle tests from `// SPEC 8: a mission's changed code` on, Task 3's isolation test)

**Interfaces:**
- Consumes: everything from `src/puzzle/layout.ts` (Task 5), `analyzeView` (Task 5), `PUZZLE_VIEW`.
- Produces: `export const ANALYZE_PANE = 'fc-analyze'`; `/contain` text unchanged (`'Opened containment, with a puzzle first.'`, `'Opened containment.'`, `'Containment could not open here; the encounter is still waiting.'`).

- [ ] **Step 1: Let the test world record open arguments and mount with a size**

In `tests/wiring.test.tsx`:
- Add `openedWith: { id: string; columns?: number; rows?: number }[]` to `World`, initialize it `openedWith: []` in `world`, and in the `ui.open` stand-in push `w.openedWith.push({ id: e.id, ...(e.columns !== undefined ? { columns: e.columns } : {}), ...(e.rows !== undefined ? { rows: e.rows } : {}) })` next to `w.opened.push(e.id)`.
- Add, below `PANE`:

```ts
/** A pane drawn in a body `bodyRows` tall, on a terminal of `viewport` size. */
const SIZED = (requestId: string, bodyColumns: number, bodyRows: number, viewport?: { columns: number; rows: number }) => ({
  ...PANE(requestId, bodyColumns),
  props: { title: '', isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows } } as never,
  ...(viewport ? { viewport } : {}),
})

/** The code rows of a drawn Analyze pane: [gutter, text]. The gutter is four cells (`   7`, `[2]>`), so a choice (`1  Line 4`) never reads as one. */
const codeRows = (texts: string[]) => texts.flatMap(t => {
  const m = /^(\[\d\]>| {3}\d| {2}\d\d| \d{3}|\d{4}) (.*)$/.exec(t)
  return m ? [[m[1]!.trim(), m[2]!] as const] : []
})
```

- Add `import { dockColumns } from '../src/puzzle/layout'` at the top.

- [ ] **Step 2: Rewrite the existing puzzle tests for the Analyze pane**

In every test from `// SPEC 8: a mission's changed code becomes the puzzle` to the end of the puzzle tests, and in Task 3's isolation test, change each `$.ui.mount(PANE('fc-lattice', ...))` that is mounted while a puzzle is being asked to `$.ui.mount(PANE('fc-analyze', ...))`. Where a test submits the result (`kind: 'submit'` on `analyzed`) and then expects `Space: seal`, unmount the Analyze pane and mount `PANE('fc-lattice', 100)` for that expectation, and add `expect(w.opened.at(-1)).toBe('fc-lattice')`.

In the first test (`with puzzles local, a mission's changed code becomes a Bug Hunt ...`), replace the two lines computing `shown` and `line` with:

```ts
  const rows = codeRows(texts)
  const shown = rows.map(([, text]) => text)
  const line = shown.findIndex((l, i) => l !== original[i]) + 1
  // The candidates are marked in the gutter with their choice's number.
  expect(rows.filter(([g]) => g.startsWith('[')).length).toBe(4)
```

- [ ] **Step 3: Write the new failing wiring tests**

Append after the puzzle tests:

```ts
// Puzzle view spec, section 1.
test('the puzzle opens in its own Analyze pane, asking for a wide dock', { options: { puzzles: 'local' } }, async ($, on) => {
  const w = world(on, { git: missionGit })
  on('tool.call', () => ({ result: { stdout: '' } }) as never)
  await missionWithCode($, on, w)
  expect((await run($, 'contain')).text).toBe('Opened containment, with a puzzle first.')
  const last = w.openedWith.at(-1)!
  expect(last.id).toBe('fc-analyze')
  expect(typeof last.columns).toBe('number')
})

test('"Contain now" from the report sizes the pane from the terminal the report was drawn on', { options: { puzzles: 'local' } }, async ($, on) => {
  const w = world(on, { git: missionGit })
  on('tool.call', () => ({ result: { stdout: '' } }) as never)
  await missionWithCode($, on, w)
  const report = await $.ui.mount(SIZED('fc-report', 100, 30, { columns: 200, rows: 50 }))
  await report.input({ key: 'report', text: '', kind: 'submit' })
  await report.unmount()
  const last = w.openedWith.at(-1)!
  expect(last).toEqual({ id: 'fc-analyze', columns: dockColumns(200), rows: 7 + 4 + 8 })
})

test('j and k scroll the code window; the panel stays', { options: { puzzles: 'local' } }, async ($, on) => {
  const w = world(on, { git: missionGit })
  on('tool.call', () => ({ result: { stdout: '' } }) as never)
  await missionWithCode($, on, w)
  await run($, 'contain')
  const pane = await $.ui.mount(SIZED('fc-analyze', 100, 4))
  const texts = async () => (await pane.findAll({ type: 'Text' })).map(t => t.text)
  const first = codeRows(await texts()).map(([g]) => g)
  expect(first.length).toBe(3)
  expect((await texts()).some(t => t.includes('more'))).toBe(true)
  await pane.input({ key: 'analyze', text: 'k', kind: 'change' })
  await pane.input({ key: 'analyze', text: 'kk', kind: 'change' })
  await pane.input({ key: 'analyze', text: 'kkk', kind: 'change' })
  expect(codeRows(await texts())[0]![0]).toBe('1')
  await pane.input({ key: 'analyze', text: 'kkkj', kind: 'change' })
  expect(codeRows(await texts())[0]![0]).not.toBe('1')
  // The question and the Input never scroll away.
  expect((await texts()).some(t => t.startsWith('1  Line '))).toBe(true)
  expect(await pane.find({ key: 'analyze' })).toBeDefined()
  await pane.unmount()
})

test('the wheel over the code scrolls the code, not the body', { options: { puzzles: 'local' } }, async ($, on) => {
  const w = world(on, { git: missionGit })
  on('tool.call', () => ({ result: { stdout: '' } }) as never)
  await missionWithCode($, on, w)
  await run($, 'contain')
  const pane = await $.ui.mount(SIZED('fc-analyze', 100, 4))
  const top = codeRows((await pane.findAll({ type: 'Text' })).map(t => t.text))[0]![0]
  const moved = await $.ui.scroll({ component: 'Pane', requestId: 'fc-analyze', offset: 1, by: 1, bodyRows: 4, contentRows: 4, origin: { kind: 'person' }, pointer: { column: 2, row: 1 } } as never)
  expect(moved).toBeDefined()
  expect(codeRows((await pane.findAll({ type: 'Text' })).map(t => t.text))[0]![0]).not.toBe(top)
  await pane.unmount()
})

test('/contain with a Containment pane still open closes it, so only Analyze shows', { options: { puzzles: 'local' } }, async ($, on) => {
  const w = world(on, { git: missionGit })
  on('tool.call', () => ({ result: { stdout: '' } }) as never)
  const closed: string[] = []
  on('ui.close', (_$, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  await missionWithCode($, on, w)
  await run($, 'contain')
  expect(closed).toContain('fc-lattice')
})

test('reopening the puzzle does not restart the fast-answer clock', { options: { puzzles: 'local' } }, async ($, on) => {
  const w = world(on, { git: missionGit })
  on('tool.call', () => ({ result: { stdout: '' } }) as never)
  await missionWithCode($, on, w)
  await run($, 'contain')
  await w.clock.advance(61_000)
  await run($, 'contain')
  const pane = await $.ui.mount(PANE('fc-analyze', 100))
  const texts = (await pane.findAll({ type: 'Text' })).map(t => t.text)
  const original = TOTAL_TS.split('\n')
  const line = codeRows(texts).map(([, t]) => t).findIndex((l, i) => l !== original[i]) + 1
  const choice = texts.filter(t => /^\d {2}Line /.test(t)).findIndex(t => t.endsWith(`Line ${line}`)) + 1
  await pane.input({ key: 'analyze', text: String(choice), kind: 'change' })
  const right = (await pane.findAll({ type: 'Text' })).map(t => t.text).join(' ')
  const pct = Number(/Containment \+(\d+)%/.exec(right)![1])
  // No fast bonus: exactly a tier's base bonus.
  expect(Object.values(PUZZLE.bonusByTier).map(b => Math.round(b * 100))).toContain(pct)
  await pane.unmount()
})

test('when Containment cannot be placed after the answer, a toast says so and the encounter waits', { options: { puzzles: 'local' } }, async ($, on) => {
  const w = world(on, { git: missionGit, refuse: ['fc-lattice'] })
  on('tool.call', () => ({ result: { stdout: '' } }) as never)
  await missionWithCode($, on, w)
  await run($, 'contain')
  const pane = await $.ui.mount(PANE('fc-analyze', 100))
  await pane.input({ key: 'analyze', text: 's', kind: 'change' })
  expect(w.toasts).toContain('Containment could not open here. The specimen is still here: /contain')
  await pane.unmount()
  expect((await run($, 'contain')).text).toBe('Containment could not open here; the encounter is still waiting.')
})
```

Add `PUZZLE` to the `../src/config` import at the top.

If the second-to-last world's `ui.close` stand-in conflicts with `world`'s own (two hooks on one event), register `closed` first and call `next(e)` instead of answering: `on('ui.close', (_$, e, next) => { closed.push(e.id); return next(e) })`, placed before `world(...)`.

If `$.ui.scroll` in the wheel test rejects the input shape (the kit's noun takes `UiScrollArgs`), replace that test with a comment `// The kit cannot raise a person's wheel; isOverCode is unit-tested and the wheel is checked live (U2).` and keep the rest.

- [ ] **Step 4: Run to verify the new tests fail**

Run: `claude plugin test .`
Expected: FAIL: no `fc-analyze` pane is opened (the puzzle still draws in `fc-lattice`).

- [ ] **Step 5: Module state and helpers in `lattice.tsx`**

In `src/contain/lattice.tsx`:
- Imports: add `PUZZLE_VIEW` to the `../config` import; add `import { clampOffset, isOverCode, paneSize, puzzleLayout, scrollKey, type PanelLine } from '../puzzle/layout'`.
- After `export const REPORT_PANE = 'fc-report'`, add:

```ts
/** SPEC 8: the puzzle asked before containment, in a pane of its own (puzzle view spec, section 1). */
export const ANALYZE_PANE = 'fc-analyze'
```

- After `let actions = 0`, add:

```ts
/** The terminal's size as the last drawing of these panes saw it: the report's "Contain now" has no command to read it from. */
let terminal: { columns: number; rows: number } | undefined
/** SPEC 8: when each encounter's puzzle was first shown this session, so closing and reopening does not restart the fast-answer clock. */
const firstShown = new Map<string, number>()
/** The Analyze pane's last drawing: what the scroll keys and the wheel move. */
let shown: { offset: number; visible: number; total: number; codeRows: number; codeColumns: number; isColumns: boolean; bodyOffset: number } | undefined

/** Remembers the terminal's size from a drawing (a remote surface's is not the terminal's). */
function see(e: { surface: string; viewport?: { columns: number; rows: number } }) {
  if (e.surface === 'terminal' && e.viewport) terminal = { columns: e.viewport.columns, rows: e.viewport.rows }
}

/** Closes one of these panes, open or not. A plugin's own close runs no ui.close hook of its own: the caller clears its state. */
async function closePane($: EngineInterface, id: string) {
  try {
    await $.ui.close({ id })
  } catch {
    // Not open: nothing to close.
  }
}

/** Moves the code window by `by` wrapped rows, within the code. */
async function scrollCode($: EngineInterface, by: number) {
  const s = shown
  if (!s || by === 0) return
  await update($, analyze, v => (v ? { ...v, offset: clampOffset(s.offset + by, s.total, s.visible) } : v))
}

/** Starts the lattice and opens its pane; false, with nothing left running, when it cannot be placed. */
async function openLattice($: EngineInterface, args: string): Promise<boolean> {
  await begin($, args)
  const placed = await $.ui.open({ id: LATTICE_PANE, title: 'Containment', focus: true, closeOnEscape: true, holdToasts: true })
  if (placed.isPlaced) return true
  stop()
  await update($, view, () => null)
  return false
}
```

- [ ] **Step 6: Replace `open`**

Replace the whole `open` function with:

```ts
async function open($: EngineInterface, args: string, columns?: number): Promise<string> {
  if (!(await read($, ready))) return 'The Final Commit could not load its save; see the debug log (claude --debug).'
  const repo = repoOf($)
  const pending = await repo.pending()
  if (!pending) return 'Nothing to contain right now.'
  stop()
  // SPEC 8: a prepared puzzle not yet answered comes first. One still being prepared is not waited for.
  const puzzle = pending.puzzle && !pending.analysis ? pending.puzzle : undefined
  if (puzzle) {
    // One pane at a time: a Containment pane left from an earlier attempt goes.
    await update($, view, () => null)
    await closePane($, LATTICE_PANE)
    const species = (await repo.system(pending.systemId))?.species.find(s => s.id === pending.speciesId)
    const shownAt = firstShown.get(pending.id) ?? (await $.clock.now())
    firstShown.set(pending.id, shownAt)
    asking = { args, shownAt, typed: 0 }
    const v = analyzeView(puzzle, headingOf(pending, species?.name), pending.tier)
    await update($, analyze, () => v)
    const size = paneSize(v, { columns: columns ?? terminal?.columns, rows: terminal?.rows })
    const placed = await $.ui.open({ id: ANALYZE_PANE, title: 'Analyze', focus: true, closeOnEscape: true, holdToasts: true, ...size })
    if (placed.isPlaced) return 'Opened containment, with a puzzle first.'
    asking = undefined
    await update($, analyze, () => null)
    return 'Containment could not open here; the encounter is still waiting.'
  }
  asking = undefined
  await update($, analyze, () => null)
  await closePane($, ANALYZE_PANE)
  return (await openLattice($, args)) ? 'Opened containment.' : 'Containment could not open here; the encounter is still waiting.'
}
```

- [ ] **Step 7: Replace `proceed` and `onAnalyzeKeys`**

```ts
/** From the answered (or skipped) puzzle on to the lattice: Analyze closes, then Containment opens. */
async function proceed($: EngineInterface) {
  const args = asking?.args ?? ''
  asking = undefined
  shown = undefined
  // A plugin's own $.ui.close does not reach its own ui.close hook, so the view is cleared here.
  await update($, analyze, () => null)
  await closePane($, ANALYZE_PANE)
  if (!(await openLattice($, args))) $.ui.toast('Containment could not open here. The specimen is still here: /contain')
}
```

```ts
/**
 * Keys typed in the Analyze pane arrive as growth of its Input's value. A
 * digit answers, `s` skips; on the result, `d` disputes; before and after,
 * `j`/`k` scroll the code a row and space/`b` a page.
 */
async function onAnalyzeKeys($: EngineInterface, value: string) {
  const a = asking
  const v = await read($, analyze)
  if (!a || !v) return
  const added = value.length > a.typed ? value.slice(a.typed) : ''
  a.typed = value.length
  for (const c of added) {
    const move = scrollKey(c)
    if (move !== undefined) {
      const page = shown?.visible ?? 1
      await scrollCode($, move === 'page' ? page : move === '-page' ? -page : move)
      continue
    }
    if (v.result) {
      if (c.toLowerCase() === 'd') return dispute($)
      continue
    }
    const key = analyzeKey(c, v.choices.length)
    if (key === undefined) continue
    return answer($, key === 'skip' ? undefined : key)
  }
}
```

- [ ] **Step 8: Hooks in `wireLattice`**

- At the top of the `REPORT_PANE` `ui.render` hook body and of the `LATTICE_PANE` `ui.render` hook body, add `see(e)` as the first line.
- Change the `contain` command hook to pass the terminal's width:

```ts
  on('command.run', { command: 'contain' }, async ($, e) => ({ text: await open($, e.args, e.presentation.columns) }))
```

- Replace the `LATTICE_PANE` `ui.close` hook with:

```ts
  on('ui.close', { id: LATTICE_PANE }, async ($, e, next) => {
    if (run) {
      stop()
      $.ui.toast('Containment paused. The specimen is still here: /contain')
    }
    await update($, view, () => null)
    return next(e)
  })

  on('ui.close', { id: ANALYZE_PANE }, async ($, e, next) => {
    // Esc: the encounter and its puzzle keep waiting for /contain.
    if (asking) $.ui.toast('Containment paused. The specimen is still here: /contain')
    asking = undefined
    shown = undefined
    await update($, analyze, () => null)
    return next(e)
  })

  on('ui.scroll', { component: 'Pane', requestId: ANALYZE_PANE }, async ($, e, next) => {
    const s = shown
    // The wheel over the code moves the code and the body stays put; anything else is the engine's.
    if (!s || !e.pointer || !isOverCode({ ...s }, e.pointer)) return next(e)
    await scrollCode($, e.by)
    return next({ ...e, offset: s.bodyOffset })
  })
```

- Remove the `const q = await read($, analyze)` branch (`if (q) { ... }`) from the `LATTICE_PANE` render hook, and add the Analyze render hook:

```tsx
  on('ui.render', { component: 'Pane', requestId: ANALYZE_PANE }, async ($, e) => {
    see(e)
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // Mobile has no Input; it falls back to buttons, and the code is drawn whole: nothing there scrolls a window.
    const Input = 'Input' in elements ? elements.Input : undefined
    const q = await read($, analyze)
    if (!q) return <Text dimColor>Nothing to analyze.</Text>
    const qColor = tierColor(q.tier, await $.clock.now())
    const isDisputed = q.result?.lines.includes(DISPUTED_LINE) ?? false
    const hints = [
      ...(q.result ? ['Enter: on to containment', ...(isDisputed ? [] : ['d: dispute this puzzle'])] : [`1-${q.choices.length}: answer`, 's: skip', 'Esc: later']),
      ...(Input ? ['j k space b: scroll code'] : []),
    ]
    const layout = puzzleLayout(q, hints, { columns: e.props.bodyColumns, rows: Input ? e.props.scroll?.bodyRows : undefined })
    shown = {
      offset: layout.code.offset, visible: layout.code.visible, total: layout.code.total,
      codeRows: layout.code.rows.length + (layout.code.more ? 1 : 0), codeColumns: layout.codeWidth,
      isColumns: layout.isColumns, bodyOffset: e.props.scroll?.offset ?? 0,
    }
    const line = (l: PanelLine) =>
      l.kind === 'heading' ? <Text bold color={qColor}>{l.text}</Text>
        : l.kind === 'question' ? <Text bold>{l.text}</Text>
          : l.kind === 'label' || l.kind === 'hint' ? <Text dimColor>{l.text}</Text>
            : <Text>{l.text}</Text>
    const code = (
      <Box flexDirection="column" width={layout.codeWidth}>
        {layout.code.rows.map(row => (
          <Text>{row}</Text>
        ))}
        {layout.code.more !== undefined && <Text dimColor>{layout.code.more}</Text>}
      </Box>
    )
    const panel = (
      <Box flexDirection="column" width={layout.isColumns ? PUZZLE_VIEW.panelColumns : layout.codeWidth}>
        {layout.panel.map(line)}
        {Input ? (
          <Input key={q.result ? 'analyzed' : 'analyze'} autoFocus label={q.result ? 'Enter' : 'Answer'} onInput={(value: string) => void onAnalyzeKeys($, value)} onSubmit={() => void (q.result ? proceed($) : undefined)} />
        ) : q.result ? (
          <Box>
            <Button key="on" label="Contain" onPress={() => void proceed($)} />
            {!isDisputed && <Button key="dispute" label="Dispute" onPress={() => void dispute($)} />}
          </Box>
        ) : (
          <Box>
            {q.choices.map((_, i) => (
              <Button key={`c${i}`} label={String(i + 1)} onPress={() => void answer($, i)} />
            ))}
            <Button key="skip" label="Skip" onPress={() => void answer($, undefined)} />
          </Box>
        )}
      </Box>
    )
    return layout.isColumns ? (
      <Box flexDirection="row">
        {code}
        <Box width={1} />
        {panel}
      </Box>
    ) : (
      <Box flexDirection="column">
        {code}
        {panel}
      </Box>
    )
  })
```

- Delete the now-unused `hintLines` only if nothing else uses it (`grep -n hintLines src/contain/lattice.tsx`); keep `fit`, which the other panes use.
- Update the file's header comment: add a sentence after the first: `A prepared puzzle is asked first, in the Analyze pane (SPEC 8), which hands on to Containment.`

- [ ] **Step 9: Run tests and typecheck**

Run: `claude plugin test .` then `npm run typecheck`
Expected: all pass. If `e.props.scroll` is typed as required, drop the `?.` in both places. If `Box` rejects `width`, check `BoxProps` in the generated types (`grep -n "width?:" .claude-plugin/types/*.d.ts` or the bundled `claude-code.d.ts`) and use the prop name it gives.

- [ ] **Step 10: Commit**

```bash
git add src/contain/lattice.tsx tests/wiring.test.tsx
git commit -m "Ask the puzzle in its own wide Analyze pane, scrollable, before containment

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Docs, final checks, and the live check

**Files:**
- Modify: `docs/SPEC.md` (section 8 intro and 8.4; 15.4), `docs/GUIDE.md` (`### Analyze Specimen (a puzzle first)`; any privacy paragraph), `README.md` (`## What data the mod sends, and where`), `src/store/schema.ts:96` and `:104` (comments), `CLAUDE.md` (`## Current phase`)

- [ ] **Step 1: SPEC**

In `docs/SPEC.md` section 8.4, add a bullet after the **Types** bullet:

```markdown
- **The Analyze pane (FC-24):** the puzzle is asked in its own pane (`fc-analyze`) before Containment. It asks for a dock of `PUZZLE_VIEW.dockShare` of the terminal (at least `twoColumnMin` columns, leaving the transcript `minTranscriptColumns`) and, inline, rows for the code and choices. From `twoColumnMin` body columns the code sits left, wrapped under a hanging indent, in a window the reader scrolls with `j`/`k` (a row), space/`b` (a page) or the wheel; the panel (question, choices, result, keys) sits right and never scrolls away. Narrower, the panel sits under the code; on mobile the code is drawn whole. Bug Hunt's candidate lines are marked `[n]>` in the gutter, read from its `Line N` choices; its explanation names the change in one line. Enter after the result closes the pane and opens Containment; Esc leaves the encounter waiting. The fast-answer clock runs from the first time the puzzle was shown in the session.
- **Local display and gates (FC-24):** each mission builds two unit sets. Prompt units are filtered as above and are the only ones Pattern ID sees. Local units, which Bug Hunt and Trace use and which never leave the machine, differ for Markdown only: a backtick span is shown, with its value shapes and token shapes (`[secret]`) still replaced, and strict's capitalized-word rule is off; double-quoted text and value shapes outside spans are filtered as for a prompt. Both sets are gated: blanked lines are trimmed from a unit's ends, and a unit is skipped when more than `maxBlankShare` of its lines are blanked or more than `maxPlaceholderShare` of its words are placeholders. Bug Hunt changes only a readable line, and never inside a span.
```

In 15.4, add one sentence to the disclosure duty: the waiting encounter and the dispute log (last 50) hold the puzzle's local text, in which Markdown code spans and capitalized words are shown.

- [ ] **Step 2: GUIDE, README, schema comments, CLAUDE.md**

- GUIDE `### Analyze Specimen (a puzzle first)`: describe the Analyze pane in player terms (the wide pane, the marked lines, `j`/`k` and space/`b` to scroll, Enter on to containment, Esc to come back later), and that a puzzle shows document code spans as written because it never leaves the machine.
- README `## What data the mod sends, and where`: under what stays local, add that puzzles shown only in the pane (Bug Hunt, Trace) show Markdown code spans and capitalized words, and that the save keeps that text with the waiting encounter and disputed puzzles; nothing of it is sent to a model.
- `src/store/schema.ts`: the `PendingEncounter.puzzle` comment gains `its code is the local text the pane shows (puzzle view spec, section 4)`; the `PuzzleDispute` comment's `its code is the filtered code it showed` becomes `its code is the local text it showed`.
- `CLAUDE.md` `## Current phase`: after the FC-23 sentence, add `The Analyze pane (FC-24: a wide, scrollable puzzle view, local display of Markdown spans, readability gates) is done.`

- [ ] **Step 3: Guardrail check**

Read the whole diff (`git diff`) against CLAUDE.md's "This is a PUBLIC repository" list. The commit hook (DENYLIST and gitleaks, see README "Local guardrail hooks") runs again on commit; never bypass it.
Expected: nothing on that list in the diff.

- [ ] **Step 4: Final checks, run plain**

Run, each on its own, not piped or redirected:

```bash
npm run typecheck
```

```bash
npm test
```

Expected: both pass. Report the test count from the output.

- [ ] **Step 5: Commit**

```bash
git add docs/SPEC.md docs/GUIDE.md README.md src/store/schema.ts CLAUDE.md
git commit -m "Document the Analyze pane, local display and readability gates

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Hand the live check to the user**

The test kit cannot show these; ask the user to run them in their fullscreen tmux (`claude --plugin-dir .`), then record the answers in the spec's "Unverified" list:

1. U1: `/contain` with a puzzle waiting: does the dock open at about 60% of the terminal?
2. U2: does the mouse wheel over the code scroll the code (and not the whole pane)?
3. U3: Enter after answering: does Containment open, focused, so Space seals?
4. U4: in a terminal under 110 columns (inline): does the pane stay at the requested height, panel under the code?
5. A 40-line unit: can every line be reached with `j`/`k` and space/`b`?
