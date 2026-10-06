import { atom, read } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { BandView } from '../../types'
import { NO_ALERT } from './alert'
import { bridgeRows, NO_GAUGES, type BridgeData } from './bridge'
import { createRepo, type Repo } from '../store/repo'

export const BRIDGE_PANE = 'fc-bridge'
const ready = atom({ plugin: 'final-commit', key: 'ready' } as const, false)
const gauges = atom({ plugin: 'final-commit', key: 'gauges' } as const, NO_GAUGES)
const alert = atom({ plugin: 'final-commit', key: 'alert' } as const, NO_ALERT)
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
  return {
    ...(system ? { system } : {}),
    ...(mission ? { mission: { key: mission.issueKey, commits: mission.commits, testRuns: mission.testRuns } } : {}),
    gauges: await read($, gauges),
    ...(fuel !== undefined ? { fuel } : {}),
    ...(log ? { log } : {}),
    isPending: (await repo.pending()) !== undefined,
    isAlert: (await $.clock.now()) < (await read($, alert)).until,
  }
}

async function bridge($: EngineInterface): Promise<string> {
  if (!(await read($, ready))) return 'The Final Commit could not load its save; see the debug log (claude --debug).'
  await $.ui.open({ id: BRIDGE_PANE, title: 'Bridge', focus: true, closeOnEscape: true })
  return 'Opened the bridge.'
}

/** SPEC 9 Bridge pane: the state of play at a glance. It never reaches the transcript. */
export function wireBridge(on: On): void {
  on('command.run', { command: 'bridge' }, async ($, _e) => ({ text: await bridge($) }))

  on('ui.render', { component: 'Pane', requestId: BRIDGE_PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    // Reading the band subscribes this drawing to every refresh of the game's views.
    await read($, band)
    const rows = bridgeRows(await gather($), e.props.bodyColumns)
    return (
      <Box flexDirection="column">
        {rows.map((r, i) => (i === 0 ? <Text bold>{r}</Text> : <Text>{r === '' ? ' ' : r}</Text>))}
        <Text dimColor>Esc closes.</Text>
      </Box>
    )
  })
}
