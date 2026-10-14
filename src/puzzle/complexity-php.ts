// SPEC 8.4, Complexity Read: the PHP reader (spec
// docs/superpowers/specs/2026-10-13-complexity-read-design.md, "The reader"
// and "Stricter readings (PHP reader, Task 7)"). Pure. Each shown line is read
// into a closed set of statement and expression shapes and costed; any shape
// it does not know, and any cost it cannot place, refuses the unit
// (undefined). Every rule is an allowlist: what is accepted is named, and all
// else refuses. A skipped unit is fine; a wrong key is not.
//
// PHP adds its own hazards: arrays are values (a write to a shared array
// copies it whole), elements of an `array` are untyped, names of functions and
// keywords ignore case, `==` coerces, and variables, calls and properties can
// be reached by name at run time. Each has its own allowlist below.

import { COMPLEXITY, PUZZLE } from '../config'
import { add, factor, hiddenScan, isExitName, isInert, isLiteralInRange, keyOf, mul, ONE, treeByBraces, type Block, type Cost, type HiddenPlace, type HiddenScan } from './complexity'
import { isBlankedLine } from './readable'
import type { Unit } from './units'

// ---------------------------------------------------------------------------
// Refusal

/** Thrown to refuse the unit and caught in `readPhp`. Carries no text. */
class Refusal {}
const REFUSAL = new Refusal()
function refuse(): never {
  throw REFUSAL
}
function need(ok: boolean): asserts ok {
  if (!ok) refuse()
}

// ---------------------------------------------------------------------------
// Word lists (config) and syntax sets

const LISTS = COMPLEXITY.builtins.PHP!
// The lists are lower case: no `keyOf` at load (complexity.ts imports this module, so its bindings are not ready yet).
const setOf = (...lists: Iterable<string>[]): ReadonlySet<string> => new Set(lists.flatMap((l) => [...l].map((w) => w.toLowerCase())))
/** PHP keywords and constructs a hidden line may not hold besides the lists. */
const PHP_WORDS = ['abstract', 'and', 'as', 'callable', 'case', 'catch', 'class', 'const', 'declare', 'default', 'do', 'echo', 'elseif', 'empty', 'enddeclare', 'endfor', 'endforeach', 'endif', 'endswitch', 'endwhile', 'enum', 'extends', 'final', 'finally', 'global', 'goto', 'implements', 'include', 'include_once', 'instanceof', 'insteadof', 'interface', 'isset', 'list', 'match', 'namespace', 'new', 'or', 'print', 'readonly', 'require', 'require_once', 'static', 'switch', 'trait', 'try', 'unset', 'use', 'var', 'xor']
/** Spec "What the reader reads", rule 3: every listed name, every global, and the keywords. */
const WORDS: ReadonlySet<string> = setOf(...Object.values(LISTS), PHP_WORDS)
const SORTS = setOf(LISTS.sort)
/** Sorts that take a comparator second. */
const USER_SORTS = new Set(['usort', 'uasort', 'uksort'])
/** Modifiers before a parameter promote it (refused). */
const MODIFIERS = new Set(['public', 'private', 'protected', 'static', 'final', 'readonly', 'abstract', 'var'])
/**
 * Fix round 1, ruling G: the modifiers a function with a body may have. `abstract` has none. `static` stays: a
 * static method only loses `$this` (refused anyway), and `static::` calls are read by name like any class's.
 */
const FUNCTION_MODIFIERS = new Set(['public', 'private', 'protected', 'static', 'final'])
const LITERAL_WORDS = new Set(['true', 'false', 'null'])

const ORDER = new Set(['<', '<=', '>', '>='])
/** Strict equality only: `==`, `!=` and `<>` coerce (lessons family 18) and refuse in the parser. */
const EQUALITY = new Set(['===', '!=='])
const FLIP: Record<string, string> = { '===': '!==', '!==': '===', '<': '>=', '>=': '<', '>': '<=', '<=': '>' }
/** Small sizes a guard may test for (spec gate 10): `size op literal`. */
const TINY: Record<string, number[]> = { '===': [0, 1], '<': [1, 2], '<=': [0, 1] }

// ---------------------------------------------------------------------------
// Tokens

type Tok = { t: 'var' | 'id' | 'num' | 'p'; v: string }

/** Longest first. Read so that every form PHP has is a token, and then refused by the grammar. */
const PUNCTS = ['<=>', '===', '!==', '**=', '??=', '<<=', '>>=', '...', '?->', '=>', '->', '::', '==', '!=', '<>', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '.=', '%=', '&=', '|=', '^=', '<<', '>>', '??', '**', '(', ')', '[', ']', '{', '}', ',', ';', '+', '-', '*', '/', '%', '<', '>', '=', '!', '?', ':', '.', '&', '|', '^', '~', '@']

/**
 * One shown line as tokens. The filter shows only lines with no quote,
 * backtick, `#`, comment or tag, so any of those (and `$$`, `${`, `$this`,
 * non-ASCII names, magic constants and number forms other than plain
 * decimals) refuses.
 */
function tokenize(text: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === ' ' || c === '\t') {
      i++
      continue
    }
    const rest = text.slice(i)
    const num = /^\d+(?:\.\d+)?/.exec(rest)
    if (num) {
      // No octal (`010`), hex, binary, exponent or separator forms.
      need(!/^[A-Za-z0-9_.]/.test(rest.slice(num[0].length)) && !/^0\d/.test(num[0]))
      // Fix round 1, ruling A: no literal beyond the shared cap (past PHP_INT_MAX a test is constant, past the floats INF).
      need(isLiteralInRange(num[0]))
      out.push({ t: 'num', v: num[0] })
      i += num[0].length
      continue
    }
    const v = /^\$[A-Za-z_][A-Za-z0-9_]*/.exec(rest)
    if (v) {
      need(v[0].toLowerCase() !== '$this' && !/^[A-Za-z0-9_\u0080-￿]/.test(rest.slice(v[0].length)))
      out.push({ t: 'var', v: v[0] })
      i += v[0].length
      continue
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)
    if (id) {
      need(!id[0].startsWith('__') && !/^[\u0080-￿]/.test(rest.slice(id[0].length)))
      out.push({ t: 'id', v: id[0] })
      i += id[0].length
      continue
    }
    const p = PUNCTS.find((q) => rest.startsWith(q))
    if (p === undefined) refuse()
    out.push({ t: 'p', v: p })
    i += p.length
  }
  return out
}

const isP = (t: Tok | undefined, v: string): boolean => t?.t === 'p' && t.v === v
/** A keyword or function name, compared case-folded (lessons family 17). */
const isWord = (t: Tok | undefined, v: string): boolean => t?.t === 'id' && keyOf(t.v, 'PHP') === v

// ---------------------------------------------------------------------------
// Expressions

type Node =
  | { k: 'var'; name: string }
  | { k: 'num'; v: number; int: boolean }
  | { k: 'const'; v: 'true' | 'false' | 'null' }
  | { k: 'index'; obj: Node; index: Node }
  /** A global function call; `fn` case-folded. */
  | { k: 'call'; fn: string; args: Node[] }
  /** `Class::method(args)`, both names case-folded. */
  | { k: 'static'; cls: string; m: string; args: Node[] }
  | { k: 'unary'; op: '!' | '-' | '+'; arg: Node }
  | { k: 'bin'; op: string; left: Node; right: Node }
  | { k: 'cmp'; op: string; left: Node; right: Node }
  | { k: 'bool'; op: '&&' | '||'; left: Node; right: Node }
  | { k: 'array'; items: Node[] }
  /** `fn($a, $b) => body`. */
  | { k: 'fn'; params: string[]; body: Node }

/**
 * A recursive-descent reader of one line's tokens, by PHP's precedence. No
 * ternary, `??`, assignment expression, cast, `@`, `.`, `**`, shift left,
 * bitwise operator, loose comparison, `new`, property or method access on a
 * value, variable call or chained comparison: anything outside the grammar
 * refuses.
 */
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
  end(): void {
    need(this.done)
  }
  variable(): string {
    const t = this.peek()
    need(t?.t === 'var')
    this.i++
    return t.v
  }

  expr(): Node {
    return this.or()
  }

  private or(): Node {
    let left = this.and()
    while (this.is('||')) {
      this.i++
      left = { k: 'bool', op: '||', left, right: this.and() }
    }
    return left
  }

  private and(): Node {
    let left = this.equality()
    while (this.is('&&')) {
      this.i++
      left = { k: 'bool', op: '&&', left, right: this.equality() }
    }
    return left
  }

  /** `===`, `!==` and `<=>` (the last only a comparator's); no chain. Loose `==`, `!=` and `<>` refuse. */
  private equality(): Node {
    const left = this.relation()
    const t = this.peek()
    if (t?.t !== 'p' || !['===', '!==', '<=>', '==', '!=', '<>'].includes(t.v)) return left
    need(t.v === '===' || t.v === '!==' || t.v === '<=>')
    this.i++
    const right = this.relation()
    const after = this.peek()
    need(!(after?.t === 'p' && ['===', '!==', '<=>', '==', '!=', '<>'].includes(after.v)))
    return { k: 'cmp', op: t.v, left, right }
  }

  private relation(): Node {
    const left = this.shift()
    const t = this.peek()
    if (t?.t !== 'p' || !ORDER.has(t.v)) return left
    this.i++
    const right = this.shift()
    need(!(this.peek()?.t === 'p' && ORDER.has(this.peek()!.v)))
    return { k: 'cmp', op: t.v, left, right }
  }

  private shift(): Node {
    let left = this.additive()
    while (this.is('>>')) {
      this.i++
      left = { k: 'bin', op: '>>', left, right: this.additive() }
    }
    return left
  }

  private additive(): Node {
    let left = this.multiplicative()
    for (;;) {
      const t = this.peek()
      if (t?.t !== 'p' || (t.v !== '+' && t.v !== '-')) return left
      this.i++
      left = { k: 'bin', op: t.v, left, right: this.multiplicative() }
    }
  }

  private multiplicative(): Node {
    let left = this.unary()
    for (;;) {
      const t = this.peek()
      if (t?.t !== 'p' || !['*', '/', '%'].includes(t.v)) return left
      this.i++
      left = { k: 'bin', op: t.v, left, right: this.unary() }
    }
  }

  private unary(): Node {
    const t = this.peek()
    if (t?.t === 'p' && (t.v === '!' || t.v === '-' || t.v === '+')) {
      this.i++
      return { k: 'unary', op: t.v, arg: this.unary() }
    }
    return this.postfix()
  }

  private postfix(): Node {
    let n = this.primary()
    while (this.is('[')) {
      need(n.k === 'var' || n.k === 'index')
      this.i++
      const index = this.expr()
      this.take(']')
      n = { k: 'index', obj: n, index }
    }
    return n
  }

  private primary(): Node {
    const t = this.peek()
    if (!t) refuse()
    this.i++
    if (t.t === 'var') return { k: 'var', name: t.v }
    if (t.t === 'num') return { k: 'num', v: Number(t.v), int: !t.v.includes('.') }
    if (t.t === 'id') {
      const w = keyOf(t.v, 'PHP')
      if (LITERAL_WORDS.has(w)) return { k: 'const', v: w as 'true' | 'false' | 'null' }
      if (w === 'fn') return this.closure()
      if (this.is('(')) return { k: 'call', fn: w, args: this.args() }
      if (this.is('::')) {
        this.i++
        const m = this.peek()
        need(m?.t === 'id')
        this.i++
        need(this.is('('))
        return { k: 'static', cls: w, m: keyOf(m!.v, 'PHP'), args: this.args() }
      }
      refuse()
    }
    if (t.v === '(') {
      const e = this.expr()
      this.take(')')
      return e
    }
    if (t.v === '[') {
      const items: Node[] = []
      while (!this.is(']')) {
        items.push(this.expr())
        if (!this.is(']')) this.take(',')
      }
      this.i++
      return { k: 'array', items }
    }
    refuse()
  }

  /** `(a, b, …)`, a trailing comma allowed; no spread and no named argument. */
  private args(): Node[] {
    this.take('(')
    const out: Node[] = []
    while (!this.is(')')) {
      out.push(this.expr())
      if (!this.is(')')) this.take(',')
    }
    this.i++
    return out
  }

  /** `fn($a, $b) => expr`: plain names only (no type, default, reference or spread). */
  private closure(): Node {
    this.take('(')
    const params: string[] = []
    while (!this.is(')')) {
      params.push(this.variable())
      if (!this.is(')')) this.take(',')
    }
    this.i++
    this.take('=>')
    return { k: 'fn', params, body: this.expr() }
  }
}

