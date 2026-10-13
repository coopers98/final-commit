import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, Timer } from 'claude-code'
import type { AnalyzeView, BandView, ChartingEntry, LatticeView, ReportView } from '../../types'
import { CELLS, LATTICE_SHARED, PUZZLE_VIEW, TIER_SPECS, type Cell, type Tier } from '../config'
import { tierColor } from '../bridge/color'
import { answerPuzzle, attemptContainment, disputePuzzle, CELL_KEYS, cellsOf, parseCell } from '../game'
import { analyzeKey, analyzeView, DISPUTED_LINE, resultLines } from '../puzzle/analyze'
import { clampOffset, paneSize, puzzleLayout, scrollKey, wheelMovesCode, type PanelLine } from '../puzzle/layout'
import type { Puzzle } from '../puzzle/puzzle'
import type { Rng } from '../rng'
import { NO_MOOD, rngFor, snapshot } from '../runtime'
import { createRepo, type Repo } from '../store/repo'
import { clientKey } from './calibrate-math'
import { advance, createLattice, latticeBonus, press, renderBar, renderLocks, type LatticeState } from './lattice-model'
import { wrap } from '../bridge/text'

// Seal the Lattice (SPEC 7.3). A prepared puzzle is asked first, in the
// Analyze pane (SPEC 8), which hands on to Containment. /contain opens a
// focused pane whose Input takes the keys (a Client only gets keys after a
// mouse click, so it cannot be used over tmux); Space seals, Enter throws the
// cell, Esc pauses. The model is advanced on the plugin's clock and judged at
// the time each key arrives.

export const LATTICE_PANE = 'fc-lattice'
/** Opened by hooks/register.tsx after a mission or survey; drawn here so Enter can open containment. */
export const REPORT_PANE = 'fc-report'
/** SPEC 8: the puzzle asked before containment, in a pane of its own (puzzle view spec, section 1). */
export const ANALYZE_PANE = 'fc-analyze'
const report = atom({ plugin: 'final-commit', key: 'report' } as const, null as ReportView | null)
const view = atom({ plugin: 'final-commit', key: 'lattice' } as const, null as LatticeView | null)
const analyze = atom({ plugin: 'final-commit', key: 'analyze' } as const, null as AnalyzeView | null)
const ready = atom({ plugin: 'final-commit', key: 'ready' } as const, false)
const mood = atom({ plugin: 'final-commit', key: 'mood' } as const, NO_MOOD)
const charting = atom({ plugin: 'final-commit', key: 'charting' } as const, [] as ChartingEntry[])
const band = atom({ plugin: 'final-commit', key: 'band' } as const, null as BandView | null)

type Run = {
  model: LatticeState
  rng: Rng
  last: number
  offsetMs: number
  typed: number
  cell: Cell
  heading: string
  tier: Tier
  sprite: string[]
  timer: Timer
  message: string
}

/** The run in progress; module state, so a hot reload ends it (the encounter stays pending). */
let run: Run | undefined
/** SPEC 8: the puzzle being asked before the run: the cell asked for, when it was shown, keys seen. */
let asking: { args: string; shownAt: number; typed: number } | undefined
/** An answer or a dispute being saved: a second key (a repeat, a double tap) waits for none and does nothing. */
let isSaving = false
let actions = 0
/** The terminal's size as the last drawing of these panes saw it: the report's "Contain now" has no command to read it from. */
let terminal: { columns: number; rows: number } | undefined
/** SPEC 8: when each encounter's puzzle was first shown this session, so closing and reopening does not restart the fast-answer clock. */
const firstShown = new Map<string, number>()
/** The Analyze pane's last drawing: what the scroll keys and the wheel move. */
let shown: { offset: number; visible: number; total: number; codeRows: number; isColumns: boolean; bodyOffset: number } | undefined

// The engine lets `$` reach only top-level functions of the same file, so
// each wiring file has its own adapters.
function repoOf($: EngineInterface): Repo {
  return createRepo(
    { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value), delete: key => $.store.delete(key), keys: () => $.store.keys() },
    line => $.ui.log(line, { to: 'debug' }),
  )
}

async function rngOf($: EngineInterface): Promise<Rng> {
  actions += 1
  return rngFor(await $.env.get('FINAL_COMMIT_SEED'), actions)
}

