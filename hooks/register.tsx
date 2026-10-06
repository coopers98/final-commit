import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { BandView, ChartingEntry, EpicFormView, ReportView } from '../types'
import { wireBand } from '../src/bridge/band'
import { wireBay } from '../src/bridge/bay-pane'
import { CHARTING, COMPANION, GENERATION, GIT, type GenerationModel } from '../src/config'
import { wireCalibration } from '../src/contain/calibrate'
import { wireLattice } from '../src/contain/lattice'
import { classifyBash } from '../src/detect/git'
import { completeEpic, completeMission, forceEncounter, onBranch, parseEpicKey, recordBash, startEpic, startMission, type Outcome } from '../src/game'
import type { Rng } from '../src/rng'
import { NO_MOOD, localDay, orphanedCharts, readSettings, rngFor, snapshot, type Settings } from '../src/runtime'
import { migrate } from '../src/store/migrate'
import { createRepo, type Repo, type StoreLike } from '../src/store/repo'
import type { Complete } from '../src/world/generate'

// Wiring only: events in, src/ modules do the work. Command `text` is read by
// the model, so it stays factual (CLAUDE.md rule 1); flavor goes in toasts,
// panes, the band and the status line.

export const EPIC_PANE = 'fc-epic'
/** The report pane is drawn and dismissed in src/contain/lattice.tsx, which can open containment from it. */
export const REPORT_PANE = 'fc-report'
const ready = atom({ plugin: 'final-commit', key: 'ready' } as const, false)
const form = atom({ plugin: 'final-commit', key: 'epicForm' } as const, null as EpicFormView | null)
const report = atom({ plugin: 'final-commit', key: 'report' } as const, null as ReportView | null)
const mood = atom({ plugin: 'final-commit', key: 'mood' } as const, NO_MOOD)
const charting = atom({ plugin: 'final-commit', key: 'charting' } as const, [] as ChartingEntry[])
const band = atom({ plugin: 'final-commit', key: 'band' } as const, null as BandView | null)

const NOT_READY = { text: 'The Final Commit could not load its save; see the debug log (claude --debug).' }

/**
 * Epics this module instance is charting. The `charting` state shows them;
 * this set says which are really running, since a hot reload ends the
 * generation but keeps the state.
 */
const live = new Set<string>()
let actions = 0
let settings: Settings = readSettings({})

// The engine lets `$` reach only top-level functions of the same file: these
// adapters are this file's own (each wiring file has its own copy).
function storeOf($: EngineInterface): StoreLike {
  return { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value), delete: key => $.store.delete(key), keys: () => $.store.keys() }
}

function repoOf($: EngineInterface): Repo {
  return createRepo(storeOf($), line => $.ui.log(line, { to: 'debug' }))
}

async function rngOf($: EngineInterface): Promise<Rng> {
  actions += 1
  return rngFor(await $.env.get('FINAL_COMMIT_SEED'), actions)
}

/** The model call, never rejecting: a refused request becomes a failed result, so generation falls back. */
function completeVia($: EngineInterface, model: GenerationModel): Complete {
  return async ({ system, prompt }) => {
    try {
      const r = await $.model.complete({ model, system, prompt, maxTokens: GENERATION.maxTokens, timeoutMs: GENERATION.timeoutMs })
      return r.isAnswered ? { ok: true, text: r.text } : { ok: false, reason: r.reason }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : 'refused' }
    }
  }
}

async function refresh($: EngineInterface) {
  const s = await snapshot(repoOf($), await read($, mood), await $.clock.now(), await read($, charting))
  $.ui.status(s.status)
  await update($, band, prev => (s.band && prev ? { ...s.band, isBlinking: prev.isBlinking } : s.band))
}

async function deps($: EngineInterface) {
  const now = await $.clock.now()
  return { repo: repoOf($), now, rng: await rngOf($), day: localDay(now) }
}