/** Every node directly under `n` (a closure's body included). */
function childrenOf(n: Node): Node[] {
  switch (n.k) {
    case 'index':
      return [n.obj, n.index]
    case 'call':
    case 'static':
      return n.args
    case 'unary':
      return [n.arg]
    case 'bin':
    case 'cmp':
    case 'bool':
      return [n.left, n.right]
    case 'array':
      return n.items
    case 'fn':
      return [n.body]
    default:
      return []
  }
}

function someNode(n: Node, f: (n: Node) => boolean): boolean {
  return f(n) || childrenOf(n).some((c) => someNode(c, f))
}

const isVar = (n: Node | undefined, name?: string): n is { k: 'var'; name: string } => n?.k === 'var' && (name === undefined || n.name === name)
const mentions = (n: Node, name: string): boolean => someNode(n, (c) => isVar(c, name))
const conjuncts = (n: Node): Node[] => (n.k === 'bool' && n.op === '&&' ? [...conjuncts(n.left), ...conjuncts(n.right)] : [n])
/** An integer literal, signed. */
function numLit(n: Node | undefined): number | undefined {
  if (n?.k === 'num' && n.int) return n.v
  if (n?.k === 'unary' && n.op === '-' && n.arg.k === 'num' && n.arg.int) return -n.arg.v
  return undefined
}
const isCallOf = (n: Node | undefined, f: string): n is Extract<Node, { k: 'call' }> => n?.k === 'call' && n.fn === f

// Each reader keeps its own copy of `negate`, `isTrivial` and `checkGrammar`: each works on its own syntax tree.
/** `!c`, with comparisons flipped so an atom stays an atom. */
function negate(n: Node): Node {
  if (n.k === 'cmp' && Object.hasOwn(FLIP, n.op)) return { ...n, op: FLIP[n.op]! }
  if (n.k === 'unary' && n.op === '!') return n.arg
  return { k: 'unary', op: '!', arg: n }
}

// ---------------------------------------------------------------------------
// Lines

/** An assignment's target: a variable, `$a[k]`, or `$a[]`. */
type Target = { k: 'var'; name: string } | { k: 'key'; name: string; key: Node } | { k: 'append'; name: string }
type Simple = { k: 'assign'; target: Target; op: '=' | '+=' | '-='; value: Node } | { k: 'expr'; node: Node } | { k: 'return'; node?: Node } | { k: 'break' } | { k: 'continue' }
/** A counting or halving `for`: one index in all three clauses. */
type ForHead = { index: string; start: Node; op: string; bound: Node; step: 'inc' | 'dec' | 'double' | 'halve' }
type Line = Simple | { k: 'if' | 'elseif' | 'while'; cond: Node } | { k: 'else' } | { k: 'foreach'; source: Node; key?: string; value: string } | { k: 'for'; head: ForHead }

/** `(cond) {` to the line's end. */
function header(p: Parser): Node {
  p.take('(')
  const c = p.expr()
  p.take(')')
  p.take('{')
  p.end()
  return c
}

/** The step clause of a `for`, over index `i`. Fix round 1, ruling C: no shift step (`1 << 63` wraps to PHP_INT_MIN, then 0, and the loop never ends). */
function readStep(p: Parser, i: string): ForHead['step'] {
  if (p.is('++') || p.is('--')) {
    const op = p.peek()!.v
    p.i++
    need(p.variable() === i)
    return op === '++' ? 'inc' : 'dec'
  }
  need(p.variable() === i)
  const t = p.peek()
  need(t?.t === 'p')
  p.i++
  switch (t!.v) {
    case '++':
      return 'inc'
    case '--':
      return 'dec'
    case '+=':
    case '-=': {
      const n = p.expr()
      need(numLit(n) === 1)
      return t!.v === '+=' ? 'inc' : 'dec'
    }
    case '*=':
      need(numLit(p.expr()) === 2)
      return 'double'
    case '=': {
      const n = p.expr()
      need(isCallOf(n, 'intdiv') && n.args.length === 2 && isVar(n.args[0], i) && numLit(n.args[1]) === 2)
      return 'halve'
    }
    default:
      refuse()
  }
}

/** One shown line as a statement or a block header (its body never on the header line). Anything else refuses. */
function parseLine(text: string): Line {
  const toks = tokenize(text.trim())
  need(toks.length > 0)
  const p = new Parser(toks)
  // A line may close the block before it only to go on with an elseif or else.
  const closes = p.is('}')
  if (closes) p.i++
  if (isP(toks.at(-1), '{')) {
    if (p.isWord('elseif')) {
      p.i++
      return { k: 'elseif', cond: header(p) }
    }
    if (p.isWord('else')) {
      p.i++
      p.take('{')
      p.end()
      return { k: 'else' }
    }
    need(!closes)
    for (const w of ['if', 'while'] as const) {
      if (p.isWord(w)) {
        p.i++
        return { k: w, cond: header(p) }
      }
    }
    if (p.isWord('foreach')) {
      p.i++
      p.take('(')
      const source = p.expr()
      p.takeWord('as')
      let value = p.variable()
      let key: string | undefined
      if (p.is('=>')) {
        p.i++
        key = value
        value = p.variable()
      }
      p.take(')')
      p.take('{')
      p.end()
      return { k: 'foreach', source, value, ...(key === undefined ? {} : { key }) }
    }
    if (p.isWord('for')) {
      p.i++
      p.take('(')
      const index = p.variable()
      p.take('=')
      const start = p.expr()
      p.take(';')
      need(p.variable() === index)
      const op = p.peek()
      need(op?.t === 'p' && ORDER.has(op.v))
      p.i++
      const bound = p.expr()
      p.take(';')
      const step = readStep(p, index)
      p.take(')')
      p.take('{')
      p.end()
      return { k: 'for', head: { index, start, op: op!.v, bound, step } }
    }
    refuse()
  }
  need(!closes && isP(toks.at(-1), ';'))
  const q = new Parser(toks.slice(0, -1))
  if (q.isWord('return')) {
    q.i++
    if (q.done) return { k: 'return' }
    const node = q.expr()
    q.end()
    return { k: 'return', node }
  }
  for (const w of ['break', 'continue'] as const) {
    if (q.isWord(w)) {
      q.i++
      q.end()
      return { k: w }
    }
  }
  // `++$v` and `--$v`.
  if (q.is('++') || q.is('--')) {
    const op = q.peek()!.v === '++' ? '+=' : '-='
    q.i++
    const name = q.variable()
    q.end()
    return { k: 'assign', target: { k: 'var', name }, op, value: { k: 'num', v: 1, int: true } }
  }
  if (q.peek()?.t === 'var') {
    const name = q.variable()
    let target: Target = { k: 'var', name }
    if (q.is('[') && q.is(']', 1)) {
      q.i += 2
      target = { k: 'append', name }
    } else if (q.is('[')) {
      q.i++
      const key = q.expr()
      q.take(']')
      target = { k: 'key', name, key }
    }
    const t = q.peek()
    need(t?.t === 'p')
    q.i++
    if (t!.v === '++' || t!.v === '--') {
      need(target.k === 'var')
      q.end()
      return { k: 'assign', target, op: t!.v === '++' ? '+=' : '-=', value: { k: 'num', v: 1, int: true } }
    }
    need(t!.v === '=' || ((t!.v === '+=' || t!.v === '-=') && target.k === 'var'))
    const value = q.expr()
    q.end()
    return { k: 'assign', target, op: t!.v as '=' | '+=' | '-=', value }
  }
  const node = q.expr()
  q.end()
  need(node.k === 'call' || node.k === 'static')
  return { k: 'expr', node }
}

// ---------------------------------------------------------------------------
// Signature (spec gate 3)

/** `array` (sized, elements untyped), `str` (sized by strlen), numbers and booleans by value, `other` anything else (never a source). */
type Kind = 'array' | 'str' | 'int' | 'float' | 'bool' | 'other'
type Param = { name: string; kind: Kind }

/** Splits `toks` at `sep` outside brackets. */
function splitTop(toks: Tok[], sep: string): Tok[][] {
  const parts: Tok[][] = [[]]
  let depth = 0
  for (const t of toks) {
    if (t.t === 'p' && ['(', '[', '{'].includes(t.v)) depth++
    else if (t.t === 'p' && [')', ']', '}'].includes(t.v)) depth--
    if (depth === 0 && isP(t, sep)) parts.push([])
    else parts.at(-1)!.push(t)
  }
  return parts
}

/** A declared type: `?T` or a union of names; `null` aside, one listed name is its kind. Promotion, references and spreads refuse. */
function classify(toks: Tok[]): Kind {
  if (toks.length === 0) return 'other'
  let ts = toks
  if (isP(ts[0], '?')) ts = ts.slice(1)
  const names: string[] = []
  ts.forEach((t, k) => {
    if (k % 2 === 1) return need(isP(t, '|'))
    need(t.t === 'id' && !MODIFIERS.has(keyOf(t.v, 'PHP')))
    names.push(keyOf(t.v, 'PHP'))
  })
  need(ts.length % 2 === 1)
  const kept = names.filter((n) => n !== 'null')
  if (kept.length !== 1) return 'other'
  const w = kept[0]!
  return w === 'array' ? 'array' : w === 'string' ? 'str' : w === 'int' || w === 'float' || w === 'bool' ? w : 'other'
}

const LITERAL_DEFAULTS = [['num'], ['-', 'num'], ['true'], ['false'], ['null'], ['[', ']']]

/**
 * Spec gate 3: `[modifiers] function name(params)[: type] {` over the lines
 * up to the body's `{` (at most `PUZZLE.maxSignatureLines`); each parameter
 * `[type] $name [= literal]`. By-reference, variadic and promoted parameters,
 * and a function returning by reference, refuse.
 */
function readSignature(lines: readonly string[], opener: number, name: string): Param[] {
  need(opener < PUZZLE.maxSignatureLines)
  const toks = tokenize(lines.slice(0, opener + 1).join(' ').trim())
  need(isP(toks.at(-1), '{'))
  let k = 0
  while (toks[k]?.t === 'id' && FUNCTION_MODIFIERS.has(keyOf(toks[k]!.v, 'PHP'))) k++
  need(isWord(toks[k], 'function') && toks[k + 1]?.t === 'id' && keyOf(toks[k + 1]!.v, 'PHP') === keyOf(name, 'PHP') && isP(toks[k + 2], '('))
  const open = k + 2
  let depth = 0
  let close = -1
  for (let j = open; j < toks.length; j++) {
    if (isP(toks[j], '(') || isP(toks[j], '[')) depth++
    else if ((isP(toks[j], ')') || isP(toks[j], ']')) && --depth === 0) {
      close = j
      break
    }
  }
  need(close > open && isP(toks[close], ')'))
  const after = toks.slice(close + 1, -1)
  // A return type: names, `?` and `|` (`static` and `self` included).
  if (after.length > 0) need(isP(after[0], ':') && after.length > 1 && after.slice(1).every((t) => t.t === 'id' || isP(t, '?') || isP(t, '|')))
  const parts = splitTop(toks.slice(open + 1, close), ',')
  if (parts.length > 1 && parts.at(-1)!.length === 0) parts.pop()
  const params: Param[] = []
  if (parts.length === 1 && parts[0]!.length === 0) return params
  for (const part of parts) {
    const at = part.findIndex((t) => t.t === 'var')
    need(at >= 0)
    const kind = classify(part.slice(0, at))
    const rest = part.slice(at + 1)
    if (rest.length > 0) {
      need(isP(rest[0], '='))
      const d = rest.slice(1).map((t) => (t.t === 'num' ? 'num' : t.t === 'id' ? keyOf(t.v, 'PHP') : t.v))
      need(LITERAL_DEFAULTS.some((l) => l.length === d.length && l.every((v, j) => v === d[j])))
    }
    params.push({ name: part[at]!.v, kind })
  }
  need(new Set(params.map((p) => p.name)).size === params.length)
  return params
}

