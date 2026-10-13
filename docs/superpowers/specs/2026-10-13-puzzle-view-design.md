# Puzzle view: a pane you can read (design)

Date: 2026-10-13. Status: approved in conversation, awaiting spec review.
Scope: part A of a two-part plan. Part B (puzzles about the mission's real
diff, shown before | after) is a later mission that reuses this view.

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

Non-goals: tuning for phones (usable is enough), new puzzle types, any
change to what is sent to a model.

## Engine facts this relies on (2.1.296)

- In the fullscreen layout from 110 columns a pane docks beside the
  transcript, floor to ceiling. `$.ui.open({ columns })` requests a dock
  width; `rows` requests an inline height. Both are requests: a size the
  person set wins.
- Elsewhere a pane sits inline above the prompt.
- `Pane` render props carry `bodyColumns`, `placement` and `scroll`
  (`bodyRows`). `ui.scroll` reports wheel and scroll-key moves with `by`;
  a hook may move its own offset instead.
- Unverified until a live run: whether the dock grants the `columns`
  request, and whether arrow keys raise `ui.scroll` once the drawing fits
  the body. The design does not depend on the second.

## Design

### 1. The Analyze pane

- The puzzle gets its own pane (`ANALYZE_PANE`, title "Analyze"), separate
  from Containment. `/contain` with an unanswered puzzle opens it with
  `focus`, `closeOnEscape`, `holdToasts`, `columns` at `PUZZLE_VIEW.dockShare`
  of the terminal's columns, and `rows` for the inline case.
- After the result, Enter closes it and opens Containment as today. Esc
  closes it and leaves the encounter waiting. The plugin's own `$.ui.close`
  does not run its own `ui.close` hook, so the code clears the pane's
  state itself; a person's close is handled by the `ui.close` hook.
- The answer and dispute logic (including the `isSaving` guard) moves out
  of `lattice.tsx` unchanged.

### 2. Layout

- Two columns when `bodyColumns >= PUZZLE_VIEW.twoColumnMin` (80):
  - Right, `PUZZLE_VIEW.panelColumns` (30) wide: heading, label, question,
    choices, result, key hints and the Input. Wrapped; always drawn whole.
  - Left: the code, wrapped with a hanging indent under the gutter, so no
    line is cut. A window exactly the body's rows tall, with `↑ n more`
    and `↓ n more` rows when there is more.
- Below that width (inline, narrow, phone): stacked. The same code window
  on top, the panel pinned beneath it, the window taking the rows left.
- Gutter: the line number, or `[n]>` on a Bug Hunt candidate line, where
  `n` is the choice that names it. The window opens on the first candidate.
- Scrolling the code: `j`/`k` a line, `space`/`b` a page, typed into the
  same Input that takes the answer digits; the wheel through a `ui.scroll`
  hook that moves the code offset. The offset is clamped to the code.

### 3. Local prose display (strict, local-only puzzles)

- Only Markdown prose carries the noise; the code adapters already blank
  literals and comments. The change is confined to the Markdown adapter.
- `filterMarkdown(text, mode, { local: true })`:
  - keeps a backtick span's text, run through the value rules
    (`filterValues`), so a URL, email, SSN, date, phone or ID inside a span
    is still replaced;
  - skips strict mode's capitalized-word rule;
  - leaves everything else as the prompt filter does: double-quoted text
    stays `[quoted]`, value shapes stay redacted, blanked lines stay `…`.
- Each mission builds two unit sets: prompt-safe units (unchanged; Pattern
  ID and anything sent to a model use only these) and local units (Bug
  Hunt and Trace, which never leave the machine).
- Accepted cost: the pending encounter and the dispute log (last 50) store
  the local text. SPEC 8 and the GUIDE's privacy section say so.

### 4. Quality gates (all adapters)

Thresholds live in `src/config.ts` under `PUZZLE_VIEW`.

- Trim runs of `…` lines from a unit's start and end.
- After trimming, skip a unit when more than half its lines are `…`, or
  when placeholder tokens are more than a third of its words.
- Bug Hunt mutates only a line that is itself readable by the same test.
- No readable unit left: no puzzle, and the encounter goes straight to
  containment, as with no units today.

### 5. Data

- `Puzzle` gains `marks?: number[]`: Bug Hunt's candidate lines, indexed
  by choice. Choices read `line 8` to match the gutter.
- `AnalyzeView` (types contract) gains `marks` and carries the code lines
  without baked-in numbers; the layout draws the gutter.
- Store schema 10 → 11 with a restamp-only migration (rule 3). A saved
  puzzle without `marks` draws without candidate marks.
- New tuning block `PUZZLE_VIEW` in `src/config.ts`: `dockShare` (0.6),
  `twoColumnMin` (80), `panelColumns` (30), and the gate thresholds.

## Units

- `src/puzzle/layout.ts` (pure): `wrapCode(lines, width)` and
  `puzzleLayout(view, { columns, rows, offset })`, which returns the rows
  of each column (or the stacked rows) and the scroll markers.
- `src/puzzle/readable.ts` (pure): trimming and the two skip tests, used
  by unit building and Bug Hunt.
- `src/puzzle/markdown-filter.ts`: the `local` option.
- `src/puzzle/material.ts`: both unit sets.
- `src/contain/analyze-pane.tsx`: the pane, keys, scroll hook, open/close.
- `src/contain/lattice.tsx`: hands off to the Analyze pane; loses the
  puzzle drawing.

## Testing

- Layout: widths 40, 79, 80 and 140; hanging indent; window opens on the
  first candidate; marker counts; offset clamping at both ends.
- Markdown local filter: spans and capitals kept; a URL, SSN or email in a
  span still redacted; double quotes still `[quoted]`; the prompt filter's
  existing tests and fuzz unchanged.
- Gates: trimming; each skip threshold at and past its edge; Bug Hunt never
  mutating a placeholder-heavy line.
- Isolation: a Pattern ID prompt never contains text from a local unit.
- Wiring: the open carries `columns`; Enter moves to Containment; `j`/`k`
  and a `ui.scroll` move the offset; Esc leaves the encounter pending;
  migration 10 → 11.
- Manual, in a fullscreen terminal (the kit cannot show it): the dock
  takes the requested width; arrows and the wheel scroll the code; a
  40-line unit is fully reachable; the stacked layout below 80 columns.

## Docs

SPEC 8 (the view, local display, gates; 8.4 built list), GUIDE (playing
the Analyze step, privacy), CLAUDE.md current phase.
