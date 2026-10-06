import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { BandView, ChartingEntry } from '../../types'
import { setCompanion } from '../game'
import { NO_MOOD, rngFor, snapshot } from '../runtime'
import { createRepo, type Repo } from '../store/repo'
import type { StarSystem } from '../store/schema'
import { bayRows } from './bay'

export const BAY_PANE = 'fc-bay'
const rows = atom({ plugin: 'final-commit', key: 'bay' } as const, [] as string[])
const ready = atom({ plugin: 'final-commit', key: 'ready' } as const, false)
const mood = atom({ plugin: 'final-commit', key: 'mood' } as const, NO_MOOD)
const charting = atom({ plugin: 'final-commit', key: 'charting' } as const, [] as ChartingEntry[])
const band = atom({ plugin: 'final-commit', key: 'band' } as const, null as BandView | null)

function repoOf($: EngineInterface): Repo {
  return createRepo(
    { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value), delete: key => $.store.delete(key), keys: () => $.store.keys() },
    line => $.ui.log(line, { to: 'debug' }),
  )
}

async function refresh($: EngineInterface) {
  const s = await snapshot(repoOf($), await read($, mood), await $.clock.now(), await read($, charting))
  $.ui.status(s.status)
  await update($, band, prev => (s.band && prev ? { ...s.band, isBlinking: prev.isBlinking } : s.band))
}

async function bay($: EngineInterface, args: string): Promise<string> {
  if (!(await read($, ready))) return 'The Final Commit could not load its save; see the debug log (claude --debug).'
  const repo = repoOf($)
  const m = /^companion\s+(\d+)$/i.exec(args.trim())
  if (m) {
    const chosen = (await repo.specimens())[Number(m[1]) - 1]
    if (!chosen) return 'No such specimen. /bay lists them.'
    const out = await setCompanion({ repo, now: await $.clock.now(), rng: rngFor(undefined, 0), specimenId: chosen.id })
    await refresh($)
    return out.text
  }
  const specimens = await repo.specimens()
  const systems: StarSystem[] = []
  for (const id of await repo.systemIds()) {
    const s = await repo.system(id)
    if (s) systems.push(s)
  }
  const meta = await repo.meta()
  // Rows are cut to the pane's width when drawn.
  await update($, rows, () => bayRows(specimens, systems, meta?.companionId ?? null, Number.MAX_SAFE_INTEGER))
  await $.ui.open({ id: BAY_PANE, title: 'Specimen Bay', focus: true, closeOnEscape: true })
  return `Opened the specimen bay (${specimens.length} specimen${specimens.length === 1 ? '' : 's'}).`
}

/** The Specimen Bay as a pane, so creature names stay out of the transcript the model reads. */
export function wireBay(on: On): void {
  on('command.run', { command: 'bay' }, async ($, e) => ({ text: await bay($, e.args) }))

  on('ui.render', { component: 'Pane', requestId: BAY_PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, rows)
    return (
      <Box flexDirection="column">
        {list.map(r => (
          <Text>{[...r].slice(0, e.props.bodyColumns).join('')}</Text>
        ))}
        <Text dimColor>/bay companion N sets your companion. Esc closes.</Text>
      </Box>
    )
  })
}