// ---------------------------------------------------------------------------
// Statements

type Branch = { at: number; cond?: Node; body: Stmt[] }
type IfStmt = { k: 'if'; branches: Branch[]; hasElse: boolean }
/** `end`: the last line of the block holding a simple statement (a local's first assignment reaches no further). */
type Stmt =
  | { k: 'simple'; at: number; line: Simple; end: number }
  | { k: 'hidden'; at: number }
  | { k: 'hblock'; at: number; body: Stmt[] }
  | IfStmt
  | { k: 'foreach'; at: number; source: Node; key?: string; value: string; body: Stmt[] }
  | { k: 'for'; at: number; head: ForHead; body: Stmt[] }
  | { k: 'while'; at: number; cond: Node; body: Stmt[] }

const endOf = (b: Block): number => Math.max(b.at, ...b.children.map(endOf))

function bodiesOf(s: Stmt): Stmt[][] {
  if (s.k === 'if') return s.branches.map((b) => b.body)
  return 'body' in s ? [s.body] : []
}

function someStmt(list: Stmt[], f: (s: Stmt) => boolean): boolean {
  return list.some((s) => f(s) || bodiesOf(s).some((b) => someStmt(b, f)))
}

const isLoopStmt = (s: Stmt): boolean => s.k === 'foreach' || s.k === 'for' || s.k === 'while'
const isTransfer = (s: Stmt): boolean => s.k === 'simple' && ['return', 'break', 'continue'].includes(s.line.k)
const mayTransfer = (body: Stmt[]): boolean => someStmt(body, isTransfer)
const mayExit = (body: Stmt[]): boolean => someStmt(body, (s) => s.k === 'simple' && (s.line.k === 'return' || s.line.k === 'break'))

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

/** A collection the reader can size: an `array` or `string` parameter, or a derived value. `origin`: the parameter whose size it is. */
type Source = { name: string; origin: string; kind: 'array' | 'str'; isParam: boolean }
/**
 * A name a loop or callback binds. `elem`: an element (opaque in an array,
 * a one-character string in a string); `key`: an array key, never an
 * element; `index`: a position; `carry`: array_reduce's number.
 */
type Binding = { role: 'elem' | 'key' | 'index' | 'carry'; origin?: string; atom: boolean }
/**
 * `index`: the loop's position name; `validFor`: the source its positions
 * read without a miss; `walks`: the string parameter it walks from 0 by 1 to
 * the end, so `$s[$i]` is a character the input chooses.
 */
type Loop = { at: number; kind: 'each' | 'count' | 'literal' | 'halving' | 'search' | 'callback'; names: Map<string, Binding>; index?: string; validFor?: string; walks?: string; factor: Cost }
type Local = { k: 'acc' } | { k: 'derived'; origin: string } | { k: 'num' } | { k: 'str' } | { k: 'opaque' } | { k: 'closed' }
type Assign = { name: string; target: Target['k']; op: string; value: Node; at: number; end: number; inLoop: boolean; loops: Loop[] }
/** A condition on the path to a site; `depth` is the number of loops around it. `opaque`: a hidden condition. */
type Entry = { cond?: Node; neg: boolean; depth: number; opaque?: boolean }
type Env = { loops: Loop[]; path: Entry[]; at: number; hidden: boolean; chain?: IfStmt }
/** `ret`: a bare collection may stand here (returned); `test`: its truth is read; `stmt`: a whole statement. */
type Ctx = 'value' | 'test' | 'ret' | 'stmt'
/** A value's type: `coll` is any array, which is never handed on as a value. */
type VT = 'num' | 'str' | 'none' | 'opaque' | 'coll'
type Val = { c: Cost; vt: VT }
/** A named value in a condition: its type and the values it reads (lessons family 4). */
type Named = { type: 'num' | 'str' | 'bool'; roots: Set<string> }

const STRICT_PLACE: HiddenPlace = { isInLoop: true, isLastAtBodyLevel: false, isInGuard: false }
const hasFactors = (c: Cost): boolean => c.some((t) => t.length > 0)
const NOTHING: Cost = []
const isEmptyArray = (n: Node): boolean => n.k === 'array' && n.items.length === 0
/** Not an lvalue: a by-reference parameter of a helper could write it. */
const isLvalue = (n: Node): boolean => n.k === 'var' || n.k === 'index'

class Reader {
  readonly params = new Map<string, Param>()
  readonly locals = new Map<string, Local>()
  readonly assigns: Assign[] = []
  /** Every line a name is read on (assignment targets that also read, included). */
  readonly reads = new Map<string, number[]>()
  /** Loop and closure names. */
  readonly loopNames = new Set<string>()
  readonly loops = new Map<number, Loop>()
  readonly searchVars = new Set<string>()
  /** A binary search's branch tests: read by the search's own shape, not the grammar. */
  readonly searchTests = new Set<Node>()
  readonly places = new Map<number, HiddenPlace>()
  readonly openers = new Set<number>()
  readonly tinyGuards = new Set<Node>()
  readonly guardBranches = new Set<number>()
  /** Number parameters that bound a loop (spec gate 10). */
  readonly sizedNumbers = new Set<string>()
  readonly sizeLocals = new Map<string, Set<string>>()
  /** Locals a condition outside loops may read (lessons families 2, 7). */
  readonly sizeFree = new Set<string>()
  /** In-place sorts per parameter: at most one, as a statement outside loops. */
  readonly sortedInPlace = new Map<string, number>()

  constructor(
    readonly unit: Unit,
    readonly lines: readonly string[],
  ) {}

  read(): { cost: Cost; numeric: string[]; params: string[] } {
    const { lines } = this
    need(lines.length > 0 && !isBlankedLine(lines[0]!))
    need(lines.every((l) => !isBlankedLine(l)) || this.unit.hidden !== undefined)
    const tree = treeByBraces(lines)
    if (!tree) refuse()
    const opener = lines.findIndex((l) => /[{}]/.test(l))
    for (const p of readSignature(lines, opener, this.unit.name)) this.params.set(p.name, p)
    this.checkNames(opener)
    const body = this.build(tree.children, { inLoop: false, inGuard: false, atRoot: true }, endOf(tree))
    this.collect(body)
    this.walkLoops(body, [])
    this.typeLocals()
    this.collectSizes()
    this.checkHidden()
    const cost = this.costOfBlock(body, { loops: [], path: [], at: 0, hidden: false })
    const params = [...this.params.values()]
    return { cost, numeric: params.filter((p) => p.kind === 'int').map((p) => p.name), params: params.map((p) => p.name) }
  }

  /** Gate 4: no shown line after the signature names the unit, any case (recursion, through `self::` or `static::` too). */
  private checkNames(opener: number): void {
    const own = keyOf(this.unit.name, 'PHP')
    for (let at = opener + 1; at < this.lines.length; at++) {
      const text = this.lines[at]!
      if (isBlankedLine(text) || text.trim() === '') continue
      for (const t of tokenize(text.trim())) need(!(t.t === 'id' && keyOf(t.v, 'PHP') === own))
    }
  }

  // --- Structure -------------------------------------------------------------

  /** Blocks to statements, recording each blanked line's place for the inert check. */
  private build(blocks: Block[], where: { inLoop: boolean; inGuard: boolean; atRoot: boolean }, parentEnd: number): Stmt[] {
    const out: Stmt[] = []
    blocks.forEach((b, k) => {
      const text = this.lines[b.at]!
      const isLast = k === blocks.length - 1
      if (isBlankedLine(text)) {
        this.places.set(b.at, { isInLoop: where.inLoop, isLastAtBodyLevel: where.atRoot && isLast, isInGuard: where.inGuard && isLast })
        if (b.children.length > 0) {
          // A hidden opener is an else (checked on its raw text), so it must close a shown if that has none.
          const prev = out.at(-1)
          need(prev?.k === 'if' && !prev.hasElse)
          this.openers.add(b.at)
          out.push({ k: 'hblock', at: b.at, body: this.build(b.children, { inLoop: where.inLoop, inGuard: false, atRoot: false }, endOf(b)) })
        } else out.push({ k: 'hidden', at: b.at })
        return
      }
      const line = parseLine(text)
      const guard = !where.inLoop && (where.atRoot || where.inGuard)
      const nested = (inLoop: boolean, inGuard: boolean): Stmt[] => {
        need(b.children.length > 0)
        return this.build(b.children, { inLoop, inGuard, atRoot: false }, endOf(b))
      }
      switch (line.k) {
        case 'if':
          out.push({ k: 'if', branches: [{ at: b.at, cond: line.cond, body: nested(where.inLoop, guard) }], hasElse: false })
          return
        case 'elseif':
        case 'else': {
          const prev = out.at(-1)
          if (prev?.k !== 'if' || prev.hasElse) refuse()
          prev.branches.push({ at: b.at, ...(line.k === 'elseif' ? { cond: line.cond } : {}), body: nested(where.inLoop, guard) })
          if (line.k === 'else') prev.hasElse = true
          return
        }
        case 'foreach':
          out.push({ k: 'foreach', at: b.at, source: line.source, value: line.value, ...(line.key === undefined ? {} : { key: line.key }), body: nested(true, false) })
          return
        case 'for':
          out.push({ k: 'for', at: b.at, head: line.head, body: nested(true, false) })
          return
        case 'while':
          out.push({ k: 'while', at: b.at, cond: line.cond, body: nested(true, false) })
          return
        default:
          need(b.children.length === 0)
          out.push({ k: 'simple', at: b.at, line, end: parentEnd })
      }
    })
    return out
  }

  // --- Names (pass 0) --------------------------------------------------------

  private declareLoopName(n: string): void {
    need(!this.params.has(n))
    this.loopNames.add(n)
  }

  private addRead(name: string, at: number): void {
    const list = this.reads.get(name) ?? []
    list.push(at)
    this.reads.set(name, list)
  }

  /** Assignments, reads and loop names; then each local's first assignment, and accumulators and derived values. */
  private collect(body: Stmt[]): void {
    const visit = (n: Node, at: number): void => {
      if (n.k === 'var') this.addRead(n.name, at)
      if (n.k === 'fn') n.params.forEach((p) => this.declareLoopName(p))
      for (const c of childrenOf(n)) visit(c, at)
    }
    const walk = (list: Stmt[], inLoop: boolean): void => {
      for (const s of list) {
        if (s.k === 'simple') {
          const l = s.line
          if (l.k === 'assign') {
            const t = l.target
            // Gate 9 and lessons family 15: no parameter is written (an array parameter would be copied whole).
            need(!this.params.has(t.name))
            this.assigns.push({ name: t.name, target: t.k, op: l.op, value: l.value, at: s.at, end: s.end, inLoop, loops: [] })
            if (t.k !== 'var' || l.op !== '=') this.addRead(t.name, s.at)
            if (t.k === 'key') visit(t.key, s.at)
            visit(l.value, s.at)
          } else if (l.k === 'expr') {
            const n = l.node
            // An in-place sort of a parameter, counted: it may stand once.
            if (n.k === 'call' && SORTS.has(n.fn) && isVar(n.args[0]) && this.params.has(n.args[0].name)) {
              const p = n.args[0].name
              this.sortedInPlace.set(p, (this.sortedInPlace.get(p) ?? 0) + 1)
            }
            visit(n, s.at)
          } else if (l.k === 'return' && l.node) visit(l.node, s.at)
        } else if (s.k === 'if') {
          for (const b of s.branches) if (b.cond) visit(b.cond, b.at)
        } else if (s.k === 'foreach') {
          for (const n of [s.key, s.value]) if (n !== undefined) this.declareLoopName(n)
          need(s.key !== s.value)
          visit(s.source, s.at)
        } else if (s.k === 'for') {
          this.declareLoopName(s.head.index)
          visit(s.head.start, s.at)
          visit(s.head.bound, s.at)
        } else if (s.k === 'while') visit(s.cond, s.at)
        for (const b of bodiesOf(s)) walk(b, inLoop || isLoopStmt(s))
      }
    }
    walk(body, false)
    const byName = new Map<string, Assign[]>()
    for (const a of this.assigns) byName.set(a.name, [...(byName.get(a.name) ?? []), a])
    for (const [name, list] of byName) {
      need(!this.loopNames.has(name))
      // Read only where the first assignment has run: after it, within its block.
      const first = list[0]!
      need(first.target === 'var' && first.op === '=')
      const refs = [...(this.reads.get(name) ?? []), ...list.slice(1).map((a) => a.at)]
      need(refs.every((r) => r > first.at && r <= first.end))
      this.locals.set(name, this.localOf(list))
    }
    // Every name read is a parameter, a local or a loop name.
    for (const name of this.reads.keys()) need(this.params.has(name) || this.locals.has(name) || this.loopNames.has(name))
  }

