import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions } from 'claude-code'
import type { SetupValues, SetupView } from '../../types'
import { wrap } from '../bridge/text'
import { GIT } from '../config'
import { answer, changesOf, questionOf, reviewLines, startSetup } from './wizard'

// `/setup` (SPEC 4.6): the wizard as a pane. Answers are typed into it, so
// they skip the transcript the model reads, and are saved as the plugin's
// own settings through `$.config.set`, as a change in `/config` would be.
// The Jira API token is a secret no plugin can write: the review says where
// to set it, and whether it is set, never what it is.

export const SETUP_PANE = 'fc-setup'
const view = atom({ plugin: 'final-commit', key: 'setup' } as const, null as SetupView | null)

const text = (v: unknown) => (typeof v === 'string' ? v : '')
let current: SetupValues = { workSources: '', plansFolders: '', githubRepos: '', jiraSite: '', jiraEmail: '' }
let hasJiraToken = false

/** This project's GitHub repo (owner/name) through gh, to suggest; undefined when there is none or gh cannot tell. */
async function repoHere($: EngineInterface): Promise<string | undefined> {
  try {
    const r = await $.process.run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { timeoutMs: GIT.timeoutMs })
    const name = r.stdout.trim()
    return r.exitCode === 0 && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name) ? name : undefined
  } catch {
    return undefined
  }
}

async function setup($: EngineInterface): Promise<{ text: string }> {
  const repo = await repoHere($)
  await update($, view, () => startSetup(current, repo))
  const placed = await $.ui.open({ id: SETUP_PANE, title: 'Set up work sources', focus: true, closeOnEscape: true })
  if (placed.isPlaced) return { text: 'Opened the setup pane.' }
  await update($, view, () => null)
  return { text: 'The setup pane could not open here. Set workSources and the source settings in /config instead.' }
}

/** Enter on a question: the answer is checked and kept, or the pane says what is wrong. */
async function submit($: EngineInterface, value: string) {
  await update($, view, v => (v ? answer(v, value) : v))
}

/**
 * Enter on the review: writes each changed setting, the source list last. A
 * write reloads the plugin with the new settings; the writes still finish.
 * The pane shows `saving` meanwhile, with no input, so a second Enter cannot
 * write them again. Saving is not stopped halfway: if the pane was closed
 * meanwhile, a toast says what was saved.
 */
async function save($: EngineInterface) {
  const v = await read($, view)
  if (!v || v.step !== 'review') return
  const changes = changesOf(v)
  if (changes.length === 0) {
    await close($)
    return
  }
  await update($, view, s => (s ? { ...s, step: 'saving' as const } : s))
  const applied: string[] = []
  for (const c of changes) {
    try {
      const r = await $.config.set({ key: `final-commit.${c.key}`, value: c.value })
      applied.push('deny' in r && r.deny !== undefined ? `${c.key}: not saved (${r.deny})` : `${c.key}: saved`)
    } catch (err) {
      applied.push(`${c.key}: not saved (${err instanceof Error ? err.message : String(err)})`)
    }
  }
  const after = await update($, view, s => (s ? { ...s, step: 'done' as const, applied } : s))
  if (!after) $.ui.toast(`Setup: ${applied.join('; ')}.`)
}

async function close($: EngineInterface) {
  // A plugin's own $.ui.close does not reach its own ui.close hook, so the view is cleared here.
  await update($, view, () => null)
  await $.ui.close({ id: SETUP_PANE })
}

/** Registers `/setup` and its pane. `options` are the settings this load runs with: the wizard starts from them. */
export function wireSetup(on: On, options: PluginOptions): void {
  current = {
    workSources: text(options.workSources),
    plansFolders: text(options.plansFolders),
    githubRepos: text(options.githubRepos),
    jiraSite: text(options.jiraSite),
    jiraEmail: text(options.jiraEmail),
  }
  hasJiraToken = text(options.jiraToken).trim() !== ''

  on('command.run', { command: 'setup' }, async $ => setup($))

  on('ui.close', { id: SETUP_PANE }, async ($, e, next) => {
    await update($, view, () => null)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: SETUP_PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const width = e.props.bodyColumns
    const v = await read($, view)
    if (!v) return <Text dimColor>Nothing to set up.</Text>
    const lines = (s: string, style?: 'bold' | 'dim' | 'error') => wrap(s, width).map(line => (
      <Text bold={style === 'bold'} dimColor={style === 'dim'} color={style === 'error' ? 'error' : undefined}>{line}</Text>
    ))
    if (!Input) return <Box flexDirection="column">{lines('This surface has no text input; run /setup from a terminal.', 'dim')}</Box>
    if (v.step === 'done') {
      return (
        <Box flexDirection="column">
          {v.applied.flatMap(a => lines(a))}
          {lines('Settings take effect at once. Enter or Esc closes.', 'dim')}
          <Input key="setup-done" autoFocus label="Enter" onInput={() => {}} onSubmit={() => void close($)} />
        </Box>
      )
    }
    if (v.step === 'saving') return <Box flexDirection="column">{lines('Saving...', 'dim')}</Box>
    if (v.step === 'review') {
      return (
        <Box flexDirection="column">
          {lines('Review', 'bold')}
          {reviewLines(v, hasJiraToken).flatMap(l => lines(l, l.startsWith('!') ? 'error' : undefined))}
          <Input key="setup-review" autoFocus label="Enter" onInput={() => {}} onSubmit={() => void save($)} />
        </Box>
      )
    }
    const q = questionOf(v)
    if (!q) return <Text dimColor>Nothing to set up.</Text>
    return (
      <Box flexDirection="column">
        {lines(q.help, 'dim')}
        {v.error ? lines(v.error, 'error') : null}
        <Input key={`setup-${v.step}`} autoFocus label={q.label} value={q.value} onInput={() => {}} onSubmit={(value: string) => void submit($, value)} />
        {lines('Enter: next  Esc: cancel, nothing saved', 'dim')}
      </Box>
    )
  })
}
