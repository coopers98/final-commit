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
 * What the command's exit status says about a runner in it (SPEC 4.3 rule 5):
 * `exact` when the runner is last and surely ran; `success-only` when an
 * `&&` comes before it (it may not have run) or only `&&` (and pipes after
 * those) follow it, so success means it passed but a failure may be another
 * command's; `unknown` when its status may be lost (piped, `;` or a new line
 * after it, an `||` before or after it, backgrounded).
 */
export type ExitStatus = 'exact' | 'success-only' | 'unknown'

/** `testStatus` and `lintStatus` are for the last test runner and the last linter in the command. */
export type BashSignals = { mayChangeBranch: boolean; commits: number; isTestRun: boolean; isLintRun: boolean; testStatus: ExitStatus; lintStatus: ExitStatus }

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
// Linters and type checkers: the Bridge's shields (SPEC 9).
const LINT_RUNNER =
  /^(?:(?:npx|pnpm\s+exec|yarn)\s+)?(?:eslint|tsc|biome\s+(?:check|lint)|(?:vendor\/bin\/)?(?:phpstan|pint|phpcs|psalm)|ruff(?:\s+check)?|flake8|mypy|golangci-lint|cargo\s+clippy|(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:lint|typecheck|type-check))\b/
const TEST_RUNNER =
  /^(?:(?:npx|pnpm\s+exec|yarn)\s+)?(?:php\s+artisan\s+test|(?:vendor\/bin\/)?(?:pest|phpunit)|(?:npm|pnpm|yarn)\s+(?:run\s+)?test|vitest|jest|pytest|go\s+test|cargo\s+test|claude\s+plugin\s+test)\b/

/**
 * The command split into its parts and the separators between them: `&&`,
 * `||`, a pipe (`|`, `|&`), `;`, a new line, or a backgrounding `&`. Quoted
 * text and escaped characters are never split, so `git commit -m "a | npm
 * test"` is one command. Redirections (`2>&1`, `>&2`, `&>`, `>|`, `<&0`) are
 * not separators. A backslash line continuation joins its lines, a heredoc's
 * body (`<<EOF` up to its `EOF` line) is input and never read as commands,
 * and a trailing `;` or new line ends the command without following it.
 */
export function splitCommand(command: string): { parts: string[]; seps: string[] } {
  const parts: string[] = []
  const seps: string[] = []
  let part = ''
  let quote: '"' | "'" | undefined
  /** Heredoc delimiters seen on the current line, whose bodies start at the next new line. */
  const heredocs: { word: string; isIndented: boolean }[] = []
  const text = command
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    const next = text[i + 1]
    const prev = text[i - 1]
    // A line continuation: the backslash and the line end join the lines (an escaped backslash, consumed below, is not one).
    if (!quote && c === '\\' && (next === '\n' || (next === '\r' && text[i + 2] === '\n'))) {
      part += ' '
      i += next === '\n' ? 1 : 2
      continue
    }
    // A heredoc may open inside a double-quoted command substitution (`"$(cat <<'EOF' ...)"`), never inside single quotes.
    if (quote !== "'" && c === '<' && next === '<' && text[i + 2] !== '<') {
      const m = /^<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(text.slice(i))
      if (m) {
        heredocs.push({ word: m[3]!, isIndented: m[1] === '-' })
        part += m[0]
        i += m[0].length - 1
        continue
      }
    }
    if (quote !== "'" && c === '\n' && heredocs.length > 0) {
      // Skip each body up to its delimiter line; outside quotes, the line end that ends the last one is the separator.
      let at = i + 1
      for (const h of heredocs.splice(0)) {
        while (at < text.length) {
          const end = text.indexOf('\n', at)
          const line = text.slice(at, end === -1 ? text.length : end).replace(/\r$/, '')
          at = end === -1 ? text.length : end + 1
          if ((h.isIndented ? line.replace(/^\t+/, '') : line) === h.word) break
        }
      }
      if (quote) {
        part += ' '
      } else {
        parts.push(part)
        seps.push('\n')
        part = ''
      }
      i = at - 1
      continue
    }
    if (quote) {
      if (c === '\\' && quote === '"' && next !== undefined) {
        part += c + next
        i += 1
      } else {
        part += c
        if (c === quote) quote = undefined
      }
      continue
    }
    if (c === '\\' && next !== undefined) {
      part += c + next
      i += 1
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      part += c
      continue
    }
    let sep: string | undefined
    if ((c === '&' && next === '&') || (c === '|' && next === '|') || (c === '|' && next === '&')) sep = c + next
    else if (c === ';' || c === '\n') sep = c
    else if (c === '|' && prev !== '>') sep = '|'
    else if (c === '&' && prev !== '>' && prev !== '<' && next !== '>') sep = '&'
    if (sep === undefined) {
      part += c
      continue
    }
    parts.push(part)
    seps.push(sep)
    part = ''
    i += sep.length - 1
  }
  parts.push(part)
  // A trailing `;` or new line (and blank lines) follow nothing; a trailing `&` still backgrounds what came before it.
  while (parts.length > 1 && parts[parts.length - 1]!.trim() === '' && (seps[seps.length - 1] === ';' || seps[seps.length - 1] === '\n')) {
    parts.pop()
    seps.pop()
  }
  return { parts, seps }
}