  /** An accumulator (starts `[]`, then only reset to `[]`, appended to or written by key); a derived value (one write outside loops); else typed later. */
  private localOf(list: Assign[]): Local {
    const first = list[0]!
    if (isEmptyArray(first.value)) {
      need(list.every((a) => a.op === '=' && (a.target !== 'var' || isEmptyArray(a.value))))
      return { k: 'acc' }
    }
    need(list.every((a) => a.target === 'var'))
    const derived = list.length === 1 && !first.inLoop ? this.derivedFrom(first.value) : undefined
    return derived ?? { k: 'num' }
  }

  /** Spec "Builtins", derived values: one `array` parameter through `array_keys`, `array_values`, `array_reverse`, `array_filter` or `array_map` (one array), keeping its size. */
  private derivedFrom(n: Node): Local | undefined {
    if (n.k !== 'call') return undefined
    const src = n.fn === 'array_map' ? n.args[1] : n.args[0]
    const arity = n.fn === 'array_map' ? n.args.length === 2 : n.fn === 'array_filter' ? n.args.length === 1 || n.args.length === 2 : n.args.length === 1
    if (!['array_keys', 'array_values', 'array_reverse', 'array_filter', 'array_map'].includes(n.fn) || !arity || !isVar(src)) return undefined
    if (n.fn === 'array_map' && n.args[0]!.k !== 'fn') return undefined
    if (n.fn === 'array_filter' && n.args[1] !== undefined && n.args[1].k !== 'fn') return undefined
    const p = this.params.get(src.name)
    return p?.kind === 'array' ? { k: 'derived', origin: p.name } : undefined
  }

  // --- Loops (spec "Loops") ----------------------------------------------------

  /** Classifies each loop; records each assignment's loops for typing. */
  private walkLoops(list: Stmt[], loops: Loop[]): void {
    list.forEach((s, k) => {
      switch (s.k) {
        case 'simple':
          for (const a of this.assigns) if (a.at === s.at) a.loops = loops
          return
        case 'foreach': {
          for (const n of [s.key, s.value]) if (n !== undefined) need(!loops.some((l) => l.names.has(n)))
          const loop = this.eachLoop(s, s.at)
          this.loops.set(s.at, loop)
          this.walkLoops(s.body, [...loops, loop])
          return
        }
        case 'for': {
          need(!loops.some((l) => l.names.has(s.head.index)))
          const loop = this.forLoop(s.head, loops, s.at)
          this.loops.set(s.at, loop)
          this.walkLoops(s.body, [...loops, loop])
          return
        }
        case 'while': {
          const loop = this.searchLoop(s, list, k)
          this.loops.set(s.at, loop)
          this.walkLoops(s.body, [...loops, loop])
          return
        }
        default:
          for (const b of bodiesOf(s)) this.walkLoops(b, loops)
      }
    })
  }

  /** An `array` or `string` parameter, or a derived value. Untyped and other-typed parameters are no sources. */
  private sourceOfName(name: string): Source | undefined {
    const p = this.params.get(name)
    if (p) return p.kind === 'array' || p.kind === 'str' ? { name, origin: name, kind: p.kind, isParam: true } : undefined
    const l = this.locals.get(name)
    return l?.k === 'derived' ? { name, origin: l.origin, kind: 'array', isParam: false } : undefined
  }

  /** `foreach ($S as [$k =>] $v)` over an array parameter or a derived value; `$S[$k]` is then a valid read. */
  private eachLoop(s: Extract<Stmt, { k: 'foreach' }>, at: number): Loop {
    need(isVar(s.source))
    const src = this.sourceOfName((s.source as { name: string }).name)
    need(src?.kind === 'array')
    const names = new Map<string, Binding>([[s.value, { role: 'elem', origin: src!.origin, atom: src!.isParam }]])
    if (s.key !== undefined) names.set(s.key, { role: 'key', origin: src!.origin, atom: false })
    return { at, kind: 'each', names, ...(s.key !== undefined ? { index: s.key, validFor: src!.name } : {}), factor: factor({ size: src!.origin, log: false, kind: 'loop', at, what: `loop over ${src!.name}` }) }
  }

  /**
   * The loop table for `for`: counting up from 0 or 1 (or an enclosing
   * index ± a literal over the same size) while `< B` or `<= B - 1` by one;
   * down from B or B - 1 to a literal by one; halving up from a positive
   * literal by `*= 2`, or down from B by `intdiv($i, 2)` (no shift step);
   * both ends literal is constant. B is `count($S)`, `strlen($s)` or an int
   * parameter, or an enclosing index (never under a halving loop or search).
   */
  private forLoop(h: ForHead, loops: Loop[], at: number): Loop {
    const index = h.index
    const names = new Map<string, Binding>([[index, { role: 'index', atom: false }]])
    const loopOf = (size: string, kind: 'loop' | 'halving', extra: Partial<Loop> = {}): Loop => ({ at, kind: kind === 'loop' ? 'count' : 'halving', names, index, factor: factor({ size, log: kind === 'halving', kind, at, what: `${kind === 'loop' ? 'loop' : 'halving loop'} over ${size}` }), ...extra })
    const start = numLit(h.start)
    const end = numLit(h.bound)
    if (h.step === 'double') {
      need((h.op === '<' || h.op === '<=') && start !== undefined && start >= 1)
      return loopOf(this.boundOf(h.bound).size, 'halving')
    }
    if (h.step === 'halve') {
      need(end !== undefined && ((h.op === '>' && end >= 0) || (h.op === '>=' && end >= 1)))
      return loopOf(this.boundOf(h.start).size, 'halving')
    }
    if (h.step === 'dec') {
      need((h.op === '>' || h.op === '>=') && end !== undefined)
      if (start !== undefined) {
        need(h.op === '>' ? start > end! : start >= end!)
        return { at, kind: 'literal', names, index, factor: ONE }
      }
      let st = h.start
      const minus = st.k === 'bin' && st.op === '-' && numLit(st.right) === 1
      if (minus) st = (st as Extract<Node, { k: 'bin' }>).left
      const b = this.boundOf(st)
      const valid = minus && b.of !== undefined && (h.op === '>=' ? end! >= 0 : end! >= -1)
      return loopOf(b.size, 'loop', valid ? { validFor: b.of } : {})
    }
    need(h.op === '<' || h.op === '<=')
    let bound = h.bound
    // The exclusive end, relative to B: `< B` is 0, `<= B - 1` is 0, `<= B` is +1, `< B - 1` is -1.
    let plus = h.op === '<=' ? 1 : 0
    if (bound.k === 'bin' && bound.op === '-' && numLit(bound.right) === 1) {
      plus -= 1
      bound = bound.left
    }
    if (start !== undefined && end !== undefined) {
      // A constant number of rounds, at least one: an empty loop's body is dead code.
      need(start >= 0 && (h.op === '<' ? end > start : end >= start))
      return { at, kind: 'literal', names, index, factor: ONE }
    }
    need(end === undefined)
    // A foreach key is no position (keys may be any integers), so only a counting loop's index bounds another.
    const ref = isVar(bound) ? loops.find((l) => l.index === (bound as { name: string }).name && l.kind === 'count') : undefined
    if (ref) {
      // An inner bound that is an enclosing index: from a literal start, never under a halving loop or a search.
      need((start === 0 || start === 1) && plus <= 0 && !loops.some((l) => l.kind === 'search' || l.kind === 'halving'))
      return { at, kind: 'count', names, index, factor: ref.factor.map((t) => t.map((f) => ({ ...f, at }))), ...(ref.validFor ? { validFor: ref.validFor } : {}) }
    }
    const b = this.boundOf(bound)
    const valid = b.of !== undefined && plus <= 0 ? { validFor: b.of } : {}
    if (start === 0 || start === 1) {
      const s = b.of !== undefined ? this.sourceOfName(b.of) : undefined
      const walks = start === 0 && plus === 0 && s?.isParam && s.kind === 'str' ? { walks: s.name } : {}
      return loopOf(b.size, 'loop', { ...valid, ...walks })
    }
    // From an enclosing index ± a literal: that loop must run over the same size, or the sum is not n × m.
    const outer = this.indexStart(h.start, loops)
    need(outer.factor.every((t) => t.every((f) => f.size === b.size)))
    return loopOf(b.size, 'loop', valid)
  }

  /** A start at an enclosing counting or foreach loop's index plus or minus a literal. */
  private indexStart(n: Node, loops: Loop[]): Loop {
    const of = (m: Node): Loop | undefined => (isVar(m) ? loops.find((l) => l.index === m.name && l.kind === 'count') : undefined)
    const direct = of(n)
    if (direct) return direct
    if (n.k === 'bin' && (n.op === '+' || n.op === '-') && numLit(n.right) !== undefined) {
      const l = of(n.left)
      if (l) return l
    }
    refuse()
  }

  /** A bound B: `count($S)` of an array source, `strlen($s)` of a string parameter (`of` names it), or an int parameter. */
  private boundOf(n: Node): { size: string; of?: string } {
    if ((isCallOf(n, 'count') || isCallOf(n, 'strlen')) && n.args.length === 1 && isVar(n.args[0])) {
      const s = this.sourceOfName(n.args[0].name)
      if (s && (n.fn === 'count' ? s.kind === 'array' : s.kind === 'str')) return { size: s.origin, of: s.name }
    }
    if (isVar(n) && this.params.get(n.name)?.kind === 'int') {
      this.sizedNumbers.add(n.name)
      return { size: n.name }
    }
    refuse()
  }

  // --- Binary search (spec "Binary search", ruling F) ---------------------------

  /**
   * `$lo = 0; $hi = count($S) - 1; while ($lo <= $hi)` (or `$hi = count($S)`
   * with `<`), `$mid = intdiv($lo + $hi, 2)` or `($lo + $hi) >> 1` first, then
   * one if/else on `$S[$mid]` against a parameter or a literal whose branches
   * set lo and hi. No equality exit: an array's elements are untyped.
   */
  private searchLoop(s: Extract<Stmt, { k: 'while' }>, list: Stmt[], k: number): Loop {
    const c = s.cond
    need(c.k === 'cmp' && (c.op === '<=' || c.op === '<') && isVar(c.left) && isVar(c.right))
    const cond = c as Extract<Node, { k: 'cmp' }>
    const lo = (cond.left as { name: string }).name
    const hi = (cond.right as { name: string }).name
    need(lo !== hi)
    const inclusive = cond.op === '<='
    const before = [list[k - 1], list[k - 2]].map((p) => (p?.k === 'simple' && p.line.k === 'assign' && p.line.op === '=' && p.line.target.k === 'var' ? { name: p.line.target.name, value: p.line.value, at: p.at } : undefined))
    const loA = before.find((d) => d?.name === lo)
    const hiA = before.find((d) => d?.name === hi)
    need(numLit(loA?.value) === 0 && hiA !== undefined)
    let hiV = hiA!.value
    if (inclusive) {
      need(hiV.k === 'bin' && hiV.op === '-' && numLit(hiV.right) === 1)
      hiV = (hiV as Extract<Node, { k: 'bin' }>).left
    }
    need(isCallOf(hiV, 'count') && (hiV as Extract<Node, { k: 'call' }>).args.length === 1)
    const arg = (hiV as Extract<Node, { k: 'call' }>).args[0]!
    const src = isVar(arg) ? this.sourceOfName(arg.name) : undefined
    need(src?.kind === 'array')
    const first = s.body[0]
    need(first?.k === 'simple' && first.line.k === 'assign' && first.line.op === '=' && first.line.target.k === 'var')
    const midA = (first as { line: Extract<Simple, { k: 'assign' }> }).line
    const mid = midA.target.name
    need(mid !== lo && mid !== hi && isMidForm(midA.value, lo, hi))
    for (const a of this.assigns.filter((x) => x.name === lo || x.name === hi || x.name === mid)) {
      if (a.at === loA!.at || a.at === hiA!.at || a.at === first!.at) continue
      need(a.target === 'var' && a.op === '=' && a.name !== mid && someStmt(s.body, (x) => 'at' in x && x.at === a.at))
      const v = a.value
      if (a.name === lo) need(v.k === 'bin' && v.op === '+' && isVar(v.left, mid) && numLit(v.right) === 1)
      else if (inclusive) need(v.k === 'bin' && v.op === '-' && isVar(v.left, mid) && numLit(v.right) === 1)
      else need(isVar(v, mid))
    }
    need(this.assigns.filter((x) => x.name === mid).length === 1)
    const test = isSearchBody(s.body.slice(1), lo, hi, mid)
    need(test !== undefined && isSearchCompare(test, src!.name, mid, (n) => this.isScalarParam(n)))
    this.searchTests.add(test!)
    for (const v of [lo, hi, mid]) this.searchVars.add(v)
    return { at: s.at, kind: 'search', names: new Map(), index: mid, validFor: src!.name, factor: factor({ size: src!.origin, log: true, kind: 'search', at: s.at, what: `binary search over ${src!.name}` }) }
  }

