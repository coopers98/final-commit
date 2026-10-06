import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { BandView } from '../../types'
import { COMPANION } from '../config'
import { besideLines, blink, trimSprite } from './band'
import { NO_ALERT } from './alert'
import type { ReportView } from '../../types'
import { BRIDGE_KEYS, crewTask, NO_CREW, REPORT_KEYS, ROLE_LABELS, TASK_ROLE, type CrewTask, type Role } from '../crew/roster'
import { bridgeRows, NO_GAUGES, type BridgeData } from './bridge'
import { createRepo, type Repo } from '../store/repo'

export const BRIDGE_PANE = 'fc-bridge'
const ready = atom({ plugin: 'final-commit', key: 'ready' } as const, false)
const gauges = atom({ plugin: 'final-commit', key: 'gauges' } as const, NO_GAUGES)
const alert = atom({ plugin: 'final-commit', key: 'alert' } as const, NO_ALERT)
const crew = atom({ plugin: 'final-commit', key: 'crew' } as const, NO_CREW)
const input = atom({ plugin: 'final-commit', key: 'bridgeInput' } as const, { isAsking: false, generation: 0 })
const report = atom({ plugin: 'final-commit', key: 'report' } as const, null as ReportView | null)
/** The report pane, drawn in src/contain/lattice.tsx. */
const REPORT_PANE = 'fc-report'
const isOpen = atom({ plugin: 'final-commit', key: 'bridgeOpen' } as const, false)
const band = atom({ plugin: 'final-commit', key: 'band' } as const, null as BandView | null)

function repoOf($: EngineInterface): Repo {
  return createRepo(
    { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value), delete: key => $.store.delete(key), keys: () => $.store.keys() },
    line => $.ui.log(line, { to: 'debug' }),
  )
}

/** The fraction of the context window left, from the status line's figures. */
async function fuelOf($: EngineInterface): Promise<number | undefined> {
  try {
    const percent = (await $.session.usage()).context.percent
    return percent === undefined ? undefined : 100 - percent
  } catch {
    return undefined
  }
}

/** Everything the bridge shows, read at draw time from the save and the session. */
async function gather($: EngineInterface): Promise<BridgeData> {
  const repo = repoOf($)
  const meta = await repo.meta()
  let system: BridgeData['system']
  for (const id of await repo.systemIds()) {
    const s = await repo.system(id)
    if (s && s.epicKey === meta?.activeEpicKey) system = { name: s.name, starClass: s.starClass, isSurveyed: s.status === 'surveyed' }
  }
  const mission = await repo.activeMission()
  const log = (await repo.captainsLog()).at(-1)
  const fuel = await fuelOf($)
  const reports = await repo.crewReports()
  return {
    ...(system ? { system } : {}),
    ...(mission ? { mission: { key: mission.issueKey, commits: mission.commits, testRuns: mission.testRuns } } : {}),
    gauges: await read($, gauges),
    ...(fuel !== undefined ? { fuel } : {}),
    ...(log ? { log } : {}),
    crew: await read($, crew),
    reportRoles: (Object.keys(reports) as Role[]).filter(r => reports[r] !== undefined),
    isPending: (await repo.pending()) !== undefined,
    isAlert: (await $.clock.now()) < (await read($, alert)).until,
  }
}

