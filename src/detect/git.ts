// SPEC 4.1 / 4.2 git signals. Pure parsing; the glue runs git itself.

const KEY_SEGMENT = /^([A-Za-z][A-Za-z0-9]{1,9})-([1-9]\d*)(?:-|$)/
// Words that start branch names but are never project keys.
const NOT_KEYS = new Set(['release', 'hotfix', 'feature', 'bugfix', 'fix', 'chore', 'build', 'rc', 'sprint', 'version', 'week'])

export function issueKeyFromBranch(branch: string): string | undefined {
  for (const segment of branch.split('/')) {
    const m = KEY_SEGMENT.exec(segment)
    if (!m || NOT_KEYS.has(m[1]!.toLowerCase()) || /^v\d*$/i.test(m[1]!)) continue
    return `${m[1]!.toUpperCase()}-${m[2]}`
  }
  return undefined
}

/**
 * `isTestStatusReliable` is false when the command's exit status may not be
 * the test runner's: piped (`| tail`), guarded (`|| true`) or backgrounded (`&`).
 */
export type BashSignals = { mayChangeBranch: boolean; commits: number; isTestRun: boolean; isTestStatusReliable: boolean }

const ENV_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/
const GIT = /^git(?:\s+-C\s+\S+)?\s+/
const TEST_RUNNER =
  /^(?:(?:npx|pnpm\s+exec|yarn)\s+)?(?:php\s+artisan\s+test|(?:vendor\/bin\/)?(?:pest|phpunit)|(?:npm|pnpm|yarn)\s+(?:run\s+)?test|vitest|jest|pytest|go\s+test|cargo\s+test|claude\s+plugin\s+test)\b/

export function classifyBash(command: string): BashSignals {
  const signals: BashSignals = { mayChangeBranch: false, commits: 0, isTestRun: false, isTestStatusReliable: true }
  if (/\|\||(?<![|&])[|&](?![|&])/.test(command)) signals.isTestStatusReliable = false
  for (const raw of command.split(/&&|\|\||;|\n/)) {
    const part = raw.trim().replace(ENV_PREFIX, '')
    if (GIT.test(part)) {
      const sub = part.replace(GIT, '')
      if (/^(?:checkout|switch)\b/.test(sub)) signals.mayChangeBranch = true
      if (/^commit\b/.test(sub)) signals.commits += 1
    }
    if (TEST_RUNNER.test(part)) signals.isTestRun = true
  }
  return signals
}
