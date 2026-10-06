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
// Commands that run another command and pass its exit status through.
const WRAPPER = /^(?:timeout(?:\s+-{1,2}[\w-]+(?:[= ]\S+)?)*\s+\d+[smhd]?|time|nice(?:\s+-n\s*-?\d+)?|env(?:\s+[A-Za-z_][A-Za-z0-9_]*=\S*)*|command)\s+/

/** Strips leading `VAR=x` assignments and wrappers like `timeout 300` or `time`. */
function unwrap(part: string): string {
  let out = part.replace(ENV_PREFIX, '')
  for (let prev = ''; prev !== out; ) {
    prev = out
    out = out.replace(WRAPPER, '').replace(ENV_PREFIX, '')
  }
  return out
}
const GIT = /^git(?:\s+-C\s+\S+)?\s+/
const TEST_RUNNER =
  /^(?:(?:npx|pnpm\s+exec|yarn)\s+)?(?:php\s+artisan\s+test|(?:vendor\/bin\/)?(?:pest|phpunit)|(?:npm|pnpm|yarn)\s+(?:run\s+)?test|vitest|jest|pytest|go\s+test|cargo\s+test|claude\s+plugin\s+test)\b/

export function classifyBash(command: string): BashSignals {
  const signals: BashSignals = { mayChangeBranch: false, commits: 0, isTestRun: false, isTestStatusReliable: true }
  // A pipe (`|`, `|&`), an `||` guard, or a backgrounding `&`. Redirections like
  // `2>&1` and `&>` are none of these and leave the exit status alone.
  if (/\|\||\|&|(?<![|&<>])\|(?![|&])|(?<![|&<>])&(?![|&>])/.test(command)) signals.isTestStatusReliable = false
  for (const raw of command.split(/&&|\|\||;|\n/)) {
    const part = unwrap(raw.trim())
    if (GIT.test(part)) {
      const sub = part.replace(GIT, '')
      if (/^(?:checkout|switch)\b/.test(sub)) signals.mayChangeBranch = true
      if (/^commit\b/.test(sub)) signals.commits += 1
    }
    if (TEST_RUNNER.test(part)) signals.isTestRun = true
  }
  return signals
}

export type TestVerdict = 'pass' | 'fail'

// Summary lines test runners print at the end of a run. A failure anywhere wins.
const FAIL_SUMMARY = [
  /^\s*[1-9]\d* fail\s*$/m, // bun, claude plugin test
  /\bTests?:?\s+(?:.*?\s)?[1-9]\d* failed\b/, // jest, vitest, pest
  /^=+ .*\b[1-9]\d* (?:failed|errors?)\b.*=+\s*$/m, // pytest
  /^(?:FAILURES|ERRORS)!\s*$/m, // phpunit
  /^FAIL\b/m, // go test
  /\btest result: FAILED\b/, // cargo test
]
const PASS_SUMMARY = [
  /^\s*[1-9]\d* pass\s*$/m,
  /\bTests?:?\s+(?:.*?\s)?[1-9]\d* passed\b/,
  /^=+ [1-9]\d* passed\b.*=+\s*$/m,
  /^OK \([1-9]\d* tests?\b/m,
  /^ok\s+\S+\s+(?:\(cached\)|\d+(?:\.\d+)?s)/m, // go test
  /\btest result: ok\./,
]

/**
 * Pass or fail from a test runner's own summary in the output, or undefined
 * when no summary is visible (cut by `| tail`, hidden by `grep`, never printed).
 */
export function testVerdictFromOutput(output: string): TestVerdict | undefined {
  if (FAIL_SUMMARY.some(p => p.test(output))) return 'fail'
  if (PASS_SUMMARY.some(p => p.test(output))) return 'pass'
  return undefined
}