async function chart($: EngineInterface, key: string, title: string, description: string) {
  live.add(key)
  const startedAt = await $.clock.now()
  await update($, charting, list => [...list.filter(c => c.key !== key), { key, startedAt }])
  // The status line's spinner and seconds (SPEC 9): redrawn while the model works.
  const spinner = $.clock.every(CHARTING.spinnerMs, () => {
    void refresh($)
  })
  await refresh($)
  try {
    const out = await startEpic({ ...(await deps($)), epic: { key, title, description }, complete: completeVia($, settings.generationModel), privacy: settings.privacyMode })
    $.ui.toast(out.toast ?? out.text)
    await refresh($)
  } catch (err) {
    $.ui.toast(`Charting ${key} failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    spinner.cancel()
    live.delete(key)
    await update($, charting, list => list.filter(c => c.key !== key))
    await refresh($)
  }
}

/** The form's Enter: the title first, then the description; then charting starts after the pane closes. */
async function submitForm($: EngineInterface, value: string) {
  const f = await read($, form)
  if (!f) return
  if (f.step === 'title') {
    if (value.trim() === '') return
    await update($, form, () => ({ ...f, step: 'description', title: value.trim() }))
    return
  }
  await update($, form, () => null)
  await $.ui.close({ id: EPIC_PANE })
  // Generation can take minutes, so it runs after this handler returns
  // (verified on 2.1.291: the model call is not aborted).
  void chart($, f.key, f.title, value.trim())
}

/**
 * Shows an outcome: its report in a pane that stays until dismissed (a toast
 * vanishes before a long name is read), or its toast where no pane can open.
 */
async function announce($: EngineInterface, out: Outcome) {
  if (out.report) {
    const r = out.report
    await update($, report, () => r)
    const placed = await $.ui.open({ id: REPORT_PANE, title: r.title, focus: true, closeOnEscape: true })
    if (placed.isPlaced) return
    await update($, report, () => null)
  }
  if (out.toast) $.ui.toast(out.toast)
}

async function epic($: EngineInterface, args: string): Promise<{ text: string }> {
  if (!(await read($, ready))) return NOT_READY
  if (args.trim().toLowerCase() === 'complete') {
    const out = await completeEpic(await deps($))
    await refresh($)
    await announce($, out)
    return { text: out.text }
  }
  const key = parseEpicKey(args)
  if (!key) return { text: 'Usage: /epic <KEY> (the title is asked for in a pane), or /epic complete.' }
  if ((await read($, charting)).some(c => c.key === key)) return { text: `Epic ${key} is already being charted.` }
  await update($, form, () => ({ key, step: 'title', title: '' }))
  await $.ui.open({ id: EPIC_PANE, title: `Chart ${key}`, focus: true, closeOnEscape: true })
  return { text: `Opened the charting form for ${key}.` }
}

async function mission($: EngineInterface, args: string): Promise<{ text: string }> {
  if (!(await read($, ready))) return NOT_READY
  const arg = args.trim()
  const d = await deps($)
  const out = arg.toLowerCase() === 'complete' ? await completeMission(d) : await startMission({ ...d, issueKey: arg })
  await refresh($)
  await announce($, out)
  return { text: out.text }
}

async function encounter($: EngineInterface): Promise<{ text: string }> {
  if (!settings.devMode) return { text: 'Developer mode is off.' }
  if (!(await read($, ready))) return NOT_READY
  const out = await forceEncounter(await deps($))
  if (out.toast) $.ui.toast(out.toast)
  await refresh($)
  return { text: out.text }
}

/** Session state from the save: run at start, and again after a /clear starts the state over. */
async function prepareSession($: EngineInterface) {
  const now = await $.clock.now()
  try {
    await migrate(storeOf($), now, line => $.ui.log(line, { to: 'debug' }))
    await update($, ready, () => true)
    await update($, mood, m => ({ ...m, lastActivityAt: now }))
    // A hot reload ends any charting in flight but keeps its marker: say so, and clear it.
    const orphans = orphanedCharts(await read($, charting), live)
    if (orphans.length > 0) {
      await update($, charting, list => list.filter(c => live.has(c.key)))
      for (const o of orphans) $.ui.toast(`Charting ${o.key} was interrupted by a reload. Run /epic ${o.key} again.`)
    }
  } catch (err) {
    // A save from a newer build, or a store that cannot be read: the game stays off rather than overwrite it.
    await update($, ready, () => false)
    $.ui.log(`final-commit: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (await read($, ready)) await refresh($)
}

async function startSession($: EngineInterface) {
  await prepareSession($)
  await $.command.register({ name: 'epic', description: 'Chart an epic as a star system, or survey it', argumentHint: '<KEY> | complete' })
  await $.command.register({ name: 'mission', description: 'Start or complete a mission', argumentHint: '<KEY> | complete' })
  await $.command.register({ name: 'contain', description: 'Open containment for a waiting encounter', argumentHint: '[reinforced]' })
  await $.command.register({ name: 'calibrate', description: "Measure this device's key latency for containment" })
  await $.command.register({ name: 'bay', description: 'Open the specimen bay', argumentHint: '[companion N]' })
  if (settings.devMode) await $.command.register({ name: 'encounter', description: 'Force an encounter (developer mode)' })
  // Idle animation (SPEC 9.3): a short blink every few seconds.
  $.clock.every(COMPANION.blinkEveryMs, () => {
    void update($, band, v => (v ? { ...v, isBlinking: true } : v))
    $.clock.after(COMPANION.blinkMs, () => {
      void update($, band, v => (v ? { ...v, isBlinking: false } : v))
    })
  })
}

/**
 * SPEC 4.2: what one Bash call says about the active mission. Results of a
 * backgrounded command are ignored: they return before the command finishes.
 */
async function observeBash($: EngineInterface, command: string, result: unknown, isError: boolean) {
  if (!(await read($, ready))) return
  const record = (result ?? {}) as {
    backgroundTaskId?: unknown
    stdout?: unknown
    stderr?: unknown
    gitOperation?: { commit?: { kind?: unknown } }
  }
  if (record.backgroundTaskId !== undefined) return
  const d = await deps($)
  const signals = classifyBash(command)
  const event: 'fed' | 'startled' | undefined = isError ? 'startled' : signals.isTestRun ? 'fed' : undefined
  await update($, mood, m => ({ last: event ? { event, at: d.now } : m.last, lastActivityAt: d.now }))
  const reported = record.gitOperation?.commit?.kind === 'committed' ? 1 : 0
  const commits = isError ? 0 : Math.max(signals.commits, reported)
  // The end of the output is where runners print their summaries.
  const output = [record.stdout, record.stderr].filter((x): x is string => typeof x === 'string').join('\n').slice(-GIT.outputTailChars)
  if (commits > 0 || signals.isTestRun) await recordBash({ ...d, signals, commits, isError, output })
  if (signals.mayChangeBranch && !isError) {
    const head = await $.process.run(['git', 'symbolic-ref', '--quiet', '--short', 'HEAD'], { timeoutMs: GIT.timeoutMs })
    if (head.exitCode === 0) {
      const out = await onBranch({ ...d, branch: head.stdout.trim() })
      if (out) $.ui.toast(out.text)
    }
  }
  await refresh($)
}

export const register: Register = (on, options) => {
  settings = readSettings(options)

  wireBand(on)
  wireLattice(on)
  wireCalibration(on)
  wireBay(on)

  on('session.start', async ($, e, next) => {
    await startSession($)
    return next(e)
  })

  // A /clear fires no session.start and starts the session's state over
  // (the band, the ready flag): set it up again from the save.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') await prepareSession($)
    return next(e)
  })

  on('command.run', { command: 'epic' }, async ($, e) => epic($, e.args))
  on('command.run', { command: 'mission' }, async ($, e) => mission($, e.args))
  on('command.run', { command: 'encounter' }, async $ => encounter($))

  on('ui.close', { id: EPIC_PANE }, async ($, e, next) => {
    await update($, form, () => null)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: EPIC_PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const f = await read($, form)
    if (!f) return <Text dimColor>No epic is being charted.</Text>
    const asking = f.step === 'title' ? 'Epic title' : 'Description (optional)'
    return (
      <Box flexDirection="column">
        <Text>{`Typed here, the text skips the transcript and is filtered (${settings.privacyMode}) before the model sees it.`}</Text>
        {f.step === 'description' && <Text dimColor>{f.title}</Text>}
        {Input ? (
          <Input key={`epic-${f.step}`} autoFocus label={asking} onInput={() => {}} onSubmit={(value: string) => void submitForm($, value)} />
        ) : (
          <Text dimColor>This surface has no text input; chart epics from a terminal.</Text>
        )}
      </Box>
    )
  })

  // SPEC 4.2: watch Bash for branch switches, commits and test runs. The tool
  // call itself is never changed; a failure here is logged, never surfaced.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    try {
      await observeBash($, e.command, ran.result, ran.isError === true)
    } catch (err) {
      $.ui.log(`final-commit: Bash observer: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    }
    return ran
  })
}
