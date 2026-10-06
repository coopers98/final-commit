import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, Timer } from 'claude-code'
import type { CalibrationView } from '../../types'
import { CALIBRATION, PANES } from '../config'
import { seedFromCrypto } from '../rng'
import { createRepo, type Repo } from '../store/repo'
import { beatSchedule, clientKey, medianOffset } from './calibrate-math'

// SPEC 7.3 latency calibration: press Space on each beat; the median error
// is stored per device and shifts the Lattice's hit window.

export const CALIBRATE_PANE = 'fc-calibrate'
const view = atom({ plugin: 'final-commit', key: 'calibration' } as const, null as CalibrationView | null)
const ready = atom({ plugin: 'final-commit', key: 'ready' } as const, false)

type Run = { start: number; beats: number[]; presses: number[]; typed: number; timer: Timer }
let run: Run | undefined

function repoOf($: EngineInterface): Repo {
  return createRepo(
    { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value), delete: key => $.store.delete(key), keys: () => $.store.keys() },
    line => $.ui.log(line, { to: 'debug' }),
  )
}

/** Same device key as the Lattice uses (see lattice.tsx). */
async function clientKeyOf($: EngineInterface, salt: string): Promise<string> {
  if (await $.env.get('TMUX')) {
    const r = await $.process.run(['tmux', 'display-message', '-p', '#{client_tty} #{client_termname}'], { timeoutMs: 2_000 })
    if (r.exitCode === 0 && r.stdout.trim() !== '') return clientKey([salt, r.stdout.trim()])
  }
  const term = (await $.env.get('TERM')) ?? ''
  const ssh = ((await $.env.get('SSH_CONNECTION')) ?? 'local').split(' ')[0] ?? 'local'
  return clientKey([salt, term, ssh])
}

function stop() {
  run?.timer.cancel()
  run = undefined
}

async function finish($: EngineInterface, r: Run) {
  stop()
  let message = 'No presses heard; nothing was saved.'
  if (r.presses.length > 0) {
    const offsetMs = Math.round(medianOffset(r.presses, r.beats))
    const repo = repoOf($)
    const calibration = await repo.calibration()
    const salt = calibration.salt !== '' ? calibration.salt : `${seedFromCrypto().toString(36)}${seedFromCrypto().toString(36)}`
    const key = await clientKeyOf($, salt)
    await repo.saveCalibration({ salt, clients: { ...calibration.clients, [key]: { offsetMs, measuredAt: await $.clock.now() } } })
    message = `Saved: your presses land ${Math.abs(offsetMs)} ms ${offsetMs >= 0 ? 'late' : 'early'}.`
  }
  await update($, view, () => ({ isBeat: false, pressed: r.presses.length, total: CALIBRATION.beats, isOver: true, message }))
  $.ui.toast(`Calibration: ${message}`)
  // Stays up until Enter or Esc, so a late Space never falls into the prompt.
}

/** A plugin's own $.ui.close does not reach its own ui.close hook, so the view is cleared here. */
async function dismiss($: EngineInterface) {
  await update($, view, () => null)
  await $.ui.close({ id: CALIBRATE_PANE })
}

async function tick($: EngineInterface, end: number) {
  const r = run
  if (!r) return
  const t = (await $.clock.now()) - r.start
  if (t >= end) return finish($, r)
  const isBeat = r.beats.some(b => t >= b && t < b + PANES.calibrationBeatGlowMs)
  const prev = await read($, view)
  if (prev && prev.isBeat !== isBeat) await update($, view, v => (v ? { ...v, isBeat } : v))
}

async function onKeys($: EngineInterface, value: string) {
  const r = run
  if (!r) return
  const added = value.length > r.typed ? value.slice(r.typed) : ''
  r.typed = value.length
  const spaces = [...added].filter(c => c === ' ').length
  if (spaces === 0) return
  const t = (await $.clock.now()) - r.start
  for (let i = 0; i < spaces; i += 1) r.presses.push(t)
  await update($, view, v => (v ? { ...v, pressed: r.presses.length } : v))
}

async function open($: EngineInterface): Promise<string> {
  if (!(await read($, ready))) return 'The Final Commit could not load its save; see the debug log (claude --debug).'
  stop()
  const beats = beatSchedule()
  const end = beats[beats.length - 1]! + CALIBRATION.beatIntervalMs
  run = {
    start: (await $.clock.now()) + PANES.calibrationLeadInMs,
    beats,
    presses: [],
    typed: 0,
    timer: $.clock.every(PANES.calibrationTickMs, () => {
      void tick($, end)
    }),
  }
  await update($, view, () => ({ isBeat: false, pressed: 0, total: CALIBRATION.beats, message: 'Press Space each time the light shows.', isOver: false }))
  const placed = await $.ui.open({ id: CALIBRATE_PANE, title: 'Calibrate', focus: true, closeOnEscape: true, holdToasts: true })
  if (!placed.isPlaced) {
    stop()
    await update($, view, () => null)
    return 'Calibration could not open here.'
  }
  return 'Opened calibration.'
}

export function wireCalibration(on: On): void {
  on('command.run', { command: 'calibrate' }, async $ => ({ text: await open($) }))

  on('ui.close', { id: CALIBRATE_PANE }, async ($, e, next) => {
    stop()
    await update($, view, () => null)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: CALIBRATE_PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const v = await read($, view)
    if (!v) return <Text dimColor>Calibration is not running.</Text>
    return (
      <Box flexDirection="column">
        <Text>{v.message}</Text>
        <Text bold>{v.isBeat ? '[ ##### ]' : '[       ]'}</Text>
        <Text dimColor>{`${v.pressed} of ${v.total} presses`}</Text>
        {!v.isOver && Input && (
          <Input key="keys" autoFocus label="Space" onInput={(value: string) => void onKeys($, value)} onSubmit={() => {}} />
        )}
        {!v.isOver && !Input && <Button key="beat" label="Beat" onPress={() => void onKeys($, ' '.repeat((run?.typed ?? 0) + 1))} />}
        {v.isOver && Input && <Input key="done" autoFocus label="Enter: close" onInput={() => {}} onSubmit={() => void dismiss($)} />}
        {v.isOver && !Input && <Button key="done" label="Close" onPress={() => void dismiss($)} />}
      </Box>
    )
  })
}