/** What the command's exit status says about the runner at `index`, given the parts and separators around it. */
function statusAt(parts: readonly string[], seps: readonly string[], index: number): ExitStatus {
  // Only the runner's own list counts before it: what ended in `;`, a new line or `&` ran apart.
  let start = 0
  for (let j = index - 1; j >= 0; j--) {
    if (seps[j] === ';' || seps[j] === '\n' || seps[j] === '&') {
      start = j + 1
      break
    }
  }
  const before = seps.slice(start, index)
  // `a || runner`: the runner may never have run, and success says nothing.
  if (before.includes('||')) return 'unknown'
  const after = seps.slice(index)
  const isAfterOnlyAnd = after.length === 0 || (after[0] === '&&' && after.every(s => s === '&&' || s === '|' || s === '|&'))
  if (!isAfterOnlyAnd) return 'unknown'
  // `a && runner`: if a failed, the runner never ran, so a failure may be a's. A `cd` first is taken to succeed.
  const isAfterAnd = before.some((s, i) => s === '&&' && !/^cd(?:\s|$)/.test(unwrap(parts[start + i]!.trim())))
  return after.length === 0 && !isAfterAnd ? 'exact' : 'success-only'
}

export function classifyBash(command: string): BashSignals {
  const signals: BashSignals = { mayChangeBranch: false, commits: 0, isTestRun: false, isLintRun: false, testStatus: 'exact', lintStatus: 'exact' }
  const { parts, seps } = splitCommand(command)
  parts.forEach((raw, i) => {
    const part = unwrap(raw.trim())
    if (GIT.test(part)) {
      const sub = part.replace(GIT, '')
      if (/^(?:checkout|switch)\b/.test(sub)) signals.mayChangeBranch = true
      if (/^commit\b/.test(sub)) signals.commits += 1
    }
    if (TEST_RUNNER.test(part)) {
      signals.isTestRun = true
      signals.testStatus = statusAt(parts, seps, i)
    }
    if (LINT_RUNNER.test(part)) {
      signals.isLintRun = true
      signals.lintStatus = statusAt(parts, seps, i)
    }
  })
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

/**
 * A test run that passed: by exit status where that status is the runner's
 * (or, after `&&`, a success, which means it passed), else by the runner's
 * summary. A run with no summary visible does not count as passing.
 */
export function testRunPassed(signals: BashSignals, isError: boolean, output: string): boolean {
  if (!signals.isTestRun) return false
  if (signals.testStatus === 'exact' || (signals.testStatus === 'success-only' && !isError)) return !isError
  return testVerdictFromOutput(output) === 'pass'
}

/**
 * A test run that failed: by exit status where that status is the runner's,
 * else by the runner's summary. A run with no summary visible is not called
 * failed.
 */
export function testRunFailed(signals: BashSignals, isError: boolean, output: string): boolean {
  if (!signals.isTestRun) return false
  if (signals.testStatus === 'exact') return isError
  if (signals.testStatus === 'success-only' && !isError) return false
  return testVerdictFromOutput(output) === 'fail'
}

/**
 * A lint or type-check run's verdict by its exit status, or undefined when
 * that status may not be the linter's: linters print no common summary to
 * read instead. After `&&`, a success is the linter's pass; a failure may be
 * a later command's, so it says nothing.
 */
export function lintVerdict(signals: BashSignals, isError: boolean): TestVerdict | undefined {
  if (!signals.isLintRun || signals.lintStatus === 'unknown') return undefined
  if (signals.lintStatus === 'success-only') return isError ? undefined : 'pass'
  return isError ? 'fail' : 'pass'
}
