import { expect, test } from 'claude-code/testing'
import { PUZZLE, TRACE } from '../src/config'
import { createRng } from '../src/rng'
import { analyzeView } from '../src/puzzle/analyze'
import { buildPuzzle, puzzleTypeFor } from '../src/puzzle/puzzle'
import { parseResults, runCalls, runnerArgv, runnerPath, type CallResult, type Run } from '../src/puzzle/runners'
import { buildTrace, candidateInputs, distractors, inputOf, questionOf, render, type Exec } from '../src/puzzle/trace'
import { parseParams, runnable } from '../src/puzzle/trace-gate'
import { filterCode } from '../src/puzzle/code-filter'
import type { Unit } from '../src/puzzle/units'

// SPEC 8, Trace: the gate, inputs, choices, the runner's reply, and the build.
// Invented code only (SPEC 15). The real harness runs under node in
// scripts/harness-check.mjs (npm test runs both).

const unit = (lines: string[], name = 'countAbove'): Unit => ({ lang: 'TypeScript', name, lines })
const fn = (...body: string[]) => unit(['function countAbove(xs: number[], limit: number): number {', ...body, '}'])

const COUNT = fn('  let n = 0', '  for (const x of xs) {', '    if (x > limit) n = n + 1', '  }', '  return n')

/** Escape attempts and other refusals: one body line each, inside an otherwise good function. */
const REFUSED: Record<string, string> = {
  'constructor chain': '  return xs.constructor.constructor',
  'this': '  return this',
  'globalThis': '  return globalThis',
  'global': '  return global',
  'process.exit': '  process.exit(1)',
  'new Function': '  return new Function',
  'import(': '  return import(limit)',
  'require': '  return require(limit)',
  'eval': '  return eval(limit)',
  '__proto__': '  return xs.__proto__',
  'prototype': '  return Array.prototype',
  'Reflect': '  return Reflect.ownKeys(xs)',
  'Proxy': '  return new Proxy(xs, xs)',
  'Date': '  return Date.now()',
  'Math.random': '  return Math.random()',
  'Math aliased': '  const m = Math; return m',
  'setTimeout': '  setTimeout(xs, 1)',
  'async': '  const f = async () => 1',
  'await': '  await xs',
  'yield': '  yield xs',
  'new of anything else': '  return new Uint8Array(limit)',
  'delete': '  delete xs[0]',
  'with': '  with (xs) {}',
  'debugger': '  debugger',
  'arguments': '  return arguments',
  'fetch': '  return fetch(xs)',
  'a free call': '  return helperOutside(xs)',
  'an optional free call': '  return helperOutside?.(xs)',
  'a blanked string access': '  return xs["…"]',
  'a blanked line': '  …',
  'a line partly blanked': '  }…{',
  'a string': '  return xs.join(",")',
  'a template': '  return `${limit}`',
  'a comment': '  return limit // done',
  'a unicode escape': '  return \\u0070rocess',
  'non-ASCII': '  return limité',
  'a redaction token': '  return [number]',
  'a private name': '  return xs.#n',
  'a decorator': '  @log',
  'String.fromCharCode': '  return String.fromCharCode(99)',
  'class': '  class A {}',
  'export inside': '  export const y = 1',
}

test('the gate refuses every escape attempt and anything it cannot show self-contained', async () => {
  expect(runnable(COUNT)).toBeDefined()
  for (const [why, line] of Object.entries(REFUSED)) {
    const r = runnable(fn('  let n = 0', line, '  return n'))
    if (r !== undefined) throw new Error(`gate let through: ${why}`)
  }
})

