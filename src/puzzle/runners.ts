import { RUNNERS, TRACE, type RunnerName } from '../config'
import { HARNESS, type HarnessPayload } from './harness'

// SPEC 8.3 rule 3: runners, one per runtime. Pure apart from the `run` the
// glue hands in (`$.process.run`). One now, node; `python3`, `php` and
// `sqlite3` each take a row in config's RUNNERS, an `argv` here and a harness
// of their own when their adapters land.

/** `$.process.run`'s shape, as much of it as a runner needs. */
export type Run = (
  argv: readonly string[],
  init: { cwd: string; stdin?: string; timeoutMs: number; env?: Record<string, string> },
) => Promise<{ exitCode: number; stdout: string; isStdoutTruncated: boolean }>

/** One call's outcome: its value as plain JSON data, or not ok. */
export type CallResult = { ok: true; value: unknown } | { ok: false }

/** The command that runs Trace's harness with this runner. */
export function runnerArgv(name: RunnerName, binaryPath: string): string[] {
  const r = RUNNERS[name]
  // `env -i`: an empty environment, so no token or setting of the session reaches the runner
  // (the engine's `env` only sets variables over the session's own). Node's permission model:
  // no file reads or writes, no child processes, workers or addons. No code from strings.
  return ['env', '-i', `HOME=${r.emptyHome}`, binaryPath, '--permission', `--max-old-space-size=${r.maxOldSpaceMb}`, '--disallow-code-generation-from-strings', '--no-warnings', '-e', HARNESS]
}

/**
 * The runner's absolute path, or undefined when it does not answer; any
 * failure means none. Checked once per session by the glue. The path is
 * what runs, since the runner itself starts with no `PATH`.
 */
export async function runnerPath(name: RunnerName, run: Run, cwd: string): Promise<string | undefined> {
  try {
    const r = await run([RUNNERS[name].binary, '-p', 'process.execPath'], { cwd, timeoutMs: TRACE.probeTimeoutMs })
    const path = r.stdout.trim()
    return r.exitCode === 0 && /^\/[\w./+-]+$/.test(path) ? path : undefined
  } catch {
    return undefined
  }
}

/**
 * The harness's reply as one result per call, or undefined: a non-zero exit,
 * output cut or over the cap, anything but one `{"results":[...]}` line, a
 * count other than `calls`, or a result of any other shape.
 */
export function parseResults(reply: { exitCode: number; stdout: string; isStdoutTruncated: boolean }, calls: number, maxChars: number): CallResult[] | undefined {
  if (reply.exitCode !== 0 || reply.isStdoutTruncated || reply.stdout.length > maxChars) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(reply.stdout)
  } catch {
    return undefined
  }
  const results = (parsed as { results?: unknown } | null)?.results
  if (!Array.isArray(results) || results.length !== calls) return undefined
  const out: CallResult[] = []
  for (const r of results as unknown[]) {
    if (typeof r !== 'object' || r === null || Array.isArray(r)) return undefined
    const rec = r as Record<string, unknown>
    const keys = Object.keys(rec).sort().join(',')
    if (rec.ok === true && keys === 'ok,value') out.push({ ok: true, value: rec.value })
    else if (rec.ok === false && keys === 'ok') out.push({ ok: false })
    else return undefined
  }
  return out
}

/**
 * Runs `code`'s function `name` once per input with the runner, in `cwd`
 * (a temporary folder, never the project): one process for all of them.
 * Undefined when the run fails in any way; a rejected run (it could not
 * start, or ran past its timeout) is a failure too.
 */
export async function runCalls(req: { name: RunnerName; path: string; run: Run; cwd: string; code: string; fn: string; inputs: unknown[][] }): Promise<CallResult[] | undefined> {
  const r = RUNNERS[req.name]
  const payload: HarnessPayload = {
    code: req.code, name: req.fn, inputs: req.inputs,
    callTimeoutMs: TRACE.callTimeoutMs, totalMs: TRACE.totalMs, maxDepth: TRACE.maxDepth, maxValueChars: TRACE.maxValueChars,
  }
  try {
    const reply = await req.run(runnerArgv(req.name, req.path), { cwd: req.cwd, stdin: JSON.stringify(payload), timeoutMs: r.timeoutMs })
    return parseResults(reply, req.inputs.length, r.outputMaxChars)
  } catch {
    return undefined
  }
}
