import { expect, test } from 'claude-code/testing'
import type { SetupValues, SetupView } from '../types'
import { answer, changesOf, questionOf, reviewLines, startSetup, suggestPrefix } from '../src/setup/wizard'

// The /setup wizard (SPEC 4.6), as a pure walk through its questions. Invented repos and sites only.

const EMPTY: SetupValues = { workSources: '', plansFolders: 'docs/plans', githubRepos: '', jiraSite: '', jiraEmail: '' }

/** Answers each question in turn, returning the steps it passed and where it stopped. */
function walk(view: SetupView, answers: string[]): { view: SetupView; steps: string[] } {
  const steps: string[] = []
  let v = view
  for (const a of answers) {
    steps.push(v.step)
    v = answer(v, a)
  }
  return { view: v, steps }
}

test('a repo name suggests a prefix: the initials of its words, else its first letters', () => {
  expect(suggestPrefix('final-commit')).toBe('FC')
  expect(suggestPrefix('nova')).toBe('NOVA')
  expect(suggestPrefix('billing_export_service')).toBe('BES')
  expect(suggestPrefix('x')).toBe('WORK')
  expect(suggestPrefix('123')).toBe('WORK')
})

test('the wizard starts from the settings as they are; an empty repo list is filled from this project\'s repo', () => {
  const v = startSetup(EMPTY, 'example/nova-tracker')
  expect(v.step).toBe('sources')
  expect(v.values.workSources).toBe('plans')
  expect(v.values.githubRepos).toBe('example/nova-tracker=NT')
  expect(v.original).toEqual(EMPTY)
  expect(startSetup({ ...EMPTY, workSources: 'github', githubRepos: 'example/a=AA' }, 'example/b').values).toEqual({ ...EMPTY, workSources: 'github', githubRepos: 'example/a=AA' })
  expect(questionOf(v)).toEqual({ label: 'Sources', help: expect.stringContaining('plans, github, jira'), value: 'plans' })
})

test('each chosen source is asked about in turn; the others are skipped', () => {
  const all = walk(startSetup(EMPTY), ['plans, github, jira', 'docs/plans', 'example/nova=NOVA', 'https://example.atlassian.net', 'me@example.com'])
  expect(all.steps).toEqual(['sources', 'plans', 'github', 'jiraSite', 'jiraEmail'])
  expect(all.view.step).toBe('review')
  expect(walk(startSetup(EMPTY), ['GitHub', 'example/nova=nova']).view.values).toEqual({ ...EMPTY, workSources: 'github', githubRepos: 'example/nova=nova' })
  const none = walk(startSetup({ ...EMPTY, workSources: 'plans' }), [''])
  expect(none.view.step).toBe('review')
  expect(changesOf(none.view)).toEqual([{ key: 'workSources', value: '' }])
})

test('a wrong answer stays on its question with what is wrong, keeping what was typed', () => {
  const cases: [string[], string, RegExp][] = [
    [['plans, linear'], 'sources', /Not a source: linear/],
    [['plans', '/etc, docs'], 'plans', /inside the project: \/etc/],
    [['plans', ''], 'plans', /at least one folder/],
    [['github', 'nova=NOVA'], 'github', /Not owner\/repo=PREFIX/],
    [['github', 'example/a=XX, example/b=XX'], 'github', /given twice: example\/b=XX/],
    [['github', ''], 'github', /at least one repository, or press Esc/],
    [['jira', 'https://jira.example.com'], 'jiraSite', /Jira Cloud site/],
    [['jira', 'https://example.atlassian.net', 'not-an-email'], 'jiraEmail', /not an email/],
  ]
  for (const [answers, step, problem] of cases) {
    const { view } = walk(startSetup(EMPTY), answers)
    expect([answers.join(' | '), view.step]).toEqual([answers.join(' | '), step])
    expect(view.error).toMatch(problem)
    expect(questionOf(view)?.value).toBe(answers.at(-1))
  }
  // Fixing the answer moves on and clears the problem.
  const fixed = answer(walk(startSetup(EMPTY), ['github', 'nova=NOVA']).view, 'example/nova=NOVA')
  expect([fixed.step, fixed.error]).toEqual(['review', null])
})

test('only changed settings of chosen sources are saved, the source list last; a source dropped keeps its settings', () => {
  const was: SetupValues = { workSources: 'jira', plansFolders: 'docs/plans', githubRepos: '', jiraSite: 'https://old.atlassian.net', jiraEmail: 'me@example.com' }
  const { view } = walk(startSetup(was), ['plans, github', 'docs/plans, plans', 'example/nova=NOVA'])
  expect(changesOf(view)).toEqual([
    { key: 'plansFolders', value: 'docs/plans, plans' },
    { key: 'githubRepos', value: 'example/nova=NOVA' },
    { key: 'workSources', value: 'plans, github' },
  ])
  expect(changesOf(walk(startSetup(was), ['jira', 'https://old.atlassian.net', 'me@example.com']).view)).toEqual([])
})

test('the review marks changes, says whether the Jira token is set, and never shows it', () => {
  const { view } = walk(startSetup(EMPTY), ['jira', 'https://example.atlassian.net', 'me@example.com'])
  const missing = reviewLines(view, false)
  expect(missing).toEqual([
    '* Sources: jira',
    '* Jira site: https://example.atlassian.net',
    '* Jira email: me@example.com',
    "! Jira API token: not set. It is a secret the game never sees: set jiraToken in the plugin's own settings (/plugin, then final-commit).",
    '* marks a change. Enter: save  Esc: cancel',
  ])
  expect(reviewLines(view, true)).toContain('  Jira API token: set')
  const same = walk(startSetup({ ...EMPTY, workSources: 'plans' }), ['plans', 'docs/plans']).view
  expect(reviewLines(same, false)).toEqual(['  Sources: plans', '  Plan folders: docs/plans', 'Nothing changes. Enter or Esc: close'])
})

test('while saving there is no question to answer', () => {
  const v: SetupView = { ...startSetup(EMPTY), step: 'saving' }
  expect(questionOf(v)).toBe(undefined)
  expect(answer(v, 'jira')).toBe(v)
})