test('the gate takes one function declared on the first line: a function or a const arrow, a leading export stripped', async () => {
  const exported = runnable(unit(['export function countAbove(xs: number[], limit: number): number {', '  return xs.length + limit', '}']))!
  expect(exported.code.startsWith('function countAbove(')).toBe(true)
  expect(runnable(unit(['export default function countAbove(n: number) {', '  return n', '}']))!.code.startsWith('function')).toBe(true)
  expect(runnable(unit(['const countAbove = (n: number): number => {', '  return n * 2', '};']))!.params).toEqual(['number'])
  expect(runnable(unit(['export const countAbove = n => {', '  return n * 2', '}']))!.params).toEqual(['number'])
  // Recursion, its own local helpers, the allowlisted globals and `new Map`, `new Set`, `new Array`.
  const ok = runnable(fn(
    '  const seen = new Set()',
    '  function bump(v: number) { return v + 1 }',
    '  const m = new Map()',
    '  if (xs.length === 0) return Math.max(0, parseInt(String(limit), 10))',
    '  return countAbove(xs.slice(1), limit) + bump(Number(JSON.stringify(seen.size)))',
  ))
  expect(ok).toBeDefined()
  // Not a method, not async, not a generator, not generic, nothing after the closing brace.
  expect(runnable(unit(['countAbove(n: number) {', '  return n', '}']))).toBe(undefined)
  expect(runnable(unit(['async function countAbove(n: number) {', '  return n', '}']))).toBe(undefined)
  expect(runnable(unit(['function* countAbove(n: number) {', '  return n', '}']))).toBe(undefined)
  expect(runnable(unit(['function countAbove<T>(n: T) {', '  return n', '}']))).toBe(undefined)
  expect(runnable(unit(['function countAbove(n: number) {', '  return n', '} countAbove(1)']))).toBe(undefined)
  // The name must be the unit's.
  expect(runnable(unit(['function other(n: number) {', '  return n', '}']))).toBe(undefined)
})

test('the gate refuses what the code filter blanked: a line with a literal never reaches Trace', async () => {
  const src = ['function countAbove(xs: number[], limit: number): number {', '  const tag = "nova"', '  return xs.length', '}'].join('\n')
  const lines = filterCode(src, 'strict').split('\n')
  expect(lines.some(l => l.includes('…'))).toBe(true)
  expect(runnable(unit(lines))).toBe(undefined)
})

test('parameters: the supported annotations, optional and default ones as their type, untyped as numbers; anything else refuses', async () => {
  const p = (list: string) => parseParams(`function f(${list}) {`, 'f')
  expect(p('a: number, b: string, c: boolean')).toEqual(['number', 'string', 'boolean'])
  expect(p('a: number[], b: string[], c: Array<number>, d: Array<string>')).toEqual(['number[]', 'string[]', 'number[]', 'string[]'])
  expect(p('a: readonly number[], b?: string, c: number = 3, d: boolean | undefined')).toEqual(['number[]', 'string', 'number', 'boolean'])
  expect(p('a, b = 2')).toEqual(['number', 'number'])
  expect(p('')).toEqual([])
  for (const bad of ['a: object', 'a: Item', 'a: Map<string, number>', 'a: () => void', 'a: number | string', '...rest: number[]', '{ a }: Opts', '[a]: number[]', 'a: T']) {
    expect(p(bad)).toBe(undefined)
  }
  // A name inside a keyword is not the name.
  expect(parseParams('function unc(a: number) {', 'unc')).toEqual(['number'])
  expect(parseParams('const f = x => {', 'f')).toEqual(['number'])
})

test('inputs come from the seeded Rng within the configured ranges, distinct, and the same for the same seed', async () => {
  const rng = createRng(7)
  for (let k = 0; k < 200; k += 1) {
    const n = inputOf('number', rng) as number
    expect(Number.isInteger(n) && n >= TRACE.intMin && n <= TRACE.intMax).toBe(true)
    expect(TRACE.words.includes(inputOf('string', rng) as string)).toBe(true)
    expect(typeof inputOf('boolean', rng)).toBe('boolean')
    const xs = inputOf('number[]', rng) as number[]
    expect(xs.length <= TRACE.maxArrayLength).toBe(true)
    expect((inputOf('string[]', rng) as string[]).every(w => TRACE.words.includes(w))).toBe(true)
  }
  const a = candidateInputs(['number[]', 'number'], createRng(3))
  expect(a.length).toBe(TRACE.candidates)
  expect(new Set(a.map(x => JSON.stringify(x))).size).toBe(a.length)
  expect(candidateInputs(['number[]', 'number'], createRng(3))).toEqual(a)
  // A small domain gives what it has.
  expect(candidateInputs(['boolean'], createRng(1)).length).toBe(2)
})

test('distractors are three, distinct from each other and never equal to the answer, as compact JSON', async () => {
  const answers: unknown[] = [3, 0, -2, true, false, 'nova', '', [1, 2, 3], [], ['ion'], { a: 1 }, null, [[1], [2]]]
  for (let seed = 0; seed < 30; seed += 1) {
    for (const answer of answers) {
      const d = distractors(answer, [answer, 4, 'flux'], createRng(seed))!
      expect(d.length).toBe(PUZZLE.choices - 1)
      expect(new Set(d).size).toBe(3)
      expect(d.includes(JSON.stringify(answer))).toBe(false)
      expect(d.every(s => s.length <= TRACE.maxAnswerChars)).toBe(true)
    }
  }
  // Other inputs' results come first.
  expect(distractors(5, [7, 9], createRng(1))!.slice(0, 2)).toEqual(['7', '9'])
  // A value too wide, or with a control character, is never shown.
  expect(render('x'.repeat(TRACE.maxAnswerChars))).toBe(undefined)
  expect(render('a‮b')).toBe(undefined)
  expect(distractors('x'.repeat(TRACE.maxAnswerChars), [], createRng(1))).toBe(undefined)
})

