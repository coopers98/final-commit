# Puzzle view: a pane you can read (design)

Date: 2026-10-13. Status: approved after a self review and an adversarial
review. Scope: part A of a two-part plan. Part B (puzzles about the
mission's real diff, shown before | after) is a later mission that reuses
this view.

## Problem

The Analyze step was unusable in play:

1. The step draws inside the Containment pane, which opens at the default
   size. A puzzle of up to 40 code lines plus question, choices and hints
   is taller than that, and a short pane clips from the top.
2. Every code line is cut to the pane's width (`fit`), not wrapped, so a
   Bug Hunt's changed word can sit in the part that is cut off.
3. Under `strict`, a Markdown unit turns to placeholder soup: every
   backtick span becomes `[quoted]`, most capitalized words become
   `[name]`, and runs of blanked `…` lines pad the unit.

## Goals

- The whole puzzle is readable and reachable in the fullscreen layout.
- The question, choices and keys never scroll away.
- Puzzles that never leave the machine show Markdown prose as written.
- No unreadable unit is offered as a puzzle.

Non-goals: tuning for phones (usable is enough), new puzzle types. What is
sent to a model is filtered exactly as today; the gates (section 5) can
only remove units from a prompt, never add text to one.

## Engine facts this relies on (2.1.296)

Verified in the types:

- In the fullscreen layout from 110 columns a pane docks beside the
  transcript, floor to ceiling; elsewhere it sits inline above the prompt.
  `$.ui.open({ columns })` requests a dock width and `rows` an inline
  height. Both are requests: a size the person set wins.
- `Pane` render props carry `bodyColumns`, `placement` and `scroll`
  (`bodyRows`, the room's rows, not the rows showing). Inline, the frame
  fits the tree.
- Every `ui.render` input may carry `viewport` (`columns`, `rows`) and its
  `surface`. `viewport.rows` is not refreshed by a height-only change.
- `ui.scroll` carries `by`, `offset`, `bodyRows`, `contentRows` and, for a
  wheel, `pointer`. Arrow keys raise it only while the engine has rows to
  scroll, so arrows never move a window the plugin draws to fit.
- `$` reaches only top-level functions of the same file (CLAUDE.md).

Unverified until a live run (the plan ends with a manual check):

- U1. The dock grants the `columns` request.
- U2. The wheel raises `ui.scroll` over a tree that fits the body.
- U3. Opening Containment from the Analyze pane's Input submit is placed at
  any width. The report pane's "Contain now" already does exactly this
  hop (`dismissReport`, lattice.tsx), so it is expected to hold.
- U4. Inline, a window sized to `min(bodyRows, needed)` keeps the frame to
  the requested `rows`.

## Design

### 1. The Analyze pane

- The puzzle gets its own pane (`ANALYZE_PANE`, title "Analyze"), separate
  from Containment. It lives in `src/contain/lattice.tsx` beside the
  report and Containment panes, because each opens the next and `$` does
  not cross an import. Only pure code moves to new files (section 7).
- `/contain` with an unanswered puzzle opens it with `focus`,
  `closeOnEscape`, `holdToasts`, `columns` at `PUZZLE_VIEW.dockShare` of
  the terminal's columns, and `rows` for the inline case.
- The terminal's size: `command.run`'s `presentation.columns` when
  `/contain` is typed; otherwise (the report's "Contain now") the last
  `viewport` a `ui.render` of this plugin saw with `surface` `terminal`.
  With neither, `columns` and `rows` are left out and the engine's default
  stands. `rows` asks for the code plus the panel, capped at the
  remembered viewport rows (approximate, by the engine's own note).
- Each of the two panes closes the other as it opens, so a Containment
  pane left from an earlier attempt never sits beside Analyze.
- After the result, Enter closes Analyze, waits for the close, then opens
  Containment, as the report's "Contain now" does today. If Containment is
  not placed, a toast says so and the encounter keeps waiting for
  `/contain`; nothing is lost.
- Esc closes Analyze (`ui.close`, origin `person`) and leaves the encounter
  waiting, with the existing "paused" toast. The plugin's own `$.ui.close`
  does not run its own `ui.close` hook, so the Enter path clears the
  pane's state itself.
- The answer and dispute logic (with the `isSaving` guard) stays in
  lattice.tsx, moved from the Containment render to the Analyze render.
- The fast-answer bonus counts from the first time this encounter's puzzle
  was shown in this session (a module map by encounter id), not from each
  reopening, so reading, closing and reopening does not reset the clock.

### 2. Layout

All sizes are in wrapped rows: the code's text is wrapped first, then the
window, offsets, counts and clamping work on the wrapped rows.

- Two columns when `bodyColumns >= PUZZLE_VIEW.twoColumnMin` (80):
  - Right, `PUZZLE_VIEW.panelColumns` (30) wide: heading, label, question,
    choices, result, key hints and the Input, wrapped. Essentials last: if
    the panel is taller than the body, the explanation is cut first (with
    `…`), never the choices, hints or Input.
  - Left: the code, wrapped with a hanging indent under the gutter, so no
    line is cut. The window is `min(bodyRows, wrapped rows)` tall, with an
    `↑ n more` / `↓ n more` row (n in wrapped rows) when there is more.
- Below that width (inline, narrow): stacked. The code window on top, the
  panel beneath it, the window taking the rows left; when that is fewer
  than `PUZZLE_VIEW.minCodeRows` (3), the window keeps 3 rows and the
  engine's body scroll covers the overflow.
- Mobile (no `Input`): the code is drawn whole, wrapped, with no window;
  the pane's own scrolling and the existing answer buttons serve.
- Gutter: the line number, or `[n]>` on a Bug Hunt candidate line, where
  `n` is the choice that names it. The window opens with the first
  candidate's first wrapped row at its top (clamped).
- Scrolling the code, before and after the answer: `j`/`k` one wrapped
  row, `space`/`b` a window's height, typed into the Input that takes the
  answer digits. The wheel, through a `ui.scroll` hook on the Analyze
  pane: when the event has a `pointer` over the code window's rows (or
  the whole body in two columns), the hook moves the code offset by `by`
  and passes `next({ ...e, offset: e.offset - e.by })`, so the body does
  not also move; otherwise it passes `next(e)` and the engine scrolls the
  body (the stacked overflow case). Arrows are not claimed.

### 3. Bug Hunt's text

- The result's explanation for a new Bug Hunt is short:
  `Line 8: \`from\` became \`to\`.` The code column shows the line itself.
  A saved puzzle with the old long explanation is cut as section 2 says.
- Gutter marks are derived, not stored: only when `type === 'bug-hunt'`,
  each choice matching `^Line (\d+)$` with the number inside the code
  marks that line. A test pins the derivation against Bug Hunt's own
  output, so a change to the choice wording fails it.
- In a Markdown unit, a mutation never lands inside a backtick span: the
  spans are now visible code, and flipping a word there makes a bad
  puzzle.

### 4. Local prose display

- Local units apply in every privacy mode: they are what Bug Hunt and
  Trace show, which never leave the machine. Under `standard` the change
  is the backtick spans only; under `strict` also the capitalized words.
- Only Markdown prose carries the noise; the code adapters already blank
  literals and comments, so their local and prompt text are the same.
- `filterMarkdown(text, mode, { local: true })`, per shown line:
  1. Strip the sentinel character (a private-use code point) from the
     line, then replace each backtick span with a numbered sentinel.
  2. Run `filterProse` on that line, with the capitalized-word rule off.
     A double quote that straddles a span is therefore still caught whole,
     and a URL cannot run into a span's closing backtick.
  3. Put back each sentinel that survived, as the span with its text run
     through `filterValues` and the local secret rule below. A sentinel
     swallowed by a rule (inside a quote) stays swallowed.
- Local secret rule (spans only): token shapes are replaced by
  `[secret]`: known prefixes (`ghp_`, `gho_`, `github_pat_`, `sk_`, `pk_`,
  `xox`, `AKIA`, `AIza`), `KEY=value` assignments whose name contains
  `KEY`, `TOKEN`, `SECRET` or `PASS`, and any run of 20 or more letters and
  digits mixing both.
- What a span still shows, stated plainly: quoted text inside a span
  (`'hunter2'`) is shown as written, because inside a span it is code.
  That is part of what the user accepted.
- Each mission builds two unit sets from one read of each file: prompt
  units (unchanged; Pattern ID uses only these) and local units (Bug Hunt
  and Trace use only these). The local filter keeps the line count, and
  the same line-count check guards it. `buildPuzzle` takes `units` and
  `localUnits`. `PUZZLE.maxUnits` caps each set on its own.
- Accepted cost: the pending encounter and the dispute log (last 50) store
  the local text.

### 5. Quality gates (all adapters, each unit set on its own text)

Thresholds live in `src/config.ts` under `PUZZLE_VIEW`.

- A blanked line: one holding a `…` that, with whitespace and the
  characters `…;,{}()[]` removed, is empty (the SQL adapter's `…;` counts;
  a lone `}` does not, so code keeps its closing brace).
- A placeholder: any of the filter's tokens (`[quoted]`, `[name]`,
  `[url]`, `[email]`, `[ip]`, `[host]`, `[key]`, `[ssn]`, `[date]`,
  `[phone]`, `[id]`, `[age]`, `[number]`, `[secret]`). A word: a run of
  non-space characters. A text's placeholder share: words holding a
  placeholder over all words.
- Trim blanked lines from a unit's start and end, then re-check
  `PUZZLE.unitMinLines`.
- Skip a unit when more than `maxBlankShare` (0.5) of its lines are
  blanked, or its placeholder share is more than `maxPlaceholderShare`
  (1/3).
- Bug Hunt mutates only a line that is not blanked and whose own
  placeholder share is at most `maxPlaceholderShare`.
- No readable unit left: no puzzle, and the encounter goes straight to
  containment, as with no units today.

### 6. Data

- No store change and no schema bump: marks are derived (section 3), the
  first-shown time is a module map, and `Puzzle` keeps its shape.
- `AnalyzeView` (types contract) gains `marks: (number | null)[]` (the
  choice for each code line; null, not undefined, because the view is
  JSON) and `offset: number | null` (the code window's first wrapped row;
  null until the reader scrolls, so it opens on the first candidate), and
  carries the code lines without baked-in numbers.
- New tuning block `PUZZLE_VIEW` in `src/config.ts`: `dockShare` (0.6),
  `minTranscriptColumns` (40), `twoColumnMin` (80), `panelColumns` (30),
  `minCodeRows` (3), `inputRows` (1), `panelReserveRows` (8),
  `inlineReserveRows` (6), `maxBlankShare` (0.5), `maxPlaceholderShare`
  (1/3).

## 7. Units

- `src/puzzle/layout.ts` (pure): `wrapCode(lines, width)` and
  `puzzleLayout(view, { columns, rows, offset })`, returning the rows of
  each column (or the stacked rows) and the scroll markers.
- `src/puzzle/readable.ts` (pure): blanked lines, placeholder share,
  trimming and the skip tests.
- `src/puzzle/markdown-filter.ts`: the `local` option and the secret rule.
- `src/puzzle/material.ts`: both unit sets, gated.
- `src/puzzle/puzzle.ts`, `bug-hunt.ts`: `localUnits`, the line test, the
  short explanation, no mutation inside a span.
- `src/puzzle/analyze.ts`: `marks`, no baked numbers.
- `src/contain/lattice.tsx`: the Analyze pane, its keys and scroll hook,
  the hop to Containment, the remembered viewport, first-shown times.

## Testing

- Layout: widths 40, 79, 80 and 140; hanging indent; a wrapped line taller
  than the window; window opens on the first candidate; marker counts;
  offset clamping at both ends; the panel cut keeps choices and Input.
- Markdown local filter: spans and capitals kept; a URL, SSN or email in a
  span replaced; each secret shape replaced; `"Jane \`x\` Smith"` stays
  `[quoted]`; a URL ending at a span's edge; a sentinel character in the
  source; line counts kept; the prompt filter's tests and fuzz unchanged.
- Gates: the blanked-line test, including `…;`; trimming and the
  min-lines re-check; each threshold at and past its edge; Bug Hunt never
  mutating a placeholder-heavy line or a span.
- Marks: derived from Bug Hunt's output; none for Pattern ID whose choice
  reads `Line 3`; none out of range.
- Isolation, in `standard` with puzzles `on` (strict never builds Pattern
  ID): a Pattern ID prompt never holds text found only in a local unit.
- Wiring: the open carries `columns` from `presentation` and from a
  remembered terminal viewport, and neither without one; `j`/`k`/space/`b`
  and a `ui.scroll` with a pointer move the offset and pin the body; Enter
  closes Analyze and opens Containment; an unplaced Containment toasts and
  keeps the encounter; a `ui.close` stand-in with origin `person` leaves
  the encounter pending; reopening keeps the first-shown time; opening one
  pane closes the other.
- Manual, in a fullscreen terminal (the kit cannot show it): U1 to U4, and
  a 40-line unit fully reachable.

## Docs

- SPEC 8 (the view, local display, gates; 8.4 built list) and SPEC 15.4's
  disclosure of what the save holds.
- GUIDE: playing the Analyze step; the privacy section.
- README "What stays local" and its privacy-filter section.
- `src/store/schema.ts` comment on `PendingEncounter.puzzle` (its code is
  now the local text).
- CLAUDE.md current phase.
