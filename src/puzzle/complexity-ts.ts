// SPEC 8.4, Complexity Read: the TypeScript reader (spec
// docs/superpowers/specs/2026-10-13-complexity-read-design.md, "The reader").
// Pure. Each shown line is read into a closed set of statement and expression
// shapes and costed; any shape it does not know, and any cost it cannot
// place, refuses the unit (undefined). A skipped unit is fine; a wrong key is
// not, so every doubt refuses.

import { COMPLEXITY } from '../config'
import { add, factor, hiddenScan, isExitName, isInert, isLiteralInRange, mul, ONE, treeByBraces, type Block, type Cost, type HiddenPlace, type HiddenScan } from './complexity'
import { isBlankedLine } from './readable'
import type { Unit } from './units'

// ---------------------------------------------------------------------------
// Refusal

/** Thrown to refuse the unit and caught in `readTypeScript`. Carries no text. */
class Refusal {}
const REFUSAL = new Refusal()
function refuse(): never {
  throw REFUSAL
}
function need(ok: boolean): void {
  if (!ok) refuse()
}

// ---------------------------------------------------------------------------
// Word lists (config) and syntax sets

const LISTS = COMPLEXITY.builtins.TypeScript!
const setOf = (...lists: Iterable<string>[]): ReadonlySet<string> => new Set(lists.flatMap((l) => [...l]))
const GLOBALS = setOf(LISTS.globals)
const FAILS = setOf(LISTS.fails)
const ITERATORS = setOf(LISTS.iterators)
const SORTS = setOf(LISTS.sort)
const LINEAR = setOf(LISTS.linear.filter((w) => !w.includes('.') && !GLOBALS.has(w)))
const MUTATE = setOf(LISTS.mutate)
/** Names that cost more than 1 or fail on a receiver the reader does not know (spec "Typed receivers"). */
const COUNTED = setOf(LISTS.sort, LINEAR, LISTS.fails, ['reverse', 'fill', 'copyWithin', 'shift', 'unshift', 'clear'])
/** Every listed method name: none may be read as a property value (a method reference). */
const METHODS = setOf(COUNTED, LISTS.mutate, LISTS.constant.filter((w) => !GLOBALS.has(w)))
/** Callbacks that stop early: their predicate must be able to run to the end. */
const SHORT = new Set(['find', 'findIndex', 'some', 'every'])
/** Callbacks whose body is a test: a test that cannot be read refuses the unit (task 6 fix round 5). */
const PREDICATES = new Set([...SHORT, 'filter'])
const STRING_METHODS = new Set(['at', 'charAt', 'charCodeAt', 'codePointAt'])
const ACC_METHODS = new Set(['push', 'add', 'set', 'has', 'get', 'delete', 'pop', 'at'])
/** A collection local the reader cannot size: lookups and appends only. */
const COLL_METHODS = new Set(['has', 'get', 'at', 'charAt', 'charCodeAt', 'codePointAt', 'push', 'add', 'set', 'delete', 'pop'])
/** Reads by position: on a size source, at a loop's index only (fix round 1). */
const POSITIONAL = new Set(['at', 'charAt', 'charCodeAt', 'codePointAt'])
/** Methods of a string or number that cost 1 (fix round 3, ruling C). */
const SCALAR_METHODS = new Set(['charAt', 'charCodeAt', 'codePointAt', 'at', 'toFixed'])
/** Spec "What the reader reads", rule 3: every builtin and global name, and the reflective names. */
const WORDS: ReadonlySet<string> = setOf(...Object.values(LISTS), ['arguments', 'eval', 'Function', 'globalThis', 'Reflect', 'this'])

const COMPARE = new Set(['===', '!==', '==', '!=', '<', '<=', '>', '>='])
/** Methods whose first argument is a needle or a key (task 7 fix round 2, ruling D′). */
const NEEDLE_METHODS = new Set(['includes', 'indexOf', 'lastIndexOf', 'has', 'get', 'set', 'add', 'delete'])
const ORDER = new Set(['<', '<=', '>', '>='])
const EQUALITY = new Set(['===', '!==', '==', '!='])
const FLIP: Record<string, string> = { '===': '!==', '!==': '===', '==': '!=', '!=': '==', '<': '>=', '>=': '<', '>': '<=', '<=': '>' }
const ARITHMETIC = new Set(['+', '-', '*', '/', '%', '>>', '<<', '>>>'])
/** Operators whose result is always a number (`+` is not: it may join strings). */
const ARITHMETIC_ALL = new Set(['-', '*', '/', '%', '**', '<<', '>>', '>>>', '&', '|', '^'])
const TRANSFERS = new Set(['return', 'throw', 'break', 'continue'])
/** Small sizes a guard may test for (spec gate 10): `size op literal`. */
const TINY: Record<string, number[]> = { '===': [0, 1], '==': [0, 1], '<': [1, 2], '<=': [0, 1] }

// ---------------------------------------------------------------------------
// Tokens

type Tok = { t: 'id' | 'num' | 'str' | 're' | 'p'; v: string }

