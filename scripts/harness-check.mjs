// SPEC 8.3 rule 4: Trace's harness, run for real with node (npm test runs
// this after the plugin's own tests, which cannot start a process). The
// runner module is loaded as the plugin has it; its `run` is node's own
// child_process here, standing in for `$.process.run`. Invented code only.
import { spawn } from 'node:child_process'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { test } from 'node:test'

// The plugin imports without extensions; node needs `.ts`.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (err) {
      if (specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context)
      throw err
    }
  },
})

const { runCalls, runnerArgv, runnerPath } = await import('../src/puzzle/runners.ts')
const { runnable } = await import('../src/puzzle/trace-gate.ts')
const { TRACE } = await import('../src/config.ts')

/** `$.process.run` over child_process: argv, cwd, stdin, a timeout that rejects, NODE_OPTIONS as given. */
function run(argv, init) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: init.cwd, env: { ...process.env, ...init.env } })
    let stdout = ''
    child.stdout.setEncoding('utf8').on('data', c => (stdout += c))
    child.stderr.resume()
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('timed out'))
    }, init.timeoutMs)
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ exitCode: code ?? 1, stdout, isStdoutTruncated: false })
    })
    child.stdin.end(init.stdin ?? '')
  })
}

const cwd = tmpdir()
const path = await runnerPath('node', run, cwd)
const calls = (code, fn, inputs) => runCalls({ name: 'node', path, run, cwd, code, fn, inputs })

test('node is available and the runner sandboxes it', async () => {
  assert.ok(path && path.startsWith('/'))
  const argv = runnerArgv('node', path)
  assert.ok(argv.includes('--permission'))
  assert.deepEqual(argv.slice(0, 2), ['env', '-i'])
  // What `env -i` leaves the runner: nothing of this process's environment.
  const probe = await run([...argv.slice(0, argv.indexOf(path) + 1), '-p', 'JSON.stringify(process.env)'], { cwd, timeoutMs: 5_000 })
  assert.deepEqual(JSON.parse(probe.stdout), { HOME: '/nonexistent' })
})

test('a small function runs on each input; TypeScript types are stripped', async () => {
  const unit = { lang: 'TypeScript', name: 'countAbove', lines: [
    'export function countAbove(xs: number[], limit: number): number {',
    '  let n = 0',
    '  for (const x of xs) {',
    '    if (x > limit) n = n + 1',
    '  }',
    '  return n',
    '}',
  ] }
  const r = runnable(unit)
  assert.ok(r)
  assert.deepEqual(await calls(r.code, r.name, [[[1, 5, 9], 4], [[], 0], [[3, 3], 2]]), [
    { ok: true, value: 2 }, { ok: true, value: 0 }, { ok: true, value: 2 },
  ])
  assert.deepEqual(await calls('const twice = (xs: string[]) => {\n  return xs.map(w => w + w)\n}', 'twice', [[['ion', 'flux']]]), [
    { ok: true, value: ['ionion', 'fluxflux'] },
  ])
})

test('an infinite loop times out cleanly: not ok, and the calls after it are not made', async () => {
  const started = Date.now()
  const out = await calls('function spin(n: number) {\n  while (true) { n = n + 1 }\n}', 'spin', [[1], [2], [3]])
  assert.deepEqual(out, [{ ok: false }, { ok: false }, { ok: false }])
  // One call's timeout, not three.
  assert.ok(Date.now() - started < TRACE.callTimeoutMs * 2)
})

test('values that do not survive JSON are not ok; neither is a throw or deep recursion', async () => {
  const one = async body => (await calls(`function f(n: number) {\n  ${body}\n}`, 'f', [[1]]))[0]
  assert.deepEqual(await one('return NaN'), { ok: false })
  assert.deepEqual(await one('return undefined'), { ok: false })
  assert.deepEqual(await one('return () => n'), { ok: false })
  assert.deepEqual(await one('return new Map()'), { ok: false })
  assert.deepEqual(await one('return { get x() { return n } }'), { ok: false })
  assert.deepEqual(await one('const a = []; a[3] = n; return a'), { ok: false })
  assert.deepEqual(await one('const o = {}; o.self = o; return o'), { ok: false })
  assert.deepEqual(await one('throw n'), { ok: false })
  assert.deepEqual(await one('return f(n + 1)'), { ok: false })
  assert.deepEqual(await one('return "x".repeat(100000)'), { ok: false })
  assert.deepEqual(await one('return { a: [n, true, null, "s"] }'), { ok: true, value: { a: [1, true, null, 's'] } })
})

test('a code that escapes the gate still finds no process, global or host in the context', async () => {
  // Each of these is refused by the gate first; here they go straight to the harness.
  const escapes = [
    'return process.pid',
    'return this.constructor.constructor("return process")()',
    'return n.constructor.constructor("return process")()',
    'return globalThis.process.pid',
    'return require("node:fs")',
    'return eval("1")',
    'return Math.random()',
    'return Date.now()',
    'return console.log(n)',
    'return import("node:fs")',
    'import("x").then(null, e => n)\n  return n',
  ]
  for (const body of escapes) {
    const code = `function f(n: number) {\n  ${body}\n}`
    assert.equal(runnable({ lang: 'TypeScript', name: 'f', lines: code.split('\n') }), undefined, body)
    const out = await calls(code, 'f', [[1]])
    assert.ok(out === undefined || out[0].ok === false, body)
  }
  assert.deepEqual(await calls('function f(n: number) {\n  return typeof process + typeof globalThis + typeof Date\n}', 'f', [[1]]), [
    { ok: true, value: 'undefinedundefinedundefined' },
  ])
  // The built-ins are frozen: a change does not hold.
  assert.deepEqual(await calls('function f(n: number) {\n  Math.max = () => n\n  return Math.max(5, 6)\n}', 'f', [[1]]), [{ ok: true, value: 6 }])
})

test('the harness refuses any module loading itself, behind the gate', async () => {
  // Security review: an import() once rejected with an error of the host process.
  assert.equal(await calls('function f(n: number) {\n  const p = import("x")\n  return n\n}', 'f', [[1]]), undefined)
  assert.equal(await calls('function f(n: number) {\n  return require\n}', 'f', [[1]]), undefined)
})

test('code that is not erasable TypeScript, or does not define the function, fails the run', async () => {
  assert.equal(await calls('enum E { A }\nfunction f() { return 1 }', 'f', [[]]), undefined)
  assert.equal(await calls('function f( {', 'f', [[]]), undefined)
  assert.deepEqual(await calls('function g() { return 1 }', 'f', [[]]), [{ ok: false }])
})
