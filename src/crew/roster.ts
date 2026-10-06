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
export type CrewState = { running: Record<string, Role>; last: Partial<Record<Role, { outcome: CrewOutcome; at: number }>> }
export const NO_CREW: CrewState = { running: {}, last: {} }

/** One line per officer for the Bridge: busy, idle, or its last result. */
export function crewLines(s: CrewState): string[] {
  const busy = new Set(Object.values(s.running))
  const word: Record<CrewOutcome, string> = { done: 'idle', clean: 'all clear', issues: 'ISSUES FOUND', stopped: 'idle (stopped)' }
  return ROLES.map(r => `  ${ROLE_LABELS[r].padEnd(12)} ${busy.has(r) ? 'busy' : s.last[r] ? word[s.last[r]!.outcome] : 'idle'}`)
}
