import { CREW } from '../config'

// SPEC 9.1 crew: real subagent types. The prompts and descriptions are working
// instructions only (CLAUDE.md rule 1): the role names are the game's, nothing
// else about the game reaches the model.

export type Role = 'engineering' | 'science' | 'tactical'
export const ROLES: readonly Role[] = ['engineering', 'science', 'tactical']

export const ROLE_LABELS: Record<Role, string> = { engineering: 'Engineering', science: 'Science', tactical: 'Tactical' }

const READ_ONLY = 'Do not modify, create or delete files, and do not commit or push.'

export type CrewSpec = { name: Role; description: string; prompt: string; tools: string[]; maxTurns: number }

export const CREW_SPECS: Record<Role, CrewSpec> = {
  engineering: {
    name: 'engineering',
    description: 'Runs the project\'s tests and explains the failures. Read-only.',
    prompt: [
      'You run a project\'s tests and explain the results.',
      'Find how the project runs its tests (package.json scripts, Makefile, composer.json, pyproject, CI config) and run the narrowest command that covers the request.',
      'Report the command you ran, the pass and fail counts, and for each failure: the test name, the assertion or error, and the most likely cause with file:line.',
      'If the tests cannot run, say why and what is missing.',
      READ_ONLY,
    ].join(' '),
    tools: ['Bash', 'Read', 'Grep', 'Glob'],
    maxTurns: CREW.maxTurns.engineering,
  },
  science: {
    name: 'science',
    description: 'Answers questions about the codebase and its docs by reading them, citing file:line. Read-only.',
    prompt: [
      'You answer questions about a codebase by reading its code and documentation.',
      'Cite file:line for every claim. Keep what you verified apart from what you infer, and say what you could not find.',
      READ_ONLY,
    ].join(' '),
    tools: ['Read', 'Grep', 'Glob'],
    maxTurns: CREW.maxTurns.science,
  },
  tactical: {
    name: 'tactical',
    description: 'Security review of the current branch\'s changes before a push; ends with a CLEAN or ISSUES verdict. Read-only.',
    prompt: [
      'You review code changes for security problems before they are pushed.',
      'Unless told otherwise, the changes under review are the commits on the current branch that its upstream lacks (git log @{u}..HEAD; with no upstream, compare against the default branch) plus uncommitted changes.',
      'Look for injection (SQL, shell, template), authentication and authorization gaps, secrets or credentials in code or config, unsafe deserialization, path traversal, server-side request forgery, missing validation at trust boundaries, sensitive data written to logs, and risky dependency changes.',
      'Report each finding with file:line, severity and a concrete fix.',
      READ_ONLY,
      'End your reply with exactly one line: "VERDICT: CLEAN" when you found no security issue, or "VERDICT: ISSUES" otherwise.',
    ].join(' '),
    tools: ['Bash', 'Read', 'Grep', 'Glob'],
    maxTurns: CREW.maxTurns.tactical,
  },
}

/** `final-commit:tactical` -> 'tactical'; undefined for any other agent type. */
export function roleOf(subagentType: string): Role | undefined {
  const m = /^final-commit:(engineering|science|tactical)$/.exec(subagentType)
  return m ? (m[1] as Role) : undefined
}

export type Verdict = 'clean' | 'issues'

/** The Tactical verdict: the last `VERDICT:` line of the reply, or undefined without one. */
export function parseVerdict(answer: string): Verdict | undefined {
  const all = [...answer.matchAll(/^\s*\**VERDICT:\s*(CLEAN|ISSUES)\b/gim)]
  const last = all.at(-1)?.[1]
  return last === undefined ? undefined : last.toUpperCase() === 'CLEAN' ? 'clean' : 'issues'
}

/** What the crew is doing this session: running agents by id, and each officer's last result. */
export type CrewOutcome = 'done' | 'clean' | 'issues' | 'stopped'
/** `fromBridge`: runs launched from the Bridge pane, whose reports open in the report pane. */
export type CrewState = { running: Record<string, Role>; last: Partial<Record<Role, { outcome: CrewOutcome; at: number }>>; fromBridge: string[] }
export const NO_CREW: CrewState = { running: {}, last: {}, fromBridge: [] }

/** What a Bridge key sends an officer to do. */
export type CrewTask = 'tests' | 'lint' | 'question' | 'review'
export const TASK_ROLE: Record<CrewTask, Role> = { tests: 'engineering', lint: 'engineering', question: 'science', review: 'tactical' }

/** The Bridge's keys: `e` tests and `l` lint (Engineering), `s` a question (Science), `t` a security review (Tactical). */
export const BRIDGE_KEYS: Record<string, CrewTask> = { e: 'tests', l: 'lint', s: 'question', t: 'review' }

/** The prompt a Bridge key gives an officer: plain working instructions, like the agent prompts. */
export function crewTask(task: CrewTask, question = ''): { prompt: string; description: string } {
  switch (task) {
    case 'tests':
      return { prompt: 'Run the project\'s test suite and report the results.', description: 'Run the tests' }
    case 'lint':
      return {
        prompt: [
          'Run the project\'s linters and type checkers (for example its lint and typecheck scripts, eslint, tsc, phpstan, ruff) and report every problem with file:line.',
          'Run each command on its own, not piped into another command, so its exit status is kept.',
          'End your reply with exactly one line: "LINT: PASS" when every check passed, or "LINT: FAIL" otherwise.',
        ].join(' '),
        description: 'Run lint and type checks',
      }
    case 'review':
      return { prompt: 'Review the changes on the current branch that are not yet pushed, plus any uncommitted changes, for security issues.', description: 'Security review' }
    case 'question':
      return { prompt: question.trim(), description: 'Answer a question' }
  }
}

/** The lint verdict an Engineering report ends with: the last `LINT:` line, or undefined. */
export function parseLint(answer: string): 'pass' | 'fail' | undefined {
  const last = [...answer.matchAll(/^\s*\**LINT:\s*(PASS|FAIL)\b/gim)].at(-1)?.[1]
  return last === undefined ? undefined : last.toUpperCase() === 'PASS' ? 'pass' : 'fail'
}

/** A finished run's answer as report lines: blank lines dropped, cut to CREW.reportLines with a note. */
export function reportLines(answer: string): string[] {
  const lines = answer.split('\n').map(l => l.trimEnd()).filter(l => l.trim() !== '')
  if (lines.length === 0) return ['(no report)']
  if (lines.length <= CREW.reportLines) return lines
  return [...lines.slice(0, CREW.reportLines - 1), `(${lines.length - CREW.reportLines + 1} more lines not shown)`]
}

/** The Bridge's number keys: each reopens that officer's last report. */
export const REPORT_KEYS: Record<string, Role> = { '1': 'engineering', '2': 'science', '3': 'tactical' }

/**
 * One line per officer for the Bridge, numbered by its report key: busy,
 * idle, or its last result, and `(report)` when one is saved.
 */
export function crewLines(s: CrewState, withReport: readonly Role[] = []): string[] {
  const busy = new Set(Object.values(s.running))
  const word: Record<CrewOutcome, string> = { done: 'idle', clean: 'all clear', issues: 'ISSUES FOUND', stopped: 'idle (stopped)' }
  return ROLES.map((r, i) => {
    const status = busy.has(r) ? 'busy' : s.last[r] ? word[s.last[r]!.outcome] : 'idle'
    return `  ${i + 1} ${ROLE_LABELS[r].padEnd(12)}${status}${withReport.includes(r) ? ' (report)' : ''}`
  })
}