test('the runner reply parser takes only a clean, whole reply of the right shape and count', async () => {
  const reply = (stdout: string, exitCode = 0, isStdoutTruncated = false) => ({ exitCode, stdout, isStdoutTruncated })
  const good = '{"results":[{"ok":true,"value":[1,2]},{"ok":false}]}\n'
  expect(parseResults(reply(good), 2, 1000)).toEqual([{ ok: true, value: [1, 2] }, { ok: false }])
  expect(parseResults(reply(good, 1), 2, 1000)).toBe(undefined)
  expect(parseResults(reply(good, 0, true), 2, 1000)).toBe(undefined)
  expect(parseResults(reply(good), 2, 10)).toBe(undefined)
  expect(parseResults(reply(good), 3, 1000)).toBe(undefined)
  expect(parseResults(reply('{"results":[{"ok":true,"value":1}'), 1, 1000)).toBe(undefined)
  expect(parseResults(reply('not json'), 1, 1000)).toBe(undefined)
  expect(parseResults(reply('null'), 1, 1000)).toBe(undefined)
  expect(parseResults(reply('{"results":[{"ok":true}]}'), 1, 1000)).toBe(undefined)
  expect(parseResults(reply('{"results":[{"ok":false,"value":1}]}'), 1, 1000)).toBe(undefined)
  expect(parseResults(reply('{"results":[{"ok":"yes","value":1}]}'), 1, 1000)).toBe(undefined)
  expect(parseResults(reply('{"results":[[true]]}'), 1, 1000)).toBe(undefined)
})

test('the runner runs node by its path in the folder it is given, with an empty environment and the payload on stdin; a rejected or failed run is none', async () => {
  const calls: { argv: readonly string[]; init: Parameters<Run>[1] }[] = []
  const run: Run = async (argv, init) => {
    calls.push({ argv, init })
    return { exitCode: 0, stdout: '{"results":[{"ok":true,"value":2}]}', isStdoutTruncated: false }
  }
  const out = await runCalls({ name: 'node', path: '/usr/bin/node', run, cwd: '/tmp', code: 'function f(n) {\n  return n\n}', fn: 'f', inputs: [[2]] })
  expect(out).toEqual([{ ok: true, value: 2 }])
  expect(calls[0]!.init.cwd).toBe('/tmp')
  expect(calls[0]!.argv).toEqual(runnerArgv('node', '/usr/bin/node'))
  // `env -i` first: none of the session's environment reaches node.
  expect(calls[0]!.argv.slice(0, 2)).toEqual(['env', '-i'])
  expect(calls[0]!.argv).toContain('/usr/bin/node')
  expect(runnerArgv('node', '/usr/bin/node')).toContain('--permission')
  const payload = JSON.parse(calls[0]!.init.stdin!)
  expect(payload.inputs).toEqual([[2]])
  expect(payload.callTimeoutMs).toBe(TRACE.callTimeoutMs)
  const rejects: Run = async () => {
    throw new Error('timed out')
  }
  expect(await runCalls({ name: 'node', path: '/usr/bin/node', run: rejects, cwd: '/tmp', code: '', fn: 'f', inputs: [[1]] })).toBe(undefined)
  expect(await runnerPath('node', rejects, '/tmp')).toBe(undefined)
  expect(await runnerPath('node', async () => ({ exitCode: 127, stdout: '', isStdoutTruncated: false }), '/tmp')).toBe(undefined)
  expect(await runnerPath('node', async () => ({ exitCode: 0, stdout: 'node; rm -rf x\n', isStdoutTruncated: false }), '/tmp')).toBe(undefined)
  expect(await runnerPath('node', async () => ({ exitCode: 0, stdout: '/usr/local/bin/node\n', isStdoutTruncated: false }), '/tmp')).toBe('/usr/local/bin/node')
})

