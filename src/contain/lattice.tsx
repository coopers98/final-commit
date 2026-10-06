import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, Timer } from 'claude-code'
import type { BandView, ChartingEntry, LatticeView } from '../../types'
import { CELLS, LATTICE_SHARED, TIER_SPECS, type Cell } from '../config'
import { attemptContainment } from '../game'
import type { Rng } from '../rng'
import { NO_MOOD, rngFor, snapshot } from '../runtime'
import { createRepo, type Repo } from '../store/repo'
import { clientKey } from './calibrate-math'
import { advance, createLattice, latticeBonus, press, renderBar, renderLocks, type LatticeState } from './lattice-model'

// Seal the Lattice (SPEC 7.3). /contain opens a focused pane whose Input takes
// the keys (a Client only gets keys after a mouse click, so it cannot be used
// over tmux); Space seals, Enter throws the cell, Esc pauses. The model is
// advanced on the plugin's clock and judged at the time each key arrives.

export const LATTICE_PANE = 'fc-lattice'
const view = atom({ plugin: 'final-commit', key: 'lattice' } as const, null as LatticeView | null)
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
  sprite: string[]
  timer: Timer
  message: string
}

/** The run in progress; module state, so a hot reload ends it (the encounter stays pending). */
let run: Run | undefined
let actions = 0

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

async function open($: EngineInterface, args: string): Promise<string> {
  if (!(await read($, ready))) return 'The Final Commit could not load its save; see the debug log (claude --debug).'
  const repo = repoOf($)
  const pending = await repo.pending()
  if (!pending) return 'Nothing to contain right now.'
  const inv = await repo.inventory()
  const cell: Cell = args.trim().toLowerCase() === 'reinforced' && inv.reinforced > 0 ? 'reinforced' : 'standard'
  const system = await repo.system(pending.systemId)
  const species = system?.species.find(s => s.id === pending.speciesId)
  const spec = TIER_SPECS[pending.tier]
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
    heading: `${spec.glyph} ${species?.name ?? 'Unknown'} (${spec.label})${pending.attachment ? ` +${pending.attachment.item}` : ''}`,
    sprite: species?.stages[0]?.rows ?? [],
    message: measured ? '' : 'Tip: run /calibrate on this device.',
    timer: $.clock.every(LATTICE_SHARED.frameMs, () => {
      void tick($)
    }),
  }
  run = r
  await update($, view, () => show(r))
  const placed = await $.ui.open({ id: LATTICE_PANE, title: 'Containment', focus: true, closeOnEscape: true, holdToasts: true })
  if (!placed.isPlaced) {
    stop()
    await update($, view, () => null)
    return 'Containment could not open here; the encounter is still waiting.'
  }
  return 'Opened containment.'
}

export function wireLattice(on: On): void {
  on('command.run', { command: 'contain' }, async ($, e) => ({ text: await open($, e.args) }))

  on('ui.close', { id: LATTICE_PANE }, async ($, e, next) => {
    if (run) {
      stop()
      $.ui.toast('Containment paused. The specimen is still here: /contain')
    }
    await update($, view, () => null)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: LATTICE_PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // Mobile has no Input; it falls back to buttons.
    const Input = 'Input' in elements ? elements.Input : undefined
    const v = await read($, view)
    const width = e.props.bodyColumns
    if (!v) return <Text dimColor>Nothing to contain.</Text>
    // A short terminal clips a pane from the top, so the sprite comes first and the essentials last.
    return (
      <Box flexDirection="column">
        {v.sprite.map(row => (
          <Text>{row}</Text>
        ))}
        <Text bold>{fit(v.heading, width)}</Text>
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
