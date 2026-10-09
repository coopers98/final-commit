import { ALLOWED_GLOBALS } from './harness'
import { BLANK } from './code-filter'
import { functionName, type Unit } from './units'

// SPEC 8.3 rule 4 (D15): which units Trace may run. Static and fail-closed:
// a unit is runnable only when this module can show it is one self-contained
// function, and every doubt refuses it. Pure. The runner's context holds only
// the allowlisted globals as well (harness.ts); this gate is the first wall,
// that is the second.

export type ParamType = 'number' | 'string' | 'boolean' | 'number[]' | 'string[]'

/** A unit Trace may run: the code to run (the shown code, less a leading `export`), its name and its parameters' types. */
export type Runnable = { code: string; name: string; params: ParamType[] }

/** Words the code may not hold anywhere, as a name or a property (SPEC 8.3 rule 4). */
const DENIED = new Set([
  'require', 'import', 'export', 'process', 'globalThis', 'global', 'window', 'self', 'this', 'eval', 'Function',
  'constructor', 'prototype', '__proto__', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
  'Reflect', 'Proxy', 'WebAssembly', 'Atomics', 'SharedArrayBuffer', 'fetch', 'XMLHttpRequest',
  'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'Date', 'async', 'await', 'yield', 'delete', 'with',
  'debugger', 'arguments', 'random', 'fromCharCode', 'fromCodePoint', 'enum', 'namespace', 'declare', 'module', 'class', 'super',
  // Host objects by name: none is in the runner's context, and a reach for one is never self-contained.
  'console', 'Buffer', 'exports', 'document', 'navigator', 'Deno', 'Bun', 'Symbol', 'Promise', 'WeakRef', 'FinalizationRegistry',
])

/** What `new` may build. */
const NEW_OK = new Set(['Map', 'Set', 'Array'])

/** Words that may stand before `(` without being a call of a free name. */
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'void', 'in', 'of', 'do', 'else', 'case',
  'throw', 'new', 'instanceof', 'try', 'finally', 'const', 'let', 'var', 'break', 'continue', 'default', 'as', 'satisfies',
  'true', 'false', 'null', 'keyof', 'is',
])

/** The privacy filter's replacement tokens: a unit holding one is not the code that was written. */
const REDACTION = /\[(?:url|email|ip|host|key|ssn|date|phone|id|age|name|number)\]/

type Token = { kind: 'name' | 'number' | 'punct'; text: string }

/**
 * Tokens of code with no literal or comment, or undefined when it holds
 * one: a quote, backtick, backslash, `//` or `/*`, or a character outside
 * printable ASCII (`…` among them, so a blanked line never tokenizes).
 */
export function tokenize(code: string): Token[] | undefined {
  const out: Token[] = []
  let i = 0
  while (i < code.length) {
    const c = code[i]!
    if (c === ' ' || c === '\t' || c === '\n') {
      i += 1
      continue
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(code.slice(i))!
      out.push({ kind: 'name', text: m[0] })
      i += m[0].length
      continue
    }
    if (/\d/.test(c) || (c === '.' && /\d/.test(code[i + 1] ?? ''))) {
      const m = /^(?:0[xXoObB][\da-fA-F_]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][+-]?\d+)?)n?/.exec(code.slice(i))
      if (!m) return undefined
      out.push({ kind: 'number', text: m[0] })
      i += m[0].length
      continue
    }
    // A string, template, comment or escape; a private name or decorator; anything unusual.
    if (c === '"' || c === "'" || c === '`' || c === '\\' || c === '#' || c === '@') return undefined
    if (code.startsWith('//', i) || code.startsWith('/*', i)) return undefined
    if (!/[\x21-\x7e]/.test(c)) return undefined
    out.push({ kind: 'punct', text: c })
    i += 1
  }
  return out
}

/** Text between the `(` at `open` and its matching `)`, or undefined. */
function inParens(line: string, open: number): { inner: string; close: number } | undefined {
  let depth = 0
  for (let i = open; i < line.length; i += 1) {
    if (line[i] === '(') depth += 1
    else if (line[i] === ')') {
      depth -= 1
      if (depth === 0) return { inner: line.slice(open + 1, i), close: i }
    }
  }
  return undefined
}

/** `list` split at commas outside brackets. */
function splitTop(list: string): string[] {
  const out: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i]!
    if ('([{<'.includes(c)) depth += 1
    else if (')]}>'.includes(c) && !(c === '>' && list[i - 1] === '=')) depth -= 1
    else if (c === ',' && depth === 0) {
      out.push(list.slice(from, i))
      from = i + 1
    }
  }
  out.push(list.slice(from))
  return out.map(p => p.trim()).filter((p, i, all) => p !== '' || i < all.length - 1)
}

const TYPES: Record<string, ParamType> = {
  number: 'number', string: 'string', boolean: 'boolean',
  'number[]': 'number[]', 'string[]': 'string[]', 'Array<number>': 'number[]', 'Array<string>': 'string[]',
  'readonlynumber[]': 'number[]', 'readonlystring[]': 'string[]', 'ReadonlyArray<number>': 'number[]', 'ReadonlyArray<string>': 'string[]',
}

