import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { DossierStat } from '../../types'
import { createRepo, type Repo } from '../store/repo'
import { dossierRows } from './dossier'

export const DOSSIER_PANE = 'fc-dossier'
const stats = atom({ plugin: 'final-commit', key: 'dossier' } as const, null as DossierStat[] | null)
const ready = atom({ plugin: 'final-commit', key: 'ready' } as const, false)

function repoOf($: EngineInterface): Repo {
  return createRepo(
    { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value), delete: key => $.store.delete(key), keys: () => $.store.keys() },
    line => $.ui.log(line, { to: 'debug' }),
  )
}

/** `/dossier`: puzzle accuracy by category, in a pane so category names stay out of the transcript the model reads. */
async function dossier($: EngineInterface): Promise<string> {
  if (!(await read($, ready))) return 'The Final Commit could not load its save; see the debug log (claude --debug).'
  const drawn = (await repoOf($).puzzleStats()).map(({ category, type, attempts, correct, recent }) => ({ category, type, attempts, correct, recent }))
  await update($, stats, () => drawn)
  await $.ui.open({ id: DOSSIER_PANE, title: 'Dossier', focus: true, closeOnEscape: true })
  return `Opened the dossier (${drawn.reduce((n, s) => n + s.attempts, 0)} answered).`
}

async function close($: EngineInterface) {
  // A plugin's own $.ui.close does not reach its own ui.close hook, so the state is cleared here.
  await update($, stats, () => null)
  await $.ui.close({ id: DOSSIER_PANE })
}

export function wireDossier(on: On): void {
  on('command.run', { command: 'dossier' }, async $ => ({ text: await dossier($) }))

  on('ui.close', { id: DOSSIER_PANE }, async ($, e, next) => {
    await update($, stats, () => null)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: DOSSIER_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, stats)
    if (!list) return <Text dimColor>Nothing to show.</Text>
    return (
      <Box flexDirection="column">
        {dossierRows(list, e.props.bodyColumns).map(r => (
          <Text bold={r.style === 'bold'}>{r.text === '' ? ' ' : r.text}</Text>
        ))}
        <Text dimColor>Esc closes.</Text>
        {e.surface === 'mobile' && <Button key="dossier-close" label="Close" onPress={() => void close($)} />}
      </Box>
    )
  })
}