async function refresh($: EngineInterface) {
  const s = await snapshot(repoOf($), await read($, mood), await $.clock.now(), await read($, charting))
  $.ui.status(s.status)
  await update($, band, prev => (s.band && prev ? { ...s.band, isBlinking: prev.isBlinking } : s.band))
}

/** The device key: under tmux the attached client's tty and terminal, else TERM and the SSH client address. Salted. */
async function clientKeyOf($: EngineInterface, salt: string): Promise<string> {
  if (await $.env.get('TMUX')) {
    const r = await $.process.run(['tmux', 'display-message', '-p', '#{client_tty} #{client_termname}'], { timeoutMs: 2_000 })
    if (r.exitCode === 0 && r.stdout.trim() !== '') return clientKey([salt, r.stdout.trim()])
  }
  const term = (await $.env.get('TERM')) ?? ''
  const ssh = ((await $.env.get('SSH_CONNECTION')) ?? 'local').split(' ')[0] ?? 'local'
  return clientKey([salt, term, ssh])
}

function fit(text: string, width: number): string {
  const chars = [...text]
  return chars.length <= width ? text : `${chars.slice(0, Math.max(1, width - 1)).join('')}~`
}

/** The key hints on one line when they fit, else one per line. */
function hintLines(parts: string[], width: number): string[] {
  const joined = parts.join('  ')
  return [...joined].length <= width ? (parts.length ? [joined] : []) : parts.map(p => fit(p, width))
}

function show(r: Run, isOver = false): LatticeView {
  return {
    heading: r.heading,
    tier: r.tier,
    sprite: r.sprite,
    bar: renderBar(r.model),
    locks: renderLocks(r.model),
    hint: isOver ? ['Enter or Esc: close'] : ['Space: seal', `Enter: throw ${CELLS[r.cell].label} Cell`, 'Esc: pause'],
    message: r.message,
    isOver,
  }
}

function stop() {
  run?.timer.cancel()
  run = undefined
}

/** Remembers the terminal's size from a drawing (a remote surface's is not the terminal's). */
function see(e: { surface: string; viewport?: { columns: number; rows: number } }) {
  if (e.surface === 'terminal' && e.viewport) terminal = { columns: e.viewport.columns, rows: e.viewport.rows }
}