/** One parameter's type: annotated as one Trace can make, or untyped (small integers); undefined for anything else. */
function paramType(param: string): ParamType | undefined {
  // The default goes: the parameter is its type, and an input is always given.
  const eq = param.search(/=(?!>)/)
  const head = (eq >= 0 ? param.slice(0, eq) : param).trim()
  const m = /^([A-Za-z_$][\w$]*)\s*\??\s*(?::\s*(.+))?$/.exec(head)
  if (!m) return undefined
  if (m[2] === undefined) return 'number'
  const type = m[2].replace(/\s+/g, '').replace(/\|undefined$/, '').replace(/^undefined\|/, '')
  return TYPES[type]
}

/** `name` for a regular expression. */
const literal = (name: string) => name.replace(/\$/g, '\\$')

/**
 * The parameters on a unit's first line (`function name(` or `const name =`):
 * their types, or undefined when any is not one Trace can make (rest,
 * destructured, objects, generics, functions, unions beyond `| undefined`)
 * or the list is not on that line.
 */
export function parseParams(first: string, name: string): ParamType[] | undefined {
  const head = new RegExp(`^(?:function|const)\\s+${literal(name)}(?![\\w$])`).exec(first)
  if (!head) return undefined
  const end = head[0].length
  // A bare arrow parameter: `const f = x => {`.
  if (/^\s*=\s*[A-Za-z_$][\w$]*\s*=>/.test(first.slice(end))) return ['number']
  const open = first.indexOf('(', end)
  const list = open < 0 ? undefined : inParens(first, open)
  if (!list) return undefined
  const out: ParamType[] = []
  for (const p of splitTop(list.inner)) {
    if (p.startsWith('...') || p.startsWith('{') || p.startsWith('[')) return undefined
    const t = paramType(p)
    if (!t) return undefined
    out.push(t)
  }
  return out
}

/** Names a unit declares (`const`, `let`, `var`, `function`, parameters): calls of these are not of free names. */
function declared(tokens: readonly Token[]): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    if (tokens[i]!.kind === 'name' && ['const', 'let', 'var', 'function'].includes(tokens[i]!.text) && tokens[i + 1]!.kind === 'name') out.add(tokens[i + 1]!.text)
  }
  return out
}

/**
 * SPEC 8.3 rule 4: the unit as Trace may run it, or undefined. Eligible only
 * when it is one function declared on its first line (a `function`
 * declaration or a `const` arrow, not a method), with no `…` on any line
 * (the code filter blanks every line it cannot show as plain code, so a
 * unit with one is not the code that was written, and a blanked string
 * could hide any property name), no redaction token, no literal or comment,
 * no denied word, `new` only for Map, Set and Array, and every free name it
 * calls either itself, a name it declares or an allowlisted global.
 */
export function runnable(unit: Unit): Runnable | undefined {
  const lines = unit.lines
  if (lines.length < 2 || lines.some(l => l.includes(BLANK) || REDACTION.test(l))) return undefined
  const first = lines[0]!.replace(/^export\s+(?:default\s+)?/, '')
  if (/^\s*export\b/.test(first) || functionName(first) !== unit.name) return undefined
  // No generics, no `async`, no annotation on the const: the parameters are the list right after.
  const isDecl = new RegExp(`^function\\s+${literal(unit.name)}\\s*\\(`).test(first)
  const isArrow = new RegExp(`^const\\s+${literal(unit.name)}\\s*=\\s*(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*(?::\\s*[^=]+?)?\\s*=>\\s*\\{\\s*$`).test(first)
  if (!isDecl && !isArrow) return undefined
  // The block closes the unit: nothing after the closing brace.
  if (!/^\}\s*;?$/.test(lines[lines.length - 1]!.trim())) return undefined
  const code = [first, ...lines.slice(1)].join('\n')
  const tokens = tokenize(code)
  if (!tokens) return undefined
  const params = parseParams(first, unit.name)
  if (!params) return undefined
  if (!isSelfContained(tokens, unit.name)) return undefined
  return { code, name: unit.name, params }
}

/** The token checks of `runnable`, over the whole unit. */
export function isSelfContained(tokens: readonly Token[], self: string): boolean {
  const allowed = new Set([...ALLOWED_GLOBALS, self, ...declared(tokens)])
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!
    const prev = tokens[i - 1]
    const next = tokens[i + 1]
    const isMember = prev?.text === '.'
    if (t.kind === 'name') {
      if (DENIED.has(t.text)) return false
      if (t.text === 'new' && !(next?.kind === 'name' && NEW_OK.has(next.text))) return false
      // Math only as `Math.x`: an alias could reach a member the gate cannot see.
      if (t.text === 'Math' && next?.text !== '.') return false
      // A call of a free name (`name(` or `name?.(`), not a member's, a keyword's or a declaration's.
      const isCall = next?.text === '(' || (next?.text === '?' && tokens[i + 2]?.text === '.' && tokens[i + 3]?.text === '(')
      if (isCall && !isMember && !KEYWORDS.has(t.text) && prev?.text !== 'function' && !allowed.has(t.text)) return false
    }
  }
  return true
}
