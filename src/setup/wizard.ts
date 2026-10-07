import type { SetupValues, SetupView } from '../../types'
import { parseRepos } from '../detect/github'
import { parseJiraSettings } from '../detect/jira'
import { sourceNames } from '../detect/sources'
import { textList } from '../runtime'

// `/setup` (SPEC 4.6): a pane that walks through how work is tracked, one
// question at a time, and writes the answers as the plugin's own settings.
// Pure: the pane draws a SetupView and hands each answer to `answer`.

/** The sources the wizard offers, in the order it asks about them. */
export const SETUP_SOURCES = ['plans', 'github', 'jira'] as const
type SourceName = (typeof SETUP_SOURCES)[number]

/** The settings the wizard writes, in the order to write them (the source list last). */
export const SETUP_KEYS: readonly (keyof SetupValues)[] = ['plansFolders', 'githubRepos', 'jiraSite', 'jiraEmail', 'workSources']

const QUESTIONS: Record<Exclude<SetupView['step'], 'review' | 'saving' | 'done'>, { label: string; help: string }> = {
  sources: { label: 'Sources', help: 'Which work sources to read, comma-separated: plans, github, jira. Leave empty for none.' },
  plans: { label: 'Plan folders', help: 'Folders of markdown plans, comma-separated, inside the project.' },
  github: { label: 'Repositories', help: 'Each as owner/repo=PREFIX, comma-separated: issue #12 becomes PREFIX-12.' },
  jiraSite: { label: 'Jira site', help: 'Your Jira Cloud site, like https://example.atlassian.net.' },
  jiraEmail: { label: 'Jira email', help: 'The email of the Atlassian account your API token belongs to.' },
}

/** The prefix a repo name suggests: the initials of a hyphenated name (`final-commit` is FC), else its first letters. */
export function suggestPrefix(repo: string): string {
  const words = repo.toUpperCase().split(/[^A-Z0-9]+/).filter(w => /^[A-Z]/.test(w))
  const initials = words.map(w => w[0]!).join('')
  const prefix = words.length >= 2 ? initials : (words[0] ?? '').slice(0, 4)
  return /^[A-Z][A-Z0-9]{1,9}$/.test(prefix) ? prefix : 'WORK'
}

/** The current settings as the wizard's starting answers; `repo` (owner/name, from gh) fills an empty repository list. */
export function startSetup(current: SetupValues, repo?: string): SetupView {
  const sources = sourceNames(current.workSources)
  const githubRepos = current.githubRepos.trim() !== '' || !repo ? current.githubRepos : `${repo}=${suggestPrefix(repo.split('/')[1] ?? repo)}`
  return {
    step: 'sources',
    values: { ...current, workSources: sources.length > 0 ? sources.join(', ') : 'plans', githubRepos },
    original: current,
    error: null,
    applied: [],
  }
}

/** The step after `step`, skipping sources not chosen. */
function after(step: SetupView['step'], chosen: readonly SourceName[]): SetupView['step'] {
  const order: SetupView['step'][] = ['sources', 'plans', 'github', 'jiraSite', 'jiraEmail', 'review']
  const wanted = (s: SetupView['step']) =>
    s === 'plans' ? chosen.includes('plans') : s === 'github' ? chosen.includes('github') : s === 'jiraSite' || s === 'jiraEmail' ? chosen.includes('jira') : true
  for (let i = order.indexOf(step) + 1; i < order.length; i++) if (wanted(order[i]!)) return order[i]!
  return 'review'
}

const chosenOf = (v: SetupValues) => sourceNames(v.workSources).filter((s): s is SourceName => (SETUP_SOURCES as readonly string[]).includes(s))