/** Sends an officer from the Bridge (SPEC 9.1); its report opens when it finishes (src/crew/crew-wire.ts). */
async function launch($: EngineInterface, taskName: CrewTask, question = '') {
  const role = TASK_ROLE[taskName]
  const c = await read($, crew)
  if (Object.values(c.running).includes(role)) {
    $.ui.toast(`${ROLE_LABELS[role]} is already on it.`)
    return
  }
  const task = crewTask(taskName, question)
  try {
    const started = await $.agent.spawn({ subagentType: `final-commit:${role}`, prompt: task.prompt, description: task.description })
    if (started.deny !== undefined || started.agentId === undefined) {
      $.ui.toast(`${ROLE_LABELS[role]} could not be sent: ${started.deny ?? 'no agent started'}`)
      return
    }
    const id = started.agentId
    // The agent.spawn hook already marked it running; this marks where its report goes.
    await update($, crew, s => ({ ...s, running: { ...s.running, [id]: role }, fromBridge: [...(s.fromBridge ?? []), id] }))
    $.ui.toast(`${ROLE_LABELS[role]} is on it.`)
  } catch (err) {
    $.ui.toast(`${ROLE_LABELS[role]} could not be sent: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Opens an officer's last saved report in the report pane, unless that pane holds a waiting encounter. */
async function reopen($: EngineInterface, role: Role) {
  const saved = (await repoOf($).crewReports())[role]
  if (!saved) {
    $.ui.toast(`${ROLE_LABELS[role]} has no report yet.`)
    return
  }
  if ((await read($, report))?.encounter) {
    $.ui.toast('Close the encounter report first.')
    return
  }
  const title = `${ROLE_LABELS[role]} report`
  await update($, report, () => ({ title, lines: saved.lines, encounter: null, reinforced: 0 }))
  const placed = await $.ui.open({ id: REPORT_PANE, title, focus: true, closeOnEscape: true })
  if (!placed.isPlaced) await update($, report, () => null)
}

/** A key typed into the Bridge's field: `e`, `l`, `s`, `t`, or `1` to `3` for a report. The field is cleared after each. */
async function onKey($: EngineInterface, value: string) {
  const last = value.slice(-1).toLowerCase()
  const saved = REPORT_KEYS[last]
  if (saved) {
    await update($, input, i => ({ isAsking: false, generation: i.generation + 1 }))
    await reopen($, saved)
    return
  }
  const task = BRIDGE_KEYS[last]
  await update($, input, i => ({ isAsking: task === 'question', generation: i.generation + 1 }))
  if (task && task !== 'question') await launch($, task)
}

async function onAsk($: EngineInterface, question: string) {
  await update($, input, i => ({ isAsking: false, generation: i.generation + 1 }))
  if (question.trim() !== '') await launch($, 'question', question)
}

/** The companion at the foot of the pane, laid out as the band lays it out: facts to the left of the sprite. */
function companionBlock(Box: any, Text: any, v: BandView, width: number) {
  const sprite = trimSprite(v.isBlinking || v.mood === 'asleep' ? blink(v.sprite) : v.sprite)
  const spriteColumns = Math.max(0, ...sprite.map(r => r.length))
  const room = width - spriteColumns - COMPANION.spriteGap
  const lines = room >= COMPANION.besideMinColumns ? besideLines(v, room) : []
  if (sprite.length === 0 || spriteColumns > width) return <Text dimColor>{`${v.tier} ${v.name} · ${v.mood}`.slice(0, width)}</Text>
  return (
    <Box flexDirection="row" marginTop={1}>
      {lines.length > 0 && (
        <Box flexDirection="column" justifyContent="center" marginRight={COMPANION.spriteGap}>
          {lines.map((line, n) => (n === 0 ? <Text bold>{line}</Text> : <Text dimColor>{line}</Text>))}
        </Box>
      )}
      <Box flexDirection="column">
        {sprite.map(row => <Text>{row}</Text>)}
      </Box>
    </Box>
  )
}

async function bridge($: EngineInterface): Promise<string> {
  if (!(await read($, ready))) return 'The Final Commit could not load its save; see the debug log (claude --debug).'
  await update($, input, i => ({ isAsking: false, generation: i.generation + 1 }))
  // The companion moves into the pane while it is open (the band steps aside).
  await update($, isOpen, () => true)
  const placed = await $.ui.open({ id: BRIDGE_PANE, title: 'Bridge', focus: true, closeOnEscape: true })
  if (!placed.isPlaced) {
    await update($, isOpen, () => false)
    return 'The bridge could not open here.'
  }
  return 'Opened the bridge.'
}

/** SPEC 9 Bridge pane: the state of play at a glance. It never reaches the transcript. */
export function wireBridge(on: On): void {
  on('command.run', { command: 'bridge' }, async ($, _e) => ({ text: await bridge($) }))

  on('ui.close', { id: BRIDGE_PANE }, async ($, e, next) => {
    await update($, input, i => ({ isAsking: false, generation: i.generation + 1 }))
    await update($, isOpen, () => false)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: BRIDGE_PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    // Reading the band subscribes this drawing to every refresh of the game's views (and the blink).
    const companion = await read($, band)
    const width = e.props.bodyColumns
    const rows = bridgeRows(await gather($), width)
    const i = await read($, input)
    const hints = ['e: run tests', 'l: lint', 's: ask Science', 't: security review', '1-3: last report', 'Esc: close']
    const joined = hints.join('  ')
    const hintRows = [...joined].length <= width ? [joined] : [`${hints[0]}  ${hints[1]}  ${hints[2]}`, `${hints[3]}  ${hints[4]}`, hints[5]!]
    return (
      <Box flexDirection="column">
        {rows.map((r, n) => (n === 0 ? <Text bold>{r}</Text> : <Text>{r === '' ? ' ' : r}</Text>))}
        <Text> </Text>
        {i.isAsking ? <Text dimColor>Type a question for Science, then Enter.</Text> : hintRows.map(hint => <Text dimColor>{hint}</Text>)}
        {companion && companionBlock(Box, Text, companion, width)}
        {Input && i.isAsking && (
          <Input key={`bridge-ask-${i.generation}`} autoFocus label="Question" onInput={() => {}} onSubmit={(q: string) => void onAsk($, q)} />
        )}
        {Input && !i.isAsking && (
          <Input key={`bridge-keys-${i.generation}`} autoFocus label="Key" onInput={(v: string) => void onKey($, v)} onSubmit={() => {}} />
        )}
        {!Input && (
          <Box flexDirection="row">
            <Button key="crew-e" label="Tests" onPress={() => void launch($, 'tests')} />
            <Button key="crew-l" label="Lint" onPress={() => void launch($, 'lint')} />
            <Button key="crew-t" label="Security" onPress={() => void launch($, 'review')} />
          </Box>
        )}
      </Box>
    )
  })
}
