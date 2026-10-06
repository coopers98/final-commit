import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { ScanRow } from '../../types'
import { parseEpicKey } from '../game'
import { createRepo, type Repo } from '../store/repo'
import { scanRows } from './scan'
import { wrap } from './text'

export const SCAN_PANE = 'fc-scan'
const rows = atom({ plugin: 'final-commit', key: 'scan' } as const, [] as ScanRow[])
const ready = atom({ plugin: 'final-commit', key: 'ready' } as const, false)

function repoOf($: EngineInterface): Repo {
  return createRepo(
    { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value), delete: key => $.store.delete(key), keys: () => $.store.keys() },
    line => $.ui.log(line, { to: 'debug' }),
  )
}

/** `/scan [KEY]`: the active epic's system, or the one charted for KEY. */
async function scan($: EngineInterface, args: string): Promise<string> {
  if (!(await read($, ready))) return 'The Final Commit could not load its save; see the debug log (claude --debug).'
  const repo = repoOf($)
  const key = args.trim() === '' ? (await repo.meta())?.activeEpicKey ?? undefined : parseEpicKey(args)
  if (!key) return args.trim() === '' ? 'No active epic. /scan <KEY> scans a charted one.' : 'Usage: /scan [KEY], for example /scan NOVA-1.'
  let system
  for (const id of await repo.systemIds()) {
    const s = await repo.system(id)
    if (s?.epicKey === key) system = s
  }
  if (!system) return `Epic ${key} is not charted.`
  const drawn = scanRows(system, await repo.catalog(), await repo.resolved())
  await update($, rows, () => drawn)
  await $.ui.open({ id: SCAN_PANE, title: `Scan ${key}`, focus: true, closeOnEscape: true })
  return `Opened the scan of epic ${key}.`
}

/** The system scan as a pane, so species names stay out of the transcript the model reads. */
export function wireScan(on: On): void {
  on('command.run', { command: 'scan' }, async ($, e) => ({ text: await scan($, e.args) }))

  on('ui.render', { component: 'Pane', requestId: SCAN_PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const width = e.props.bodyColumns
    const list = await read($, rows)
    // Sprites are cut to the width; prose wraps.
    const lines = list.flatMap(r => (r.isArt ? [{ ...r, text: [...r.text].slice(0, width).join('') }] : wrap(r.text, width).map(text => ({ ...r, text }))))
    return (
      <Box flexDirection="column">
        {lines.map(r => (
          <Text bold={r.style === 'bold'} dimColor={r.style === 'dim'}>
            {r.text}
          </Text>
        ))}
        <Text dimColor>Esc closes.</Text>
      </Box>
    )
  })
}