const PUNCTS = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>', '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%', '&', '|', '^', '!', '~', '?', ':', '=', '.']
const IDENT = /^[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*/u
const NUMBER = /^(?:0[xXbBoO][\da-fA-F_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)n?/
const BLOCK = '{BLOCK}'

/** One shown line as tokens; comments, `${` templates and any character outside the closed set refuse. */
function tokenize(line: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < line.length) {
    const c = line[i]!
    if (c === ' ' || c === '\t') {
      i++
      continue
    }
    const rest = line.slice(i)
    if (rest.startsWith('//') || rest.startsWith('/*')) refuse()
    if (c === "'" || c === '"' || c === '`') {
      let k = i + 1
      while (k < line.length && line[k] !== c) k += line[k] === '\\' ? 2 : 1
      if (k >= line.length || (c === '`' && line.slice(i, k).includes('${'))) refuse()
      out.push({ t: 'str', v: '' })
      i = k + 1
      continue
    }
    // The filter writes a regular expression as `/…/`.
    const re = /^\/…\/[a-z]*/.exec(rest)
    if (re) {
      out.push({ t: 're', v: '' })
      i += re[0].length
      continue
    }
    const num = /\d/.test(c) || (c === '.' && /\d/.test(line[i + 1] ?? '')) ? NUMBER.exec(rest) : null
    if (num) {
      // A bigint literal (`10n`) mixed with a number throws.
      if (IDENT.test(rest.slice(num[0].length)) || num[0].endsWith('n')) refuse()
      // Task 7 fix round 1, ruling A: no literal beyond the shared cap (`1e400` is Infinity, constant against any number).
      need(isLiteralInRange(num[0]))
      out.push({ t: 'num', v: num[0] })
      i += num[0].length
      continue
    }
    const id = IDENT.exec(rest)
    if (id) {
      out.push({ t: 'id', v: id[0] })
      i += id[0].length
      continue
    }
    const p = PUNCTS.find((q) => rest.startsWith(q))
    if (p === undefined) refuse()
    const v = p === '?.' && /\d/.test(rest[2] ?? '') ? '?' : p
    out.push({ t: 'p', v })
    i += v.length
  }
  return out
}

const isP = (t: Tok | undefined, v: string): boolean => t?.t === 'p' && t.v === v
const isWord = (t: Tok | undefined, v: string): boolean => t?.t === 'id' && t.v === v

// ---------------------------------------------------------------------------
// Expressions

type Node =
  | { k: 'id'; name: string }
  | { k: 'lit'; kind: 'num' | 'str' | 're' | 'other'; v?: number; nullish?: boolean }
  | { k: 'this' }
  | { k: 'member'; obj: Node; name: string }
  | { k: 'index'; obj: Node; index: Node }
  | { k: 'call'; callee: Node; args: Node[] }
  | { k: 'new'; callee: string; args: Node[] }
  | { k: 'unary'; op: string; arg: Node }
  | { k: 'update'; op: string; arg: Node }
  | { k: 'bin'; op: string; left: Node; right: Node }
  | { k: 'cond'; test: Node; yes: Node; no: Node }
  | { k: 'assign'; op: string; target: Node; value: Node }
  | { k: 'array'; items: Node[] }
  | { k: 'object'; items: Node[] }
  | { k: 'spread'; arg: Node }
  | { k: 'arrow'; params: string[]; body: Node | 'block' }

/** Words no shown expression may hold as a name: definitions, other statements, and syntax the reader does not model. */
const KEYWORDS = new Set(['yield', 'function', 'class', 'goto', 'do', 'switch', 'case', 'default', 'try', 'catch', 'finally', 'with', 'debugger', 'import', 'export', 'super', 'async', 'void', 'delete', 'var', 'let', 'const', 'if', 'else', 'for', 'while', 'return', 'break', 'continue', 'throw', 'in', 'instanceof', 'new', 'typeof', 'await', 'enum', 'interface', 'implements', 'package', 'private', 'protected', 'public', 'static'])
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??='])
/** Task 6 fix round 5: assignments that short-circuit on their target (a hidden guard) fail. */
const LOGICAL_ASSIGN = new Set(['&&=', '||=', '??='])
const PRECEDENCE: Record<string, number> = { '??': 1, '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6, '===': 6, '!==': 6, '<': 7, '>': 7, '<=': 7, '>=': 7, instanceof: 7, in: 7, '<<': 8, '>>': 8, '>>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10, '**': 11 }

/** String and number methods that always return a string or number (`at` and `codePointAt` may return undefined). */
const NON_NULL_METHODS = new Set(['charAt', 'charCodeAt', 'toFixed'])
const isTarget = (n: Node): boolean => n.k === 'id' || n.k === 'member' || n.k === 'index'
const numberOf = (v: string): number | undefined => (/^\d+$/.test(v) ? Number(v) : undefined)

/** A recursive-descent reader of one line's tokens. Anything outside its grammar refuses. */
class Parser {
  i = 0
  constructor(readonly toks: Tok[]) {}
  get done(): boolean {
    return this.i >= this.toks.length
  }
  peek(k = 0): Tok | undefined {
    return this.toks[this.i + k]
  }
  is(v: string, k = 0): boolean {
    return isP(this.peek(k), v)
  }
  isWord(v: string, k = 0): boolean {
    return isWord(this.peek(k), v)
  }
  take(v: string): void {
    need(this.is(v))
    this.i++
  }
  takeWord(v: string): void {
    need(this.isWord(v))
    this.i++
  }
  name(): string {
    const t = this.peek()
    if (t?.t !== 'id' || KEYWORDS.has(t.v)) refuse()
    this.i++
    return t.v
  }
  end(): void {
    need(this.done)
  }

  expr(): Node {
    if (this.atArrow()) return this.arrow()
    const left = this.conditional()
    const t = this.peek()
    if (t?.t === 'p' && ASSIGN_OPS.has(t.v)) {
      need(isTarget(left) && !LOGICAL_ASSIGN.has(t.v))
      this.i++
      return { k: 'assign', op: t.v, target: left, value: this.expr() }
    }
    return left
  }

  private atArrow(): boolean {
    if (this.peek()?.t === 'id') return this.is('=>', 1)
    if (!this.is('(')) return false
    let k = 1
    while (this.peek(k)?.t === 'id' || this.is(',', k)) k++
    return this.is(')', k) && this.is('=>', k + 1)
  }

  /** Plain parameter names only (no types, defaults or patterns); a block body is the line's trailing `{`. */
  private arrow(): Node {
    const params: string[] = []
    if (this.is('(')) {
      this.i++
      while (!this.is(')')) {
        params.push(this.name())
        if (!this.is(')')) this.take(',')
      }
      this.i++
    } else params.push(this.name())
    this.take('=>')
    if (this.is(BLOCK)) {
      this.i++
      return { k: 'arrow', params, body: 'block' }
    }
    need(!this.is('{'))
    return { k: 'arrow', params, body: this.expr() }
  }

  private conditional(): Node {
    const test = this.binary(1)
    if (!this.is('?')) return test
    this.i++
    const yes = this.expr()
    this.take(':')
    return { k: 'cond', test, yes, no: this.expr() }
  }

  private binary(min: number): Node {
    let left = this.unary()
    for (;;) {
      const t = this.peek()
      const op = t && (t.t === 'p' || t.v === 'in' || t.v === 'instanceof') && Object.hasOwn(PRECEDENCE, t.v) ? t.v : undefined
      if (op === undefined || PRECEDENCE[op]! < min) return left
      this.i++
      const right = this.binary(op === '**' ? PRECEDENCE[op]! : PRECEDENCE[op]! + 1)
      left = { k: 'bin', op, left, right }
    }
  }

  private unary(): Node {
    const t = this.peek()
    if (t?.t === 'p' && ['!', '-', '+', '~'].includes(t.v)) {
      this.i++
      return { k: 'unary', op: t.v, arg: this.unary() }
    }
    if (t?.t === 'p' && (t.v === '++' || t.v === '--')) {
      this.i++
      const arg = this.unary()
      need(isTarget(arg))
      return { k: 'update', op: t.v, arg }
    }
    if (t?.t === 'id' && t.v === 'typeof') {
      this.i++
      return { k: 'unary', op: t.v, arg: this.unary() }
    }
    return this.postfix()
  }

  private postfix(): Node {
    let n = this.primary()
    for (;;) {
      if (this.is('.') || this.is('?.')) {
        const optional = this.is('?.')
        this.i++
        if (optional && this.is('(')) n = { k: 'call', callee: n, args: this.args() }
        else if (optional && this.is('[')) n = this.indexed(n)
        else {
          const t = this.peek()
          if (t?.t !== 'id') refuse()
          this.i++
          n = { k: 'member', obj: n, name: t.v }
        }
      } else if (this.is('[')) n = this.indexed(n)
      else if (this.is('(')) n = { k: 'call', callee: n, args: this.args() }
      // TypeScript's non-null assertion: `x!` reads as `x`.
      else if (this.is('!')) this.i++
      else if (this.is('++') || this.is('--')) {
        need(isTarget(n))
        const op = this.peek()!.v
        this.i++
        return { k: 'update', op, arg: n }
      } else return n
    }
  }

  private indexed(obj: Node): Node {
    this.take('[')
    const index = this.expr()
    this.take(']')
    return { k: 'index', obj, index }
  }

  private primary(): Node {
    const t = this.peek()
    if (!t) refuse()
    this.i++
    if (t.t === 'num') return { k: 'lit', kind: 'num', v: numberOf(t.v) }
    if (t.t === 'str') return { k: 'lit', kind: 'str' }
    if (t.t === 're') return { k: 'lit', kind: 're' }
    if (t.t === 'p') {
      if (t.v === '(') {
        const e = this.expr()
        this.take(')')
        return e
      }
      if (t.v === '[') return { k: 'array', items: this.list(']') }
      if (t.v === '{') return this.object()
      refuse()
    }
    if (t.v === 'this') return { k: 'this' }
    if (t.v === 'null' || t.v === 'undefined') return { k: 'lit', kind: 'other', nullish: true }
    if (t.v === 'true' || t.v === 'false') return { k: 'lit', kind: 'other' }
    // NaN equals nothing: no value a test can choose.
    if (t.v === 'NaN') return { k: 'lit', kind: 'other' }
    if (t.v === 'Infinity') return { k: 'lit', kind: 'num' }
    if (t.v === 'new') return this.construct()
    if (KEYWORDS.has(t.v)) refuse()
    return { k: 'id', name: t.v }
  }

  private list(close: string): Node[] {
    const items: Node[] = []
    while (!this.is(close)) {
      if (this.is('...')) {
        this.i++
        items.push({ k: 'spread', arg: this.expr() })
      } else items.push(this.expr())
      if (!this.is(close)) this.take(',')
    }
    this.i++
    return items
  }

  private args(): Node[] {
    this.take('(')
    return this.list(')')
  }

  /** An object literal on one line: keys are dropped, values and spreads kept; methods refuse. */
  private object(): Node {
    const items: Node[] = []
    while (!this.is('}')) {
      if (this.is('...')) {
        this.i++
        items.push({ k: 'spread', arg: this.expr() })
      } else if (this.is('[')) {
        this.i++
        items.push(this.expr())
        this.take(']')
        this.take(':')
        items.push(this.expr())
      } else {
        const t = this.peek()
        if (!t || (t.t !== 'id' && t.t !== 'str' && t.t !== 'num')) refuse()
        this.i++
        if (this.is(':')) {
          this.i++
          items.push(this.expr())
        } else {
          if (t.t !== 'id' || KEYWORDS.has(t.v) || !(this.is(',') || this.is('}'))) refuse()
          items.push({ k: 'id', name: t.v })
        }
      }
      if (!this.is('}')) this.take(',')
    }
    this.i++
    return { k: 'object', items }
  }

  /** `new Name(args)`, with type arguments allowed (`new Map<string, number>()`). */
  private construct(): Node {
    const callee = this.name()
    if (this.is('<')) this.skipTypeArguments()
    return { k: 'new', callee, args: this.args() }
  }

  private skipTypeArguments(): void {
    let depth = 0
    do {
      const t = this.peek()
      if (!t) refuse()
      this.i++
      if (isP(t, '<')) depth++
      else if (t.t === 'p' && /^>+$/.test(t.v)) depth -= t.v.length
      else if (!(t.t === 'id' || (t.t === 'p' && [',', '[', ']', '|', '.'].includes(t.v)))) refuse()
    } while (depth > 0)
    need(depth === 0)
  }

  /** A declaration's type: names, generics, arrays and unions only (no function or object types). */
  typeUntilAssign(): Tok[] {
    const out: Tok[] = []
    while (!this.done && !this.is('=')) {
      const t = this.peek()!
      if (!(t.t === 'id' || t.t === 'str' || (t.t === 'p' && ['<', '>', '>>', '>>>', ',', '[', ']', '|', '&', '.', '(', ')'].includes(t.v)))) refuse()
      out.push(t)
      this.i++
    }
    return out
  }
}

/** Every node directly under `n` (an inline arrow's body included). */
function childrenOf(n: Node): Node[] {
  switch (n.k) {
    case 'member':
      return [n.obj]
    case 'index':
      return [n.obj, n.index]
    case 'call':
      return [n.callee, ...n.args]
    case 'new':
      return n.args
    case 'unary':
    case 'update':
    case 'spread':
      return [n.arg]
    case 'bin':
      return [n.left, n.right]
    case 'cond':
      return [n.test, n.yes, n.no]
    case 'assign':
      return [n.target, n.value]
    case 'array':
    case 'object':
      return n.items
    case 'arrow':
      return n.body === 'block' ? [] : [n.body]
    default:
      return []
  }
}

function someNode(n: Node, f: (n: Node) => boolean): boolean {
  return f(n) || childrenOf(n).some((c) => someNode(c, f))
}

/** The name an assignment target or receiver chain starts from, and whether it is that name itself. */
function rootOf(n: Node): { name: string; whole: boolean } | undefined {
  let whole = true
  while (n.k === 'member' || n.k === 'index') {
    n = n.obj
    whole = false
  }
  return n.k === 'id' ? { name: n.name, whole } : undefined
}

/** A receiver's root name through properties, elements and calls (`m.get(k).push` reaches `m`). */
function receiverRoot(n: Node): { name: string; whole: boolean } | undefined {
  let whole = true
  for (;;) {
    if (n.k === 'member' || n.k === 'index') n = n.obj
    else if (n.k === 'call') n = n.callee
    else return n.k === 'id' ? { name: n.name, whole } : undefined
    whole = false
  }
}

const numLit = (n: Node | undefined): number | undefined => (n?.k === 'lit' && n.kind === 'num' ? n.v : undefined)
const isValueLit = (n: Node): boolean => n.k === 'lit' && (n.kind === 'num' || n.kind === 'str')
const isId = (n: Node, name?: string): boolean => n.k === 'id' && (name === undefined || n.name === name)
const conjuncts = (n: Node): Node[] => (n.k === 'bin' && n.op === '&&' ? [...conjuncts(n.left), ...conjuncts(n.right)] : [n])
const mentions = (n: Node, name: string): boolean => someNode(n, (c) => c.k === 'id' && c.name === name)

/** `!c`, with comparisons flipped so an atom stays an atom. */
function negate(n: Node): Node {
  if (n.k === 'bin' && Object.hasOwn(FLIP, n.op)) return { ...n, op: FLIP[n.op]! }
  if (n.k === 'unary' && n.op === '!') return n.arg
  return { k: 'unary', op: '!', arg: n }
}

// ---------------------------------------------------------------------------
// Lines

type ForHead = { k: 'of' | 'in'; names: string[]; pattern: boolean; source: Node } | { k: 'count'; name: string; init: Node; test: Node; step: Node }
type Simple =
  | { k: 'decl'; name: string; isConst: boolean; type?: 'numeric' | 'string'; init?: Node }
  | { k: 'expr'; node: Node }
  | { k: 'return'; node?: Node }
  | { k: 'throw'; node: Node }
  | { k: 'break' }
  | { k: 'continue' }
type Line = Simple | { k: 'if'; cond: Node } | { k: 'else'; cond?: Node } | { k: 'for'; head: ForHead } | { k: 'while'; cond: Node } | { k: 'cb'; line: Simple }

/** One shown line read as a statement or a block header; anything else refuses (labels, `do`, `switch`, `try`, bodies on the header line). */
function parseLine(text: string): Line {
  let toks = tokenize(text)
  if (isP(toks.at(-1), ';')) toks = toks.slice(0, -1)
  need(toks.length > 0)
  const first = toks[0]!
  if (isWord(first, 'for')) return forLine(toks)
  need(!toks.some((t) => isP(t, ';')))
  if (isP(first, '}')) return elseLine(new Parser(toks.slice(1)))
  if (isWord(first, 'else')) return elseLine(new Parser(toks))
  if (isWord(first, 'if') || isWord(first, 'while')) {
    const p = new Parser(toks)
    p.i++
    p.take('(')
    const cond = p.expr()
    p.take(')')
    p.take('{')
    p.end()
    return { k: isWord(first, 'if') ? 'if' : 'while', cond }
  }
  if (isP(toks.at(-1), '{')) {
    // A block callback: `… => {`, its body on the next lines, closed by a lone `})`.
    need(isP(toks.at(-2), '=>'))
    const body: Tok[] = [...toks.slice(0, -1), { t: 'p', v: BLOCK }]
    let parens = 0
    for (const t of body) {
      if (t.t !== 'p') continue
      parens += t.v === '(' ? 1 : t.v === ')' ? -1 : 0
      need(parens >= 0 && !['[', ']', '{', '}'].includes(t.v))
    }
    need(parens === 1)
    return { k: 'cb', line: simpleLine([...body, { t: 'p', v: ')' }]) }
  }
  return simpleLine(toks)
}

function elseLine(p: Parser): Line {
  p.takeWord('else')
  if (p.isWord('if')) {
    p.i++
    p.take('(')
    const cond = p.expr()
    p.take(')')
    p.take('{')
    p.end()
    return { k: 'else', cond }
  }
  p.take('{')
  p.end()
  return { k: 'else' }
}

function forLine(toks: Tok[]): Line {
  const p = new Parser(toks)
  p.i++
  p.take('(')
  if ((p.isWord('const') || p.isWord('let')) && (p.isWord('of', 2) || p.isWord('in', 2) || p.is('[', 1))) {
    p.i++
    const names: string[] = []
    const pattern = p.is('[')
    if (pattern) {
      p.i++
      while (!p.is(']')) {
        names.push(p.name())
        if (!p.is(']')) p.take(',')
      }
      p.i++
    } else names.push(p.name())
    const k = p.isWord('of') ? 'of' : 'in'
    p.takeWord(k)
    const source = p.expr()
    p.take(')')
    p.take('{')
    p.end()
    need(names.length >= 1 && names.length <= (k === 'in' ? 1 : 2))
    return { k: 'for', head: { k, names, pattern, source } }
  }
  p.takeWord('let')
  const name = p.name()
  p.take('=')
  const init = p.expr()
  p.take(';')
  const test = p.expr()
  p.take(';')
  const step = p.expr()
  p.take(')')
  p.take('{')
  p.end()
  return { k: 'for', head: { k: 'count', name, init, test, step } }
}

function simpleLine(toks: Tok[]): Simple {
  const p = new Parser(toks)
  if (p.isWord('return')) {
    p.i++
    const node = p.done ? undefined : p.expr()
    p.end()
    return node ? { k: 'return', node } : { k: 'return' }
  }
  if (p.isWord('throw')) {
    p.i++
    const node = p.expr()
    p.end()
    return { k: 'throw', node }
  }
  if (p.isWord('break') || p.isWord('continue')) {
    const k = p.isWord('break') ? 'break' : 'continue'
    p.i++
    p.end()
    return { k }
  }
  if (p.isWord('const') || p.isWord('let')) {
    const isConst = p.isWord('const')
    p.i++
    const name = p.name()
    let type: 'numeric' | 'string' | undefined
    if (p.is(':')) {
      p.i++
      const t = p.typeUntilAssign()
      const word = t.length === 1 ? t[0]!.v : ''
      type = word === 'number' ? 'numeric' : word === 'string' ? 'string' : undefined
    }
    let init: Node | undefined
    if (p.is('=')) {
      p.i++
      init = p.expr()
    }
    p.end()
    need(!isConst || init !== undefined)
    return { k: 'decl', name, isConst, ...(type ? { type } : {}), ...(init ? { init } : {}) }
  }
  const node = p.expr()
  p.end()
  return { k: 'expr', node }
}

// ---------------------------------------------------------------------------
// Signature (spec gate 3)

/**
 * `fixed`: a tuple or object type, whose size does not grow; `bool`: a boolean; `literal`: a string or number
 * literal type or union, never a size or loop source (fix round 5); `other`: any other or no type.
 */
type Kind = 'array' | 'string' | 'set' | 'map' | 'numeric' | 'bool' | 'fixed' | 'literal' | 'other'
/** What an element is: a primitive, or `opaque` (any other or unknown type: property reads and comparisons only). */
type ElemType = 'number' | 'string' | 'boolean' | 'opaque'
/** A named value's type in the condition grammar (task 6 fix round 4). */
type GrammarType = 'number' | 'string' | 'boolean'
/** `elem`: an array's or Set's element type, a Map's value type; `key`: a Map's key type. */
/** `literal`: for kind `literal`, whether its literals are strings or numbers (ruling C). */
/** `shape`: an element (a Map's value) that is an object or an array, never null (task 6 fix round 1: it takes property reads). */
type Param = { name: string; kind: Kind; elem?: ElemType; key?: ElemType; literal?: 'string' | 'number'; shape?: Shape; props?: Props }
type Shape = 'object' | 'array'
/** An object literal type's declared, non-optional properties: an object or array, or a primitive (never null). */
type Props = ReadonlyMap<string, Shape | 'primitive'>

/** Splits `toks` at `sep` outside brackets of any kind. */
function splitTop(toks: Tok[], sep: string): Tok[][] {
  const parts: Tok[][] = [[]]
  let depth = 0
  for (const t of toks) {
    if (t.t === 'p' && ['(', '[', '{', '<'].includes(t.v)) depth++
    else if (t.t === 'p' && [')', ']', '}'].includes(t.v)) depth--
    else if (t.t === 'p' && /^>+$/.test(t.v)) depth -= t.v.length
    if (depth === 0 && isP(t, sep)) parts.push([])
    else parts.at(-1)!.push(t)
  }
  return parts
}

/** True when the type's generic `<` opened by its second token closes at its last token. */
function closesAtEnd(toks: Tok[]): boolean {
  if (!isP(toks[1], '<')) return false
  let depth = 0
  for (const [k, t] of toks.entries()) {
    if (isP(t, '<')) depth++
    else if (t.t === 'p' && /^>+$/.test(t.v)) depth -= t.v.length
    if (depth <= 0 && k > 1) return depth === 0 && k === toks.length - 1
  }
  return false
}

/**
 * Whether an element type is an object (an object literal type, or a named
 * type of the code's own: capitalized, two letters or more, no global) or an
 * array, so it is never null or undefined and takes a property read.
 */
function shapeOf(toks: Tok[]): Shape | undefined {
  if (toks.length >= 3 && isP(toks.at(-2), '[') && isP(toks.at(-1), ']')) return 'array'
  if ((isWord(toks[0], 'Array') || isWord(toks[0], 'ReadonlyArray')) && closesAtEnd(toks)) return 'array'
  if (isP(toks[0], '{') && isP(toks.at(-1), '}') && splitTop(toks, '|').length === 1) return 'object'
  if (toks.length === 1 && toks[0]!.t === 'id' && /^[A-Z][A-Za-z0-9_$]+$/.test(toks[0]!.v) && !GLOBALS.has(toks[0]!.v)) return 'object'
  return undefined
}

/** An object literal type's declared properties that are never null: `{ tags: number[]; id: number }` (an optional `?` one is left out). */
function propsOf(toks: Tok[]): Props | undefined {
  if (!isP(toks[0], '{') || !isP(toks.at(-1), '}')) return undefined
  const out = new Map<string, Shape | 'primitive'>()
  for (const part of splitTop(toks.slice(1, -1), ',').flatMap((q) => splitTop(q, ';'))) {
    if (part.length < 3 || part[0]!.t !== 'id' || !isP(part[1], ':')) continue
    const type = part.slice(2)
    const shape = shapeOf(type)
    if (shape) out.set(part[0]!.v, shape)
    else if (type.length === 1 && ['number', 'string', 'boolean', 'bigint'].includes(type[0]!.v)) out.set(part[0]!.v, 'primitive')
  }
  return out
}

/** A primitive element type by name; anything else (objects, tuples, named or generic types) is opaque. */
function elemTypeOf(toks: Tok[]): ElemType {
  if (toks.length !== 1 || toks[0]!.t !== 'id') return 'opaque'
  const w = toks[0]!.v
  // Task 6 fix round 3: a bigint is no number (mixing the two throws, and toFixed is no bigint method).
  return w === 'number' ? 'number' : w === 'string' ? 'string' : w === 'boolean' ? 'boolean' : 'opaque'
}

/** Spec "Typed receivers": arrays, `string`, `Set<…>`, `Map<…>` (optionally `| undefined`/`| null`); numbers are sizes by value. */
function classify(type: Tok[]): Omit<Param, 'name'> {
  const parts = splitTop(type, '|').filter((p) => !(p.length === 1 && (isWord(p[0], 'undefined') || isWord(p[0], 'null'))))
  const literal = parts.length === 0 ? undefined : parts.every((q) => q.length === 1 && q[0]!.t === 'str') ? 'string' : parts.every((q) => (q.length === 1 && q[0]!.t === 'num') || (q.length === 2 && isP(q[0], '-') && q[1]!.t === 'num')) ? 'number' : undefined
  if (literal) return { kind: 'literal', literal }
  if (parts.length !== 1) return { kind: 'other' }
  let p = parts[0]!
  if (p.length === 1 && isWord(p[0], 'number')) return { kind: 'numeric' }
  if (p.length === 1 && isWord(p[0], 'string')) return { kind: 'string' }
  if (p.length === 1 && isWord(p[0], 'boolean')) return { kind: 'bool' }
  const readonly = isWord(p[0], 'readonly')
  if (readonly) p = p.slice(1)
  const shaped = (t: Tok[]): { shape?: Shape; props?: Props } => (shapeOf(t) ? { shape: shapeOf(t)!, ...(propsOf(t) ? { props: propsOf(t)! } : {}) } : {})
  if (p.length >= 3 && isP(p.at(-2), '[') && isP(p.at(-1), ']')) return { kind: 'array', elem: elemTypeOf(p.slice(0, -2)), ...shaped(p.slice(0, -2)) }
  if (isP(p[0], '[') || isP(p[0], '{')) return { kind: 'fixed' }
  if (readonly) return { kind: 'other' }
  const args = closesAtEnd(p) ? splitTop(p.slice(2, -1), ',') : []
  if ((isWord(p[0], 'Array') || isWord(p[0], 'ReadonlyArray')) && args.length === 1) return { kind: 'array', elem: elemTypeOf(args[0]!), ...shaped(args[0]!) }
  if (isWord(p[0], 'Set') && args.length === 1) return { kind: 'set', elem: elemTypeOf(args[0]!), ...shaped(args[0]!) }
  if (isWord(p[0], 'Map') && args.length === 2) return { kind: 'map', key: elemTypeOf(args[0]!), elem: elemTypeOf(args[1]!), ...shaped(args[1]!) }
  return { kind: 'other' }
}

const LITERAL_DEFAULTS = [['num'], ['str'], ['-', 'num'], ['true'], ['false'], ['null'], ['undefined'], ['[', ']'], ['{', '}']]

function readParam(toks: Tok[]): Param {
  const p = new Parser(toks)
  const name = p.name()
  need(name !== 'this' && !['readonly', 'override'].includes(name))
  if (p.is('?')) p.i++
  let typed: Omit<Param, 'name'> = { kind: 'other' }
  if (p.is(':')) {
    p.i++
    const type: Tok[] = []
    while (!p.done && !p.is('=')) type.push(p.toks[p.i++]!)
    need(type.length > 0 && !type.some((t) => isP(t, '=>')))
    typed = classify(type)
  }
  if (p.is('=')) {
    p.i++
    const rest = p.toks.slice(p.i).map((t) => (t.t === 'num' || t.t === 'str' ? t.t : t.v))
    need(LITERAL_DEFAULTS.some((d) => d.length === rest.length && d.every((v, k) => v === rest[k])))
    p.i = p.toks.length
  }
  p.end()
  return { name, ...typed }
}

// No `async`: an awaited value is opaque to the reader (fix round 3, ruling B).
const MODIFIERS = ['export', 'default', 'public', 'private', 'protected', 'static', 'readonly', 'override']

/** Spec gate 3: one balanced list of plain parameters, read from the lines up to the body's `{`. The unit's own arrow is the only `=>`. */
export function readSignature(text: string, name: string): Param[] {
  const toks = tokenize(text)
  need(isP(toks.at(-1), '{'))
  const p = new Parser(toks.slice(0, -1))
  while (MODIFIERS.some((m) => p.isWord(m))) p.i++
  let isArrow = false
  if (p.isWord('function')) {
    p.i++
    p.takeWord(name)
  } else if (p.isWord('const') || p.isWord('let')) {
    p.i++
    p.takeWord(name)
    p.take('=')
    isArrow = true
  } else {
    need(!['get', 'set', 'constructor'].includes(name))
    p.takeWord(name)
  }
  const rest = p.toks.slice(p.i)
  let params: Param[]
  let after: Tok[]
  if (isArrow && rest[0]?.t === 'id') {
    params = [{ name: new Parser([rest[0]]).name(), kind: 'other' }]
    after = rest.slice(1)
  } else {
    let k = 0
    if (isP(rest[0], '<')) {
      let depth = 0
      do {
        const t = rest[k++]
        if (!t) refuse()
        if (isP(t, '<')) depth++
        else if (t.t === 'p' && /^>+$/.test(t.v)) depth -= t.v.length
      } while (depth > 0)
    }
    need(isP(rest[k], '('))
    let depth = 0
    let close = -1
    for (let j = k; j < rest.length; j++) {
      if (isP(rest[j], '(')) depth++
      else if (isP(rest[j], ')') && --depth === 0) {
        close = j
        break
      }
    }
    need(close > k)
    const parts = splitTop(rest.slice(k + 1, close), ',')
    // One trailing comma is allowed.
    if (parts.length > 1 && parts.at(-1)!.length === 0) parts.pop()
    params = parts[0]!.length === 0 && parts.length === 1 ? [] : parts.map(readParam)
    need(!rest.slice(0, k).some((t) => isP(t, '=>')))
    after = rest.slice(close + 1)
  }
  if (isArrow) {
    need(isP(after.at(-1), '=>'))
    after = after.slice(0, -1)
  }
  need(!after.some((t) => isP(t, '=>')) && (after.length === 0 || isP(after[0], ':')))
  need(new Set(params.map((q) => q.name)).size === params.length && !params.some((q) => q.name === name))
  return params
}

// ---------------------------------------------------------------------------
// Statements

type Branch = { at: number; cond?: Node; body: Stmt[] }
type IfStmt = { k: 'if'; branches: Branch[]; hasElse: boolean }
type Stmt =
  | { k: 'line'; at: number; line: Simple }
  | { k: 'hidden'; at: number }
  | { k: 'hblock'; at: number; body: Stmt[] }
  | IfStmt
  | { k: 'for'; at: number; head: ForHead; body: Stmt[] }
  | { k: 'while'; at: number; cond: Node; body: Stmt[] }
  | { k: 'cb'; at: number; line: Simple; body: Stmt[] }

const keptBraces = (line: string): string => line.replace(/[^{}]/g, '')

/** Each opening line's closing line, by matching braces from the root's `{` (`treeByBraces` has checked their shape). */
function closersOf(lines: readonly string[], opener: number): Map<number, number> {
  const closers = new Map<number, number>()
  const open: number[] = []
  for (let at = opener; at < lines.length; at++) {
    let s = keptBraces(lines[at]!)
    while (s.includes('{}')) s = s.replace('{}', '')
    for (const c of s) {
      if (c === '{') open.push(at)
      else {
        const o = open.pop()
        if (o !== undefined) closers.set(o, at)
      }
    }
  }
  return closers
}

function simpleNodes(s: Simple): Node[] {
  if (s.k === 'decl') return s.init ? [s.init] : []
  if (s.k === 'expr' || s.k === 'throw') return [s.node]
  if (s.k === 'return') return s.node ? [s.node] : []
  return []
}

function headNodes(h: ForHead): Node[] {
  return h.k === 'count' ? [h.init, h.test, h.step] : [h.source]
}

function stmtNodes(s: Stmt): Node[] {
  switch (s.k) {
    case 'line':
    case 'cb':
      return simpleNodes(s.line)
    case 'if':
      return s.branches.flatMap((b) => (b.cond ? [b.cond] : []))
    case 'for':
      return headNodes(s.head)
    case 'while':
      return [s.cond]
    default:
      return []
  }
}

function bodiesOf(s: Stmt): Stmt[][] {
  if (s.k === 'if') return s.branches.map((b) => b.body)
  return 'body' in s ? [s.body] : []
}

function someStmt(list: Stmt[], f: (s: Stmt) => boolean): boolean {
  return list.some((s) => f(s) || bodiesOf(s).some((b) => someStmt(b, f)))
}

const isTransfer = (s: Stmt): boolean => s.k === 'line' && TRANSFERS.has(s.line.k)
const mayTransfer = (body: Stmt[]): boolean => someStmt(body, isTransfer)
const mayExit = (body: Stmt[]): boolean => someStmt(body, (s) => s.k === 'line' && (s.line.k === 'return' || s.line.k === 'throw' || s.line.k === 'break'))

/** A statement after which the rest of its list never runs. */
function alwaysTransfers(s: Stmt): boolean {
  return isTransfer(s) || (s.k === 'if' && s.hasElse && s.branches.every((b) => endsInTransfer(b.body)))
}

/** A body whose last statement leaves it, or may (a hidden line). */
function endsInTransfer(body: Stmt[]): boolean {
  const last = body.at(-1)
  return last !== undefined && (alwaysTransfers(last) || last.k === 'hidden')
}

// ---------------------------------------------------------------------------
// The reader

/**
 * A source's elements. `yields`: keys or entries when its values are indices
 * (never elements; `numericKeys` when they are numbers), `pairs` for a Map's
 * entries. `type`: what an element is (`key` for a pair's first). `atom`: an
 * element bound directly over a parameter or a filter of one, the only kind an
 * exit or choose test may read (spec "Stricter readings", fix round 2).
 */
/** `derived`: an element of a derived value, never a fixed-cost operand (task 7 fix round 2, ruling D′). */
type Elem = { origin: string; distinct: boolean; yields?: 'keys' | 'entries' | 'pairs'; numericKeys?: boolean; type: ElemType; key?: ElemType; atom: boolean; shape?: Shape; props?: Props; derived?: boolean }
type LoopKind = 'of' | 'count' | 'halving' | 'literal' | 'search' | 'callback' | 'comparator'
/** `positions`: names holding an index (keys, entry indices) besides `index`; never elements. */
/** `walks`: the source whose positions `index` and `positions` are, from 0 to its length (fix round 3, ruling A). */
/** `eqExit`: a binary search's equality exit test (ruling F), checked by its own pattern. */
type Loop = { at: number; kind: LoopKind; index?: string; positions?: string[]; numeric?: string[]; walks?: string; eqExit?: Node; start?: { from: string; plus: number }; elements: Map<string, Elem>; factor: Cost; hasExit: boolean }
/** `coll`: a collection the reader can see but not size (a copy, a literal, a string from a parameter); `reaches`: a plain local holding something reached through a parameter or loop name. */
type Local = ({ k: 'derived' } & Elem) | { k: 'acc'; array: boolean } | { k: 'local'; reaches: boolean }
type Decl = { name: string; at: number; line: Extract<Simple, { k: 'decl' }>; inLoop: boolean }
type Assignment = { name: string; whole: boolean; op: string; value?: Node; at: number; inLoop: boolean }
/** A condition on the path to a site; `depth` is the number of loops around it. `opaque`: a hidden condition. */
type Entry = { cond?: Node; neg: boolean; depth: number; opaque?: boolean }
type Env = { loops: Loop[]; path: Entry[]; at: number; hidden: boolean; chain?: IfStmt; block?: Stmt[] }
type Ctx = 'value' | 'test' | 'ret' | 'stmt' | 'compare'
type ElemRef = Elem & { chain: boolean; pos?: string }

const STRICT_PLACE: HiddenPlace = { isInLoop: true, isLastAtBodyLevel: false, isInGuard: false }
const hasFactors = (c: Cost): boolean => c.some((t) => t.length > 0)
const NOTHING: Cost = []

class Reader {
  readonly params = new Map<string, Param>()
  readonly decls = new Map<string, Decl>()
  readonly locals = new Map<string, Local>()
  /** Loop variables, indices and arrow parameters. */
  readonly loopNames = new Set<string>()
  readonly assignments: Assignment[] = []
  readonly mutated = new Set<string>()
  readonly sizeLocals = new Map<string, Set<string>>()
  /** Number parameters that are sizes: named in a counting loop's header or flowing into a local (spec gate 10). */
  readonly sizedNumbers = new Set<string>()
  readonly loops = new Map<number, Loop>()
  readonly searchVars = new Set<string>()
  /** Names the signature holds besides its parameters (types): never called. */
  readonly signatureNames = new Set<string>()
  readonly places = new Map<number, HiddenPlace>()
  readonly openers = new Set<number>()
  readonly tinyGuards = new Set<Node>()
  readonly guardBranches = new Set<number>()
  /** Each pair of sizes compared, and which way (spec gate 10, fix round 1). */
  readonly sizeOrders = new Map<string, 'lt' | 'gt'>()
  /** Locals a condition outside loops may read (fix round 2). */
  readonly sizeFree = new Set<string>()
  /** Locals proven scalar or numeric where declared (pass 2); every later write must keep the proof. */
  readonly scalarLocals = new Set<string>()
  readonly numericLocals = new Set<string>()
  closers = new Map<number, number>()
  opener = 0

  constructor(
    readonly unit: Unit,
    readonly lines: readonly string[],
  ) {}

  // --- Entry ---------------------------------------------------------------

  read(): { cost: Cost; numeric: string[]; params: string[] } {
    const { lines } = this
    need(lines.every((l) => !isBlankedLine(l)) || this.unit.hidden !== undefined)
    this.opener = lines.findIndex((l) => /[{}]/.test(l))
    need(this.opener >= 0)
    const signature = lines.slice(0, this.opener + 1).join(' ')
    for (const p of readSignature(signature, this.unit.name)) {
      need(!GLOBALS.has(p.name) && !FAILS.has(p.name))
      this.params.set(p.name, p)
    }
    // Task 6 fix round 2: a name the signature uses as a type (a class) throws when called without `new`.
    for (const t of tokenize(signature)) if (t.t === 'id' && !this.params.has(t.v) && t.v !== this.unit.name) this.signatureNames.add(t.v)
    const tree = treeByBraces(lines)
    if (!tree) refuse()
    this.closers = closersOf(lines, this.opener)
    this.checkGates()
    const body = this.build(tree.children, { inLoop: false, inGuard: false, atRoot: true })
    this.checkCloser(this.opener, 'root')
    this.collect(body)
    this.checkHidden()
    this.checkFlow(body, { loops: [], path: [], at: 0, hidden: false })
    const cost = this.costOfBlock(body, { loops: [], path: [], at: 0, hidden: false })
    const params = [...this.params.values()]
    return { cost, numeric: params.filter((p) => p.kind === 'numeric').map((p) => p.name), params: params.map((p) => p.name) }
  }

  /** Line-level gates: 4 (the unit naming itself), 7 (a statement over two lines, by how a line starts). */
  private checkGates(): void {
    const name = this.unit.name.replace(/[$]/g, '\\$')
    const self = new RegExp(`(?:^|[^\\p{ID_Continue}$])${name}\\s*\\(`, 'u')
    for (let at = 1; at < this.lines.length; at++) {
      const text = this.lines[at]!
      if (isBlankedLine(text)) continue
      need(!self.test(text))
      if (at <= this.opener) continue
      const s = text.trimStart()
      need(/^(?:\+\+|--)/.test(s) || !/^(?:\.|[(\[`+\-*/%<>=&|^?:,])/.test(s))
    }
  }

  // --- Structure -------------------------------------------------------------

  /** Blocks to statements, recording each blanked line's place for the inert check. */
  private build(blocks: Block[], where: { inLoop: boolean; inGuard: boolean; atRoot: boolean }): Stmt[] {
    const out: Stmt[] = []
    blocks.forEach((b, k) => {
      const text = this.lines[b.at]!
      const isLast = k === blocks.length - 1
      if (isBlankedLine(text)) {
        this.places.set(b.at, { isInLoop: where.inLoop, isLastAtBodyLevel: where.atRoot && isLast, isInGuard: where.inGuard && isLast })
        if (keptBraces(text).endsWith('{')) {
          this.openers.add(b.at)
          this.checkCloser(b.at, 'branch')
          out.push({ k: 'hblock', at: b.at, body: this.build(b.children, { inLoop: where.inLoop, inGuard: false, atRoot: false }) })
        } else {
          need(b.children.length === 0)
          out.push({ k: 'hidden', at: b.at })
        }
        return
      }
      const line = parseLine(text)
      const nested = (inLoop: boolean, inGuard: boolean): Stmt[] => this.build(b.children, { inLoop, inGuard, atRoot: false })
      const guard = !where.inLoop && (where.atRoot || where.inGuard)
      switch (line.k) {
        case 'if':
          this.checkCloser(b.at, 'branch')
          out.push({ k: 'if', branches: [{ at: b.at, cond: line.cond, body: nested(where.inLoop, guard) }], hasElse: false })
          return
        case 'else': {
          const prev = out.at(-1)
          if (prev?.k !== 'if' || prev.hasElse) refuse()
          this.checkCloser(b.at, 'branch')
          prev.branches.push({ at: b.at, ...(line.cond ? { cond: line.cond } : {}), body: nested(where.inLoop, guard) })
          if (!line.cond) prev.hasElse = true
          return
        }
        case 'for':
          this.checkCloser(b.at, 'loop')
          out.push({ k: 'for', at: b.at, head: line.head, body: nested(true, false) })
          return
        case 'while':
          this.checkCloser(b.at, 'loop')
          out.push({ k: 'while', at: b.at, cond: line.cond, body: nested(true, false) })
          return
        case 'cb':
          this.checkCloser(b.at, 'cb')
          out.push({ k: 'cb', at: b.at, line: line.line, body: nested(true, false) })
          return
        default:
          need(b.children.length === 0)
          out.push({ k: 'line', at: b.at, line })
      }
    })
    return out
  }

  /** The line closing a block: `}` (or blanked to `}`); `} else …` after an if branch; exactly `})` after a block callback. */
  private checkCloser(at: number, kind: 'branch' | 'loop' | 'cb' | 'root'): void {
    const c = this.closers.get(at)
    if (c === undefined) refuse()
    const text = this.lines[c]!
    if (isBlankedLine(text)) {
      const kept = keptBraces(text)
      need(kind !== 'cb' && (kept === '}' || (kind === 'branch' && kept === '}{')))
      return
    }
    const s = text.trim()
    if (kind === 'cb') need(/^\}\);?$/.test(s))
    else if (kind === 'root') need(s === '}' || s === '};')
    else need(s === '}' || (kind === 'branch' && /^\}\s*else\b/.test(s)))
  }

  // --- Names (pass 0) --------------------------------------------------------

  private isBound(name: string): boolean {
    return this.params.has(name) || this.decls.has(name) || this.loopNames.has(name)
  }

  /** Declarations, scoping, assignments and mutating calls; then what each local is (spec "Builtins": derived values, accumulators). */
  private collect(body: Stmt[]): void {
    this.collectDecls(body, false)
    for (const d of this.decls.keys()) need(!this.params.has(d) && d !== this.unit.name && !GLOBALS.has(d) && !FAILS.has(d))
    this.scope(body, new Set())
    for (const n of this.loopNames) need(!this.decls.has(n))
    this.collectWrites(body)
    for (const [name, d] of this.decls) this.locals.set(name, this.localOf(name, d))
    this.collectSizedNumbers(body)
    this.collectSizes()
    this.collectSizeFree()
  }

  private collectDecls(list: Stmt[], inLoop: boolean): void {
    for (const s of list) {
      if ((s.k === 'line' || s.k === 'cb') && s.line.k === 'decl') {
        need(!this.decls.has(s.line.name))
        this.decls.set(s.line.name, { name: s.line.name, at: s.at, line: s.line, inLoop })
      }
      const loopy = s.k === 'for' || s.k === 'while' || s.k === 'cb'
      for (const b of bodiesOf(s)) this.collectDecls(b, inLoop || loopy)
    }
  }

  /** Loop variables and arrow parameters: none may shadow a visible name, a parameter, a local or the unit. */
  private scope(list: Stmt[], visible: ReadonlySet<string>): void {
    const declare = (names: string[], vis: ReadonlySet<string>): Set<string> => {
      const next = new Set(vis)
      for (const n of names) {
        need(!vis.has(n) && !this.params.has(n) && !this.decls.has(n) && n !== this.unit.name && !GLOBALS.has(n) && !FAILS.has(n))
        this.loopNames.add(n)
        next.add(n)
      }
      return next
    }
    /** Inline arrows declare their parameters over their bodies; a block arrow's parameters are returned for its body. */
    const visit = (n: Node, vis: ReadonlySet<string>): Set<string> | undefined => {
      if (n.k === 'arrow') {
        const inner = declare(n.params, vis)
        if (n.body === 'block') return inner
        return visit(n.body, inner)
      }
      let block: Set<string> | undefined
      for (const c of childrenOf(n)) block = visit(c, vis) ?? block
      return block
    }
    for (const s of list) {
      let inner: ReadonlySet<string> = visible
      for (const n of stmtNodes(s)) inner = visit(n, visible) ?? inner
      if (s.k === 'for') inner = declare(s.head.k === 'count' ? [s.head.name] : s.head.names, visible)
      for (const b of bodiesOf(s)) this.scope(b, inner)
    }
  }

  /** Every assignment and mutating call; `inLoop`: inside a loop or a callback. */
  private collectWrites(list: Stmt[], inLoop = false): void {
    const visit = (c: Node, at: number, inner: boolean): void => {
      if (c.k === 'id' || c.k === 'member') need(c.name !== this.unit.name)
      if (c.k === 'assign' || c.k === 'update') {
        const root = rootOf(c.k === 'assign' ? c.target : c.arg)
        if (!root) refuse()
        this.assignments.push({ name: root.name, whole: root.whole, op: c.op, ...(c.k === 'assign' ? { value: c.value } : {}), at, inLoop: inner })
      }
      if (c.k === 'call' && c.callee.k === 'member' && MUTATE.has(c.callee.name)) {
        const root = rootOf(c.callee.obj)
        if (root) this.mutated.add(root.name)
      }
      for (const k of childrenOf(c)) visit(k, at, inner || c.k === 'arrow')
    }
    for (const s of list) {
      const at = s.k === 'if' ? -1 : s.at
      const loopy = s.k === 'for' || s.k === 'while' || s.k === 'cb'
      for (const n of stmtNodes(s)) visit(n, at, inLoop)
      for (const b of bodiesOf(s)) this.collectWrites(b, inLoop || loopy)
    }
  }

  private localOf(name: string, d: Decl): Local {
    const init = d.line.init
    const written = this.assignments.some((a) => a.name === name)
    if (init && isEmptyCollection(init)) {
      need(!this.assignments.some((a) => a.name === name && a.whole))
      return { k: 'acc', array: init.k === 'array' }
    }
    const derived = init && !d.inLoop && !written && !this.mutated.has(name) ? this.derivedFrom(init) : undefined
    if (derived) return { k: 'derived', ...derived }
    // Whether it is proven scalar is settled where it is declared (`costOfLine`); until then, and otherwise, it is closed-list.
    // A fresh collection (a filled Set or Map, a copy) reaches nothing: writing to it changes no parameter.
    const fresh = init !== undefined && (init.k === 'new' || (init.k === 'call' && init.callee.k === 'member' && (isId(init.callee.obj, 'Array') || isId(init.callee.obj, 'Object') || ['concat', 'slice', 'filter', 'map', 'toSorted', 'toReversed'].includes(init.callee.name))))
    const reaches = init !== undefined && !fresh && someNode(init, (c) => c.k === 'id' && c.name !== name && (this.params.has(c.name) || this.loopNames.has(c.name) || this.decls.has(c.name)))
    return { k: 'local', reaches }
  }

  /**
   * Spec "Builtins", derived values: one parameter through a builtin that
   * returns at most its size and takes no limit. Only a filter's elements are
   * atoms (they are the parameter's own); a map's are opaque.
   */
  private derivedFrom(n: Node): Elem | undefined {
    const param = (m: Node | undefined, kinds: Kind[]): Param | undefined => {
      const p = m?.k === 'id' ? this.params.get(m.name) : undefined
      return p && kinds.includes(p.kind) ? p : undefined
    }
    /** A copy of `p`'s elements: the same type, no atoms (a Map's become opaque pairs). */
    const copy = (p: Param): Elem => ({ origin: p.name, distinct: p.kind === 'set' || p.kind === 'map', type: p.kind === 'string' ? 'string' : p.kind === 'map' ? 'opaque' : (p.elem ?? 'opaque'), atom: false })
    if (n.k === 'array' && n.items.length === 1 && n.items[0]!.k === 'spread') {
      const p = param(n.items[0]!.arg, ['array', 'set', 'map', 'string'])
      return p && copy(p)
    }
    if (n.k !== 'call' || n.callee.k !== 'member') return undefined
    const { obj, name: m } = n.callee
    const args = n.args
    if (isId(obj, 'Array') && m === 'from' && args.length === 1) {
      const p = param(args[0], ['array', 'set', 'map', 'string'])
      return p && copy(p)
    }
    if (isId(obj, 'Object') && ['keys', 'values', 'entries'].includes(m) && args.length === 1) {
      const p = param(args[0], ['array', 'other'])
      if (!p) return undefined
      const type = p.kind === 'array' ? (p.elem ?? 'opaque') : 'opaque'
      return m === 'values' ? { origin: p.name, distinct: true, type, atom: false } : { origin: p.name, distinct: true, yields: m === 'keys' ? 'keys' : 'entries', type, atom: false }
    }
    const p = param(obj, ['array'])
    if (!p) return undefined
    const type = p.elem ?? 'opaque'
    // A filter keeps its parameter's size only when its test can hold for every element.
    if (m === 'filter') {
      const cb = args[0]
      if (args.length !== 1 || cb?.k !== 'arrow' || cb.body === 'block' || cb.params.length !== 1) return undefined
      const elems = new Map([[cb.params[0]!, { origin: p.name, distinct: false, type, atom: true }]])
      return this.canHoldAlways(cb.body, elems) ? { origin: p.name, distinct: false, type, atom: true } : undefined
    }
    if (m === 'map' && args.length === 1 && (args[0]!.k === 'arrow' || args[0]!.k === 'id')) return { origin: p.name, distinct: false, type: 'opaque', atom: false }
    const shaped = ((m === 'slice' || m === 'toReversed') && args.length === 0) || (m === 'toSorted' && args.length <= 1)
    return shaped ? { origin: p.name, distinct: false, type, atom: false } : undefined
  }

  /**
   * Spec "Stricter readings", fix round 2: a local is size-free (it may stand
   * in a condition outside loops) when it is declared outside loops from a
   * value a root condition may hold, and is never written inside a loop or
   * callback, nor with any other value.
   */
  private collectSizeFree(): void {
    for (const [name, d] of this.decls) if (!d.inLoop && d.line.init && this.locals.get(name)?.k === 'local') this.sizeFree.add(name)
    for (let changed = true; changed; ) {
      changed = false
      for (const name of [...this.sizeFree]) {
        const d = this.decls.get(name)!
        const ok = this.rootAllowed(d.line.init!) && this.assignments.every((a) => a.name !== name || (!a.inLoop && (a.value === undefined || this.rootAllowed(a.value))))
        if (!ok) {
          this.sizeFree.delete(name)
          changed = true
        }
      }
    }
  }

  /** What a condition outside loops may hold: literals, number and boolean parameters, a parameter's `.length`/`.size`, size-free locals, and operators. */
  private rootAllowed(n: Node): boolean {
    switch (n.k) {
      case 'lit':
        return n.kind !== 're'
      case 'id': {
        const p = this.params.get(n.name)
        return p ? p.kind === 'numeric' || p.kind === 'bool' : this.sizeFree.has(n.name)
      }
      case 'member': {
        const p = n.obj.k === 'id' ? this.params.get(n.obj.name) : undefined
        return (n.name === 'length' || n.name === 'size') && p !== undefined && ['array', 'string', 'set', 'map', 'other'].includes(p.kind)
      }
      case 'unary':
        return this.rootAllowed(n.arg)
      case 'bin':
        return n.op !== 'in' && n.op !== 'instanceof' && this.rootAllowed(n.left) && this.rootAllowed(n.right)
      case 'cond':
        return this.rootAllowed(n.test) && this.rootAllowed(n.yes) && this.rootAllowed(n.no)
      default:
        return false
    }
  }

  /**
   * A number parameter is a size where it can bound a loop: named in a
   * counting header, or held by a local as itself or less one (a binary
   * search's `hi`, or a guard through a local). Elsewhere it is a plain value,
   * such as a search target.
   */
  private collectSizedNumbers(body: Stmt[]): void {
    const holders: Node[] = []
    const held = (v: Node | undefined): void => {
      if (v?.k === 'bin' && v.op === '-' && numLit(v.right) === 1) v = v.left
      if (v?.k === 'id') holders.push(v)
    }
    for (const d of this.decls.values()) held(d.line.init)
    for (const a of this.assignments) held(a.value)
    someStmt(body, (s) => {
      if (s.k === 'for' && s.head.k === 'count') holders.push(...headNodes(s.head))
      return false
    })
    for (const p of this.params.values()) if (p.kind === 'numeric' && holders.some((h) => mentions(h, p.name))) this.sizedNumbers.add(p.name)
  }

  /** Locals holding a size (spec gate 10): assigned anywhere from an expression with a size in it. */
  private collectSizes(): void {
    for (let changed = true; changed; ) {
      changed = false
      for (const [name, d] of this.decls) {
        const values = [d.line.init, ...this.assignments.filter((a) => a.name === name).map((a) => a.value)]
        const found = new Set(this.sizeLocals.get(name))
        for (const v of values) if (v) for (const o of this.sizes(v)) found.add(o)
        if (found.size > (this.sizeLocals.get(name)?.size ?? 0)) {
          this.sizeLocals.set(name, found)
          changed = true
        }
      }
    }
  }

  // --- Hidden lines (spec "What the reader reads") -----------------------------

  private checkHidden(): void {
    if (this.lines.every((l) => !isBlankedLine(l))) return
    const bound = new Set([...this.params.keys(), ...this.decls.keys(), ...this.loopNames, this.unit.name])
    const hidden = this.unit.hidden
    if (!hidden) refuse()
    const scan = hiddenScan(this.lines)
    need(hidden((raw, at) => this.isHiddenOk(raw, at, bound, scan)) === true && scan.open === undefined)
  }

  private isHiddenOk(raw: string, at: number, bound: ReadonlySet<string>, scan: HiddenScan): boolean {
    const kept = this.lines[at]
    if (typeof raw !== 'string' || !Number.isInteger(at) || at <= this.opener || kept === undefined || !isBlankedLine(kept)) return false
    if (!isInert(raw, kept, 'TypeScript', bound, WORDS, this.places.get(at) ?? STRICT_PLACE, scan, at)) return false
    // A blanked opener is only an else (task 6 fix round 1: a hidden test may raise); its body runs at most once where it stands.
    return !this.openers.has(at) || /^\}?\s*else\s*\{/.test(raw.trim())
  }

  /** Whether the blanked line at `at` holds an exit word (only a boolean leaves `hidden`). */
  private hiddenExits(at: number): boolean {
    let seen = false
    const ok = this.unit.hidden?.((raw, k) => {
      if (k !== at) return true
      seen = true
      return /\b(?:return|throw)\b/.test(raw)
    })
    return ok === true && seen
  }

  // --- Flow (pass 1): loops, exits, dead code, conditions --------------------

  /** Conditions the statements after `s` stand behind: an if branch that may leave means its test was false. */
  private afterGuards(s: Stmt, depth: number): Entry[] {
    if (s.k !== 'if') return []
    return s.branches.filter((b) => mayTransfer(b.body)).map((b) => (b.cond ? { cond: b.cond, neg: true, depth } : { neg: false, depth, opaque: true }))
  }

  private checkFlow(list: Stmt[], env: Env): void {
    let path = env.path
    list.forEach((s, k) => {
      need(!alwaysTransfers(s) || k === list.length - 1)
      this.flowStmt(s, { ...env, path }, list, k)
      path = [...path, ...this.afterGuards(s, env.loops.length)]
    })
  }

  private flowStmt(s: Stmt, env: Env, list: Stmt[], k: number): void {
    const depth = env.loops.length
    switch (s.k) {
      case 'line':
        if (TRANSFERS.has(s.line.k)) {
          need(!env.hidden)
          this.checkExits(s.line.k, env)
        }
        for (const n of simpleNodes(s.line)) this.sizesIn(n, env, false)
        return
      case 'hidden':
        return
      case 'hblock':
        this.checkFlow(s.body, { ...env, hidden: true, path: [...env.path, { neg: false, depth, opaque: true }] })
        return
      case 'if': {
        const prev: Entry[] = []
        for (const b of s.branches) {
          if (b.cond) {
            need(!isTrivial(b.cond))
            // Task 6 fix round 3: outside loops, no comparison names one value on both sides (`k !== k + 1` always holds).
            if (depth === 0) {
              const names = (m: Node): Set<string> => {
                const out = new Set<string>()
                someNode(m, (c) => (c.k === 'id' ? (out.add(c.name), false) : false))
                return out
              }
              need(!someNode(b.cond, (m) => m.k === 'bin' && COMPARE.has(m.op) && [...names(m.left)].some((x) => names(m.right).has(x))))
            }
            // Family 2: outside loops, a test holds only literals, number and boolean parameters, a parameter's size and size-free locals.
            if (depth === 0) need(this.rootAllowed(b.cond))
            // Family 3: no test names two size sources.
            need(this.namedSizes(b.cond) <= 1)
            this.checkConsistent([...env.path, ...prev], b.cond)
            this.approveGuard(b, env)
            this.sizesIn(b.cond, env, true)
          }
          const own: Entry[] = b.cond ? [{ cond: b.cond, neg: false, depth }] : []
          this.checkFlow(b.body, { ...env, path: [...env.path, ...prev, ...own], chain: s })
          if (b.cond) prev.push({ cond: b.cond, neg: true, depth })
        }
        return
      }
      case 'for': {
        const loop = this.classifyLoop(s, env)
        if (s.head.k !== 'count') this.sizesIn(s.head.source, env, false)
        this.loops.set(s.at, loop)
        this.checkFlow(s.body, { ...env, loops: [...env.loops, loop], chain: undefined })
        return
      }
      case 'while': {
        const loop = this.isBinarySearch(s, list, k)
        this.loops.set(s.at, loop)
        this.checkFlow(s.body, { ...env, loops: [...env.loops, loop], chain: undefined })
        return
      }
      case 'cb': {
        const loop = this.blockLoop(s)
        for (const n of simpleNodes(s.line)) this.sizesIn(n, env, false)
        this.loops.set(s.at, loop)
        this.checkFlow(s.body, { ...env, loops: [...env.loops, loop], chain: undefined })
      }
    }
  }

  /**
   * Spec "Nesting and exits". An exit from a loop must sit behind a test the
   * input can always make false: an equality between an element and a value
   * from another source, or membership of an element in another parameter.
   * Its tests read only elements, parameters, derived values and calls on
   * them; it may not stand in an if chain whose every branch leaves.
   */
  private checkExits(kind: string, env: Env): void {
    const loops = env.loops
    const lastCallback = loops.findLastIndex((l) => l.kind === 'callback' || l.kind === 'comparator')
    if (kind === 'continue' || kind === 'break') need(loops.length > lastCallback + 1)
    if (kind === 'continue') return
    const exited = kind === 'throw' ? loops : kind === 'return' ? loops.slice(lastCallback + 1) : loops.slice(-1)
    if (exited.length === 0) return
    for (const l of exited) l.hasExit = true
    const outer = loops.indexOf(exited[0]!)
    const entries = env.path.filter((e) => e.depth > outer)
    // A binary search's own equality exit: `S[mid] === v`, S its number or string source, v a literal or another parameter.
    const only = exited.length === 1 ? exited[0]! : undefined
    if (only?.kind === 'search' && only.eqExit && entries.length === 1 && entries[0]!.cond === only.eqExit) {
      need(this.isSearchEquality(only.eqExit, only.index!))
      return
    }
    const elems = elementsOf(loops)
    need(entries.every((e) => !e.opaque && e.cond !== undefined && this.readsOnly(e.cond, elems)))
    const positives = entries.filter((e) => !e.neg).map((e) => e.cond!)
    need(positives.some((c) => conjuncts(c).some((a) => this.isFalsifiable(a, elems, loops))))
    const chain = env.chain
    need(!(chain?.hasElse && chain.branches.every((b) => endsInTransfer(b.body))))
  }

  private isSearchEquality(c: Node, mid: string): boolean {
    if (c.k !== 'bin' || (c.op !== '===' && c.op !== '==')) return false
    for (const [x, y] of [
      [c.left, c.right],
      [c.right, c.left],
    ] as const) {
      const src = x.k === 'index' && x.obj.k === 'id' && isId(x.index, mid) ? this.sourceOfName(x.obj.name) : undefined
      const other = isValueLit(y) || (y.k === 'id' && this.params.has(y.name) && x.k === 'index' && x.obj.k === 'id' && y.name !== x.obj.name)
      if (src && src.yields === undefined && (src.type === 'number' || src.type === 'string') && other) return true
    }
    return false
  }

  // --- Loops (spec "Loops") --------------------------------------------------

  private classifyLoop(s: Extract<Stmt, { k: 'for' }>, env: Env): Loop {
    const h = s.head
    if (h.k !== 'count') {
      const src = this.sourceOf(h.source, h.k)
      // An untyped or other-typed parameter may be a one-shot iterator: iterated inside a loop, it runs once.
      if (h.k === 'of' && h.source.k === 'id' && this.params.get(h.source.name)?.kind === 'other') need(env.loops.length === 0)
      const { elements, positions, numeric } = rolesOf(h.names, src, h.pattern)
      // An array's keys() and entries() walk it: their positions index it.
      const walker = src.numericKeys && h.source.k === 'call' && h.source.callee.k === 'member' && h.source.callee.obj.k === 'id' ? h.source.callee.obj.name : undefined
      return { at: s.at, kind: 'of', elements, positions, numeric, ...(walker ? { walks: walker } : {}), factor: factor({ size: src.origin, log: false, kind: 'loop', at: s.at, what: `loop over ${src.origin}` }), hasExit: false }
    }
    need(h.test.k === 'bin' && isId(h.test.left, h.name))
    const test = h.test as Extract<Node, { k: 'bin' }>
    const step = stepOf(h.step, h.name)
    const base = { at: s.at, index: h.name, numeric: [h.name], elements: new Map<string, Elem>(), hasExit: false }
    const loopOf = (size: string, kind: LoopKind, what: string, log = false): Loop => ({ ...base, kind, factor: factor({ size, log, kind: log ? 'halving' : 'loop', at: s.at, what }) })
    const start = numLit(h.init)
    const up = test.op === '<' || test.op === '<='
    const down = test.op === '>' || test.op === '>='
    // Both ends literal: a constant number of rounds.
    if (start !== undefined && numLit(test.right) !== undefined && ((step === 'up' && up) || (step === 'down' && down))) return { ...base, kind: 'literal', factor: ONE }
    if (step === 'up' && up) {
      const ref = test.right.k === 'id' ? env.loops.find((l) => l.index === (test.right as { name: string }).name && (l.kind === 'count' || l.kind === 'of')) : undefined
      if (ref) {
        // An inner bound that is an enclosing index: never under a halving loop, and from a literal start.
        need((start === 0 || start === 1) && !env.loops.some((l) => l.kind === 'halving' || l.kind === 'search'))
        return { ...base, kind: 'count', factor: ref.factor.map((t) => t.map((f) => ({ ...f, at: s.at }))) }
      }
      const size = this.boundOf(test.right, true)
      // From 0 while below p.length, step 1: the index walks p.
      const r = test.right
      const walks = start === 0 && test.op === '<' && r.k === 'member' && r.name === 'length' && r.obj.k === 'id' ? r.obj.name : undefined
      if (start === 0 || start === 1) return { ...loopOf(size, 'count', `loop over ${size}`), ...(walks ? { walks } : {}) }
      // From an enclosing index: that loop must run over the same size (or a literal count), or the sum is not n × m.
      const from = this.indexStart(h.init, env)
      const outer = env.loops.find((l) => l.index === from.from)!
      need(outer.kind === 'literal' || outer.factor.every((t) => t.every((f) => f.size === size)))
      return { ...loopOf(size, 'count', `loop over ${size}`), start: from }
    }
    if (step === 'down' && down && numLit(test.right) !== undefined) {
      const size = this.boundOf(h.init, true)
      return loopOf(size, 'count', `loop over ${size}`)
    }
    if (step === 'double' && up && start !== undefined && start > 0) {
      const size = this.boundOf(test.right, false)
      return loopOf(size, 'halving', `halving loop over ${size}`, true)
    }
    if (step === 'halve' && test.op === '>' && numLit(test.right) === 0) {
      const size = this.boundOf(h.init, false)
      return loopOf(size, 'halving', `halving loop over ${size}`, true)
    }
    refuse()
  }

  /** A start at an enclosing loop's index plus or minus a literal. */
  private indexStart(n: Node, env: Env): { from: string; plus: number } {
    const isIndex = (m: Node): m is { k: 'id'; name: string } => m.k === 'id' && env.loops.some((l) => l.index === m.name && l.kind !== 'search')
    if (isIndex(n)) return { from: n.name, plus: 0 }
    if (n.k === 'bin' && (n.op === '+' || n.op === '-') && isIndex(n.left)) {
      const k = numLit(n.right)
      if (k !== undefined) return { from: n.left.name, plus: n.op === '+' ? k : -k }
    }
    refuse()
  }

  /** A bound B: `S.length`, `S.size` of a parameter or derived value, or a number parameter (`B - 1` when allowed). */
  private boundOf(n: Node, minusOne: boolean): string {
    if (minusOne && n.k === 'bin' && n.op === '-' && numLit(n.right) === 1) n = n.left
    if (n.k === 'member' && (n.name === 'length' || n.name === 'size') && n.obj.k === 'id') {
      const s = this.sourceOfName(n.obj.name)
      if (s) return s.origin
    }
    if (n.k === 'id' && this.params.get(n.name)?.kind === 'numeric') return n.name
    refuse()
  }

  /** A parameter (not a number, boolean or fixed type) or a derived value, as a size source, with what its elements are. */
  private sourceOfName(name: string): Elem | undefined {
    const p = this.params.get(name)
    if (p) {
      switch (p.kind) {
        case 'array':
          return { origin: name, distinct: false, type: p.elem ?? 'opaque', atom: true, ...(p.shape ? { shape: p.shape } : {}), ...(p.props ? { props: p.props } : {}) }
        case 'string':
          return { origin: name, distinct: false, type: 'string', atom: true }
        case 'set':
          return { origin: name, distinct: true, type: p.elem ?? 'opaque', atom: true, ...(p.shape ? { shape: p.shape } : {}), ...(p.props ? { props: p.props } : {}) }
        case 'map':
          return { origin: name, distinct: true, yields: 'pairs', type: p.elem ?? 'opaque', key: p.key ?? 'opaque', atom: true, ...(p.shape ? { shape: p.shape } : {}), ...(p.props ? { props: p.props } : {}) }
        case 'other':
          return { origin: name, distinct: true, type: 'opaque', atom: true }
        default:
          return undefined
      }
    }
    const l = this.locals.get(name)
    if (l?.k !== 'derived') return undefined
    const { k: _, ...elem } = l
    return { ...elem, derived: true }
  }

  /** Spec "size source" for a for-of or for-in header; `yields` says when its values are indices, entries or pairs. */
  private sourceOf(n: Node, kind: 'of' | 'in'): Elem {
    if (n.k === 'id') {
      const p = this.params.get(n.name)
      if (kind === 'in') need(p !== undefined && (p.kind === 'array' || p.kind === 'other'))
      const s = this.sourceOfName(n.name)
      if (!s) refuse()
      // for-in yields keys: string indices of an array.
      return kind === 'in' ? { origin: s.origin, distinct: true, yields: 'keys', type: 'string', atom: false } : s
    }
    need(kind === 'of' && n.k === 'call' && n.callee.k === 'member')
    const call = n as Extract<Node, { k: 'call' }>
    const { obj, name: m } = call.callee as Extract<Node, { k: 'member' }>
    need(['keys', 'values', 'entries'].includes(m))
    if (isId(obj, 'Object')) {
      need(call.args.length === 1 && call.args[0]!.k === 'id')
      const name = (call.args[0] as { name: string }).name
      const p = this.params.get(name)
      need(p === undefined ? this.locals.get(name)?.k === 'derived' : p.kind === 'array' || p.kind === 'other')
      const s = this.sourceOfName(name)!
      need(s.yields === undefined)
      // Object.values copies, so its elements are no atoms; keys and entries hold string indices.
      if (m === 'values') return { origin: s.origin, distinct: true, type: s.type, atom: false }
      return { origin: s.origin, distinct: true, yields: m === 'keys' ? 'keys' : 'entries', type: s.type, atom: false }
    }
    need(call.args.length === 0 && obj.k === 'id')
    const name = (obj as { name: string }).name
    const p = this.params.get(name)
    need(p === undefined ? this.locals.get(name)?.k === 'derived' : ['array', 'set', 'map'].includes(p.kind))
    const s = this.sourceOfName(name)!
    need(s.yields === undefined || s.yields === 'pairs')
    if (p?.kind === 'map') {
      if (m === 'keys') return { origin: s.origin, distinct: true, type: s.key ?? 'opaque', atom: true }
      if (m === 'values') return { origin: s.origin, distinct: false, type: s.type, atom: true }
      return s
    }
    if (p?.kind === 'set') return m === 'entries' ? { ...s, yields: 'pairs', key: s.type } : s
    // An array's keys are numeric indices and its entries pair one with a value.
    if (m === 'keys') return { origin: s.origin, distinct: true, yields: 'keys', numericKeys: true, type: 'number', atom: false }
    if (m === 'entries') return { ...s, yields: 'entries', numericKeys: true }
    return s
  }

  /** A block callback's loop: an iteration builtin (not a short-circuit one) or a sort's comparator, on a typed array or derived value. */
  private blockLoop(s: Extract<Stmt, { k: 'cb' }>): Loop {
    const call = blockCall(s.line)
    const { obj, name: m } = call.callee as Extract<Node, { k: 'member' }>
    need(obj.k === 'id')
    const name = (obj as { name: string }).name
    const src = this.params.get(name)?.kind === 'array' || this.locals.get(name)?.k === 'derived' ? this.sourceOfName(name) : undefined
    if (!src) refuse()
    const arrow = call.args.at(-1) as Extract<Node, { k: 'arrow' }>
    if (SORTS.has(m)) return { at: s.at, kind: 'comparator', elements: new Map(), factor: ONE, hasExit: false }
    need(ITERATORS.has(m) && !SHORT.has(m))
    return this.callbackLoop(m, arrow.params, src, s.at, name)
  }

  /** `numericStart`: a reduce whose start is a number, so its accumulator holds one. */
  private callbackLoop(m: string, params: string[], src: Elem, at: number, recv: string, numericStart = false): Loop {
    const isReduce = m === 'reduce'
    need(params.length >= (isReduce ? 2 : 1) && params.length <= (isReduce ? 3 : 2))
    const element = params[isReduce ? 1 : 0]!
    const index = params[isReduce ? 2 : 1]
    const roles = rolesOf([element], src)
    const numeric = [...roles.numeric, ...(index ? [index] : []), ...(isReduce && numericStart ? [params[0]!] : [])]
    return { at, kind: 'callback', ...(index ? { index, walks: recv } : {}), positions: roles.positions, numeric, elements: roles.elements, factor: factor({ size: src.origin, log: false, kind: 'callback', at, what: `${m} over ${recv}` }), hasExit: false }
  }

  // --- Binary search (spec "Binary search") ------------------------------------

  private isBinarySearch(s: Extract<Stmt, { k: 'while' }>, list: Stmt[], k: number): Loop {
    const c = s.cond
    need(c.k === 'bin' && (c.op === '<=' || c.op === '<'))
    const cond = c as Extract<Node, { k: 'bin' }>
    need(cond.left.k === 'id' && cond.right.k === 'id')
    const lo = (cond.left as { name: string }).name
    const hi = (cond.right as { name: string }).name
    need(lo !== hi)
    const inclusive = cond.op === '<='
    // `lo = 0` and `hi = len - 1` (with <=) or `hi = len` (with <) just before the loop.
    const before = [list[k - 1], list[k - 2]].map((p) => (p?.k === 'line' && p.line.k === 'decl' && !p.line.isConst ? p.line : undefined))
    const loDecl = before.find((d) => d?.name === lo)
    const hiDecl = before.find((d) => d?.name === hi)
    need(numLit(loDecl?.init) === 0 && hiDecl?.init !== undefined)
    const hiInit = hiDecl!.init!
    if (inclusive) need(hiInit.k === 'bin' && hiInit.op === '-' && numLit(hiInit.right) === 1)
    const size = this.boundOf(inclusive ? (hiInit as Extract<Node, { k: 'bin' }>).left : hiInit, false)
    const first = s.body[0]
    need(first?.k === 'line' && first.line.k === 'decl' && first.line.init !== undefined)
    const midDecl = (first as { line: Extract<Simple, { k: 'decl' }> }).line
    const mid = midDecl.name
    need(isMidForm(midDecl.init!, lo, hi))
    // lo, hi and mid are assigned only in the listed forms, only inside this loop.
    const end = this.closers.get(s.at) ?? -1
    for (const a of this.assignments.filter((x) => x.name === lo || x.name === hi || x.name === mid)) {
      need(a.at > s.at && a.at < end && a.whole && a.op === '=' && a.value !== undefined && a.name !== mid)
      const v = a.value!
      if (a.name === lo) need(v.k === 'bin' && v.op === '+' && isId(v.left, mid) && numLit(v.right) === 1)
      else if (inclusive) need(v.k === 'bin' && v.op === '-' && isId(v.left, mid) && numLit(v.right) === 1)
      else need(isId(v, mid))
    }
    need(!someStmt(s.body, (x) => x.k === 'line' && x.line.k === 'continue'))
    need(isSearchBody(s.body.slice(1), lo, hi, mid))
    const eq = s.body.length === 3 && s.body[1]!.k === 'if' ? s.body[1]!.branches[0]!.cond : undefined
    for (const v of [lo, hi, mid]) this.searchVars.add(v)
    return { at: s.at, kind: 'search', index: mid, numeric: [mid], ...(eq ? { eqExit: eq } : {}), elements: new Map(), factor: factor({ size, log: true, kind: 'search', at: s.at, what: `binary search over ${size}` }), hasExit: false }
  }

  // --- Conditions: sizes (gate 10), elements and invariants ------------------

  /** The parameters whose sizes `n` holds, outside index brackets and arrow bodies. */
  private sizes(n: Node): Set<string> {
    const out = new Set<string>()
    const visit = (m: Node): void => {
      if (m.k === 'member' && (m.name === 'length' || m.name === 'size')) {
        const s = m.obj.k === 'id' ? this.sourceOfName(m.obj.name) : undefined
        // Any other length is a size the reader cannot name ('?'), unless it is an element's.
        if (s) out.add(s.origin)
        else if (!this.isElementValue(m.obj)) out.add('?')
        return
      }
      if (m.k === 'id') {
        if (this.sizedNumbers.has(m.name)) out.add(m.name)
        for (const o of this.sizeLocals.get(m.name) ?? []) out.add(o)
        return
      }
      if (m.k === 'index') return visit(m.obj)
      if (m.k === 'arrow') return
      childrenOf(m).forEach(visit)
    }
    visit(n)
    return out
  }

  /** An element: through an index read, or rooted at a loop name (element, index, arrow parameter). */
  private isElementValue(n: Node): boolean {
    while (n.k === 'member') n = n.obj
    return n.k === 'index' || (n.k === 'id' && this.loopNames.has(n.name))
  }

  /** How many size sources a test names ('?' sizes refuse elsewhere). */
  private namedSizes(n: Node): number {
    return [...this.sizes(n)].filter((o) => o !== '?').length
  }

  private directSize(n: Node): boolean {
    if (n.k === 'member' && (n.name === 'length' || n.name === 'size') && n.obj.k === 'id') return this.sourceOfName(n.obj.name) !== undefined
    return n.k === 'id' && this.sizedNumbers.has(n.name)
  }

  /** Spec gate 10's exception: `size === 0`-like tests reached through && and ||, in an if outside loops whose branch ends in an exit. */
  private approveGuard(b: Branch, env: Env): void {
    if (env.loops.length > 0 || env.hidden || !b.cond) return
    const found: Node[] = []
    const visit = (n: Node): void => {
      if (n.k === 'bin' && (n.op === '&&' || n.op === '||')) {
        visit(n.left)
        visit(n.right)
      } else if (n.k === 'bin' && Object.hasOwn(TINY, n.op) && this.directSize(n.left) && TINY[n.op]!.includes(numLit(n.right) ?? -1)) found.push(n)
      else if (n.k === 'unary' && n.op === '!' && this.directSize(n.arg)) found.push(n)
    }
    visit(b.cond)
    const last = b.body.at(-1)
    const exits = last?.k === 'line' ? last.line.k === 'return' || last.line.k === 'throw' : last?.k === 'hidden' && this.hiddenExits(last.at)
    if (found.length === 0 || !exits) return
    for (const n of found) this.tinyGuards.add(n)
    this.guardBranches.add(b.at)
  }

  /** Gate 10 over an expression: every comparison holding a size, and no size tested any other way. */
  private sizesIn(n: Node, env: Env, test: boolean): void {
    if (n.k === 'bin' && COMPARE.has(n.op)) {
      if (!this.tinyGuards.has(n)) this.checkComparison(n, env)
      this.sizesIn(n.left, env, false)
      this.sizesIn(n.right, env, false)
      return
    }
    if (n.k === 'bin' && (n.op === '&&' || n.op === '||' || n.op === '??')) {
      this.sizesIn(n.left, env, true)
      this.sizesIn(n.right, env, test)
      return
    }
    if (n.k === 'unary' && n.op === '!') {
      if (!this.tinyGuards.has(n)) this.sizesIn(n.arg, env, true)
      return
    }
    if (n.k === 'cond') {
      need(this.namedSizes(n.test) <= 1)
      this.sizesIn(n.test, env, true)
      this.sizesIn(n.yes, env, test)
      this.sizesIn(n.no, env, test)
      return
    }
    if (test) need(this.sizes(n).size === 0)
    if (n.k === 'call' && n.callee.k === 'member' && (SHORT.has(n.callee.name) || n.callee.name === 'filter') && n.args[0]?.k === 'arrow' && n.args[0].body !== 'block') {
      this.sizesIn(n.callee, env, false)
      this.sizesIn(n.args[0].body, env, true)
      n.args.slice(1).forEach((a) => this.sizesIn(a, env, false))
      return
    }
    for (const c of childrenOf(n)) this.sizesIn(c, env, false)
  }

  /** A size compared with another parameter's size or an enclosing loop's index, in plain arithmetic. */
  private checkComparison(n: Extract<Node, { k: 'bin' }>, env: Env): void {
    const left = this.sizes(n.left)
    const right = this.sizes(n.right)
    if (left.size === 0 && right.size === 0) return
    const indices = new Set(env.loops.flatMap((l) => (l.index && l.kind !== 'search' ? [l.index] : [])))
    const plain = (m: Node): boolean =>
      (m.k === 'lit' && m.kind === 'num') ||
      this.directSize(m) ||
      (m.k === 'id' && (this.sizeLocals.has(m.name) || indices.has(m.name))) ||
      (m.k === 'bin' && ARITHMETIC.has(m.op) && plain(m.left) && plain(m.right)) ||
      (m.k === 'unary' && (m.op === '-' || m.op === '+') && plain(m.arg))
    need(plain(n.left) && plain(n.right) && !left.has('?') && !right.has('?'))
    // Family 3: two sizes compared, in any form, may force them equal.
    need(left.size === 0 || right.size === 0)
    need(someNode(left.size > 0 ? n.right : n.left, (m) => m.k === 'id' && indices.has(m.name)))
  }

  /** Spec exits: a test reads only elements, element reads `p[i]`, parameters, derived values and calls on them. */
  private readsOnly(n: Node, elems: ReadonlyMap<string, Elem>): boolean {
    switch (n.k) {
      case 'lit':
        return true
      case 'id':
        return this.params.has(n.name) || this.locals.get(n.name)?.k === 'derived' || elems.has(n.name)
      case 'member':
        return this.readsOnly(n.obj, elems)
      case 'index':
        return (n.obj.k === 'id' && this.sourceOfName(n.obj.name) !== undefined) || (this.readsOnly(n.obj, elems) && this.readsOnly(n.index, elems))
      case 'call': {
        const c = n.callee
        const callee = c.k === 'member' ? isId(c.obj, 'Math') || this.readsOnly(c.obj, elems) : c.k === 'id' && !this.isBound(c.name) && !GLOBALS.has(c.name)
        return callee && n.args.every((a) => this.readsOnly(a, elems))
      }
      case 'unary':
      case 'bin':
      case 'cond':
        return childrenOf(n).every((c) => this.readsOnly(c, elems))
      default:
        return false
    }
  }

  /** The same for every iteration of every loop: literals, parameters, derived values, and builtins on them. */
  private isInvariant(n: Node): boolean {
    switch (n.k) {
      case 'lit':
        return true
      case 'id':
        return this.params.has(n.name) || this.locals.get(n.name)?.k === 'derived'
      case 'member':
        return this.isInvariant(n.obj)
      case 'index':
        return this.isInvariant(n.obj) && this.isInvariant(n.index)
      case 'call':
        return n.callee.k === 'member' && this.isInvariant(n.callee.obj) && n.args.every((a) => this.isInvariant(a))
      case 'unary':
      case 'bin':
      case 'cond':
        return childrenOf(n).every((c) => this.isInvariant(c))
      default:
        return false
    }
  }

  /** An element (a loop's element, or `p[i]` of a parameter or derived value), possibly through properties. */
  private elemRef(n: Node, elems: ReadonlyMap<string, Elem>, loops: Loop[] = []): ElemRef | undefined {
    let chain = false
    for (;;) {
      if (n.k === 'id') {
        const e = elems.get(n.name)
        return e?.atom ? { ...e, chain } : undefined
      }
      if (n.k === 'index' && n.obj.k === 'id' && !elems.has(n.obj.name)) {
        // p[pos] is p's element only when pos walks p (ruling A).
        const s = this.sourceOfName(n.obj.name)
        const p = n.obj.name
        const pos = n.index.k === 'id' ? n.index.name : undefined
        const walks = pos !== undefined && loops.some((l) => l.walks === p && (l.index === pos || l.positions?.includes(pos)))
        return s && s.yields === undefined && s.atom && walks ? { ...s, chain, pos } : undefined
      }
      if ((n.k === 'member' && n.name !== 'length' && n.name !== 'size') || (n.k === 'index' && n.index.k === 'lit')) {
        n = n.obj
        chain = true
        continue
      }
      return undefined
    }
  }

  /** A value from a source: an element, or a parameter or derived value (through properties). */
  private valueRef(n: Node, elems: ReadonlyMap<string, Elem>, loops: Loop[] = []): ElemRef | undefined {
    const e = this.elemRef(n, elems, loops)
    if (e) return e
    while (n.k === 'member') n = n.obj
    if (n.k !== 'id') return undefined
    if (this.params.has(n.name)) return { origin: n.name, distinct: false, type: 'opaque', atom: false, chain: false }
    const l = this.locals.get(n.name)
    return l?.k === 'derived' ? { origin: l.origin, distinct: l.distinct, type: l.type, atom: false, chain: false } : undefined
  }

  /** Two element reads of one source at positions that never meet: `j` counts up from `i + k`, k ≥ 1. */
  private apart(a: ElemRef, b: ElemRef, loops: Loop[]): boolean {
    if (!a.pos || !b.pos || a.pos === b.pos || a.pos === '#' || b.pos === '#') return false
    const after = (x: string, y: string): boolean => loops.some((l) => l.index === x && l.kind === 'count' && l.start?.from === y && l.start.plus >= 1)
    return after(a.pos, b.pos) || after(b.pos, a.pos)
  }

  private differs(e: ElemRef, v: ElemRef | undefined, loops: Loop[]): boolean {
    return v !== undefined && (v.origin !== e.origin || this.apart(e, v, loops))
  }

  /** `S.includes(e)` / `S.has(e)` with S a typed parameter or derived value from another source than e. */
  private isMembership(n: Node, elems: ReadonlyMap<string, Elem>, loops: Loop[] = []): boolean {
    if (n.k !== 'call' || n.callee.k !== 'member' || n.callee.obj.k !== 'id' || n.args.length !== 1) return false
    const m = n.callee.name
    const recv = n.callee.obj.name
    const local = this.locals.get(recv)
    const kind = this.params.get(recv)?.kind ?? (local?.k === 'derived' && local.yields === undefined ? 'array' : undefined)
    if (!((m === 'includes' && kind === 'array') || (m === 'has' && (kind === 'set' || kind === 'map')))) return false
    const e = this.elemRef(n.args[0]!, elems, loops)
    return e !== undefined && e.origin !== this.sourceOfName(recv)?.origin
  }

  /** A test the input can make false at every iteration (spec exits; see `checkExits`). */
  private isFalsifiable(a: Node, elems: ReadonlyMap<string, Elem>, loops: Loop[]): boolean {
    // Ruling E: only `===`/`==` on a number or string element itself (an infinite domain), against a literal
    // or a value from another source. Membership, orderings, `!==`, booleans, unions and named types refuse.
    if (a.k !== 'bin' || (a.op !== '===' && a.op !== '==')) return false
    for (const [x, y] of [
      [a.left, a.right],
      [a.right, a.left],
    ] as const) {
      const e = this.elemRef(x, elems, loops)
      if (e && !e.chain && (e.type === 'number' || e.type === 'string') && (isValueLit(y) || this.differs(e, this.valueRef(y, elems, loops), loops))) return true
    }
    return false
  }

  /**
   * How a test that varies by iteration can be made true at every one: by
   * avoiding values (`!==`, not a member) or by choosing them (`===` on a
   * source that may repeat, an ordering, membership). Anything else refuses.
   */
  private verifiable(a: Node, elems: ReadonlyMap<string, Elem>, loops: Loop[]): 'avoid' | 'choose' {
    if (a.k === 'unary' && a.op === '!' && this.isMembership(a.arg, elems, loops)) return 'avoid'
    if (this.isMembership(a, elems, loops)) return 'choose'
    if (a.k === 'bin') {
      for (const [x, y] of [
        [a.left, a.right],
        [a.right, a.left],
      ] as const) {
        const e = this.elemRef(x, elems, loops)
        if (!e) continue
        const v = isValueLit(y) ? undefined : this.valueRef(y, elems, loops)
        if (!isValueLit(y) && !this.differs(e, v, loops)) continue
        if (a.op === '!==' || a.op === '!=') return 'avoid'
        if ((a.op === '===' || a.op === '==') && (e.chain || !e.distinct)) return 'choose'
        if (ORDER.has(a.op) && v !== undefined) return 'choose'
      }
    }
    refuse()
  }

  /**
   * Costly work inside a loop counts at every iteration only when the tests
   * on its path can all hold at once at every iteration: tests that do not
   * vary, plus either tests that avoid values, or one test that chooses them
   * (and then no exit from those loops, which must be avoided too).
   */
  private takeable(env: Env): void {
    const entries = env.path.filter((e) => e.depth >= 1)
    if (entries.length === 0) return
    need(entries.every((e) => !e.opaque && e.cond !== undefined))
    const elems = elementsOf(env.loops)
    const kinds: ('avoid' | 'choose')[] = []
    for (const e of entries) {
      if (this.isInvariant(e.cond!)) continue
      for (const a of e.neg ? [negate(e.cond!)] : conjuncts(e.cond!)) if (!this.isInvariant(a)) kinds.push(this.verifiable(a, elems, env.loops))
    }
    if (kinds.includes('choose')) need(kinds.length === 1 && !env.loops.some((l) => l.hasExit))
  }

  /** A filter's test the input can make true for every element (see `takeable`); no exceptions escape. */
  private canHoldAlways(test: Node, elems: ReadonlyMap<string, Elem>): boolean {
    try {
      const kinds = conjuncts(test).filter((a) => !this.isInvariant(a)).map((a) => this.verifiable(a, elems, []))
      return this.readsOnly(test, elems) && (!kinds.includes('choose') || kinds.length === 1)
    } catch {
      return false
    }
  }

  /**
   * Two tests that do not vary, on one path (at any depth), may contradict
   * each other (`k > 0` then `k < 0`) and leave a branch that never runs:
   * refuse any two that name the same value.
   */
  private checkConsistent(path: Entry[], cond: Node): void {
    const atoms = [...path.flatMap((e) => (e.cond === undefined ? [] : e.neg ? [e.cond] : conjuncts(e.cond))), ...conjuncts(cond)].filter((a) => this.isInvariant(a))
    const seen = new Set<string>()
    for (const a of atoms) {
      const refs = refsOf(a)
      need(![...refs].some((r) => seen.has(r)))
      for (const r of refs) seen.add(r)
    }
  }

  // --- Conditions: the read-once grammar (task 6 fix round 4) -------------------

  /**
   * Spec "Stricter readings", the condition grammar: a test that guards an
   * exit, costly work or a size is &&, || and ! over atoms, and no named value
   * (read through locals) is in two atoms. An atom is a bare boolean, a bare
   * `.length`/`.size`, `A op B` of two named values of one type or of a named
   * value and a finite literal of its type, or an element's membership in
   * another source (`isMembership`). Ternaries, typeof,
   * arithmetic and any other form refuse. Read-once atoms that each vary over
   * distinct values make a test no input leaves constant.
   */
  private checkGrammar(cond: Node, env: Env): void {
    const seen = new Set<string>()
    const walk = (n: Node): void => {
      if (n.k === 'bin' && (n.op === '&&' || n.op === '||')) {
        walk(n.left)
        walk(n.right)
        return
      }
      if (n.k === 'unary' && n.op === '!') return walk(n.arg)
      for (const r of this.atomRoots(n, env)) {
        need(!seen.has(r))
        seen.add(r)
      }
    }
    walk(cond)
  }

  /** The values one atom reads; anything but an atom refuses. */
  private atomRoots(n: Node, env: Env): Set<string> {
    if (n.k === 'bin' && COMPARE.has(n.op)) {
      const l = this.named(n.left, env)
      const r = this.named(n.right, env)
      const lit = (m: Node): GrammarType | undefined => {
        if (m.k === 'unary' && (m.op === '-' || m.op === '+')) m = m.arg
        if (m.k !== 'lit') return undefined
        if (m.kind === 'num') return m.v !== undefined && Number.isFinite(m.v) ? 'number' : undefined
        return m.kind === 'str' ? 'string' : undefined
      }
      if (l && r) {
        need(l.type === r.type && [...l.roots].every((x) => !r.roots.has(x)))
        if (l.type === 'boolean') need(EQUALITY.has(n.op))
        return new Set([...l.roots, ...r.roots])
      }
      const one = l ?? r
      if (!one) refuse()
      // A boolean takes no literal: `b === true` reads as `b`.
      need(one.type !== 'boolean' && lit(l ? n.right : n.left) === one.type)
      return one.roots
    }
    // Membership of an element in another source (`ids.includes(x)`), as `isMembership` reads it.
    if (n.k === 'call' && n.callee.k === 'member' && n.callee.obj.k === 'id' && this.isMembership(n, elementsOf(env.loops), env.loops)) {
      const e = this.named(n.args[0]!, env)
      need(e !== undefined && !e.roots.has(n.callee.obj.name))
      return new Set([n.callee.obj.name, ...e!.roots])
    }
    const v = this.named(n, env)
    need(v !== undefined && (v.type === 'boolean' || (n.k === 'member' && (n.name === 'length' || n.name === 'size'))))
    return v!.roots
  }

  /**
   * A single named value, its type and the values it reads: a number, boolean
   * or string parameter; a typed element or element read at a loop's index; a
   * loop number; a binary search's lo, hi or mid; a `.length`/`.size` of a
   * source; or a local never assigned after its declaration that holds one of
   * these (a number plus or minus a finite literal), read through to it.
   */
  private named(n: Node, env: Env, seen = new Set<string>()): { type: GrammarType; roots: Set<string> } | undefined {
    const typed = (t: ElemType | undefined): GrammarType | undefined => (t === 'number' || t === 'string' || t === 'boolean' ? t : undefined)
    switch (n.k) {
      case 'id': {
        const name = n.name
        const p = this.params.get(name)
        if (p) {
          const type = p.kind === 'numeric' ? 'number' : p.kind === 'bool' ? 'boolean' : p.kind === 'string' ? 'string' : undefined
          return type && { type, roots: new Set([name]) }
        }
        const e = elementsOf(env.loops).get(name)
        if (e) {
          const type = typed(e.type)
          return type && { type, roots: new Set([name]) }
        }
        if (this.loopNumeric(name, env) || this.searchVars.has(name)) return { type: 'number', roots: new Set([name]) }
        const d = this.decls.get(name)
        if (!d?.line.init || this.locals.get(name)?.k !== 'local' || seen.has(name) || this.assignments.some((a) => a.name === name)) return undefined
        seen.add(name)
        let init = d.line.init
        const offset = init.k === 'bin' && (init.op === '+' || init.op === '-') && numLit(init.right) !== undefined && Number.isFinite(numLit(init.right))
        if (offset) init = (init as Extract<Node, { k: 'bin' }>).left
        const v = this.named(init, env, seen)
        if (!v || (offset && v.type !== 'number')) return undefined
        return { type: v.type, roots: new Set([name, ...v.roots]) }
      }
      case 'member': {
        if ((n.name !== 'length' && n.name !== 'size') || n.obj.k !== 'id') return undefined
        const obj = n.obj.name
        const ok = this.sourceOfName(obj) !== undefined || elementsOf(env.loops).get(obj)?.type === 'string'
        return ok ? { type: 'number', roots: new Set([obj]) } : undefined
      }
      case 'index': {
        if (n.obj.k !== 'id' || n.index.k !== 'id' || !this.loopNumeric(n.index.name, env)) return undefined
        const s = this.sourceOfName(n.obj.name)
        const type = s && s.yields === undefined ? typed(s.type) : undefined
        return type && { type, roots: new Set([`${n.obj.name}[${n.index.name}]`, n.index.name]) }
      }
      default:
        return undefined
    }
  }

  /** A body that holds a loop or callback, or names a size: a test in front of it decides a cost. */
  private touchesSize(body: Stmt[]): boolean {
    return someStmt(body, (s) => s.k === 'for' || s.k === 'while' || s.k === 'cb' || s.k === 'hblock' || stmtNodes(s).some((n) => this.sizes(n).size > 0))
  }

  private costly(env: Env, c: Cost): Cost {
    if (env.loops.length > 0 && hasFactors(c)) this.takeable(env)
    return c
  }

  // --- Cost (pass 2) -----------------------------------------------------------

  private costOfBlock(list: Stmt[], env: Env): Cost {
    let total = NOTHING
    let path = env.path
    for (const s of list) {
      total = add(total, this.costOfStmt(s, { ...env, path }))
      path = [...path, ...this.afterGuards(s, env.loops.length)]
    }
    return total
  }

  private costOfStmt(s: Stmt, env: Env): Cost {
    const depth = env.loops.length
    switch (s.k) {
      case 'line':
        return this.costOfLine(s.line, { ...env, at: s.at })
      case 'hidden':
        return NOTHING
      case 'hblock': {
        // A hidden if's test is unknown (it may never hold): its body must cost 1.
        const body = this.costOfBlock(s.body, { ...env, path: [...env.path, { neg: false, depth, opaque: true }] })
        need(!hasFactors(body))
        return body
      }
      case 'if': {
        let total = NOTHING
        const prev: Entry[] = []
        let guards = depth === 0
        for (const b of s.branches) {
          const here = { ...env, at: b.at, path: [...env.path, ...prev] }
          if (b.cond) total = add(total, this.cost(b.cond, here, 'test'))
          const body = this.costOfBlock(b.body, { ...here, path: b.cond ? [...here.path, { cond: b.cond, neg: false, depth }] : here.path })
          // A tiny guard's branch, and a branch that leaves a loop, run at most once.
          if (this.guardBranches.has(b.at) || (depth > 0 && mayExit(b.body))) need(!hasFactors(body))
          if (hasFactors(body) || mayTransfer(b.body) || this.touchesSize(b.body)) guards = true
          total = add(total, body)
          if (b.cond) prev.push({ cond: b.cond, neg: true, depth })
        }
        // Task 6 fix round 4: a chain that guards an exit, costly work or a size (any chain outside loops) reads every test by the grammar.
        if (guards) for (const b of s.branches) if (b.cond) this.checkGrammar(b.cond, env)
        return total
      }
      case 'for': {
        const loop = this.loops.get(s.at)!
        const header = s.head.k === 'count' ? NOTHING : this.headerCost(s.head.source, { ...env, at: s.at })
        const body = this.costOfBlock(s.body, { ...env, loops: [...env.loops, loop] })
        return add(header, this.costly({ ...env, at: s.at }, mul(loop.factor, add(ONE, body))))
      }
      case 'while': {
        const loop = this.loops.get(s.at)!
        this.checkGrammar(s.cond, env)
        const body = this.costOfBlock(s.body, { ...env, loops: [...env.loops, loop] })
        return this.costly({ ...env, at: s.at }, mul(loop.factor, add(ONE, body)))
      }
      case 'cb':
        return this.costOfLine(s.line, { ...env, at: s.at, block: s.body })
    }
  }

  /** A for-of header that calls a counted builtin adds it once (spec "Loops"). */
  private headerCost(n: Node, env: Env): Cost {
    if (n.k !== 'call' || n.callee.k !== 'member') return NOTHING
    const { obj, name: m } = n.callee
    const name = n.args[0]?.k === 'id' ? n.args[0].name : obj.k === 'id' ? obj.name : ''
    const counted = isId(obj, 'Object') || this.params.get(name)?.kind === 'array' || this.locals.get(name)?.k === 'derived'
    return counted ? this.site(env, name, 'builtin', `${isId(obj, 'Object') ? 'Object.' : ''}${m} of ${name}`) : NOTHING
  }

  private costOfLine(line: Simple, env: Env): Cost {
    switch (line.k) {
      case 'decl': {
        const init = line.init
        const c = init ? this.cost(init, env) : NOTHING
        // Proven where declared (family 4, 5): every later write must keep it (`costOfAssign`).
        if (this.locals.get(line.name)?.k === 'local') {
          if (line.type === 'numeric' || (init && this.isNumeric(init, env))) this.numericLocals.add(line.name)
          if (line.type !== undefined || (init && this.isScalar(init, env))) this.scalarLocals.add(line.name)
        }
        return c
      }
      case 'expr':
        return this.cost(line.node, env, 'stmt')
      case 'return':
        return line.node ? this.cost(line.node, env, 'ret') : NOTHING
      case 'throw':
        return this.cost(line.node, env)
      default:
        return NOTHING
    }
  }

  /** One linear factor over `recv`'s source, at the current line. */
  private site(env: Env, recv: string, kind: 'builtin' | 'callback', what: string): Cost {
    const src = this.sourceOfName(recv)
    if (!src) refuse()
    return this.costly(env, factor({ size: src.origin, log: false, kind, at: env.at, what }))
  }

  private cost(n: Node, env: Env, ctx: Ctx = 'value'): Cost {
    const depth = env.loops.length
    switch (n.k) {
      case 'lit':
      case 'this':
        return NOTHING
      case 'id':
        this.checkBare(n.name, ctx)
        return NOTHING
      case 'member':
        return this.costOfMember(n, env)
      case 'index':
        need(!(n.obj.k === 'id' && GLOBALS.has(n.obj.name)) && !this.mayBeStringParam(n.index) && this.isFixedOperand(n.index, env))
        // A read at a fixed position probes the size (`items[16] !== undefined`).
        // So does any read by position on a call's or literal's result.
        if ((n.obj.k === 'id' && this.isSequence(n.obj.name)) || !['id', 'member', 'index'].includes(n.obj.k)) need(this.isPosition(n.index, env))
        // Task 6 fix round 2: an index read throws on null or undefined, as a property read does.
        need(this.isPropertyReceiver(n.obj, env))
        return add(this.costOfObject(n.obj, env), this.cost(n.index, env))
      case 'call':
        return this.costOfCall(n, env, ctx)
      case 'new':
        return this.costOfNew(n, env)
      case 'unary':
        return this.cost(n.arg, env, n.op === '!' || n.op === 'typeof' ? 'test' : 'value')
      case 'update':
        return this.costOfAssign(n.arg, n.op, undefined, env)
      case 'assign':
        return this.costOfAssign(n.target, n.op, n.value, env)
      case 'bin':
        if (n.op === '&&' || n.op === '||' || n.op === '??') {
          if (n.op !== '??') this.checkConsistent(env.path, n.left)
          const guard: Entry = n.op === '??' ? { neg: false, depth, opaque: true } : { cond: n.left, neg: n.op === '||', depth }
          const arm = ctx === 'test' || ctx === 'ret' ? ctx : 'value'
          const right = this.cost(n.right, { ...env, path: [...env.path, guard] }, arm)
          // Outside loops, a test that guards costly work holds only what a root condition may (family 2).
          if (depth === 0 && hasFactors(right)) need(n.op !== '??' && this.rootAllowed(n.left))
          // Task 6 fix round 4: a left operand that guards costly work or a size takes the grammar.
          if (hasFactors(right) || this.sizes(n.right).size > 0) {
            need(n.op !== '??')
            this.checkGrammar(n.left, env)
          }
          return add(this.cost(n.left, env, n.op === '??' ? (ctx === 'ret' ? 'ret' : 'value') : 'test'), right)
        }
        if (n.op === 'in' && n.right.k === 'id' && this.isSequence(n.right.name)) need(this.isPosition(n.left, env))
        if (n.op === 'in' && n.right.k !== 'id') need(this.isPosition(n.left, env))
        // Task 7 fix round 1, ruling D: comparing (or hashing, for `in`) a whole string parameter costs its length.
        if (COMPARE.has(n.op) || n.op === 'in') need(!this.mayBeStringParam(n.left) && !this.mayBeStringParam(n.right))
        // Task 7 fix round 2, ruling D′: both sides of a comparison, and the needle of `in`, are fixed-cost operands.
        if (COMPARE.has(n.op)) need(this.isFixedOperand(n.left, env) && this.isFixedOperand(n.right, env))
        if (n.op === 'in') need(this.isFixedOperand(n.left, env))
        if (COMPARE.has(n.op) || n.op === 'in') return add(this.cost(n.left, env, 'compare'), this.cost(n.right, env, 'compare'))
        // + joins strings unless both sides are proven numbers (family 5).
        if (n.op === '+') need(this.isNumeric(n.left, env) && this.isNumeric(n.right, env))
        return add(this.cost(n.left, env), this.cost(n.right, env))
      case 'cond': {
        need(!isTrivial(n.test))
        this.checkConsistent(env.path, n.test)
        const arm = ctx === 'test' || ctx === 'ret' ? ctx : 'value'
        const yes = this.cost(n.yes, { ...env, path: [...env.path, { cond: n.test, neg: false, depth }] }, arm)
        const no = this.cost(n.no, { ...env, path: [...env.path, { cond: n.test, neg: true, depth }] }, arm)
        if (depth === 0 && (hasFactors(yes) || hasFactors(no))) need(this.rootAllowed(n.test))
        // Task 6 fix round 4: a test that picks costly work or a size takes the grammar.
        if (hasFactors(yes) || hasFactors(no) || this.sizes(n.yes).size > 0 || this.sizes(n.no).size > 0) this.checkGrammar(n.test, env)
        return add(this.cost(n.test, env, 'test'), add(yes, no))
      }
      case 'array':
      case 'object':
        return n.items.reduce((c, it) => add(c, it.k === 'spread' ? this.costOfSpread(it.arg, env, n.k) : this.cost(it, env)), NOTHING)
      default:
        // A spread outside a literal or a listed call, or an arrow outside an iteration callback (gate 5).
        refuse()
    }
  }

  /** A name read as a whole value: a collection, or any local not proven scalar, may only be tested, compared or returned (never aliased or handed on). */
  private checkBare(name: string, ctx: Ctx): void {
    need(name !== this.unit.name && !GLOBALS.has(name) && !FAILS.has(name))
    const p = this.params.get(name)
    const l = this.locals.get(name)
    const collection = (p !== undefined && p.kind !== 'numeric' && p.kind !== 'bool') || l?.k === 'derived' || l?.k === 'acc' || (l?.k === 'local' && !this.scalarLocals.has(name))
    if (collection) need(ctx === 'test' || ctx === 'ret' || ctx === 'compare')
  }

  /** What a receiver is: a parameter's kind, a local's kind (`scalar` when proven, else `closed`), or `expr` for anything but a name. */
  private receiverOf(obj: Node): Kind | 'derived' | 'acc' | 'scalar' | 'closed' | 'plain' | 'expr' {
    if (obj.k !== 'id') return 'expr'
    const p = this.params.get(obj.name)
    if (p) return p.kind
    const l = this.locals.get(obj.name)
    if (l?.k === 'derived' || l?.k === 'acc') return l.k
    if (l?.k === 'local') return this.scalarLocals.has(obj.name) ? 'scalar' : 'closed'
    return 'plain'
  }

  /** A loop's index (counting, halving, search `mid`, callback index, keys), plus or minus a literal; a literal loop's is a fixed position. */
  private isPosition(n: Node | undefined, env: Env): boolean {
    if (n?.k === 'bin' && (n.op === '+' || n.op === '-') && numLit(n.right) !== undefined) n = n.left
    if (n?.k !== 'id') return false
    const name = n.name
    return env.loops.some((l) => (l.kind !== 'literal' && l.index === name) || l.positions?.includes(name))
  }

  /**
   * Ruling B (fix round 3): a value is plain only when proven — a literal, a
   * number or boolean parameter, element or element read, `.length`/`.size`,
   * a proven-scalar local or loop number, and arithmetic or comparisons of
   * these. Everything else (call results, other elements, any other node) is
   * opaque: it takes no method call and is handed to no call but as a key or a
   * pushed value.
   */
  private isPlainValue(n: Node, env: Env): boolean {
    switch (n.k) {
      case 'lit':
        return n.kind !== 're'
      case 'id': {
        const p = this.params.get(n.name)
        const t = elementsOf(env.loops).get(n.name)?.type
        return p?.kind === 'numeric' || p?.kind === 'bool' || t === 'number' || t === 'boolean' || this.scalarLocals.has(n.name) || this.loopNumeric(n.name, env)
      }
      case 'member':
        return n.name === 'length' || n.name === 'size'
      case 'index': {
        const t = n.obj.k === 'id' ? this.sourceOfName(n.obj.name) : undefined
        return t !== undefined && t.yields === undefined && (t.type === 'number' || t.type === 'boolean')
      }
      case 'unary':
        return ['-', '+', '!', '~', 'typeof'].includes(n.op) && this.isPlainValue(n.arg, env)
      case 'update':
        return true
      case 'bin':
        return COMPARE.has(n.op) || (this.isPlainValue(n.left, env) && this.isPlainValue(n.right, env))
      case 'cond':
        return this.isPlainValue(n.yes, env) && this.isPlainValue(n.no, env)
      default:
        return false
    }
  }

  private isOpaqueValue(n: Node, env: Env): boolean {
    return !this.isPlainValue(n, env)
  }

  /** A string or number value the reader can see (ruling C): its methods are the closed O(1) list only. */
  private isPrimitiveValue(n: Node, env: Env): boolean {
    if (this.isPlainValue(n, env)) return true
    if (n.k === 'lit') return n.kind === 'str'
    if (n.k === 'id') return elementsOf(env.loops).get(n.name)?.type === 'string'
    if (n.k === 'index' && n.obj.k === 'id') return this.sourceOfName(n.obj.name)?.type === 'string'
    return false
  }

  /**
   * Task 7 fix round 2, ruling D′ (an allowlist): a comparison operand, a
   * needle or a key costs 1 only when it is a finite number literal or a plain
   * string literal; a parameter typed exactly `number`; a proven number local,
   * a loop number or a binary search's lo, hi or mid; an element bound
   * directly over a parameter (never a derived value's); a read `p[i]`,
   * `s.charAt(i)`, `s.charCodeAt(i)`, `s.codePointAt(i)` or `s.at(i)` of a
   * parameter at an index that walks it; or arithmetic over these, or
   * `.length`/`.size` of a parameter. Anything else refuses.
   */
  private isFixedOperand(n: Node, env: Env): boolean {
    // A position that walks the parameter, or a binary search's mid over it.
    const walked = (obj: Node, i: Node | undefined): boolean => obj.k === 'id' && this.params.has(obj.name) && i?.k === 'id' && env.loops.some((l) => ((l.index === i.name || l.positions?.includes(i.name)) && l.walks === obj.name) || (l.kind === 'search' && l.index === i.name && l.factor[0]?.[0]?.size === obj.name))
    switch (n.k) {
      case 'lit':
        return n.kind === 'num' ? n.v !== undefined && Number.isFinite(n.v) : n.kind === 'str'
      case 'id': {
        const e = elementsOf(env.loops).get(n.name)
        if (e) return e.atom && !e.derived
        const p = this.params.get(n.name)
        if (p) return p.kind === 'numeric'
        return this.loopNumeric(n.name, env) || this.searchVars.has(n.name) || this.numericLocals.has(n.name)
      }
      case 'unary':
        return (n.op === '-' || n.op === '+') && this.isFixedOperand(n.arg, env)
      case 'bin':
        return ['+', '-', '*', '/', '%'].includes(n.op) && this.isFixedOperand(n.left, env) && this.isFixedOperand(n.right, env)
      case 'member':
        return (n.name === 'length' || n.name === 'size') && n.obj.k === 'id' && ['array', 'string', 'set', 'map'].includes(this.params.get(n.obj.name)?.kind ?? '')
      case 'index':
        return walked(n.obj, n.index)
      case 'call':
        return n.callee.k === 'member' && ['charAt', 'charCodeAt', 'codePointAt', 'at'].includes(n.callee.name) && n.args.length === 1 && this.params.get(n.callee.obj.k === 'id' ? n.callee.obj.name : '')?.kind === 'string' && walked(n.callee.obj, n.args[0])
      default:
        return false
    }
  }

  /** Ruling D′ for derived collections: every name in a map or filter callback's body is its own parameter or a fixed-cost operand. */
  private isFixedBody(n: Node, own: readonly string[], env: Env): boolean {
    if (this.isFixedOperand(n, env) || (n.k === 'id' && own.includes(n.name))) return true
    if (['id', 'this', 'arrow', 'new', 'call', 'member'].includes(n.k) && !(n.k === 'member' && n.obj.k === 'id' && own.includes(n.obj.name))) return n.k === 'member' ? false : n.k === 'call' ? this.isFixedCall(n as Extract<Node, { k: 'call' }>, own, env) : false
    return childrenOf(n).every((c) => this.isFixedBody(c, own, env))
  }

  /** A call in a derived collection's callback: only a method of the callback's own parameter, with fixed-cost arguments. */
  private isFixedCall(n: Extract<Node, { k: 'call' }>, own: readonly string[], env: Env): boolean {
    return n.callee.k === 'member' && n.callee.obj.k === 'id' && own.includes(n.callee.obj.name) && n.args.every((a) => this.isFixedBody(a, own, env))
  }

  /**
   * Task 7 fix round 1, ruling D: a value that may be a whole string
   * parameter (the parameter, a local any write of which may be one, or an
   * arm of `?:`, `&&`, `||` or `??` that may be). Its length is a size, so
   * comparing, searching or hashing it costs that size: it is never an
   * operand of a comparison or `in`, an index, or a collection method's
   * argument (but `push`). `.length` and single characters stay.
   */
  private mayBeStringParam(n: Node, seen = new Set<string>()): boolean {
    switch (n.k) {
      case 'id': {
        if (this.params.get(n.name)?.kind === 'string') return true
        const d = this.decls.get(n.name)
        if (!d || seen.has(n.name)) return false
        seen.add(n.name)
        const values = [d.line.init, ...this.assignments.filter((a) => a.name === n.name).map((a) => a.value)]
        return values.some((v) => v !== undefined && this.mayBeStringParam(v, seen))
      }
      case 'cond':
        return this.mayBeStringParam(n.yes, seen) || this.mayBeStringParam(n.no, seen)
      case 'bin':
        return (n.op === '&&' || n.op === '||' || n.op === '??') && (this.mayBeStringParam(n.left, seen) || this.mayBeStringParam(n.right, seen))
      case 'assign':
        return this.mayBeStringParam(n.value, seen)
      default:
        return false
    }
  }

  /** Task 6 fix round 3: proven a string — a string literal, a string element or element read, a string method's result, or a local every write of which is one. */
  private isStringValue(n: Node, env: Env, seen = new Set<string>()): boolean {
    switch (n.k) {
      case 'lit':
        return n.kind === 'str'
      case 'id': {
        const e = elementsOf(env.loops).get(n.name)
        if (e) return e.type === 'string'
        const d = this.decls.get(n.name)
        if (!d || seen.has(n.name) || this.locals.get(n.name)?.k !== 'local') return false
        seen.add(n.name)
        const values = [d.line.init, ...this.assignments.filter((a) => a.name === n.name).map((a) => (a.op === '=' ? a.value : undefined))]
        return values.every((v) => v !== undefined && this.isStringValue(v, env, seen))
      }
      case 'index':
        return n.obj.k === 'id' && this.sourceOfName(n.obj.name)?.type === 'string'
      case 'call':
        return n.callee.k === 'member' && n.callee.name === 'charAt' && this.isStringValue(n.callee.obj, env, seen)
      default:
        return false
    }
  }

  /** A value whose positions reveal a size: a size source, a closed local, an array accumulator. */
  private isSequence(name: string): boolean {
    const l = this.locals.get(name)
    return this.sourceOfName(name) !== undefined || (l?.k === 'local' && !this.scalarLocals.has(name)) || (l?.k === 'acc' && l.array)
  }

  /** A local holding something reached through a parameter or loop name. */
  private reaches(name: string): boolean {
    const l = this.locals.get(name)
    return l?.k === 'local' && l.reaches
  }

  /** Every name that holds a number in the loops around: indices, number elements, numeric keys, a numeric reduce's accumulator. */
  private loopNumeric(name: string, env: Env): boolean {
    return env.loops.some((l) => l.numeric?.includes(name))
  }

  /** A call that returns a number: `Math.*`, `Number`, `parseInt`, and the index searches on a typed array or derived value. */
  private isNumericCall(n: Extract<Node, { k: 'call' }>): boolean {
    const c = n.callee
    if (c.k === 'id') return c.name === 'Number' || c.name === 'parseInt'
    if (c.k !== 'member') return false
    if (isId(c.obj, 'Math')) return true
    const r = this.receiverOf(c.obj)
    return (r === 'array' || r === 'derived') && ['indexOf', 'lastIndexOf', 'findIndex'].includes(c.name)
  }

  /** A call that returns a boolean, by its receiver's kind and listed method (ruling B, rule 4). */
  private isBooleanCall(n: Extract<Node, { k: 'call' }>): boolean {
    const c = n.callee
    if (c.k !== 'member') return false
    const r = this.receiverOf(c.obj)
    return ((r === 'array' || r === 'derived') && ['includes', 'some', 'every'].includes(c.name)) || ((r === 'set' || r === 'map') && c.name === 'has')
  }

  /** Proven a number (spec "Stricter readings", fix round 2, family 5): `+` and `+=` take only these. */
  private isNumeric(n: Node, env: Env): boolean {
    switch (n.k) {
      case 'lit':
        return n.kind === 'num'
      case 'unary':
        return n.op === '-' || n.op === '+' || n.op === '~'
      case 'update':
        return true
      case 'id':
        return this.params.get(n.name)?.kind === 'numeric' || this.numericLocals.has(n.name) || this.loopNumeric(n.name, env)
      case 'member':
        return n.name === 'length' || n.name === 'size'
      case 'index': {
        const s = n.obj.k === 'id' ? this.sourceOfName(n.obj.name) : undefined
        return s !== undefined && s.yields === undefined && s.type === 'number'
      }
      case 'call':
        return this.isNumericCall(n)
      case 'bin':
        return n.op === '+' ? this.isNumeric(n.left, env) && this.isNumeric(n.right, env) : ARITHMETIC_ALL.has(n.op)
      case 'cond':
        return this.isNumeric(n.yes, env) && this.isNumeric(n.no, env)
      default:
        return false
    }
  }

  /** Proven a scalar (a number, boolean or string): a local holding one may take any method (fix round 2, family 4). */
  private isScalar(n: Node, env: Env): boolean {
    switch (n.k) {
      case 'lit':
        return n.kind !== 're'
      case 'unary':
        return ['-', '+', '!', '~', 'typeof'].includes(n.op) && this.isScalar(n.arg, env)
      case 'update':
        return true
      case 'id': {
        const p = this.params.get(n.name)
        const e = elementsOf(env.loops).get(n.name)
        return p?.kind === 'numeric' || p?.kind === 'bool' || this.scalarLocals.has(n.name) || this.loopNumeric(n.name, env) || (e !== undefined && e.type !== 'opaque')
      }
      case 'member':
        return n.name === 'length' || n.name === 'size'
      case 'index': {
        const s = n.obj.k === 'id' ? this.sourceOfName(n.obj.name) : undefined
        return s !== undefined && s.yields === undefined && s.type !== 'opaque'
      }
      case 'call':
        return this.isNumericCall(n) || this.isBooleanCall(n)
      case 'bin':
        return COMPARE.has(n.op) || n.op === 'in' || n.op === 'instanceof' || ARITHMETIC_ALL.has(n.op) || (this.isScalar(n.left, env) && this.isScalar(n.right, env))
      case 'cond':
        return this.isScalar(n.yes, env) && this.isScalar(n.no, env)
      default:
        return false
    }
  }

  private costOfObject(obj: Node, env: Env): Cost {
    if (obj.k === 'id') {
      need(obj.name !== this.unit.name && !FAILS.has(obj.name))
      return NOTHING
    }
    return this.cost(obj, env)
  }

  private costOfMember(n: Extract<Node, { k: 'member' }>, env: Env): Cost {
    need(!FAILS.has(n.name))
    if (n.obj.k === 'id' && GLOBALS.has(n.obj.name)) {
      need(n.obj.name === 'Math')
      return NOTHING
    }
    const isSize = n.name === 'length' || n.name === 'size'
    // A listed method read as a value escapes the lists.
    need(isSize || !METHODS.has(n.name))
    const recv = this.receiverOf(n.obj)
    if (['array', 'string', 'set', 'map', 'derived', 'acc'].includes(recv)) need(isSize)
    need(this.isPropertyReceiver(n.obj, env))
    return this.costOfObject(n.obj, env)
  }

  /**
   * Task 6 fix round 1: a property read throws on null or undefined, so it
   * reads only a value that is never either: a typed parameter or derived
   * value, an accumulator, a proven scalar local, a number, boolean or literal
   * parameter, a loop's index or primitive, object or array element, an
   * element read of such a parameter, or the result of a helper or a module's
   * function. Never a closed local (`const v = null`), a lookup's result
   * (`m.get(k)`), another property (`x.a.b`), `this` or an untyped parameter.
   */
  private isPropertyReceiver(obj: Node, env: Env): boolean {
    const shaped = (e: Elem | undefined): boolean => e !== undefined && (e.type !== 'opaque' || e.shape !== undefined)
    if (obj.k === 'id') {
      const p = this.params.get(obj.name)
      if (p) return ['array', 'string', 'set', 'map', 'numeric', 'bool', 'literal'].includes(p.kind)
      const l = this.locals.get(obj.name)
      if (l) return l.k === 'derived' || l.k === 'acc' || this.isNonNullLocal(obj.name, env)
      const e = elementsOf(env.loops).get(obj.name)
      if (e) return shaped(e)
      return this.loopNumeric(obj.name, env) || env.loops.some((lp) => lp.index === obj.name || lp.positions?.includes(obj.name))
    }
    // A declared, non-optional property of an object literal element type: `x.tags.length`.
    if (obj.k === 'member' && obj.obj.k === 'id') return elementsOf(env.loops).get(obj.obj.name)?.props?.has(obj.name) === true
    if (obj.k === 'index' && obj.obj.k === 'id') return shaped(this.sourceOfName(obj.obj.name))
    if (obj.k === 'call') {
      const c = obj.callee
      if (c.k === 'id') return !GLOBALS.has(c.name) && !this.isBound(c.name) && !isExitName(c.name)
      if (c.k !== 'member') return false
      // A builtin that always returns a value: a copy, a search's index, a string or number method's result.
      if (this.isNonNull(obj, env, new Set())) return true
      return c.obj.k === 'id' && !GLOBALS.has(c.obj.name) && !this.isBound(c.obj.name) && !isExitName(c.name)
    }
    return false
  }

  /** An array accumulator, or a local that only ever holds an array literal. */
  private isArrayReceiver(obj: Node): boolean {
    if (obj.k !== 'id') return false
    const l = this.locals.get(obj.name)
    if (l?.k === 'acc') return l.array
    if (l?.k !== 'local') return false
    const d = this.decls.get(obj.name)
    const values = [d?.line.init, ...this.assignments.filter((a) => a.name === obj.name && a.whole).map((a) => a.value)]
    return values.every((v) => v !== undefined && v.k === 'array')
  }

  /** Task 6 fix round 2: a write's receiver is an accumulator, or a local that only ever holds a fresh object or array (never null or a primitive). */
  private isWritableReceiver(obj: Node): boolean {
    if (obj.k !== 'id') return false
    const l = this.locals.get(obj.name)
    if (l?.k === 'acc') return true
    if (l?.k !== 'local' || this.scalarLocals.has(obj.name)) return false
    const d = this.decls.get(obj.name)
    const values = [d?.line.init, ...this.assignments.filter((a) => a.name === obj.name && a.whole).map((a) => a.value)]
    return values.every((v) => v !== undefined && (v.k === 'array' || v.k === 'object' || v.k === 'new'))
  }

  /** A local every write of which is never null or undefined (task 6 fix round 1). */
  private isNonNullLocal(name: string, env: Env, seen = new Set<string>()): boolean {
    const d = this.decls.get(name)
    if (!d?.line.init || seen.has(name)) return false
    seen.add(name)
    const values = [d.line.init, ...this.assignments.filter((a) => a.name === name && a.whole).map((a) => a.value)]
    return values.every((v) => v !== undefined && this.isNonNull(v, env, seen))
  }

  private isNonNull(n: Node, env: Env, seen: Set<string>): boolean {
    switch (n.k) {
      case 'lit':
        return n.nullish !== true
      case 'array':
      case 'object':
      case 'new':
      case 'unary':
      case 'update':
        return true
      case 'bin':
        return n.op === '&&' || n.op === '||' || n.op === '??' ? this.isNonNull(n.left, env, seen) && this.isNonNull(n.right, env, seen) : true
      case 'cond':
        return this.isNonNull(n.yes, env, seen) && this.isNonNull(n.no, env, seen)
      case 'id': {
        const p = this.params.get(n.name)
        if (p) return ['array', 'string', 'set', 'map', 'numeric', 'bool', 'literal'].includes(p.kind)
        if (this.locals.has(n.name)) return this.isNonNullLocal(n.name, env, seen)
        return false
      }
      case 'call': {
        const c = n.callee
        if (c.k === 'id') return c.name === 'Number' || c.name === 'parseInt'
        if (c.k !== 'member') return false
        if (isId(c.obj, 'Math') || ((isId(c.obj, 'Array') || isId(c.obj, 'Object')) && ['from', 'keys', 'values', 'entries'].includes(c.name))) return true
        const r = this.receiverOf(c.obj)
        if ((r === 'array' || r === 'derived') && ['slice', 'concat', 'filter', 'map', 'toSorted', 'toReversed', 'indexOf', 'lastIndexOf', 'findIndex', 'includes', 'some', 'every', 'join'].includes(c.name)) return true
        return NON_NULL_METHODS.has(c.name) && (this.isPrimitiveValue(c.obj, env) || (c.obj.k === 'id' && this.params.get(c.obj.name)?.kind === 'literal'))
      }
      default:
        return false
    }
  }

  /** `keys`: a lookup, key or append, which may take an opaque value; nothing else is handed one. */
  private costOfArgs(args: Node[], env: Env, keys = false): Cost {
    return args.reduce((c, a) => {
      need(a.k !== 'spread' && a.k !== 'arrow' && (keys || !this.isOpaqueValue(a, env)))
      return add(c, this.cost(a, env))
    }, NOTHING)
  }

  private costOfCall(n: Extract<Node, { k: 'call' }>, env: Env, ctx: Ctx): Cost {
    const callee = n.callee
    // Task 6 fix round 1: a call that ends the process is an exit the input cannot avoid.
    need(!((callee.k === 'id' || callee.k === 'member') && isExitName(callee.name)))
    if (callee.k === 'id') {
      const f = callee.name
      need(f !== this.unit.name && !FAILS.has(f))
      if (GLOBALS.has(f)) {
        need(f === 'Number' || f === 'parseInt')
        return this.costOfArgs(n.args, env)
      }
      const p = this.params.get(f)
      // A callback parameter, or a helper: 1 by the rule. A local or loop name is never called.
      need(p ? p.kind === 'other' : !this.isBound(f) && !this.signatureNames.has(f))
      return this.costOfArgs(n.args, env)
    }
    need(callee.k === 'member')
    const { obj, name: m } = callee as Extract<Node, { k: 'member' }>
    if (obj.k === 'id' && GLOBALS.has(obj.name)) return this.costOfGlobalCall(obj.name, m, n.args, env)
    const recv = this.receiverOf(obj)
    const root = receiverRoot(obj)
    // Gate 9: no mutating call on a parameter or anything reached through one (an element, a loop
    // variable, a call's result), but an in-place sort of a parameter as a statement outside loops.
    if (root && (this.params.has(root.name) || this.loopNames.has(root.name) || this.reaches(root.name)) && MUTATE.has(m)) {
      need(m === 'sort' && root.whole && recv === 'array' && ctx === 'stmt' && env.loops.length === 0)
      return this.costOfSort(root.name, n.args, env)
    }
    const name = obj.k === 'id' ? obj.name : ''
    // Ruling B and C: a value that is not a known collection takes a method only when it is a string or number,
    // and then only the closed O(1) list. An unbound name (a module) keeps the rule: other calls cost 1.
    const isModule = obj.k === 'id' && !this.isBound(obj.name)
    const isValue = recv === 'expr' || recv === 'scalar' || recv === 'numeric' || recv === 'bool' || (recv === 'plain' && !isModule)
    // Fix round 4: a parameter of no known collection kind (`fixed`, `other`) takes no method; a string or number
    // literal union takes only the closed O(1) list for its type.
    need(recv !== 'fixed' && recv !== 'other')
    const literal = recv === 'literal' ? this.params.get(name)?.literal : undefined
    if (recv === 'literal') need(literal === 'string' ? STRING_METHODS.has(m) : literal === 'number' && m === 'toFixed')
    // Task 6 fix round 3: a scalar method matches its receiver's proven type (toFixed on numbers, the rest on strings).
    if (isValue) need(this.isPrimitiveValue(obj, env) && SCALAR_METHODS.has(m) && (m === 'toFixed' ? this.isNumeric(obj, env) : this.isStringValue(obj, env)))
    // toFixed throws a RangeError past 20 digits.
    if (m === 'toFixed') need(n.args.length === 1 && (numLit(n.args[0]) ?? -1) >= 0 && numLit(n.args[0])! <= 20)
    // Reached through a closed local or an accumulator (`o.a`, `acc[k]`): lookups and appends only.
    const rootLocal = root ? this.locals.get(root.name) : undefined
    if (obj.k !== 'id' && root && (rootLocal?.k === 'acc' || (rootLocal?.k === 'local' && !this.scalarLocals.has(root.name)))) need(COLL_METHODS.has(m))
    // A closed local's elements may be a parameter's (a copy): they are not mutated.
    if (obj.k !== 'id' && rootLocal?.k === 'local' && !this.scalarLocals.has(root!.name)) need(!MUTATE.has(m))
    if (obj.k !== 'id' && POSITIONAL.has(m)) need(this.isPosition(n.args[0], env) || this.isElementValue(obj))
    // Task 7 fix round 1, ruling D: a whole string parameter is no needle or key of a collection (appending it is fine).
    if (['array', 'derived', 'set', 'map', 'acc', 'closed'].includes(recv) && m !== 'push') need(!n.args.some((a) => this.mayBeStringParam(a)))
    // Task 7 fix round 2, ruling D′: a needle or key is a fixed-cost operand.
    if (['array', 'derived', 'set', 'map', 'acc', 'closed', 'string'].includes(recv) && NEEDLE_METHODS.has(m)) need(n.args[0] !== undefined && this.isFixedOperand(n.args[0], env))
    switch (recv) {
      case 'array':
      case 'derived':
        return this.costOfArrayCall(name, m, n.args, env)
      case 'string':
        need(STRING_METHODS.has(m) && this.isPosition(n.args[0], env))
        return this.costOfArgs(n.args, env)
      case 'set':
        need(m === 'has')
        return this.costOfArgs(n.args, env, true)
      case 'map':
        need(m === 'has' || m === 'get')
        return this.costOfArgs(n.args, env, true)
      case 'acc':
        need(ACC_METHODS.has(m))
        if (m === 'at') need(this.isPosition(n.args[0], env))
        return this.costOfArgs(n.args, env, true)
      case 'closed':
        need(COLL_METHODS.has(m))
        if (POSITIONAL.has(m)) need(this.isPosition(n.args[0], env))
        return this.costOfArgs(n.args, env, true)
      default:
        // Left here: a module's call (1 by the rule), a proven string or number value, or a literal union parameter.
        need(!COUNTED.has(m) && (isModule || isValue || literal !== undefined))
        return add(this.costOfObject(obj, env), this.costOfArgs(n.args, env, COLL_METHODS.has(m) && obj.k !== 'id'))
    }
  }

  /** Spec "Builtins" on an array-typed parameter or a derived value. */
  private costOfArrayCall(recv: string, m: string, args: Node[], env: Env): Cost {
    if (m === 'toSorted') return this.costOfSort(recv, args, env)
    if (ITERATORS.has(m) || m === 'reduceRight') return this.costOfIteration(recv, m, args, env)
    // entries, keys and values return lazy iterators (1, not n): counted only in a for-of header, refused elsewhere.
    need(!['entries', 'keys', 'values'].includes(m))
    if (['slice', 'concat', 'toReversed'].includes(m)) need(args.length === 0)
    // A search from a start index, or a join, takes no limit: the whole receiver is read.
    if (['includes', 'indexOf', 'lastIndexOf', 'join', 'at'].includes(m)) need(args.length <= 1)
    if (LINEAR.has(m) && m !== 'findLast' && m !== 'findLastIndex') return add(this.costOfArgs(args, env), this.site(env, recv, 'builtin', `${m} on ${recv}`))
    need(m === 'at' && this.isPosition(args[0], env))
    return this.costOfArgs(args, env)
  }

  /** n log n, with a comparator of constant cost (an arrow, or a helper by the rule). */
  private costOfSort(recv: string, args: Node[], env: Env): Cost {
    need(args.length <= 1)
    const cmp = args[0]
    if (cmp?.k === 'arrow') {
      need(cmp.params.length <= 2)
      const loop: Loop = { at: env.at, kind: 'comparator', elements: new Map(), factor: ONE, hasExit: false }
      const inner = { ...env, loops: [...env.loops, loop] }
      if (cmp.body === 'block') need(env.block !== undefined)
      const body = cmp.body === 'block' ? this.costOfBlock(env.block!, inner) : this.cost(cmp.body, inner)
      need(!hasFactors(body))
    } else if (cmp) need(cmp.k === 'id' && !this.isBound(cmp.name) && !GLOBALS.has(cmp.name) && !FAILS.has(cmp.name))
    const what = `sort of ${recv}`
    const src = this.sourceOfName(recv)
    if (!src) refuse()
    return this.costly(env, mul(factor({ size: src.origin, log: false, kind: 'sort', at: env.at, what }), factor({ size: src.origin, log: true, kind: 'sort', at: env.at, what })))
  }

  /** An iteration callback is a loop body: n × (1 + its cost). A short-circuit one must be able to run to the end. */
  private costOfIteration(recv: string, m: string, args: Node[], env: Env): Cost {
    const [cb, ...rest] = args
    if (cb === undefined) refuse()
    need(rest.length <= (m === 'reduce' || m === 'reduceRight' ? 1 : 0))
    const src = this.sourceOfName(recv)
    if (!src) refuse()
    let body = NOTHING
    if (cb.k === 'arrow') {
      need(m !== 'reduceRight')
      // Task 7 fix round 2, ruling D′: a map or filter builds a collection from its own parameters, literals and fixed-cost operands only.
      if (m === 'map' || m === 'filter') need(cb.body !== 'block')
      const start = rest[0]
      let numericStart = cb.body !== 'block' && start !== undefined && this.isNumeric(start, env)
      // Ruling D: the accumulator holds a number only when every return of the callback does, assuming it does.
      if (numericStart && cb.body !== 'block') {
        const assumed = this.callbackLoop(m, cb.params, src, env.at, recv, true)
        numericStart = this.isNumeric(cb.body, { ...env, loops: [...env.loops, assumed] })
      }
      const loop = cb.body === 'block' ? this.loops.get(env.at) : this.callbackLoop(m, cb.params, src, env.at, recv, numericStart)
      need(loop?.kind === 'callback')
      const inner = { ...env, loops: [...env.loops, loop!] }
      if (cb.body === 'block') {
        need(env.block !== undefined && !PREDICATES.has(m))
        body = this.costOfBlock(env.block!, inner)
      } else {
        if (m === 'map' || m === 'filter') need(this.isFixedBody(cb.body, cb.params, inner))
        if (SHORT.has(m)) this.checkPredicate(m, cb.body, inner)
        // Task 6 fix rounds 4 and 5: every predicate (one that stops the walk, or a filter's, which sizes what it keeps) takes the grammar.
        if (PREDICATES.has(m)) {
          need(!isTrivial(cb.body))
          this.checkGrammar(cb.body, inner)
        }
        body = this.cost(cb.body, inner, PREDICATES.has(m) ? 'test' : 'value')
      }
    } else need(cb.k === 'id' && !PREDICATES.has(m) && !this.isBound(cb.name) && !GLOBALS.has(cb.name) && !FAILS.has(cb.name))
    // A reduce starts from a number or an empty collection: a string start, or the first element, may concatenate.
    if (m === 'reduce' || m === 'reduceRight') {
      const start = rest[0]
      need(start !== undefined && (numLit(start) !== undefined || (start.k === 'lit' && start.kind === 'num') || (start.k === 'unary' && start.op === '-' && start.arg.k === 'lit' && start.arg.kind === 'num') || isEmptyCollection(start)))
    }
    const init = this.costOfArgs(rest, env)
    const f = factor({ size: src.origin, log: false, kind: 'callback', at: env.at, what: `${m} over ${recv}` })
    return add(init, this.costly(env, mul(f, add(ONE, body))))
  }

  /** find, findIndex and some stop at the first true: one test must be falsifiable. every stops at the first false: each test is membership. */
  private checkPredicate(m: string, body: Node, env: Env): void {
    const elems = elementsOf(env.loops)
    need(this.readsOnly(body, elems))
    const atoms = conjuncts(body)
    if (m === 'every') need(atoms.every((a) => this.isMembership(a, elems, env.loops)))
    else need(atoms.some((a) => this.isFalsifiable(a, elems, env.loops)))
  }

  /** A bare typed parameter or derived value as the argument of a listed global. */
  private bareSource(n: Node | undefined, kinds: Kind[]): string {
    need(n?.k === 'id')
    const name = (n as { name: string }).name
    const p = this.params.get(name)
    need(p ? kinds.includes(p.kind) : this.locals.get(name)?.k === 'derived')
    return name
  }

  private costOfGlobalCall(g: string, m: string, args: Node[], env: Env): Cost {
    if (g === 'Math') {
      const spread = args.find((a) => a.k === 'spread')
      if (!spread) return this.costOfArgs(args, env)
      need((m === 'max' || m === 'min') && args.length === 1)
      const name = this.bareSource((spread as { arg: Node }).arg, ['array', 'set', 'string'])
      return this.site(env, name, 'builtin', `Math.${m} of ${name}`)
    }
    need(args.length === 1)
    if (g === 'Object' && ['keys', 'values', 'entries'].includes(m)) {
      const name = this.bareSource(args[0], ['array', 'other'])
      return this.site(env, name, 'builtin', `Object.${m} of ${name}`)
    }
    if (g === 'Array' && m === 'from') {
      const name = this.bareSource(args[0], ['array', 'set', 'map', 'string'])
      return this.site(env, name, 'builtin', `Array.from of ${name}`)
    }
    need(g === 'JSON' && m === 'stringify')
    const name = this.bareSource(args[0], ['array'])
    return this.site(env, name, 'builtin', `JSON.stringify of ${name}`)
  }

  private costOfNew(n: Extract<Node, { k: 'new' }>, env: Env): Cost {
    // Task 6 fix round 3: an exit-named constructor may end the process as an exit-named call may.
    need(n.callee !== this.unit.name && !FAILS.has(n.callee) && !isExitName(n.callee))
    if (n.callee === 'Set' || n.callee === 'Map') {
      if (n.args.length === 0) return NOTHING
      need(n.args.length === 1)
      const name = this.bareSource(n.args[0], n.callee === 'Set' ? ['array', 'set', 'map', 'string'] : ['array', 'map'])
      return this.site(env, name, 'builtin', `${n.callee} of ${name}`)
    }
    need(!GLOBALS.has(n.callee) && !this.isBound(n.callee))
    return this.costOfArgs(n.args, env)
  }

  private costOfSpread(arg: Node, env: Env, where: 'array' | 'object'): Cost {
    const name = this.bareSource(arg, where === 'array' ? ['array', 'set', 'map', 'string'] : ['array', 'string'])
    return this.site(env, name, 'builtin', `spread of ${name}`)
  }

  /**
   * Gate 9 and the spec's locals: no parameter, loop name, derived value or
   * undeclared name is written; an accumulator only by key; inside a loop,
   * `+=` (or `x = … x …`) only on a number.
   */
  private costOfAssign(target: Node, op: string, value: Node | undefined, env: Env): Cost {
    const root = rootOf(target)
    if (!root) refuse()
    const name = root.name
    need(!this.params.has(name))
    let c = value ? this.cost(value, env) : NOTHING
    if (target.k === 'index') c = add(c, this.cost(target.index, env))
    if (target.k !== 'id') c = add(c, this.costOfObject(target.k === 'index' || target.k === 'member' ? target.obj : target, env))
    // Task 6 fix round 1: a write to a property or index of null throws; round 2: so does one to a primitive (strict
    // mode), and a write to `.length` resizes (or throws on a negative length).
    if (target.k === 'member' || target.k === 'index') need(this.isWritableReceiver(target.obj) && !(target.k === 'member' && (target.name === 'length' || target.name === 'size')))
    // Task 6 fix round 3: a bracket write takes a number key (never 'length') on an array accumulator or a fresh array.
    if (target.k === 'index') need(this.isNumeric(target.index, env) && this.isArrayReceiver(target.obj) && this.isFixedOperand(target.index, env))
    if (this.searchVars.has(name)) return c
    need(!this.loopNames.has(name))
    const local = this.locals.get(name)
    if (!local) refuse()
    if (local.k === 'derived') refuse()
    if (local.k === 'acc') need(!root.whole && target.k === 'index')
    if (!root.whole) need(!this.reaches(name))
    // += only on proven numbers (family 5); a proven number or scalar keeps its proof.
    if (op === '+=') need(this.isNumeric(target, env) && value !== undefined && this.isNumeric(value, env))
    if (root.whole && value !== undefined && this.numericLocals.has(name)) need(this.isNumeric(value, env))
    if (root.whole && value !== undefined && this.scalarLocals.has(name)) need(this.isScalar(value, env))
    return c
  }
}

// ---------------------------------------------------------------------------
// Helpers over shapes

const isEmptyCollection = (n: Node): boolean => (n.k === 'array' || n.k === 'object' ? n.items.length === 0 : n.k === 'new' && (n.callee === 'Set' || n.callee === 'Map') && n.args.length === 0)

function elementsOf(loops: Loop[]): Map<string, Elem> {
  const out = new Map<string, Elem>()
  for (const l of loops) for (const [k, v] of l.elements) out.set(k, v)
  return out
}

/**
 * Which loop names are elements and which hold indices: keys are indices; an
 * entry's first name is one; a Map pair's names are its key and value; a
 * whole entry or pair is an opaque element and no atom. `numeric`: names that
 * hold numbers. `pattern`: the names destructure each item; of plain elements
 * that refuses (final review M1: a part of an element is no fixed-cost operand).
 */
function rolesOf(names: string[], src: Elem, pattern = false): { elements: Map<string, Elem>; positions: string[]; numeric: string[] } {
  const elem = (type: ElemType, shaped = true): Elem => ({ origin: src.origin, distinct: src.distinct, type, atom: src.atom, ...(shaped && src.shape ? { shape: src.shape } : {}), ...(shaped && src.props ? { props: src.props } : {}), ...(src.derived ? { derived: true } : {}) })
  const whole = (n: string): Elem => ({ origin: src.origin, distinct: src.distinct, type: 'opaque', atom: false })
  const numeric = (m: Map<string, Elem>, pos: string[]): string[] => [...[...m].filter(([, e]) => e.type === 'number').map(([n]) => n), ...(src.numericKeys ? pos : [])]
  let elements: Map<string, Elem>
  let positions: string[] = []
  if (src.yields === 'keys') positions = names
  if (src.yields === 'keys') elements = new Map()
  else if (src.yields === 'entries') {
    positions = names.length === 2 ? [names[0]!] : []
    elements = names.length === 2 ? new Map([[names[1]!, elem(src.type)]]) : new Map([[names[0]!, whole(names[0]!)]])
  } else if (src.yields === 'pairs') {
    elements = names.length === 2 ? new Map([[names[0]!, elem(src.key ?? 'opaque', false)], [names[1]!, elem(src.type)]]) : new Map([[names[0]!, whole(names[0]!)]])
  } else {
    need(!pattern)
    elements = new Map(names.map((n) => [n, elem(src.type)]))
  }
  return { elements, positions, numeric: numeric(elements, positions) }
}

/** The values a test names: names and their property paths (`opts.a`), indexed objects by name. */
function refsOf(n: Node): Set<string> {
  const out = new Set<string>()
  const path = (m: Node): string | undefined => (m.k === 'id' ? m.name : m.k === 'member' ? (p => p && `${p}.${m.name}`)(path(m.obj)) : undefined)
  const visit = (m: Node): void => {
    const p = path(m)
    if (p !== undefined) out.add(p)
    else childrenOf(m).forEach(visit)
  }
  visit(n)
  return out
}

/** `i++`, `++i`, `i += 1` (up); the same down; `i *= 2` (double); `i = Math.floor(i / 2)` (halve). */
function stepOf(n: Node, name: string): 'up' | 'down' | 'double' | 'halve' | undefined {
  if (n.k === 'update' && isId(n.arg, name)) return n.op === '++' ? 'up' : 'down'
  if (n.k !== 'assign' || !isId(n.target, name)) return undefined
  const k = numLit(n.value)
  if (n.op === '+=' && k === 1) return 'up'
  if (n.op === '-=' && k === 1) return 'down'
  // Task 7 fix round 1, ruling C: no shift step (a 32-bit shift wraps: `1 << 31` is negative).
  if (n.op === '*=' && k === 2) return 'double'
  const v = n.value
  if (n.op === '=' && v.k === 'call' && v.callee.k === 'member' && isId(v.callee.obj, 'Math') && v.callee.name === 'floor' && v.args.length === 1) {
    const a = v.args[0]!
    if (a.k === 'bin' && a.op === '/' && isId(a.left, name) && numLit(a.right) === 2) return 'halve'
  }
  return undefined
}

/** Spec "Binary search": `(lo + hi) >> 1`, `lo + ((hi - lo) >> 1)` or `Math.floor((lo + hi) / 2)`. */
function isMidForm(n: Node, lo: string, hi: string): boolean {
  const sum = (m: Node): boolean => m.k === 'bin' && m.op === '+' && isId(m.left, lo) && isId(m.right, hi)
  if (n.k === 'bin' && n.op === '>>' && sum(n.left) && numLit(n.right) === 1) return true
  if (n.k === 'bin' && n.op === '+' && isId(n.left, lo)) {
    const r = n.right
    return r.k === 'bin' && r.op === '>>' && numLit(r.right) === 1 && r.left.k === 'bin' && r.left.op === '-' && isId(r.left.left, hi) && isId(r.left.right, lo)
  }
  if (n.k === 'call' && n.callee.k === 'member' && isId(n.callee.obj, 'Math') && n.callee.name === 'floor' && n.args.length === 1) {
    const a = n.args[0]!
    return a.k === 'bin' && a.op === '/' && sum(a.left) && numLit(a.right) === 2
  }
  return false
}

/**
 * Ruling F: after `mid`, an optional equality exit (an if, no else, testing a
 * comparison that reads mid, whose body is one return or break), then one
 * if/else on such a comparison whose branches assign exactly lo and hi, one
 * each, and nothing else. Any other shape refuses.
 */
function isSearchBody(rest: Stmt[], lo: string, hi: string, mid: string): boolean {
  const readsMid = (c: Node | undefined): boolean => c !== undefined && c.k === 'bin' && COMPARE.has(c.op) && mentions(c, mid)
  const only = (body: Stmt[]): Simple | undefined => (body.length === 1 && body[0]!.k === 'line' ? body[0]!.line : undefined)
  const target = (b: Branch): string | undefined => {
    const l = only(b.body)
    return l?.k === 'expr' && l.node.k === 'assign' && l.node.op === '=' && l.node.target.k === 'id' ? l.node.target.name : undefined
  }
  if (rest.length < 1 || rest.length > 2) return false
  if (rest.length === 2) {
    const e = rest[0]!
    const l = e.k === 'if' && e.branches.length === 1 ? only(e.branches[0]!.body) : undefined
    if (e.k !== 'if' || e.branches.length !== 1 || !readsMid(e.branches[0]!.cond) || (l?.k !== 'return' && l?.k !== 'break')) return false
  }
  const s = rest.at(-1)!
  if (s.k !== 'if' || s.branches.length !== 2 || !s.hasElse || !readsMid(s.branches[0]!.cond)) return false
  const t = s.branches.map(target)
  return (t[0] === lo && t[1] === hi) || (t[0] === hi && t[1] === lo)
}

/** The call a block callback's line makes: the line's value is that call, its last argument the block arrow. */
function blockCall(line: Simple): Extract<Node, { k: 'call' }> {
  let v = line.k === 'decl' ? line.init : line.k === 'expr' || line.k === 'return' ? line.node : undefined
  if (v?.k === 'assign') v = v.value
  if (v?.k !== 'call' || v.callee.k !== 'member') refuse()
  const last = v.args.at(-1)
  need(last?.k === 'arrow' && last.body === 'block')
  return v
}

/** A condition no input can change: no names at all, a comparison of a value with itself, or `a || !a` / `a && !a` (comparisons flipped). */
function isTrivial(n: Node): boolean {
  if (!someNode(n, (m) => m.k === 'id' || m.k === 'this')) return true
  // Task 6 fix round 3: a literal (or fresh value) operand of ||, && or ! makes the test always or never hold.
  const isLiteral = (m: Node): boolean => ['lit', 'array', 'object', 'new', 'arrow'].includes(m.k)
  if (someNode(n, (m) => (m.k === 'bin' && (m.op === '||' || m.op === '&&' || m.op === '??') && (isLiteral(m.left) || isLiteral(m.right))) || (m.k === 'unary' && m.op === '!' && isLiteral(m.arg)))) return true
  const same = (a: Node, b: Node): boolean => JSON.stringify(a) === JSON.stringify(b)
  return someNode(n, (m) => m.k === 'bin' && ((COMPARE.has(m.op) && same(m.left, m.right)) || ((m.op === '||' || m.op === '&&') && (same(negate(m.left), m.right) || same(m.left, negate(m.right))))))
}

/** The worst-case cost of a TypeScript unit, its number parameters and its parameter names; undefined for any shape the reader cannot place. */
export function readTypeScript(unit: Unit): { cost: Cost; numeric: string[]; params: string[] } | undefined {
  try {
    return new Reader(unit, unit.full?.lines ?? unit.lines).read()
  } catch {
    return undefined
  }
}