  /** A number parameter (fix round 1, ruling D: never a whole string, whose comparison costs its length). */
  private isScalarParam(name: string): boolean {
    const k = this.params.get(name)?.kind
    return k === 'int' || k === 'float'
  }

  // --- Locals: types (lessons family 5) -----------------------------------------

  /** The type of a value by its shape, without checks (`val` checks and must agree). */
  private typeOf(n: Node, loops: Loop[]): VT | 'bad' {
    switch (n.k) {
      case 'num':
        return 'num'
      case 'const':
        return n.v === 'null' ? 'none' : 'num'
      case 'var':
        return this.nameVT(n.name, loops) ?? 'bad'
      case 'index': {
        const s = isVar(n.obj) ? this.sourceOfName(n.obj.name) : undefined
        return s ? (s.kind === 'str' ? 'str' : 'opaque') : 'bad'
      }
      case 'call':
        return this.callType(n, loops)
      case 'static':
        return 'opaque'
      case 'unary':
        return n.op === '!' || this.typeOf(n.arg, loops) === 'num' ? 'num' : 'bad'
      case 'bin':
        return this.typeOf(n.left, loops) === 'num' && this.typeOf(n.right, loops) === 'num' ? 'num' : 'bad'
      case 'cmp':
      case 'bool':
        return 'num'
      case 'array':
        return 'coll'
      default:
        return 'bad'
    }
  }

  private callType(n: Extract<Node, { k: 'call' }>, loops: Loop[]): VT | 'bad' {
    switch (n.fn) {
      case 'count':
      case 'strlen':
      case 'array_sum':
      case 'in_array':
      case 'isset':
      case 'empty':
      case 'array_key_exists':
      case 'abs':
      case 'intdiv':
      case 'array_reduce':
        return 'num'
      case 'max':
      case 'min':
        if (n.args.length === 1) return 'opaque'
        return n.args.every((x) => this.typeOf(x, loops) === 'num') ? 'num' : 'bad'
      case 'array_search':
      case 'array_key_first':
      case 'array_key_last':
        return 'opaque'
      case 'array_keys':
      case 'array_values':
      case 'array_reverse':
      case 'array_flip':
      case 'array_slice':
      case 'array_filter':
      case 'array_map':
        return 'coll'
      default:
        return 'bad'
    }
  }

  private nameVT(name: string, loops: Loop[]): VT | undefined {
    for (let k = loops.length - 1; k >= 0; k--) {
      const b = loops[k]!.names.get(name)
      if (b) return b.role === 'index' || b.role === 'carry' ? 'num' : 'opaque'
    }
    const l = this.locals.get(name)
    if (l) return l.k === 'num' ? 'num' : l.k === 'str' ? 'str' : l.k === 'opaque' ? 'opaque' : 'coll'
    const p = this.params.get(name)
    if (!p) return undefined
    if (p.kind === 'int' || p.kind === 'float' || p.kind === 'bool') return 'num'
    if (p.kind === 'str') return 'str'
    return p.kind === 'array' ? 'coll' : 'opaque'
  }

  /**
   * Family 5: a local is a number (or a string) only when every write is one,
   * by a fixpoint from "all numbers" down; a mix of scalars is opaque; arrays
   * from literals and copying builtins are closed. Anything else refuses.
   */
  private typeLocals(): void {
    const pending = [...this.locals].filter(([, l]) => l.k === 'num').map(([n]) => n)
    for (let round = 0, changed = true; changed; round++) {
      need(round <= 3 * pending.length + 3)
      changed = false
      for (const name of pending) {
        const vts = this.assigns.filter((a) => a.name === name).map((a) => {
          const t = this.typeOf(a.value, a.loops)
          return a.op === '=' ? t : t === 'num' ? 'num' : 'bad'
        })
        const next: Local['k'] | 'bad' = vts.includes('bad') ? 'bad' : vts.every((v) => v === 'num') ? 'num' : vts.every((v) => v === 'str') ? 'str' : vts.every((v) => v === 'coll') ? 'closed' : vts.includes('coll') ? 'bad' : 'opaque'
        need(next !== 'bad')
        if (next !== this.locals.get(name)!.k) {
          this.locals.set(name, { k: next } as Local)
          changed = true
        }
      }
    }
    for (const a of this.assigns) if (a.op !== '=') need(this.locals.get(a.name)?.k === 'num')
  }

  // --- Sizes (gate 10, lessons families 2, 3, 7) --------------------------------

  private collectSizes(): void {
    for (let changed = true; changed; ) {
      changed = false
      for (const a of this.assigns) {
        const found = new Set(this.sizeLocals.get(a.name))
        const before = found.size
        for (const o of this.sizesOf(a.value)) found.add(o)
        if (found.size > before) {
          this.sizeLocals.set(a.name, found)
          changed = true
        }
      }
    }
    // Size-free: a number written only outside loops, from a parameter plus or minus a literal (never from a call: family 7).
    for (const [name, l] of this.locals) if (l.k === 'num' && this.assigns.every((a) => a.name !== name || !a.inLoop)) this.sizeFree.add(name)
    for (let changed = true; changed; ) {
      changed = false
      for (const name of [...this.sizeFree]) {
        if (!this.assigns.every((a) => a.name !== name || this.isSizeFreeValue(a.value))) {
          this.sizeFree.delete(name)
          changed = true
        }
      }
    }
  }

  /** The parameters whose sizes `n` holds ('?' for a size the reader cannot name); index brackets excluded. */
  private sizesOf(n: Node): Set<string> {
    const out = new Set<string>()
    const visit = (m: Node): void => {
      if (isCallOf(m, 'count') || isCallOf(m, 'strlen') || isCallOf(m, 'empty')) {
        const a = m.args[0]
        const s = isVar(a) ? this.sourceOfName(a.name) : undefined
        if (s) out.add(s.origin)
        else if (!(isVar(a) && this.isCharValue(a.name))) out.add('?')
        return
      }
      if (isVar(m)) {
        if (this.sizedNumbers.has(m.name)) out.add(m.name)
        for (const o of this.sizeLocals.get(m.name) ?? []) out.add(o)
        return
      }
      if (m.k === 'index') return visit(m.obj)
      if (m.k === 'fn') return
      childrenOf(m).forEach(visit)
    }
    visit(n)
    return out
  }

  /** A string value that is no size: a string local (a character). */
  private isCharValue(name: string): boolean {
    return this.locals.get(name)?.k === 'str'
  }

  private namedSizes(n: Node): number {
    return [...this.sizesOf(n)].filter((o) => o !== '?').length
  }

  /** `count($S)` / `strlen($s)` of a source, or a sized number parameter. */
  private directSize(n: Node): boolean {
    if (isCallOf(n, 'count') || isCallOf(n, 'strlen')) return n.args.length === 1 && isVar(n.args[0]) && this.sourceOfName(n.args[0].name) !== undefined
    return isVar(n) && this.sizedNumbers.has(n.name)
  }

  /**
   * Family 2: a stable test is `&&`, `||` and `!` over atoms that each hold
   * alone and do not vary by iteration: a bool parameter, or a comparison of an
   * int or float parameter or a size-free local with another or an integer
   * literal; at the root also `count($p)`, `strlen($p)` and `empty($p)` of a
   * parameter, which gate 10 then reads.
   */
  private isStable(n: Node, root: boolean): boolean {
    switch (n.k) {
      case 'bool':
        return this.isStable(n.left, root) && this.isStable(n.right, root)
      case 'unary':
        return n.op === '!' && this.isStable(n.arg, root)
      case 'var':
        return this.params.get(n.name)?.kind === 'bool'
      case 'call':
        return root && n.fn === 'empty' && n.args.length === 1 && isVar(n.args[0]) && this.sourceOfName(n.args[0].name)?.isParam === true
      case 'cmp': {
        if (!EQUALITY.has(n.op) && !ORDER.has(n.op)) return false
        const side = (m: Node): 'lit' | 'var' | undefined => {
          if (numLit(m) !== undefined) return 'lit'
          if (isVar(m)) {
            const k = this.params.get(m.name)?.kind
            return k === 'int' || k === 'float' || this.sizeFree.has(m.name) ? 'var' : undefined
          }
          return root && (isCallOf(m, 'count') || isCallOf(m, 'strlen')) && m.args.length === 1 && isVar(m.args[0]) && this.sourceOfName(m.args[0].name)?.isParam ? 'var' : undefined
        }
        const l = side(n.left)
        const r = side(n.right)
        return l !== undefined && r !== undefined && (l === 'var' || r === 'var')
      }
      default:
        return false
    }
  }

  /** A size-free local's value: an int or float parameter or a size-free local, plus or minus an integer literal. */
  private isSizeFreeValue(n: Node): boolean {
    if (n.k === 'bin' && (n.op === '+' || n.op === '-') && numLit(n.right) !== undefined) n = n.left
    if (!isVar(n)) return false
    const k = this.params.get(n.name)?.kind
    return k === 'int' || k === 'float' || this.sizeFree.has(n.name)
  }

  /** Spec gate 10's exception: `count($p) === 0`-like tests and `empty($p)`, through && and ||, in an if outside loops whose branch ends in an exit. */
  private approveGuard(b: Branch, env: Env): void {
    if (env.loops.length > 0 || env.hidden || !b.cond) return
    const found: Node[] = []
    const visit = (n: Node): void => {
      if (n.k === 'bool') {
        visit(n.left)
        visit(n.right)
      } else if (n.k === 'cmp' && Object.hasOwn(TINY, n.op) && this.directSize(n.left) && TINY[n.op]!.includes(numLit(n.right) ?? -1)) found.push(n)
      else if (isCallOf(n, 'empty') && n.args.length === 1 && isVar(n.args[0]) && this.sourceOfName(n.args[0].name) !== undefined) found.push(n)
    }
    visit(b.cond)
    const last = b.body.at(-1)
    const exits = last?.k === 'simple' ? last.line.k === 'return' : last?.k === 'hidden' && this.hiddenExits(last.at)
    if (found.length === 0 || !exits) return
    for (const n of found) this.tinyGuards.add(n)
    this.guardBranches.add(b.at)
  }

  /** Gate 10 over an expression: every comparison holding a size, and no size tested any other way. */
  private sizesIn(n: Node, env: Env, test: boolean): void {
    if (n.k === 'cmp') {
      if (!this.tinyGuards.has(n)) this.checkComparison(n, env)
      this.sizesIn(n.left, env, false)
      this.sizesIn(n.right, env, false)
      return
    }
    if (n.k === 'bool') {
      this.sizesIn(n.left, env, true)
      this.sizesIn(n.right, env, test)
      return
    }
    if (n.k === 'unary' && n.op === '!') {
      this.sizesIn(n.arg, env, true)
      return
    }
    if (this.tinyGuards.has(n)) return
    if (test) need(this.sizesOf(n).size === 0)
    if (n.k === 'fn') return
    for (const c of childrenOf(n)) this.sizesIn(c, env, false)
  }