test('the gate refuses regex literals, word-spelling members and computed access beyond a name or number', async () => {
  const unit = (body: string[]): Unit => ({ lang: 'TypeScript', name: 'f', lines: ['function f(n: number) {', ...body, '}'] })
  expect(runnable(unit(['  return n + 1']))).toBeDefined()
  expect(runnable(unit(['  const xs = [n, n]', '  return xs[n - 1]']))).toBeDefined()
  for (const body of [
    ['  const r = /constr/', '  return n'],
    ['  const k = (typeof n)', '  return n'],
    ['  const xs = [n]', '  return xs[n * 2]'],
    ['  const o = [n]', '  return o[o[0]]'],
    ['  return n.toString'],
    ['  leaked = n', '  return n'],
    ['  total += n', '  return n'],
    ['  Error.prepareStackTrace = n', '  return n'],
    ['  const e = n', '  return e.stack'],
  ]) expect(runnable(unit(body))).toBe(undefined)
  // Assigning its own names is fine.
  expect(runnable(unit(['  let t = 0', '  t += n', '  n = n + 1', '  return t + n']))).toBeDefined()
})

/** A stand-in runner: computes countAbove itself, as the harness would reply. */
function fakeExec(answer: (args: unknown[]) => CallResult = args => ({ ok: true, value: (args[0] as number[]).filter(x => x > (args[1] as number)).length })): Exec & { inputs: unknown[][][] } {
  const inputs: unknown[][][] = []
  const f = (async (_unit, ins) => {
    inputs.push(ins)
    return ins.map(answer)
  }) as Exec & { inputs: unknown[][][] }
  f.inputs = inputs
  return f
}

test('a Trace asks what the function returns for a generated input; the answer is the runner\'s output, the other choices are not', async () => {
  for (let seed = 0; seed < 20; seed += 1) {
    const exec = fakeExec()
    const p = (await buildTrace([COUNT], createRng(seed), exec))!
    expect(p.type).toBe('trace')
    expect(p.category).toBe('trace')
    expect(p.code).toEqual(COUNT.lines)
    expect(p.choices.length).toBe(4)
    expect(new Set(p.choices).size).toBe(4)
    // One runner call, every candidate twice.
    expect(exec.inputs.length).toBe(1)
    const sent = exec.inputs[0]!
    const half = sent.length / 2
    expect(sent.slice(0, half)).toEqual(sent.slice(half))
    const args = sent.slice(0, half).find(a => p.question === questionOf('countAbove', a))!
    const real = (args[0] as number[]).filter(x => x > (args[1] as number)).length
    expect(p.choices[p.answer]).toBe(String(real))
    expect(p.explanation).toBe(`Running it gives ${real}.`)
    expect(p.question.length <= PUZZLE.maxQuestionChars).toBe(true)
  }
})

test('no Trace from a run that fails, a result that is not ok, or one that differs between its two runs', async () => {
  expect(await buildTrace([COUNT], createRng(1), async () => undefined)).toBe(undefined)
  expect(await buildTrace([COUNT], createRng(1), fakeExec(() => ({ ok: false })))).toBe(undefined)
  let k = 0
  expect(await buildTrace([COUNT], createRng(1), fakeExec(() => ({ ok: true, value: (k += 1) })))).toBe(undefined)
  // A unit the gate refuses is never run.
  const exec = fakeExec()
  expect(await buildTrace([fn('  return this')], createRng(1), exec)).toBe(undefined)
  expect(exec.inputs).toEqual([])
})

test('Rare asks for Trace when it is built; without a runner it falls back as before', async () => {
  expect(puzzleTypeFor('rare', ['pattern-id', 'trace', 'bug-hunt'])).toBe('trace')
  expect(puzzleTypeFor('rare', ['pattern-id', 'bug-hunt'])).toBe('pattern-id')
  expect(puzzleTypeFor('exotic', ['pattern-id', 'trace', 'bug-hunt'])).toBe('bug-hunt')
  const trace = (units: readonly Unit[], rng: ReturnType<typeof createRng>) => buildTrace(units, rng, fakeExec())
  expect((await buildPuzzle({ units: [COUNT], tier: 'rare', rng: createRng(1), trace }))!.type).toBe('trace')
  // A Trace that cannot be made gives way to Bug Hunt.
  const none = async () => undefined
  expect((await buildPuzzle({ units: [COUNT], tier: 'rare', rng: createRng(1), trace: none }))!.type).toBe('bug-hunt')
  expect((await buildPuzzle({ units: [COUNT], tier: 'rare', rng: createRng(1) }))!.type).toBe('bug-hunt')
  const p = (await buildPuzzle({ units: [COUNT], tier: 'rare', rng: createRng(1), trace }))!
  expect(analyzeView(p, 'x', 'rare').label).toBe('Analyze Specimen · Trace · TypeScript')
})