/** Closes one of these panes, open or not. A plugin's own close runs no ui.close hook of its own: the caller clears its state. */
async function closePane($: EngineInterface, id: string) {
  try {
    await $.ui.close({ id })
  } catch {
    // A hook denied the close: the open or the hand-on goes ahead regardless.
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

async function catchUp($: EngineInterface, r: Run) {
  const now = await $.clock.now()
  r.model = advance(r.model, now - r.last, r.rng)
  r.last = now
}

async function tick($: EngineInterface) {
  const r = run
  if (!r) return
  await catchUp($, r)
  await update($, view, () => show(r))
}

async function resolve($: EngineInterface) {
  const r = run
  if (!r) return
  stop()
  const result = await attemptContainment({
    repo: repoOf($), now: await $.clock.now(), rng: r.rng, cell: r.cell, latticeBonus: latticeBonus(r.model),
  })
  const toast = 'toast' in result ? result.toast : undefined
  r.message = toast ?? result.text
  await update($, view, () => show(r, true))
  if (toast) $.ui.toast(toast)
  // The result stays up until Enter or Esc: a pane that closed by itself let
  // a late Space fall into the prompt and break the next slash command.
  await refresh($)
}

/** Closes the result. A plugin's own $.ui.close does not reach its own ui.close hook, so the view is cleared here. */
async function dismiss($: EngineInterface) {
  await update($, view, () => null)
  await $.ui.close({ id: LATTICE_PANE })
}

/** Space presses arrive as growth of the Input's value; a burst can arrive as one change. */
async function onKeys($: EngineInterface, value: string) {
  const r = run
  if (!r) return
  const added = value.length > r.typed ? value.slice(r.typed) : ''
  r.typed = value.length
  const spaces = [...added].filter(c => c === ' ').length
  if (spaces === 0) return
  await catchUp($, r)
  for (let i = 0; i < spaces && !r.model.isDone; i += 1) {
    const out = press(r.model, r.offsetMs, r.rng)
    r.model = out.state
    r.message = out.result === 'center' ? 'Dead center!' : out.result === 'hit' ? 'Sealed.' : 'Missed.'
  }
  if (r.model.isDone) await resolve($)
  else await update($, view, () => show(r))
}

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
  shown = undefined
  await update($, analyze, () => null)
  await closePane($, ANALYZE_PANE)
  return (await openLattice($, args)) ? 'Opened containment.' : 'Containment could not open here; the encounter is still waiting.'
}

const headingOf = (p: { tier: Tier; attachment?: { item: string } }, name: string | undefined) => {
  const spec = TIER_SPECS[p.tier]
  return `${spec.glyph} ${name ?? 'Unknown'} (${spec.label})${p.attachment ? ` +${p.attachment.item}` : ''}`
}

/** Starts Seal the Lattice in the containment pane, with the cell `args` asks for. */
async function begin($: EngineInterface, args: string) {
  const repo = repoOf($)
  const pending = await repo.pending()
  if (!pending) return
  const requested = parseCell(args) ?? 'standard'
  const usable = await cellsOf(repo)
  const cell: Cell = requested !== 'standard' && usable[requested] > 0 ? requested : 'standard'
  const held = await repo.inventory()
  const cellNote =
    cell === requested ? ''
    : requested === 'singularity' && held.singularity > 0 ? 'The Singularity Cell needs a Legendary flora sample to activate. Standard Cell loaded.'
    : `No ${CELLS[requested].label} Cell held. Standard Cell loaded.`
  const species = (await repo.system(pending.systemId))?.species.find(s => s.id === pending.speciesId)
  const calibration = await repo.calibration()
  const measured = calibration.salt !== '' ? calibration.clients[await clientKeyOf($, calibration.salt)] : undefined

  stop()
  const rng = await rngOf($)
  const r: Run = {
    model: createLattice(pending.tier, rng),
    rng,
    last: await $.clock.now(),
    offsetMs: measured?.offsetMs ?? 0,
    typed: 0,
    cell,
    heading: headingOf(pending, species?.name),
    tier: pending.tier,
    sprite: species?.stages[0]?.rows ?? [],
    message: cellNote !== '' ? cellNote : measured ? '' : 'Tip: run /calibrate on this device.',
    timer: $.clock.every(LATTICE_SHARED.frameMs, () => {
      void tick($)
    }),
  }
  run = r
  await update($, view, () => show(r))
}

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

async function answer($: EngineInterface, choice: number | undefined) {
  const a = asking
  if (!a || isSaving) return
  isSaving = true
  let puzzle: Puzzle | null | undefined
  let analysis: Awaited<ReturnType<typeof answerPuzzle>>
  try {
    const repo = repoOf($)
    const now = await $.clock.now()
    puzzle = (await repo.pending())?.puzzle
    analysis = await answerPuzzle({ repo, now, rng: await rngOf($), choice, elapsedMs: now - a.shownAt })
  } finally {
    isSaving = false
  }
  if (!puzzle || !analysis) return
  if (analysis.isSkipped) return proceed($)
  // The result's input is a new one, empty: keys are counted from its start.
  a.typed = 0
  await update($, analyze, v => (v ? { ...v, result: { lines: resultLines(puzzle, analysis) } } : v))
}

/** SPEC 8.1 rule 4: logs the answered puzzle for review and says so on the result. */
async function dispute($: EngineInterface) {
  if (isSaving) return
  isSaving = true
  let isDisputed = false
  try {
    isDisputed = await disputePuzzle({ repo: repoOf($), now: await $.clock.now() })
  } finally {
    isSaving = false
  }
  if (isDisputed) await update($, analyze, v => (v?.result ? { ...v, result: { lines: [...v.result.lines, DISPUTED_LINE] } } : v))
}

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

/** Enter on the report: close it, and go straight to containment when a creature is waiting. A cell's key (`r`, `s`, `x`) picks that cell. */
async function dismissReport($: EngineInterface, typed: string) {
  const r = await read($, report)
  // A plugin's own $.ui.close does not reach its own ui.close hook, so the view is cleared here.
  await update($, report, () => null)
  await $.ui.close({ id: REPORT_PANE })
  if (r?.encounter) await open($, typed)
}

export function wireLattice(on: On): void {
  on('ui.close', { id: REPORT_PANE }, async ($, e, next) => {
    // Esc: the encounter, if any, keeps waiting for /contain.
    await update($, report, () => null)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: REPORT_PANE }, async ($, e) => {
    see(e)
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const r = await read($, report)
    const width = e.props.bodyColumns
    if (!r) return <Text dimColor>Nothing to report.</Text>
    const color = r.encounter ? tierColor(r.encounter.tier, await $.clock.now()) : undefined
    const offered = r.encounter && r.cells ? (Object.keys(CELL_KEYS) as (keyof typeof CELL_KEYS)[]).filter(c => (r.cells?.[c] ?? 0) > 0) : []
    const hints = r.encounter
      ? ['Enter: contain now', ...offered.map(c => `${CELL_KEYS[c]} Enter: use a ${CELLS[c].label} Cell (${r.cells?.[c]})`), 'Esc: later']
      : ['Enter or Esc: close']
    // A short terminal clips from the top: the sprite first, the essentials last.
    return (
      <Box flexDirection="column">
        {r.encounter?.sprite.map(row => (
          <Text color={color}>{row}</Text>
        ))}
        <Text bold>{fit(r.title, width)}</Text>
        {r.lines.flatMap(line => wrap(line, width)).map(line => (
          <Text>{line}</Text>
        ))}
        {r.encounter && <Text bold color={color}>{fit(r.encounter.heading, width)}</Text>}
        {hintLines(hints, width).map(line => (
          <Text dimColor>{line}</Text>
        ))}
        {Input ? (
          <Input key="report" autoFocus label="Enter" onInput={() => {}} onSubmit={(value: string) => void dismissReport($, value)} />
        ) : (
          <Box>
            <Button key="report" label={r.encounter ? 'Contain now' : 'Close'} onPress={() => void dismissReport($, '')} />
            {offered.map(c => (
              <Button key={c} label={`${CELLS[c].label} (${r.cells?.[c]})`} onPress={() => void dismissReport($, CELL_KEYS[c])} />
            ))}
          </Box>
        )}
      </Box>
    )
  })

  on('command.run', { command: 'contain' }, async ($, e) => ({ text: await open($, e.args, e.presentation.columns) }))

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
    // The wheel over a code window with rows to scroll moves the code and the body stays put; anything else
    // (a code window already showing every row, too) is the engine's, so an overflowing panel still scrolls.
    if (!s || !e.pointer || !wheelMovesCode(s, e.pointer)) return next(e)
    await scrollCode($, e.by)
    return next({ ...e, offset: s.bodyOffset })
  })

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
      codeRows: layout.code.rows.length + (layout.code.more ? 1 : 0),
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

  on('ui.render', { component: 'Pane', requestId: LATTICE_PANE }, async ($, e) => {
    see(e)
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // Mobile has no Input; it falls back to buttons.
    const Input = 'Input' in elements ? elements.Input : undefined
    const width = e.props.bodyColumns
    const v = await read($, view)
    if (!v) return <Text dimColor>Nothing to contain.</Text>
    const color = tierColor(v.tier, await $.clock.now())
    // A short terminal clips a pane from the top, so the sprite comes first and the essentials last.
    return (
      <Box flexDirection="column">
        {v.sprite.map(row => (
          <Text color={color}>{row}</Text>
        ))}
        <Text bold color={color}>{fit(v.heading, width)}</Text>
        <Text>{v.bar}</Text>
        <Text>{v.locks}</Text>
        {v.message !== '' && <Text>{fit(v.message, width)}</Text>}
        {hintLines(v.hint, width).map(line => (
          <Text dimColor>{line}</Text>
        ))}
        {!v.isOver && Input && (
          <Input key="keys" autoFocus label="Space" onInput={(value: string) => void onKeys($, value)} onSubmit={() => void resolve($)} />
        )}
        {v.isOver && Input && <Input key="done" autoFocus label="Enter: close" onInput={() => {}} onSubmit={() => void dismiss($)} />}
        {!v.isOver && !Input && (
          <Box>
            <Button key="seal" label="Seal" onPress={() => void onKeys($, ' '.repeat((run?.typed ?? 0) + 1))} />
            <Button key="throw" label="Throw" onPress={() => void resolve($)} />
          </Box>
        )}
        {v.isOver && !Input && <Button key="done" label="Close" onPress={() => void dismiss($)} />}
      </Box>
    )
  })
}