  /** A size compared only with an enclosing loop's index, in plain arithmetic; never two sizes. */
  private checkComparison(n: Extract<Node, { k: 'cmp' }>, env: Env): void {
    const left = this.sizesOf(n.left)
    const right = this.sizesOf(n.right)
    if (left.size === 0 && right.size === 0) return
    const indices = new Set(env.loops.flatMap((l) => (l.index && l.kind === 'count' ? [l.index] : [])))
    const plain = (m: Node): boolean => numLit(m) !== undefined || this.directSize(m) || (isVar(m) && (this.sizeLocals.has(m.name) || indices.has(m.name))) || (m.k === 'bin' && ['+', '-', '*'].includes(m.op) && plain(m.left) && plain(m.right))
    need((EQUALITY.has(n.op) || ORDER.has(n.op)) && plain(n.left) && plain(n.right) && !left.has('?') && !right.has('?'))
    // Family 3: two sizes compared, in any form, may force them equal.
    need(left.size === 0 || right.size === 0)
    need(someNode(left.size > 0 ? n.right : n.left, (m) => isVar(m) && indices.has(m.name)))
  }

  // --- Conditions: the read-once grammar (lessons family 4) ------------------------

  // Each reader keeps its own copy of the grammar (see `negate`): it works on this reader's syntax tree.
  /**
   * Every condition is `&&`, `||` and `!` over atoms, and no named value (read
   * through locals) is in two atoms. An atom is a bare bool parameter,
   * `empty($S)` of a source, `A op B` (op `===`, `!==` or an ordering) of two
   * named values of one type or of a named number and an integer literal, or
   * an element's membership in another source (`in_array($x, $S)`,
   * `isset($S[$x])`, `array_key_exists($x, $S)`), once per test. Read-once
   * atoms that each vary over distinct values make a test no input leaves
   * constant.
   */
  private checkGrammar(cond: Node, env: Env): void {
    const seen = new Set<string>()
    const walk = (n: Node): void => {
      if (n.k === 'bool') {
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
    if (n.k === 'cmp' && (EQUALITY.has(n.op) || ORDER.has(n.op))) {
      const l = this.named(n.left, env)
      const r = this.named(n.right, env)
      if (l && r) {
        need(l.type === r.type && [...l.roots].every((x) => !r.roots.has(x)))
        if (l.type === 'bool') need(EQUALITY.has(n.op))
        return new Set([...l.roots, ...r.roots])
      }
      const one = l ?? r
      if (!one) refuse()
      // A number takes an integer literal; a bool or a string takes none (no string is ever shown).
      need(one.type === 'num' && numLit(l ? n.right : n.left) !== undefined)
      return one.roots
    }
    const m = this.membership(n, env)
    if (m) return m
    if (isCallOf(n, 'empty') && n.args.length === 1 && isVar(n.args[0]) && this.sourceOfName(n.args[0].name) !== undefined) return new Set([n.args[0].name])
    const v = this.named(n, env)
    need(v?.type === 'bool')
    return v!.roots
  }

  /** `in_array($e, $S[, true])`, `isset($S[$e])` or `array_key_exists($e, $S)`: an element in another source. Its roots, or undefined. */
  private membership(n: Node, env: Env): Set<string> | undefined {
    if (n.k !== 'call') return undefined
    let e: Node | undefined
    let s: Node | undefined
    if (n.fn === 'in_array' && (n.args.length === 2 || (n.args.length === 3 && n.args[2]!.k === 'const' && n.args[2]!.v === 'true'))) [e, s] = n.args
    else if (n.fn === 'array_key_exists' && n.args.length === 2) [e, s] = n.args
    else if (n.fn === 'isset' && n.args.length === 1 && n.args[0]!.k === 'index') [s, e] = [n.args[0]!.obj, n.args[0]!.index]
    if (!isVar(e) || !isVar(s)) return undefined
    const b = this.bindingOf(e.name, env)
    const src = this.sourceOfName(s.name)
    // The element is one the input chooses: bound directly over a parameter (lessons family 1).
    if (b?.role !== 'elem' || !b.atom || b.origin === undefined || src?.kind !== 'array' || src.origin === b.origin) return undefined
    return new Set([s.name, e.name])
  }

  /**
   * A single named value, its type and the values it reads: a number or bool
   * parameter (never a whole string, ruling D); a for loop's index or a binary search's lo, hi or mid; a
   * character `$s[$i]` at a position valid for that string; `count` or
   * `strlen` of a source; or a local written once outside loops that holds one
   * of these (a number plus or minus an integer literal), read through to it.
   */
  private named(n: Node, env: Env, seen = new Set<string>()): Named | undefined {
    switch (n.k) {
      case 'var': {
        const name = n.name
        const p = this.params.get(name)
        if (p) {
          // Fix round 1, ruling D: a whole string parameter is no named value (comparing it costs its length).
          const type = p.kind === 'int' || p.kind === 'float' ? 'num' : p.kind === 'bool' ? 'bool' : undefined
          return type && { type, roots: new Set([name]) }
        }
        const b = this.bindingOf(name, env)
        if (b) return b.role === 'index' && env.loops.some((l) => l.index === name && (l.kind === 'count' || l.kind === 'literal' || l.kind === 'halving')) ? { type: 'num', roots: new Set([name]) } : undefined
        if (this.searchVars.has(name)) return { type: 'num', roots: new Set([name]) }
        const writes = this.assigns.filter((a) => a.name === name)
        if (writes.length !== 1 || writes[0]!.inLoop || writes[0]!.op !== '=' || this.locals.get(name)?.k !== 'num' || seen.has(name)) return undefined
        seen.add(name)
        let init = writes[0]!.value
        const offset = init.k === 'bin' && (init.op === '+' || init.op === '-') && numLit(init.right) !== undefined
        if (offset) init = (init as Extract<Node, { k: 'bin' }>).left
        const v = this.named(init, env, seen)
        if (!v || (offset && v.type !== 'num')) return undefined
        return { type: v.type, roots: new Set([name, ...v.roots]) }
      }
      case 'call': {
        if ((n.fn !== 'count' && n.fn !== 'strlen') || n.args.length !== 1 || !isVar(n.args[0])) return undefined
        const s = this.sourceOfName(n.args[0].name)
        return s && (n.fn === 'count' ? s.kind === 'array' : s.kind === 'str') ? { type: 'num', roots: new Set([n.args[0].name]) } : undefined
      }
      case 'index': {
        if (!isVar(n.obj) || !isVar(n.index)) return undefined
        const s = this.sourceOfName(n.obj.name)
        if (s?.kind !== 'str' || !this.isPosition(n.index.name, n.obj.name, env)) return undefined
        return { type: 'str', roots: new Set([`${n.obj.name}[${n.index.name}]`, n.index.name]) }
      }
      default:
        return undefined
    }
  }

  /**
   * Stable tests on one path may contradict each other (`$k > 0`, then
   * `$k < 0`): every name they read, through size-free locals, may appear only
   * once on the path.
   */
  private checkConsistent(path: Entry[], cond: Node): void {
    const tests = [...path.flatMap((e) => (e.cond === undefined ? [] : [e.cond])), cond].filter((c) => this.isStable(c, true))
    const seen = new Set<string>()
    for (const t of tests) {
      for (const r of this.refsOf(t)) {
        need(!seen.has(r))
        seen.add(r)
      }
    }
  }

  /** Every name a test reads, once per occurrence, and the names behind each size-free local. */
  private refsOf(n: Node): string[] {
    const out: string[] = []
    const expand = (name: string, seen: Set<string>): void => {
      out.push(name)
      if (!this.sizeFree.has(name) || seen.has(name)) return
      seen.add(name)
      for (const a of this.assigns) if (a.name === name) someNode(a.value, (c) => (isVar(c) ? (expand(c.name, seen), false) : false))
    }
    someNode(n, (c) => (isVar(c) ? (expand(c.name, new Set()), false) : false))
    return out
  }

  /** A test the reader reads: by the grammar, not trivial, at most one size, consistent with its path, and gate 10. */
  private checkTest(cond: Node, env: Env): void {
    need(!isTrivial(cond))
    this.checkGrammar(cond, env)
    need(this.namedSizes(cond) <= 1)
    this.checkConsistent(env.path, cond)
    this.sizesIn(cond, env, true)
  }

  // --- Hidden lines (spec "What the reader reads", lessons family 13) ---------------

  private checkHidden(): void {
    if (this.lines.every((l) => !isBlankedLine(l))) return
    const bound = new Set([...this.params.keys(), ...this.locals.keys(), ...this.loopNames, this.unit.name])
    const hidden = this.unit.hidden
    if (!hidden) refuse()
    const scan = hiddenScan(this.lines)
    need(hidden((raw, at) => this.isHiddenOk(raw, at, bound, scan)) === true && scan.open === undefined)
  }

  private isHiddenOk(raw: string, at: number, bound: ReadonlySet<string>, scan: HiddenScan): boolean {
    const kept = this.lines[at]
    if (typeof raw !== 'string' || !Number.isInteger(at) || at < 1 || kept === undefined || !isBlankedLine(kept)) return false
    if (!isInert(raw, kept, 'PHP', bound, WORDS, this.places.get(at) ?? STRICT_PLACE, scan, at)) return false
    // A blanked opener is only an else; its body runs at most once where it stands.
    return !this.openers.has(at) || /^(?:}\s*)?else\s*{/i.test(raw.trim())
  }

  /** Whether the blanked line at `at` holds an exit word (only a boolean leaves `hidden`). */
  private hiddenExits(at: number): boolean {
    let seen = false
    const ok = this.unit.hidden?.((raw, k) => {
      if (k !== at) return true
      seen = true
      return /\b(?:return|throw|exit|die)\b/i.test(raw)
    })
    return ok === true && seen
  }

  // --- Exits (spec "Nesting and exits", lessons family 12) --------------------------

  /** Conditions the statements after `s` stand behind: an if branch that may leave means its test was false. */
  private afterGuards(s: Stmt, depth: number): Entry[] {
    if (s.k !== 'if') return []
    // At the root a hidden line may exit (inert rule 4): its branch may leave too.
    const leaves = (body: Stmt[]): boolean => mayTransfer(body) || (depth === 0 && someStmt(body, (x) => x.k === 'hidden'))
    return s.branches.filter((b) => leaves(b.body)).map((b) => (b.cond ? { cond: b.cond, neg: true, depth } : { neg: false, depth, opaque: true }))
  }

  /**
   * An exit from a loop must stand behind a positive `===` between a
   * character of a string parameter the loop walks and a character of another
   * one walked by its own loop, which
   * the input can always make false. An array's elements are untyped, so no
   * test on one is an exit. It may not stand in an if chain whose every
   * branch leaves.
   */
  private checkExit(kind: 'return' | 'break' | 'continue', env: Env): void {
    need(!env.hidden)
    const loops = env.loops
    if (kind !== 'return') need(loops.length > 0)
    if (kind === 'continue') return
    const exited = kind === 'return' ? loops : loops.slice(-1)
    if (exited.length === 0) return
    need(exited.every((l) => l.kind !== 'callback'))
    const outer = loops.indexOf(exited[0]!)
    const entries = env.path.filter((e) => e.depth > outer)
    need(entries.every((e) => !e.opaque && e.cond !== undefined && this.readsOnly(e.cond, env)))
    const positives = entries.filter((e) => !e.neg).map((e) => e.cond!)
    need(positives.some((c) => conjuncts(c).some((a) => this.isFalsifiable(a, env))))
    const chain = env.chain
    need(!(chain?.hasElse && chain.branches.every((b) => endsInTransfer(b.body))))
  }

  /** An exit test reads only literals, parameters, loop names and valid element reads, through operators. */
  private readsOnly(n: Node, env: Env): boolean {
    switch (n.k) {
      case 'num':
      case 'const':
        return true
      case 'var':
        return this.params.has(n.name) || this.bindingOf(n.name, env) !== undefined
      case 'index':
        return isVar(n.obj) && isVar(n.index) && this.sourceOfName(n.obj.name) !== undefined && this.isPosition(n.index.name, n.obj.name, env)
      case 'unary':
      case 'bin':
      case 'cmp':
      case 'bool':
        return childrenOf(n).every((c) => this.readsOnly(c, env))
      default:
        return false
    }
  }

  private bindingOf(name: string, env: Env): Binding | undefined {
    for (let k = env.loops.length - 1; k >= 0; k--) {
      const b = env.loops[k]!.names.get(name)
      if (b) return b
    }
    return undefined
  }

  /** A character the input chooses: `$s[$i]` with `$i` walking the string parameter `$s`. */
  private charRef(n: Node, env: Env): string | undefined {
    if (n.k !== 'index' || !isVar(n.obj) || !isVar(n.index)) return undefined
    const recv = n.obj.name
    const pos = n.index.name
    return env.loops.some((l) => l.walks === recv && l.index === pos) ? recv : undefined
  }

  /** `$s[$i] === $c[$j]`, characters of two string parameters (fix round 1, ruling D: never a whole string). */
  private isFalsifiable(a: Node, env: Env): boolean {
    if (a.k !== 'cmp' || a.op !== '===') return false
    for (const [x, y] of [
      [a.left, a.right],
      [a.right, a.left],
    ] as const) {
      const e = this.charRef(x, env)
      if (e === undefined) continue
      const o = this.charRef(y, env)
      if (o !== undefined && o !== e) return true
    }
    return false
  }

  // --- Costly work behind tests ---------------------------------------------------

  /**
   * Costly work in a loop counts at every iteration only when every test on
   * its path inside loops is the same at every iteration (and they agree, see
   * `checkConsistent`). A test that varies may never hold: it guards only
   * constant work.
   */
  private costly(env: Env, c: Cost): Cost {
    if (env.loops.length > 0 && hasFactors(c)) {
      for (const e of env.path) if (e.depth >= 1) need(!e.opaque && e.cond !== undefined && this.isStable(e.cond, false))
    }
    return c
  }

  // --- Cost ----------------------------------------------------------------------

  private costOfBlock(list: Stmt[], env: Env): Cost {
    let total = NOTHING
    let path = env.path
    list.forEach((s, k) => {
      // Dead code: a statement that always leaves must be last.
      need(!alwaysTransfers(s) || k === list.length - 1)
      total = add(total, this.costOfStmt(s, { ...env, path }))
      path = [...path, ...this.afterGuards(s, env.loops.length)]
    })
    return total
  }

  private costOfStmt(s: Stmt, env: Env): Cost {
    const depth = env.loops.length
    switch (s.k) {
      case 'simple':
        return this.costOfSimple(s.line, { ...env, at: s.at })
      case 'hidden':
        return NOTHING
      case 'hblock': {
        // A hidden else: its body must cost 1 and never leave.
        const body = this.costOfBlock(s.body, { ...env, hidden: true, path: [...env.path, { neg: false, depth, opaque: true }] })
        need(!hasFactors(body))
        return body
      }
      case 'if': {
        let total = NOTHING
        const prev: Entry[] = []
        for (const b of s.branches) {
          const here: Env = { ...env, at: b.at, path: [...env.path, ...prev] }
          if (b.cond) {
            if (this.searchTests.has(b.cond)) {
              // A binary search's branch test (read by its shape, `isSearchCompare`, at cost 1): it only picks lo or hi.
            } else {
              if (depth === 0) need(this.isStable(b.cond, true))
              this.approveGuard(b, here)
              this.checkTest(b.cond, here)
              total = add(total, this.val(b.cond, here, 'test').c)
            }
          }
          const body = this.costOfBlock(b.body, { ...here, path: b.cond ? [...here.path, { cond: b.cond, neg: false, depth }] : here.path, chain: s })
          // A tiny guard's branch, and a branch that leaves a loop, run at most once.
          if (this.guardBranches.has(b.at) || (depth > 0 && mayExit(b.body))) need(!hasFactors(body))
          total = add(total, body)
          if (b.cond) prev.push({ cond: b.cond, neg: true, depth })
        }
        return total
      }
      case 'foreach':
      case 'for': {
        const loop = this.loops.get(s.at)!
        const here: Env = { ...env, at: s.at }
        if (s.k === 'for') {
          this.sizesIn(s.head.start, here, false)
          this.sizesIn(s.head.bound, here, false)
        }
        const body = this.costOfBlock(s.body, { ...here, loops: [...env.loops, loop], chain: undefined })
        return this.costly(here, mul(loop.factor, add(ONE, body)))
      }
      case 'while': {
        const loop = this.loops.get(s.at)!
        const here: Env = { ...env, at: s.at }
        const body = this.costOfBlock(s.body, { ...here, loops: [...env.loops, loop], chain: undefined })
        return this.costly(here, mul(loop.factor, add(ONE, body)))
      }
    }
  }

  private costOfSimple(line: Simple, env: Env): Cost {
    switch (line.k) {
      case 'assign':
        this.sizesIn(line.value, env, false)
        return this.costOfAssign(line, env)
      case 'expr':
        this.sizesIn(line.node, env, false)
        return this.statementCall(line.node, env)
      case 'return': {
        if (line.node) this.sizesIn(line.node, env, false)
        const c = line.node ? this.val(line.node, env, 'ret').c : NOTHING
        this.checkExit('return', env)
        return c
      }
      case 'break':
      case 'continue':
        this.checkExit(line.k, env)
        return NOTHING
    }
  }

  /** A call standing as a statement: an in-place sort of a parameter (once, outside loops), or any call a value may hold. */
  private statementCall(n: Node, env: Env): Cost {
    if (n.k === 'call' && SORTS.has(n.fn)) {
      const p = isVar(n.args[0]) ? this.params.get(n.args[0].name) : undefined
      need(p?.kind === 'array' && env.loops.length === 0 && this.sortedInPlace.get(p.name) === 1)
      if (USER_SORTS.has(n.fn)) need(n.args.length === 2 && isComparator(n.args[1]!, (v) => this.isBoundName(v)))
      else need(n.args.length === 1)
      return this.sortSite(env, p!.name)
    }
    return this.val(n, env, 'stmt').c
  }

  /** A name the function binds: no closure parameter may shadow one. */
  private isBoundName(name: string): boolean {
    return this.params.has(name) || this.locals.has(name)
  }

  /** Gate 9 and the locals: a write keeps the local's kind; an accumulator is reset only to `[]`, and grows by `[] =` or a key write. */
  private costOfAssign(line: Extract<Simple, { k: 'assign' }>, env: Env): Cost {
    const t = line.target
    need(!this.params.has(t.name) && !this.loopNames.has(t.name))
    const l = this.locals.get(t.name)
    if (!l) refuse()
    if (t.k !== 'var') {
      need(l.k === 'acc')
      const v = this.val(line.value, env)
      need(v.vt !== 'coll')
      if (t.k === 'append') return v.c
      const k = this.scalar(t.key, env)
      need(k.vt === 'num' || k.vt === 'str' || k.vt === 'opaque')
      return add(k.c, v.c)
    }
    if (l.k === 'acc') {
      need(isEmptyArray(line.value))
      return NOTHING
    }
    need(!this.isStrParam(line.value))
    const v = this.val(line.value, env, l.k === 'derived' || l.k === 'closed' ? 'ret' : 'value')
    switch (l.k) {
      case 'derived':
        need(v.vt === 'coll')
        return v.c
      case 'num':
        need(v.vt === 'num')
        return v.c
      case 'str':
        need(v.vt === 'str')
        return v.c
      case 'opaque':
        need(v.vt !== 'coll')
        return v.c
      case 'closed':
        // A fresh array from a builtin or a literal, never an alias of another (copy on write, family 15).
        need(v.vt === 'coll' && line.op === '=' && !isVar(line.value))
        return v.c
    }
  }

  /** One linear factor over `recv`'s source, at the current line. */
  private site(env: Env, recv: string, what: string): Cost {
    const s = this.sourceOfName(recv)
    if (!s) refuse()
    return this.costly(env, factor({ size: s.origin, log: false, kind: 'builtin', at: env.at, what }))
  }

  private sortSite(env: Env, recv: string): Cost {
    const s = this.sourceOfName(recv)
    if (!s) refuse()
    const what = `sort of ${recv}`
    return this.costly(env, mul(factor({ size: s.origin, log: false, kind: 'sort', at: env.at, what }), factor({ size: s.origin, log: true, kind: 'sort', at: env.at, what })))
  }

  /** A value: its cost and type. A collection is handed on only where named (returned, counted, searched). */
  private val(n: Node, env: Env, ctx: Ctx = 'value'): Val {
    const depth = env.loops.length
    switch (n.k) {
      case 'num':
        return { c: NOTHING, vt: 'num' }
      case 'const':
        return { c: NOTHING, vt: n.v === 'null' ? 'none' : 'num' }
      case 'var': {
        const vt = this.nameVT(n.name, env.loops)
        if (vt === undefined) refuse()
        if (vt === 'coll') need(ctx === 'ret')
        if (vt === 'opaque' || vt === 'none') need(ctx !== 'test')
        return { c: NOTHING, vt }
      }
      case 'index': {
        // A read by position only at a position its loop proves present (lessons family 1).
        need(isVar(n.obj) && isVar(n.index))
        const name = (n.obj as { name: string }).name
        const s = this.sourceOfName(name)
        need(s !== undefined && this.isPosition((n.index as { name: string }).name, name, env))
        const vt: VT = s!.kind === 'str' ? 'str' : 'opaque'
        if (vt === 'opaque') need(ctx !== 'test')
        return { c: NOTHING, vt }
      }
      case 'call':
        return this.valCall(n, env, ctx)
      case 'static': {
        // A class's static method: 1 by the rule, never an exit name, with no argument it could take by reference (family 9).
        need(!isExitName(n.cls) && !isExitName(n.m))
        let c = NOTHING
        for (const a of n.args) {
          need(!isLvalue(a))
          const v = this.val(a, env)
          need(v.vt === 'num' || v.vt === 'str' || v.vt === 'none')
          c = add(c, v.c)
        }
        need(ctx !== 'test')
        return { c, vt: 'opaque' }
      }
      case 'unary': {
        if (n.op === '!') return { c: this.val(n.arg, env, 'test').c, vt: 'num' }
        const a = this.val(n.arg, env)
        need(a.vt === 'num')
        return { c: a.c, vt: 'num' }
      }
      case 'bin': {
        // Family 6: arithmetic on numbers only; a divisor is a nonzero literal; `>>` only by one (a binary search's mid).
        const l = this.val(n.left, env)
        const r = this.val(n.right, env)
        need(l.vt === 'num' && r.vt === 'num')
        if (n.op === '/' || n.op === '%') need(numLit(n.right) !== undefined && numLit(n.right) !== 0)
        else if (n.op === '>>') need(numLit(n.right) === 1)
        else need(n.op === '+' || n.op === '-' || n.op === '*')
        return { c: add(l.c, r.c), vt: 'num' }
      }
      case 'cmp': {
        need(n.op !== '<=>' && !this.isStrParam(n.left) && !this.isStrParam(n.right))
        const l = this.val(n.left, env)
        const r = this.val(n.right, env)
        need(l.vt !== 'coll' && r.vt !== 'coll')
        // `===` may take an opaque value against a scalar (comparing two opaque values may compare whole arrays); orderings one kind on both sides.
        if (EQUALITY.has(n.op)) need(l.vt !== 'opaque' || r.vt !== 'opaque')
        else need((l.vt === 'num' && r.vt === 'num') || (l.vt === 'str' && r.vt === 'str'))
        return { c: add(l.c, r.c), vt: 'num' }
      }
      case 'bool': {
        // Only a condition holds && or ||; each operand guards the next (family 4).
        need(ctx === 'test')
        this.checkConsistent(env.path, n.left)
        const guard: Entry = { cond: n.left, neg: n.op === '||', depth }
        const left = this.val(n.left, env, 'test')
        const right = this.val(n.right, { ...env, path: [...env.path, guard] }, 'test')
        // Outside loops, a test that guards costly work holds only what a root condition may (family 2).
        if (depth === 0 && hasFactors(right.c)) need(this.isStable(n.left, true))
        return { c: add(left.c, right.c), vt: 'num' }
      }
      case 'array': {
        need(ctx !== 'test')
        let c = NOTHING
        for (const it of n.items) {
          const v = this.val(it, env)
          need(v.vt !== 'coll')
          c = add(c, v.c)
        }
        return { c, vt: 'coll' }
      }
      case 'fn':
        // A closure only as the callback of a listed builtin (gate 5).
        refuse()
    }
  }

  /** A position its loop proves present for `recv`: a counting index over it, a foreach key over it, or its search's mid. */
  private isPosition(pos: string, recv: string, env: Env): boolean {
    return env.loops.some((l) => l.index === pos && l.validFor === recv)
  }

  /** A bare source named as a builtin's argument. */
  private namedSource(a: Node | undefined, kind: 'array' | 'str' = 'array'): Source {
    need(isVar(a))
    const s = this.sourceOfName((a as { name: string }).name)
    need(s?.kind === kind)
    return s!
  }

  /** A bare array the function owns or reads: an array parameter, a derived value or an accumulator (for lookups and counts). */
  private isArrayName(n: Node | undefined): boolean {
    if (!isVar(n)) return false
    const l = this.locals.get(n.name)
    return this.sourceOfName(n.name)?.kind === 'array' || l?.k === 'acc' || l?.k === 'closed'
  }

  /**
   * Fix round 1, ruling D: a whole string parameter. Its length is a size, so
   * comparing, searching or hashing it costs that size: it is no comparison
   * operand, needle or key, and no local takes it (an alias would carry it).
   * `strlen`, `empty` and its characters `$s[$i]` stay.
   */
  private isStrParam(n: Node): boolean {
    return isVar(n) && this.params.get(n.name)?.kind === 'str'
  }

  /** A value that is no array and no whole string parameter (a needle, a key). */
  private scalar(n: Node, env: Env): Val {
    need(!this.isStrParam(n))
    const v = this.val(n, env)
    need(v.vt !== 'coll')
    return v
  }

  /** PHP global functions: a closed list (spec "Builtins", stricter readings). Names compare case-folded. */
  private valCall(n: Extract<Node, { k: 'call' }>, env: Env, ctx: Ctx): Val {
    const args = n.args
    // Exit names (`exit`, `die`, `pcntl_signal`, …) refuse; sorts stand only as statements.
    need(!isExitName(n.fn) && !SORTS.has(n.fn))
    const num = (c: Cost): Val => ({ c, vt: 'num' })
    switch (n.fn) {
      case 'count': {
        need(args.length === 1)
        const a = args[0]!
        if (isVar(a)) {
          need(this.isArrayName(a))
          return num(NOTHING)
        }
        const v = this.val(a, env, 'ret')
        need(v.vt === 'coll' && a.k === 'call')
        return num(v.c)
      }
      case 'strlen': {
        need(args.length === 1)
        const v = this.val(args[0]!, env)
        need(v.vt === 'str')
        return num(v.c)
      }
      case 'isset': {
        need(args.length === 1 && args[0]!.k === 'index' && this.isArrayName(args[0]!.obj))
        return num(this.scalar((args[0] as Extract<Node, { k: 'index' }>).index, env).c)
      }
      case 'empty': {
        need(args.length === 1 && isVar(args[0]))
        const vt = this.nameVT((args[0] as { name: string }).name, env.loops)
        need(vt === 'coll' || vt === 'str' || vt === 'num')
        return num(NOTHING)
      }
      case 'array_key_exists':
        need(args.length === 2 && this.isArrayName(args[1]))
        return num(this.scalar(args[0]!, env).c)
      case 'array_key_first':
      case 'array_key_last':
        need(args.length === 1 && this.isArrayName(args[0]))
        need(ctx !== 'test')
        return { c: NOTHING, vt: 'opaque' }
      case 'abs': {
        need(args.length === 1)
        const v = this.val(args[0]!, env)
        need(v.vt === 'num')
        return num(v.c)
      }
      case 'intdiv': {
        need(args.length === 2 && numLit(args[1]) !== undefined && numLit(args[1]) !== 0)
        const v = this.val(args[0]!, env)
        need(v.vt === 'num')
        return num(v.c)
      }
      case 'max':
      case 'min': {
        need(args.length >= 1)
        if (args.length === 1) {
          const s = this.namedSource(args[0])
          need(ctx !== 'test')
          return { c: this.site(env, s.name, `${n.fn} of ${s.name}`), vt: 'opaque' }
        }
        let c = NOTHING
        for (const a of args) {
          const v = this.val(a, env)
          need(v.vt === 'num')
          c = add(c, v.c)
        }
        return num(c)
      }
      case 'in_array':
      case 'array_search': {
        need(args.length === 2 || (args.length === 3 && args[2]!.k === 'const' && args[2]!.v === 'true'))
        const needle = this.scalar(args[0]!, env)
        const s = this.namedSource(args[1])
        if (n.fn === 'array_search') need(ctx !== 'test')
        return { c: add(needle.c, this.site(env, s.name, `${n.fn} on ${s.name}`)), vt: n.fn === 'in_array' ? 'num' : 'opaque' }
      }
      case 'array_keys':
      case 'array_values':
      case 'array_reverse':
      case 'array_flip':
      case 'array_sum': {
        need(args.length === 1)
        const s = this.namedSource(args[0])
        if (n.fn !== 'array_sum') need(ctx === 'ret')
        return { c: this.site(env, s.name, `${n.fn} of ${s.name}`), vt: n.fn === 'array_sum' ? 'num' : 'coll' }
      }
      case 'array_slice': {
        need(args.length === 2 && ctx === 'ret')
        const s = this.namedSource(args[0])
        const off = this.val(args[1]!, env)
        need(off.vt === 'num')
        return { c: add(off.c, this.site(env, s.name, `array_slice of ${s.name}`)), vt: 'coll' }
      }
      case 'array_filter': {
        need((args.length === 1 || args.length === 2) && ctx === 'ret')
        const s = this.namedSource(args[0])
        if (args.length === 1) return { c: this.site(env, s.name, `array_filter of ${s.name}`), vt: 'coll' }
        return { c: this.callback(s, args[1]!, env, 'filter'), vt: 'coll' }
      }
      case 'array_map': {
        need(args.length === 2 && ctx === 'ret')
        const s = this.namedSource(args[1])
        return { c: this.callback(s, args[0]!, env, 'map'), vt: 'coll' }
      }
      case 'array_reduce': {
        need(args.length === 3 && args[2]!.k === 'num')
        const s = this.namedSource(args[0])
        return num(this.callback(s, args[1]!, env, 'reduce'))
      }
      default:
        // Every other global function refuses (lessons family 19).
        refuse()
    }
  }

  /**
   * A callback over `s` (spec "Builtins": its body is a loop body): `fn($x) =>`
   * one expression, its parameters shadowing nothing. A filter's body is a
   * predicate (the grammar, never trivial, family 10); a map's any value but an
   * array; a reduce's a number from its carry `$c`.
   */
  private callback(s: Source, f: Node, env: Env, kind: 'filter' | 'map' | 'reduce'): Cost {
    need(f.k === 'fn')
    const fnode = f as Extract<Node, { k: 'fn' }>
    need(fnode.params.length === (kind === 'reduce' ? 2 : 1))
    for (const p of fnode.params) need(!this.isBoundName(p) && this.bindingOf(p, env) === undefined)
    need(new Set(fnode.params).size === fnode.params.length)
    const at = env.at
    const elem = fnode.params.at(-1)!
    const names = new Map<string, Binding>([[elem, { role: 'elem', origin: s.origin, atom: s.isParam }]])
    if (kind === 'reduce') names.set(fnode.params[0]!, { role: 'carry', atom: false })
    const loop: Loop = { at, kind: 'callback', names, factor: factor({ size: s.origin, log: false, kind: 'callback', at, what: `${kind} callback over ${s.name}` }) }
    const inner: Env = { ...env, loops: [...env.loops, loop], chain: undefined }
    this.sizesIn(fnode.body, inner, kind === 'filter')
    let body: Val
    if (kind === 'filter') {
      this.checkTest(fnode.body, inner)
      body = this.val(fnode.body, inner, 'test')
    } else {
      body = this.val(fnode.body, inner)
      need(kind === 'reduce' ? body.vt === 'num' : body.vt !== 'coll')
    }
    return this.costly(env, mul(loop.factor, add(ONE, body.c)))
  }
}

// ---------------------------------------------------------------------------
// Helpers over shapes

/** Spec "Binary search", PHP: `intdiv($lo + $hi, 2)` or `($lo + $hi) >> 1`. */
function isMidForm(n: Node, lo: string, hi: string): boolean {
  const sum = (m: Node | undefined): boolean => m?.k === 'bin' && m.op === '+' && isVar(m.left, lo) && isVar(m.right, hi)
  if (isCallOf(n, 'intdiv')) return n.args.length === 2 && sum(n.args[0]) && numLit(n.args[1]) === 2
  return n.k === 'bin' && n.op === '>>' && sum(n.left) && numLit(n.right) === 1
}

/**
 * Ruling F, PHP: after `mid`, one if/else whose branches assign exactly lo
 * and hi, one each, and nothing else. Its test, or undefined.
 */
function isSearchBody(rest: Stmt[], lo: string, hi: string, mid: string): Node | undefined {
  const only = (body: Stmt[]): Simple | undefined => (body.length === 1 && body[0]!.k === 'simple' ? body[0]!.line : undefined)
  const target = (b: Branch): string | undefined => {
    const l = only(b.body)
    return l?.k === 'assign' && l.op === '=' && l.target.k === 'var' ? l.target.name : undefined
  }
  if (rest.length !== 1) return undefined
  const s = rest[0]!
  if (s.k !== 'if' || s.branches.length !== 2 || !s.hasElse || !s.branches[0]!.cond || !mentions(s.branches[0]!.cond, mid)) return undefined
  const t = s.branches.map(target)
  return (t[0] === lo && t[1] === hi) || (t[0] === hi && t[1] === lo) ? s.branches[0]!.cond : undefined
}

/** `$S[$mid] op v` (either way round), an ordering, v a scalar parameter or an integer literal. */
function isSearchCompare(c: Node, src: string, mid: string, isScalarParam: (name: string) => boolean): boolean {
  if (c.k !== 'cmp' || !ORDER.has(c.op)) return false
  const elem = (m: Node): boolean => m.k === 'index' && isVar(m.obj, src) && isVar(m.index, mid)
  const other = (m: Node): boolean => numLit(m) !== undefined || (isVar(m) && isScalarParam(m.name))
  return (elem(c.left) && other(c.right)) || (elem(c.right) && other(c.left))
}

/** A comparator: `fn($p, $q) => $p <=> $q` (or `$q <=> $p`), its names shadowing nothing. */
function isComparator(n: Node, isBound: (name: string) => boolean): boolean {
  if (n.k !== 'fn' || n.params.length !== 2) return false
  const [p, q] = n.params as [string, string]
  if (p === q || isBound(p) || isBound(q)) return false
  const b = n.body
  return b.k === 'cmp' && b.op === '<=>' && ((isVar(b.left, p) && isVar(b.right, q)) || (isVar(b.left, q) && isVar(b.right, p)))
}

// Each reader keeps its own copy (see `negate`): it works on this reader's syntax tree.
/** A condition no input can change: no names at all, a literal operand of `&&`, `||` or `!`, a comparison of a value with itself, or `a || !a` / `a && !a`. */
function isTrivial(n: Node): boolean {
  if (!someNode(n, (m) => m.k === 'var')) return true
  const isLiteral = (m: Node): boolean => ['num', 'const', 'array', 'fn'].includes(m.k) || numLit(m) !== undefined || (m.k === 'unary' && m.arg.k === 'num')
  if (someNode(n, (m) => (m.k === 'bool' && (isLiteral(m.left) || isLiteral(m.right))) || (m.k === 'unary' && m.op === '!' && isLiteral(m.arg)))) return true
  const same = (a: Node, b: Node): boolean => JSON.stringify(a) === JSON.stringify(b)
  return someNode(n, (m) => (m.k === 'cmp' && same(m.left, m.right)) || (m.k === 'bool' && (same(negate(m.left), m.right) || same(m.left, negate(m.right)))))
}

/** The worst-case cost of a PHP unit, its int parameters and its parameter names (with `$`); undefined for any shape the reader cannot place. */
export function readPhp(unit: Unit): { cost: Cost; numeric: string[]; params: string[] } | undefined {
  try {
    return new Reader(unit, unit.full?.lines ?? unit.lines).read()
  } catch {
    return undefined
  }
}