/** Checks one answer. Undefined when it is fine, else what is wrong (the pane stays on the question). */
function problemOf(step: SetupView['step'], value: string): string | undefined {
  if (step === 'sources') {
    const unknown = sourceNames(value).filter(s => !(SETUP_SOURCES as readonly string[]).includes(s))
    return unknown.length > 0 ? `Not a source: ${unknown.join(', ')}. Choose from plans, github, jira.` : undefined
  }
  if (step === 'plans') {
    const folders = textList(value)
    const bad = folders.filter(p => /^([/\\~]|[A-Za-z]:)/.test(p) || p.split(/[/\\]/).includes('..'))
    if (bad.length > 0) return `Folders must be inside the project: ${bad.join(', ')}.`
    // An empty setting reads docs/plans: say so rather than show none.
    return folders.length === 0 ? 'List at least one folder (docs/plans is the usual one).' : undefined
  }
  if (step === 'github') {
    const { repos, invalid } = parseRepos(textList(value))
    if (invalid.length > 0) return `Not owner/repo=PREFIX, or a repo or prefix given twice: ${invalid.join(', ')}.`
    return repos.length === 0 ? 'List at least one repository, or press Esc and run /setup again without github.' : undefined
  }
  if (step === 'jiraSite') {
    const { problem } = parseJiraSettings(value, 'x', 'x')
    return problem
  }
  if (step === 'jiraEmail') return /^[^\s@]+@[^\s@]+$/.test(value.trim()) ? undefined : 'That is not an email address.'
  return undefined
}

const FIELD: Partial<Record<SetupView['step'], keyof SetupValues>> = {
  sources: 'workSources', plans: 'plansFolders', github: 'githubRepos', jiraSite: 'jiraSite', jiraEmail: 'jiraEmail',
}

/** The question the pane asks now, with the answer it holds so far. */
export function questionOf(view: SetupView): { label: string; help: string; value: string } | undefined {
  const field = FIELD[view.step]
  if (!field || view.step === 'review' || view.step === 'saving' || view.step === 'done') return undefined
  return { ...QUESTIONS[view.step], value: view.values[field] }
}

/** Enter on a question: checks the answer, keeps it, and moves on; a wrong answer stays with its problem. */
export function answer(view: SetupView, value: string): SetupView {
  const field = FIELD[view.step]
  if (!field) return view
  const text = field === 'workSources' ? sourceNames(value).join(', ') : textList(value).join(', ')
  const problem = problemOf(view.step, value)
  if (problem) return { ...view, values: { ...view.values, [field]: value }, error: problem }
  const values = { ...view.values, [field]: field === 'jiraSite' || field === 'jiraEmail' ? value.trim() : text }
  return { ...view, values, error: null, step: after(view.step, chosenOf(values)) }
}

/**
 * What applying would change: each setting whose answer differs from now, in
 * the order to write them (the source list last, so each source has its
 * settings when it starts). A source not chosen keeps its settings as they are.
 */
export function changesOf(view: SetupView): { key: keyof SetupValues; value: string }[] {
  const chosen = chosenOf(view.values)
  const asked: Record<keyof SetupValues, boolean> = {
    workSources: true, plansFolders: chosen.includes('plans'), githubRepos: chosen.includes('github'), jiraSite: chosen.includes('jira'), jiraEmail: chosen.includes('jira'),
  }
  return SETUP_KEYS.filter(k => asked[k] && view.values[k] !== view.original[k]).map(k => ({ key: k, value: view.values[k] }))
}

/** The review's lines: each answer, what changes, and what the wizard cannot do (the secret token). */
export function reviewLines(view: SetupView, hasJiraToken: boolean): string[] {
  const chosen = chosenOf(view.values)
  const changing = new Set(changesOf(view).map(c => c.key))
  const line = (label: string, key: keyof SetupValues) => `${changing.has(key) ? '* ' : '  '}${label}: ${view.values[key] || '(none)'}`
  const lines = [line('Sources', 'workSources')]
  if (chosen.includes('plans')) lines.push(line('Plan folders', 'plansFolders'))
  if (chosen.includes('github')) lines.push(line('Repositories', 'githubRepos'))
  if (chosen.includes('jira')) {
    lines.push(line('Jira site', 'jiraSite'), line('Jira email', 'jiraEmail'))
    lines.push(hasJiraToken
      ? '  Jira API token: set'
      : '! Jira API token: not set. It is a secret the game never sees: set jiraToken in the plugin\'s own settings (/plugin, then final-commit).')
  }
  lines.push(changing.size > 0 ? '* marks a change. Enter: save  Esc: cancel' : 'Nothing changes. Enter or Esc: close')
  return lines
}
