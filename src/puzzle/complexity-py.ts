// SPEC 8.4, Complexity Read: the Python reader (spec
// docs/superpowers/specs/2026-10-13-complexity-read-design.md, "The reader"
// and "Stricter readings (Python reader, Task 6)"). Pure. Each shown line is
// read into a closed set of statement and expression shapes and costed; any
// shape it does not know, and any cost it cannot place, refuses the unit
// (undefined). Every rule is an allowlist: what is accepted is named, and all
// else refuses. A skipped unit is fine; a wrong key is not.
//
// Python adds three hazards the TypeScript reader does not meet: an exception
// the input cannot avoid is an exit (a raise on the first iteration makes any
// loop constant), integers grow without bound (an accumulator that doubles
// costs its own length per step), and a local read before its first
// assignment raises. Each has its own allowlist below.

import { COMPLEXITY } from '../config'
import { add, factor, hiddenScan, isExitName, isInert, isLiteralInRange, mul, ONE, treeByIndent, type Block, type Cost, type HiddenPlace, type HiddenScan } from './complexity'
import { isBlankedLine } from './readable'
import type { Unit } from './units'

// ---------------------------------------------------------------------------
// Refusal

/** Thrown to refuse the unit and caught in `readPython`. Carries no text. */
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

const LISTS = COMPLEXITY.builtins.Python!
const setOf = (...lists: Iterable<string>[]): ReadonlySet<string> => new Set(lists.flatMap((l) => [...l]))
const GLOBALS = setOf(LISTS.globals)
/** Spec "What the reader reads", rule 3: every listed name, every builtin, and the statements that raise or unbind. */
const WORDS: ReadonlySet<string> = setOf(...Object.values(LISTS), COMPLEXITY.pythonHiddenWords)
const KEYWORDS = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield'])
/** A method's own object: never a parameter and never read. */
const RECEIVERS = new Set(['self', 'cls'])

const ORDER = new Set(['<', '<=', '>', '>='])
/** The arithmetic a number takes: no `**` or `<<` (they grow it by its own size), no bitwise operator (a float raises). */
const ARITHMETIC = new Set(['+', '-', '*', '/', '//', '%'])
const EQUALITY = new Set(['==', '!='])
const FLIP: Record<string, string> = { '==': '!=', '!=': '==', '<': '>=', '>=': '<', '>': '<=', '<=': '>', in: 'not in', 'not in': 'in', is: 'is not', 'is not': 'is' }
/** Small sizes a guard may test for (spec gate 10): `size op literal`. */
const TINY: Record<string, number[]> = { '==': [0, 1], '<': [1, 2], '<=': [0, 1] }

// ---------------------------------------------------------------------------
// Tokens

type Tok = { t: 'id' | 'num' | 'p'; v: string }

// `:=` is a token so a walrus is read, then refused by the grammar.
const PUNCTS = ['**=', '//=', '>>=', '<<=', '->', ':=', '**', '//', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '(', ')', '[', ']', '{', '}', ',', ':', '.', '+', '-', '*', '/', '%', '<', '>', '=', '&', '|', '^', '~']

/**
 * One shown line as tokens. The filter shows only lines with no quote, `#` or
 * backslash, so any of those (and `;`, `@`, `!`, non-ASCII, dunder names,
 * number forms other than plain decimals) refuses.
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
      need(!/^[A-Za-z0-9_.]/.test(rest.slice(num[0].length)))
      // Task 7 fix round 1, ruling A: no literal beyond the shared cap (any int is below `1e400`).
      need(isLiteralInRange(num[0]))
      out.push({ t: 'num', v: num[0] })
      i += num[0].length
      continue
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)
    if (id) {
      need(!id[0].startsWith('__'))
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
const isWord = (t: Tok | undefined, v: string): boolean => t?.t === 'id' && t.v === v

// ---------------------------------------------------------------------------
// Expressions

type Kw = { name: string; value: Node }
/** One `for` clause of a comprehension: its names, its source and its `if` filters. */
type Clause = { targets: string[]; source: Node; conds: Node[] }
type Node =
  | { k: 'name'; name: string }
  | { k: 'num'; v: number; int: boolean }
  | { k: 'const'; v: 'True' | 'False' | 'None' }
  | { k: 'attr'; obj: Node; name: string }
  | { k: 'index'; obj: Node; index: Node }
  | { k: 'call'; callee: Node; args: Node[]; kw: Kw[] }
  | { k: 'unary'; op: string; arg: Node }
  | { k: 'bin'; op: string; left: Node; right: Node }
  | { k: 'cmp'; op: string; left: Node; right: Node }
  | { k: 'bool'; op: 'and' | 'or'; left: Node; right: Node }
  | { k: 'list' | 'set'; items: Node[] }
  | { k: 'dict'; keys: Node[]; values: Node[] }
  | { k: 'comp'; kind: 'list' | 'set' | 'dict' | 'gen'; elt: Node; value?: Node; clauses: Clause[] }

/** Binary operators by precedence, loosest first (comparisons and `**` apart). */
const LEVELS: readonly (readonly string[])[] = [['|'], ['^'], ['&'], ['<<', '>>'], ['+', '-'], ['*', '/', '//', '%']]

/** A recursive-descent reader of one line's tokens. No conditional expression, lambda, walrus, tuple, slice, star or chained comparison: anything outside the grammar refuses. */
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
  name(): string {
    const t = this.peek()
    need(t?.t === 'id' && !KEYWORDS.has(t.v))
    this.i++
    return t.v
  }

  expr(): Node {
    return this.orTest()
  }

  orTest(): Node {
    let left = this.andTest()
    while (this.isWord('or')) {
      this.i++
      left = { k: 'bool', op: 'or', left, right: this.andTest() }
    }
    return left
  }

  private andTest(): Node {
    let left = this.notTest()
    while (this.isWord('and')) {
      this.i++
      left = { k: 'bool', op: 'and', left, right: this.notTest() }
    }
    return left
  }

  private notTest(): Node {
    if (this.isWord('not')) {
      this.i++
      return { k: 'unary', op: 'not', arg: this.notTest() }
    }
    return this.comparison()
  }

  /** The comparison operator at the cursor and its token count. */
  private compOp(): [string, number] | undefined {
    const t = this.peek()
    if (t?.t === 'p' && (EQUALITY.has(t.v) || ORDER.has(t.v))) return [t.v, 1]
    if (this.isWord('in')) return ['in', 1]
    if (this.isWord('not') && this.isWord('in', 1)) return ['not in', 2]
    if (this.isWord('is')) return this.isWord('not', 1) ? ['is not', 2] : ['is', 1]
    return undefined
  }

  private comparison(): Node {
    const left = this.binary(0)
    const op = this.compOp()
    if (!op) return left
    this.i += op[1]
    const right = this.binary(0)
    // A chain (`a < b < c`) refuses.
    need(this.compOp() === undefined)
    return { k: 'cmp', op: op[0], left, right }
  }

  private binary(level: number): Node {
    if (level === LEVELS.length) return this.unary()
    let left = this.binary(level + 1)
    for (;;) {
      const t = this.peek()
      if (t?.t !== 'p' || !LEVELS[level]!.includes(t.v)) return left
      this.i++
      left = { k: 'bin', op: t.v, left, right: this.binary(level + 1) }
    }
  }

  private unary(): Node {
    const t = this.peek()
    if (t?.t === 'p' && ['-', '+', '~'].includes(t.v)) {
      this.i++
      return { k: 'unary', op: t.v, arg: this.unary() }
    }
    const base = this.primary()
    if (this.is('**')) {
      this.i++
      return { k: 'bin', op: '**', left: base, right: this.unary() }
    }
    return base
  }

  private primary(): Node {
    let n = this.atom()
    for (;;) {
      if (this.is('.')) {
        this.i++
        n = { k: 'attr', obj: n, name: this.name() }
      } else if (this.is('(')) n = { k: 'call', callee: n, ...this.args() }
      else if (this.is('[')) {
        this.i++
        const index = this.expr()
        this.take(']')
        n = { k: 'index', obj: n, index }
      } else return n
    }
  }

  private atom(): Node {
    const t = this.peek()
    if (!t) refuse()
    this.i++
    if (t.t === 'num') return { k: 'num', v: Number(t.v), int: !t.v.includes('.') }
    if (t.t === 'id') {
      if (t.v === 'True' || t.v === 'False' || t.v === 'None') return { k: 'const', v: t.v }
      need(!KEYWORDS.has(t.v))
      return { k: 'name', name: t.v }
    }
    if (t.v === '(') {
      const e = this.expr()
      this.take(')')
      return e
    }
    if (t.v === '[') return this.list()
    if (t.v === '{') return this.brace()
    refuse()
  }

  private list(): Node {
    if (this.is(']')) {
      this.i++
      return { k: 'list', items: [] }
    }
    const first = this.expr()
    if (this.isWord('for')) {
      const clauses = this.clauses()
      this.take(']')
      return { k: 'comp', kind: 'list', elt: first, clauses }
    }
    const items = [first]
    while (this.is(',')) {
      this.i++
      if (this.is(']')) break
      items.push(this.expr())
    }
    this.take(']')
    return { k: 'list', items }
  }

  private brace(): Node {
    if (this.is('}')) {
      this.i++
      return { k: 'dict', keys: [], values: [] }
    }
    const first = this.expr()
    if (this.is(':')) {
      this.i++
      const value = this.expr()
      if (this.isWord('for')) {
        const clauses = this.clauses()
        this.take('}')
        return { k: 'comp', kind: 'dict', elt: first, value, clauses }
      }
      const keys = [first]
      const values = [value]
      while (this.is(',')) {
        this.i++
        if (this.is('}')) break
        keys.push(this.expr())
        this.take(':')
        values.push(this.expr())
      }
      this.take('}')
      return { k: 'dict', keys, values }
    }
    if (this.isWord('for')) {
      const clauses = this.clauses()
      this.take('}')
      return { k: 'comp', kind: 'set', elt: first, clauses }
    }
    const items = [first]
    while (this.is(',')) {
      this.i++
      if (this.is('}')) break
      items.push(this.expr())
    }
    this.take('}')
    return { k: 'set', items }
  }

  /** Call arguments: positional, then `name=value`; a generator only as the one argument. */
  private args(): { args: Node[]; kw: Kw[] } {
    this.take('(')
    const args: Node[] = []
    const kw: Kw[] = []
    while (!this.is(')')) {
      if (this.peek()?.t === 'id' && this.is('=', 1)) {
        const name = this.name()
        this.take('=')
        kw.push({ name, value: this.expr() })
      } else {
        need(kw.length === 0)
        const e = this.expr()
        if (this.isWord('for')) {
          need(args.length === 0)
          const clauses = this.clauses()
          this.take(')')
          return { args: [{ k: 'comp', kind: 'gen', elt: e, clauses }], kw }
        }
        args.push(e)
      }
      if (!this.is(')')) this.take(',')
    }
    this.i++
    return { args, kw }
  }

  private clauses(): Clause[] {
    const out: Clause[] = []
    while (this.isWord('for')) {
      this.i++
      const targets = [this.name()]
      if (this.is(',')) {
        this.i++
        targets.push(this.name())
      }
      this.takeWord('in')
      const source = this.orTest()
      const conds: Node[] = []
      while (this.isWord('if')) {
        this.i++
        conds.push(this.orTest())
      }
      out.push({ targets, source, conds })
    }
    return out
  }
}

/** Every node directly under `n`. */
function childrenOf(n: Node): Node[] {
  switch (n.k) {
    case 'attr':
      return [n.obj]
    case 'index':
      return [n.obj, n.index]
    case 'call':
      return [n.callee, ...n.args, ...n.kw.map((k) => k.value)]
    case 'unary':
      return [n.arg]
    case 'bin':
    case 'cmp':
    case 'bool':
      return [n.left, n.right]
    case 'list':
    case 'set':
      return n.items
    case 'dict':
      return [...n.keys, ...n.values]
    case 'comp':
      return [n.elt, ...(n.value ? [n.value] : []), ...n.clauses.flatMap((c) => [c.source, ...c.conds])]
    default:
      return []
  }
}

function someNode(n: Node, f: (n: Node) => boolean): boolean {
  return f(n) || childrenOf(n).some((c) => someNode(c, f))
}

const isName = (n: Node | undefined, name?: string): n is { k: 'name'; name: string } => n?.k === 'name' && (name === undefined || n.name === name)
const mentions = (n: Node, name: string): boolean => someNode(n, (c) => isName(c, name))
const conjuncts = (n: Node): Node[] => (n.k === 'bool' && n.op === 'and' ? [...conjuncts(n.left), ...conjuncts(n.right)] : [n])
/** An integer literal, signed. */
function numLit(n: Node | undefined): number | undefined {
  if (n?.k === 'num' && n.int) return n.v
  if (n?.k === 'unary' && n.op === '-' && n.arg.k === 'num' && n.arg.int) return -n.arg.v
  return undefined
}
const isCallOf = (n: Node | undefined, f: string): n is Extract<Node, { k: 'call' }> => n?.k === 'call' && isName(n.callee, f)

/** `not c`, with comparisons flipped so an atom stays an atom. */
function negate(n: Node): Node {
  if (n.k === 'cmp' && Object.hasOwn(FLIP, n.op)) return { ...n, op: FLIP[n.op]! }
  if (n.k === 'unary' && n.op === 'not') return n.arg
  return { k: 'unary', op: 'not', arg: n }
}

// ---------------------------------------------------------------------------
// Lines

type Simple = { k: 'assign'; target: Node; op: string; value: Node } | { k: 'expr'; node: Node } | { k: 'return'; node?: Node } | { k: 'break' } | { k: 'continue' } | { k: 'pass' }
type Line = Simple | { k: 'if' | 'elif' | 'while'; cond: Node } | { k: 'else' } | { k: 'for'; targets: string[]; source: Node }

/** One shown line as a statement or a block header (its body never on the header line). Anything else refuses. */
function parseLine(text: string): Line {
  const toks = tokenize(text.trim())
  need(toks.length > 0)
  const p = new Parser(toks)
  const header = (): Node => {
    const c = p.expr()
    p.take(':')
    p.end()
    return c
  }
  for (const w of ['if', 'elif', 'while'] as const) {
    if (p.isWord(w)) {
      p.i++
      return { k: w, cond: header() }
    }
  }
  if (p.isWord('else')) {
    p.i++
    p.take(':')
    p.end()
    return { k: 'else' }
  }
  if (p.isWord('for')) {
    p.i++
    const targets = [p.name()]
    if (p.is(',')) {
      p.i++
      targets.push(p.name())
    }
    p.takeWord('in')
    const source = p.orTest()
    p.take(':')
    p.end()
    return { k: 'for', targets, source }
  }
  if (p.isWord('return')) {
    p.i++
    if (p.done) return { k: 'return' }
    const node = p.expr()
    p.end()
    return { k: 'return', node }
  }
  for (const w of ['break', 'continue', 'pass'] as const) {
    if (p.isWord(w)) {
      p.i++
      p.end()
      return { k: w }
    }
  }
  const target = p.expr()
  if (p.is('=') || p.is('+=') || p.is('-=')) {
    const op = p.peek()!.v
    p.i++
    need(target.k === 'name' || (op === '=' && target.k === 'index' && target.obj.k === 'name'))
    const value = p.expr()
    p.end()
    return { k: 'assign', target, op, value }
  }
  p.end()
  need(target.k === 'call')
  return { k: 'expr', node: target }
}

// ---------------------------------------------------------------------------
// Signature (spec gate 3)

/** `list`: a list (sortable in place); `seq`: Sequence or a variable tuple; `literal`: a Literal type, never a size; `fixed`: a fixed tuple; `other`: any other or no type. */
type Kind = 'list' | 'seq' | 'str' | 'set' | 'map' | 'int' | 'float' | 'bool' | 'literal' | 'fixed' | 'other'
/** What an element is: a primitive, `object` (an instance of a class of the code's own: it takes attribute reads), or `opaque` (any other or unknown type). */
type ElemType = 'int' | 'float' | 'bool' | 'str' | 'object' | 'opaque'
/** A value's type: `coll` is any collection, which is never handed on as a value. */
type VT = 'num' | 'str' | 'none' | 'opaque' | 'coll'
/** `elem`: a collection's element type (a dict's value type); `key`: a dict's key type; `literal`: a Literal's value type. */
type Param = { name: string; kind: Kind; elem: ElemType; key: ElemType; literal?: VT }

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

/** True when the `[` at the type's second token closes at its last token. */
function closesAtEnd(toks: Tok[]): boolean {
  if (toks[0]?.t !== 'id' || !isP(toks[1], '[')) return false
  let depth = 0
  for (const [k, t] of toks.entries()) {
    if (isP(t, '[')) depth++
    else if (isP(t, ']')) depth--
    if (depth === 0 && k > 0) return k === toks.length - 1
  }
  return false
}

/** A primitive by name; a class of the code's own (a capitalized name of two letters or more, no typing or collection name: never None, a container or a primitive); anything else opaque. */
function elemOf(toks: Tok[]): ElemType {
  if (toks.length !== 1 || toks[0]!.t !== 'id') return 'opaque'
  const w = toks[0]!.v
  if (['int', 'float', 'bool', 'str'].includes(w)) return w as ElemType
  return /^[A-Z][A-Za-z0-9_]+$/.test(w) && !COMPLEXITY.pythonNotClasses.includes(w) ? 'object' : 'opaque'
}

/** Spec "Typed receivers": the listed collections, bare or subscripted, optionally `Optional[...]` or `X | None`; numbers by value. */
function classify(toks: Tok[]): Omit<Param, 'name'> {
  const other: Omit<Param, 'name'> = { kind: 'other', elem: 'opaque', key: 'opaque' }
  const parts = splitTop(toks, '|').filter((p) => !(p.length === 1 && isWord(p[0], 'None')))
  if (parts.length !== 1 || parts[0]!.length === 0) return other
  const p = parts[0]!
  if (p.length === 1 && p[0]!.t === 'id') {
    const w = p[0]!.v
    if (w === 'int' || w === 'float' || w === 'bool') return { ...other, kind: w }
    if (w === 'str') return { kind: 'str', elem: 'str', key: 'opaque' }
    if (w === 'list' || w === 'List') return { ...other, kind: 'list' }
    if (w === 'Sequence' || w === 'tuple') return { ...other, kind: 'seq' }
    if (w === 'set' || w === 'frozenset') return { ...other, kind: 'set' }
    if (w === 'dict' || w === 'Mapping') return { ...other, kind: 'map' }
    return other
  }
  if (!closesAtEnd(p)) return other
  const w = p[0]!.v
  const args = splitTop(p.slice(2, -1), ',')
  if (w === 'Optional' && args.length === 1) return classify(args[0]!)
  if (w === 'Literal') return { ...other, kind: 'literal', literal: args.every((a) => (a.length === 1 && a[0]!.t === 'num') || (a.length === 2 && isP(a[0], '-') && a[1]!.t === 'num')) ? 'num' : 'opaque' }
  if ((w === 'list' || w === 'List') && args.length === 1) return { ...other, kind: 'list', elem: elemOf(args[0]!) }
  if (w === 'Sequence' && args.length === 1) return { ...other, kind: 'seq', elem: elemOf(args[0]!) }
  if (w === 'tuple') {
    const variable = args.length === 2 && args[1]!.length === 3 && args[1]!.every((t) => isP(t, '.'))
    return variable ? { ...other, kind: 'seq', elem: elemOf(args[0]!) } : { ...other, kind: 'fixed' }
  }
  if ((w === 'set' || w === 'frozenset') && args.length === 1) return { ...other, kind: 'set', elem: elemOf(args[0]!) }
  if ((w === 'dict' || w === 'Mapping') && args.length === 2) return { kind: 'map', key: elemOf(args[0]!), elem: elemOf(args[1]!) }
  return other
}

const LITERAL_DEFAULTS = [['num'], ['-', 'num'], ['True'], ['False'], ['None']]

/** Spec gate 3: `def name(params) -> type:` on the first line; plain parameters with an annotation and an immutable literal default. `self`/`cls` first are skipped. */
function readSignature(line: string, name: string): { params: Param[]; skipped: string[] } {
  const toks = tokenize(line.trim())
  need(isWord(toks[0], 'def') && isWord(toks[1], name) && isP(toks[2], '('))
  let depth = 0
  let close = -1
  for (let k = 2; k < toks.length; k++) {
    if (isP(toks[k], '(') || isP(toks[k], '[')) depth++
    else if ((isP(toks[k], ')') || isP(toks[k], ']')) && --depth === 0) {
      close = k
      break
    }
  }
  need(close > 2 && isP(toks.at(-1), ':') && isP(toks[close], ')'))
  const after = toks.slice(close + 1, -1)
  need(after.length === 0 || (isP(after[0], '->') && after.length > 1 && !after.some((t) => isP(t, ':') || isP(t, '='))))
  const parts = splitTop(toks.slice(3, close), ',')
  if (parts.length > 1 && parts.at(-1)!.length === 0) parts.pop()
  const params: Param[] = []
  const skipped: string[] = []
  if (parts.length === 1 && parts[0]!.length === 0) return { params, skipped }
  parts.forEach((part, k) => {
    const first = part[0]
    need(first?.t === 'id' && !KEYWORDS.has(first.v))
    if (k === 0 && part.length === 1 && RECEIVERS.has(first.v)) {
      skipped.push(first.v)
      return
    }
    need(!RECEIVERS.has(first.v) && !GLOBALS.has(first.v) && first.v !== name)
    const [head, ...defaults] = splitTop(part.slice(1), '=')
    let typed: Omit<Param, 'name'> = { kind: 'other', elem: 'opaque', key: 'opaque' }
    if (head!.length > 0) {
      need(isP(head![0], ':') && head!.length > 1)
      typed = classify(head!.slice(1))
    }
    need(defaults.length <= 1)
    if (defaults.length === 1) {
      const d = defaults[0]!.map((t) => (t.t === 'num' ? 'num' : t.v))
      need(LITERAL_DEFAULTS.some((l) => l.length === d.length && l.every((v, j) => v === d[j])))
    }
    params.push({ name: first.v, ...typed })
  })
  need(new Set(params.map((p) => p.name)).size === params.length)
  return { params, skipped }
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
  | { k: 'for'; at: number; targets: string[]; source: Node; body: Stmt[] }
  | { k: 'while'; at: number; cond: Node; body: Stmt[] }

const endOf = (b: Block): number => Math.max(b.at, ...b.children.map(endOf))

function bodiesOf(s: Stmt): Stmt[][] {
  if (s.k === 'if') return s.branches.map((b) => b.body)
  return 'body' in s ? [s.body] : []
}

function someStmt(list: Stmt[], f: (s: Stmt) => boolean): boolean {
  return list.some((s) => f(s) || bodiesOf(s).some((b) => someStmt(b, f)))
}

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

/** A collection the reader can size: a parameter of a listed type, or a derived value. `name` is what the code names; `origin` the parameter whose size it is. */
type Source = { name: string; origin: string; kind: 'list' | 'seq' | 'str' | 'set' | 'map'; elem: ElemType; key: ElemType; isParam: boolean }
/**
 * A name a loop binds. `elem`: an element (an atom only when bound directly
 * over a parameter, the one kind an exit test may read); `key`: a dict key,
 * never an element; `index`: a position.
 */
type Binding = { role: 'elem' | 'key' | 'index'; type: ElemType; origin?: string; atom: boolean }
/**
 * `index`: the loop's position name (a range's, enumerate's, a search's mid);
 * `validFor`: the source its positions index without a raise; `walks`: the
 * parameter it walks from 0 by 1 to the end, so `p[index]` is p's element;
 * `header`: a counted builtin in the header, costed once before the loop.
 */
type Loop = { at: number; kind: 'each' | 'count' | 'literal' | 'search'; names: Map<string, Binding>; index?: string; validFor?: string; walks?: string; eqExit?: Node; factor: Cost; header?: { recv: string; what: string; sort: boolean } }
type Local = { k: 'acc'; kind: 'list' | 'set' | 'dict' } | { k: 'derived'; origin: string; kind: 'list' | 'set'; elem: ElemType } | { k: 'num' } | { k: 'str' } | { k: 'opaque' } | { k: 'closed' }
type Assign = { name: string; whole: boolean; op: string; value: Node; at: number; end: number; inLoop: boolean; loops: Loop[] }
/** A condition on the path to a site; `depth` is the number of loops around it. `opaque`: a hidden condition. */
type Entry = { cond?: Node; neg: boolean; depth: number; opaque?: boolean }
type Env = { loops: Loop[]; path: Entry[]; at: number; hidden: boolean; chain?: IfStmt }
/** `ret`: a bare collection may stand here (returned); `test`: its truth is read; `stmt`: a whole statement. */
type Ctx = 'value' | 'test' | 'ret' | 'stmt'
type Val = { c: Cost; vt: VT }

const STRICT_PLACE: HiddenPlace = { isInLoop: true, isLastAtBodyLevel: false, isInGuard: false }
const hasFactors = (c: Cost): boolean => c.some((t) => t.length > 0)
const NOTHING: Cost = []
const vtOf = (t: ElemType): VT => (t === 'str' ? 'str' : t === 'opaque' || t === 'object' ? 'opaque' : 'num')
const isPrimitive = (t: ElemType): boolean => t === 'int' || t === 'float' || t === 'bool' || t === 'str'
const iterType = (s: Source): ElemType => (s.kind === 'map' ? s.key : s.elem)
const indexable = (s: Source | undefined): boolean => s !== undefined && (s.kind === 'list' || s.kind === 'seq' || s.kind === 'str')
const isEmptyLiteral = (n: Node): 'list' | 'set' | 'dict' | undefined => {
  if (n.k === 'list' && n.items.length === 0) return 'list'
  if (n.k === 'dict' && n.keys.length === 0) return 'dict'
  if (n.k === 'call' && n.callee.k === 'name' && n.args.length === 0 && n.kw.length === 0) {
    const f = n.callee.name
    if (f === 'set' || f === 'dict' || f === 'list') return f
  }
  return undefined
}

class Reader {
  readonly params = new Map<string, Param>()
  skipped: string[] = []
  readonly locals = new Map<string, Local>()
  readonly assigns: Assign[] = []
  /** Every line a name is read on (assignment targets that also read, included). */
  readonly reads = new Map<string, number[]>()
  /** Loop and comprehension names. */
  readonly loopNames = new Set<string>()
  readonly loops = new Map<number, Loop>()
  readonly searchVars = new Set<string>()
  readonly places = new Map<number, HiddenPlace>()
  readonly openers = new Set<number>()
  readonly tinyGuards = new Set<Node>()
  readonly guardBranches = new Set<number>()
  /** Number parameters that bound a range (spec gate 10). */
  readonly sizedNumbers = new Set<string>()
  readonly sizeLocals = new Map<string, Set<string>>()
  /** Locals a condition outside loops may read (lessons family 2, 6). */
  readonly sizeFree = new Set<string>()
  /** Names the signature holds besides its parameters (types, `def`): never called. */
  readonly signatureNames = new Set<string>()
  /** In-place sorts per parameter: a sorted run sorts again in linear time, so nothing sorts it twice. */
  readonly sortedInPlace = new Map<string, number>()

  constructor(
    readonly unit: Unit,
    readonly lines: readonly string[],
  ) {}

  read(): { cost: Cost; numeric: string[]; params: string[] } {
    const { lines } = this
    need(lines.length > 0 && !isBlankedLine(lines[0]!))
    need(lines.every((l) => !isBlankedLine(l)) || this.unit.hidden !== undefined)
    const sig = readSignature(lines[0]!, this.unit.name)
    for (const p of sig.params) this.params.set(p.name, p)
    // Fix round 2: a name the signature uses as a type is a class, never a helper (a call may need arguments it lacks).
    for (const t of tokenize(lines[0]!.trim())) if (t.t === 'id' && !this.params.has(t.v) && t.v !== this.unit.name) this.signatureNames.add(t.v)
    this.skipped = sig.skipped
    const tree = treeByIndent(lines)
    if (!tree) refuse()
    this.checkNames()
    const body = this.build(tree.children, { inLoop: false, inGuard: false, atRoot: true }, endOf(tree))
    this.collect(body)
    this.walkLoops(body, [])
    this.typeLocals()
    this.checkGrowth()
    this.collectSizes(body)
    this.checkHidden()
    const cost = this.costOfBlock(body, { loops: [], path: [], at: 0, hidden: false })
    const params = [...this.params.values()]
    return { cost, numeric: params.filter((p) => p.kind === 'int').map((p) => p.name), params: params.map((p) => p.name) }
  }

  /** Gate 4 (the unit naming itself, recursion) and the receiver: never named on a shown line. */
  private checkNames(): void {
    for (let at = 1; at < this.lines.length; at++) {
      const text = this.lines[at]!
      if (isBlankedLine(text) || text.trim() === '') continue
      for (const t of tokenize(text.trim())) need(!(t.t === 'id' && (t.v === this.unit.name || RECEIVERS.has(t.v))))
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
          // Fix round 3: a hidden opener is an else (checked on its raw text), so it must close a shown if, for or while.
          const prev = out.at(-1)
          need(prev !== undefined && (prev.k === 'for' || prev.k === 'while' || (prev.k === 'if' && !prev.hasElse)))
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
        case 'elif':
        case 'else': {
          // An else after a for or while (for…else) has no if before it.
          const prev = out.at(-1)
          if (prev?.k !== 'if' || prev.hasElse) refuse()
          prev.branches.push({ at: b.at, ...(line.k === 'elif' ? { cond: line.cond } : {}), body: nested(where.inLoop, guard) })
          if (line.k === 'else') prev.hasElse = true
          return
        }
        case 'for':
          out.push({ k: 'for', at: b.at, targets: line.targets, source: line.source, body: nested(true, false) })
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

  private isBound(name: string): boolean {
    return this.params.has(name) || this.locals.has(name) || this.loopNames.has(name) || this.skipped.includes(name) || RECEIVERS.has(name)
  }

  private declareLoopName(n: string): void {
    need(!this.params.has(n) && !GLOBALS.has(n) && !RECEIVERS.has(n) && n !== this.unit.name)
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
      if (n.k === 'name') this.addRead(n.name, at)
      if (n.k === 'comp') for (const c of n.clauses) c.targets.forEach((t) => this.declareLoopName(t))
      for (const c of childrenOf(n)) visit(c, at)
    }
    const walk = (list: Stmt[], inLoop: boolean): void => {
      for (const s of list) {
        if (s.k === 'simple') {
          const l = s.line
          if (l.k === 'assign') {
            const t = l.target
            const name = t.k === 'name' ? t.name : t.k === 'index' && t.obj.k === 'name' ? t.obj.name : refuse()
            // Gate 9: no parameter is written.
            need(!this.params.has(name))
            this.assigns.push({ name, whole: t.k === 'name', op: l.op, value: l.value, at: s.at, end: s.end, inLoop, loops: [] })
            if (t.k === 'index') {
              this.addRead(name, s.at)
              visit(t.index, s.at)
            } else if (l.op !== '=') this.addRead(name, s.at)
            visit(l.value, s.at)
          } else if (l.k === 'expr' || (l.k === 'return' && l.node)) visit((l as { node: Node }).node, s.at)
          if (l.k === 'expr' && l.node.k === 'call' && l.node.callee.k === 'attr' && l.node.callee.name === 'sort' && isName(l.node.callee.obj)) {
            const p = l.node.callee.obj.name
            this.sortedInPlace.set(p, (this.sortedInPlace.get(p) ?? 0) + 1)
          }
        } else if (s.k === 'if') {
          for (const b of s.branches) if (b.cond) visit(b.cond, b.at)
        } else if (s.k === 'for') {
          s.targets.forEach((t) => this.declareLoopName(t))
          need(s.targets.length === 1 || s.targets[0] !== s.targets[1])
          visit(s.source, s.at)
        } else if (s.k === 'while') visit(s.cond, s.at)
        const loopy = s.k === 'for' || s.k === 'while'
        for (const b of bodiesOf(s)) walk(b, inLoop || loopy)
      }
    }
    walk(body, false)
    const byName = new Map<string, Assign[]>()
    for (const a of this.assigns) byName.set(a.name, [...(byName.get(a.name) ?? []), a])
    for (const [name, list] of byName) {
      need(!this.loopNames.has(name) && !GLOBALS.has(name) && !RECEIVERS.has(name) && name !== this.unit.name)
      // Read only where the first assignment has run: after it, within its block (else the read raises).
      const first = list[0]!
      need(first.whole && first.op === '=')
      const refs = [...(this.reads.get(name) ?? []), ...list.slice(1).map((a) => a.at)]
      need(refs.every((r) => r > first.at && r <= first.end))
      this.locals.set(name, this.localOf(list))
    }
  }

  /** An accumulator (starts empty, written only empty again or by key); a derived value (one write outside loops, from a derive builtin on a parameter); else typed later. */
  private localOf(list: Assign[]): Local {
    const first = list[0]!
    const empty = isEmptyLiteral(first.value)
    if (empty) {
      need(list.every((a) => a.op === '=' && (a.whole ? isEmptyLiteral(a.value) === empty : empty === 'dict')))
      return { k: 'acc', kind: empty }
    }
    need(list.every((a) => a.whole))
    const derived = list.length === 1 && !first.inLoop ? this.derivedFrom(first.value) : undefined
    return derived ?? { k: 'num' }
  }

  /**
   * Spec "Builtins", derived values: one parameter through `sorted`, `list`,
   * `tuple`, `set` or `copy()`, keeping its size. A set keeps it only over an
   * unbounded element type (int, float or str values; not a string's characters).
   */
  private derivedFrom(n: Node): Local | undefined {
    if (n.k !== 'call') return undefined
    const c = n.callee
    if (c.k === 'attr' && c.name === 'copy' && n.args.length === 0 && n.kw.length === 0 && isName(c.obj)) {
      const p = this.params.get(c.obj.name)
      if (p?.kind === 'list') return { k: 'derived', origin: p.name, kind: 'list', elem: p.elem }
      if (p?.kind === 'set') return { k: 'derived', origin: p.name, kind: 'set', elem: p.elem }
      return undefined
    }
    if (c.k !== 'name' || n.args.length !== 1 || !isName(n.args[0])) return undefined
    const p = this.params.get(n.args[0].name)
    if (!p || !['list', 'seq', 'str', 'set', 'map'].includes(p.kind)) return undefined
    const type = p.kind === 'map' ? p.key : p.elem
    if (c.name === 'sorted' && isPrimitive(type) && this.isReverseOnly(n.kw) && !this.sortedInPlace.has(p.name)) return { k: 'derived', origin: p.name, kind: 'list', elem: type }
    if (n.kw.length > 0) return undefined
    if (c.name === 'list' || c.name === 'tuple') return { k: 'derived', origin: p.name, kind: 'list', elem: type }
    if (c.name === 'set' && p.kind !== 'str' && ['int', 'float', 'str'].includes(type)) return { k: 'derived', origin: p.name, kind: 'set', elem: type }
    return undefined
  }

  private isReverseOnly(kw: Kw[]): boolean {
    return kw.every((k) => k.name === 'reverse' && k.value.k === 'const' && k.value.v !== 'None')
  }

  // --- Loops (spec "Loops") ----------------------------------------------------

  /** Classifies each for and while; records each assignment's loops for typing. */
  private walkLoops(list: Stmt[], loops: Loop[]): void {
    list.forEach((s, k) => {
      switch (s.k) {
        case 'simple':
          for (const a of this.assigns) if (a.at === s.at) a.loops = loops
          return
        case 'for': {
          for (const t of s.targets) need(!loops.some((l) => l.names.has(t)))
          const loop = this.sourceLoop(s.source, s.targets, loops, s.at, false)
          this.loops.set(s.at, loop)
          this.walkLoops(s.body, [...loops, loop])
          return
        }
        case 'while': {
          const loop = this.searchLoop(s, list, k, loops)
          this.loops.set(s.at, loop)
          this.walkLoops(s.body, [...loops, loop])
          return
        }
        default:
          for (const b of bodiesOf(s)) this.walkLoops(b, loops)
      }
    })
  }

  /** A parameter of a listed collection type, or a derived value. Untyped, other-typed, Literal and fixed parameters are no sources. */
  private sourceOfName(name: string): Source | undefined {
    const p = this.params.get(name)
    if (p) {
      if (p.kind === 'list' || p.kind === 'seq' || p.kind === 'str' || p.kind === 'set' || p.kind === 'map') return { name, origin: name, kind: p.kind, elem: p.elem, key: p.key, isParam: true }
      return undefined
    }
    const l = this.locals.get(name)
    return l?.k === 'derived' ? { name, origin: l.origin, kind: l.kind, elem: l.elem, key: l.elem, isParam: false } : undefined
  }

  /** A for or comprehension header (spec "Loops", "size source"). `comp`: a comprehension clause, a callback-like loop. */
  private sourceLoop(src: Node, targets: string[], loops: Loop[], at: number, comp: boolean): Loop {
    const each = (s: Source, names: Map<string, Binding>, extra: Partial<Loop> = {}): Loop => ({ at, kind: 'each', names, factor: factor({ size: s.origin, log: false, kind: comp ? 'callback' : 'loop', at, what: `${comp ? 'comprehension' : 'loop'} over ${s.name}` }), ...extra })
    const one = (b: Binding): Map<string, Binding> => {
      need(targets.length === 1)
      return new Map([[targets[0]!, b]])
    }
    const iterate = (s: Source, atom: boolean): Binding => (s.kind === 'map' ? { role: 'key', type: s.key, origin: s.origin, atom: false } : { role: 'elem', type: s.elem, origin: s.origin, atom })
    if (isName(src)) {
      const s = this.sourceOfName(src.name)
      if (!s) refuse()
      return each(s, one(iterate(s, s.isParam)))
    }
    need(src.k === 'call' && src.kw.length === 0)
    const call = src as Extract<Node, { k: 'call' }>
    const args = call.args
    if (call.callee.k === 'attr') {
      // A dict's views, only as a header.
      const { obj, name: m } = call.callee
      need(isName(obj) && args.length === 0 && ['items', 'keys', 'values'].includes(m))
      const s = this.sourceOfName((obj as { name: string }).name)
      need(s?.kind === 'map' && s.isParam)
      const key: Binding = { role: 'key', type: s!.key, origin: s!.origin, atom: false }
      const value: Binding = { role: 'elem', type: s!.elem, origin: s!.origin, atom: false }
      if (m === 'items') {
        need(targets.length === 2)
        return each(s!, new Map([[targets[0]!, key], [targets[1]!, value]]))
      }
      return each(s!, one(m === 'keys' ? key : value))
    }
    need(call.callee.k === 'name')
    const f = (call.callee as { name: string }).name
    need(args.length >= 1)
    if (f === 'range') return this.rangeLoop(args, targets, loops, at, comp, false)
    need(args.length === 1)
    const a = args[0]!
    if (f === 'reversed' && isCallOf(a, 'range') && a.kw.length === 0) return this.rangeLoop(a.args, targets, loops, at, comp, true)
    need(isName(a))
    const s = this.sourceOfName((a as { name: string }).name)
    if (!s) refuse()
    if (f === 'reversed') {
      need(indexable(s))
      return each(s, one(iterate(s, s.isParam)))
    }
    if (f === 'enumerate') {
      need(targets.length === 2)
      const index: Binding = { role: 'index', type: 'int', atom: false }
      const valid = indexable(s) ? s.name : undefined
      const walks = indexable(s) && s.isParam ? s.name : undefined
      return each(s, new Map([[targets[0]!, index], [targets[1]!, iterate(s, s.isParam)]]), { index: targets[0]!, ...(valid ? { validFor: valid } : {}), ...(walks ? { walks } : {}) })
    }
    // A copy or sort in the header: its cost once, and its elements are no atoms.
    const type = iterType(s)
    if (f === 'sorted') need(isPrimitive(type) && s.isParam && !this.sortedInPlace.has(s.name))
    else if (f === 'set') need(s.kind !== 'str' && ['int', 'float', 'str'].includes(type))
    else need(f === 'list' || f === 'tuple')
    return each(s, one({ role: 'elem', type, origin: s.origin, atom: false }), { header: { recv: s.name, what: `${f} of ${s.name}`, sort: f === 'sorted' } })
  }

  /**
   * `range` per the loop table: up from 0 or 1 (or an enclosing index ± a
   * literal over the same size) to a bound B, B - 1 or B + 1 (`len(S)` or a
   * number parameter) or an enclosing index, by a literal step ≥ 1; down as
   * `range(B - 1, -1, -1)`; both ends literal is constant.
   */
  private rangeLoop(args: Node[], targets: string[], loops: Loop[], at: number, comp: boolean, reversed: boolean): Loop {
    need(targets.length === 1 && args.length >= 1 && args.length <= 3)
    const index = targets[0]!
    const names = new Map<string, Binding>([[index, { role: 'index', type: 'int', atom: false }]])
    const loopOf = (size: string, extra: Partial<Loop> = {}): Loop => ({ at, kind: 'count', names, index, factor: factor({ size, log: false, kind: comp ? 'callback' : 'loop', at, what: `${comp ? 'comprehension' : 'loop'} over ${size}` }), ...extra })
    const valid = (b: { of?: string }, plus: number): Partial<Loop> => (b.of !== undefined && plus <= 0 && indexable(this.sourceOfName(b.of)) ? { validFor: b.of } : {})
    if (args.length === 3 && numLit(args[2]) === -1) {
      need(!reversed)
      const end = numLit(args[1])
      need(end === -1 || end === 0)
      const st = args[0]!
      const minus = st.k === 'bin' && st.op === '-' && numLit(st.right) === 1
      const b = this.boundOf(minus ? (st as Extract<Node, { k: 'bin' }>).left : st)
      return loopOf(b.size, minus ? valid(b, 0) : {})
    }
    const start = args.length === 1 ? 0 : numLit(args[0])
    const startNode = args.length === 1 ? undefined : args[0]!
    let bound = args.length === 1 ? args[0]! : args[1]!
    let step = 1
    if (args.length === 3) {
      const k = numLit(args[2])
      need(k !== undefined && k >= 1)
      step = k
    }
    const end = numLit(bound)
    if (start !== undefined && end !== undefined) {
      // A constant number of rounds, at least one: an empty range's body is dead code.
      need(start >= 0 && end > start)
      return { at, kind: 'literal', names, index, factor: ONE }
    }
    let plus = 0
    if (bound.k === 'bin' && (bound.op === '+' || bound.op === '-') && numLit(bound.right) === 1) {
      plus = bound.op === '+' ? 1 : -1
      bound = bound.left
    }
    const ref = isName(bound) ? loops.find((l) => l.index === (bound as { name: string }).name && (l.kind === 'count' || l.kind === 'each')) : undefined
    if (ref) {
      // An inner bound that is an enclosing index: never under a binary search, and from a literal start.
      need((start === 0 || start === 1) && !loops.some((l) => l.kind === 'search'))
      return { at, kind: 'count', names, index, factor: ref.factor.map((t) => t.map((f) => ({ ...f, at }))), ...(ref.validFor ? { validFor: ref.validFor } : {}) }
    }
    const b = this.boundOf(bound)
    if (start === 0 || start === 1) {
      const p = b.of !== undefined ? this.params.get(b.of) : undefined
      const walks = start === 0 && plus === 0 && step === 1 && !reversed && p !== undefined && indexable(this.sourceOfName(p.name)) ? p.name : undefined
      return loopOf(b.size, { ...valid(b, plus), ...(walks ? { walks } : {}) })
    }
    // From an enclosing index ± a literal: that loop must run over the same size, or the sum is not n × m.
    const outer = this.indexStart(startNode!, loops)
    need(outer.factor.every((t) => t.every((f) => f.size === b.size)))
    return loopOf(b.size, valid(b, plus))
  }

  /** A start at an enclosing loop's index plus or minus a literal. */
  private indexStart(n: Node, loops: Loop[]): Loop {
    const of = (m: Node): Loop | undefined => (isName(m) ? loops.find((l) => l.index === m.name && (l.kind === 'count' || l.kind === 'each')) : undefined)
    const direct = of(n)
    if (direct) return direct
    if (n.k === 'bin' && (n.op === '+' || n.op === '-') && numLit(n.right) !== undefined) {
      const l = of(n.left)
      if (l) return l
    }
    refuse()
  }

  /** A bound B: `len(S)` of a source (`of` names S), or an int parameter. */
  private boundOf(n: Node): { size: string; of?: string } {
    if (isCallOf(n, 'len') && n.args.length === 1 && n.kw.length === 0 && isName(n.args[0])) {
      const s = this.sourceOfName(n.args[0].name)
      if (s) return { size: s.origin, of: s.name }
    }
    if (isName(n) && this.params.get(n.name)?.kind === 'int') return { size: n.name }
    refuse()
  }

  // --- Binary search (spec "Binary search", ruling F) ---------------------------

  private searchLoop(s: Extract<Stmt, { k: 'while' }>, list: Stmt[], k: number, loops: Loop[]): Loop {
    const c = s.cond
    need(c.k === 'cmp' && (c.op === '<=' || c.op === '<') && isName(c.left) && isName(c.right))
    const cond = c as Extract<Node, { k: 'cmp' }>
    const lo = (cond.left as { name: string }).name
    const hi = (cond.right as { name: string }).name
    need(lo !== hi)
    const inclusive = cond.op === '<='
    // `lo = 0` and `hi = len(S) - 1` (with <=) or `hi = len(S)` (with <) just before the loop.
    const before = [list[k - 1], list[k - 2]].map((p) => (p?.k === 'simple' && p.line.k === 'assign' && p.line.op === '=' && isName(p.line.target) ? { name: p.line.target.name, value: p.line.value, at: p.at } : undefined))
    const loA = before.find((d) => d?.name === lo)
    const hiA = before.find((d) => d?.name === hi)
    need(numLit(loA?.value) === 0 && hiA !== undefined)
    let hiV = hiA!.value
    if (inclusive) {
      need(hiV.k === 'bin' && hiV.op === '-' && numLit(hiV.right) === 1)
      hiV = (hiV as Extract<Node, { k: 'bin' }>).left
    }
    need(isCallOf(hiV, 'len') && (hiV as Extract<Node, { k: 'call' }>).args.length === 1 && (hiV as Extract<Node, { k: 'call' }>).kw.length === 0)
    const arg = (hiV as Extract<Node, { k: 'call' }>).args[0]!
    const src = isName(arg) ? this.sourceOfName(arg.name) : undefined
    need(indexable(src))
    const first = s.body[0]
    need(first?.k === 'simple' && first.line.k === 'assign' && first.line.op === '=' && isName(first.line.target))
    const midA = (first as { line: Extract<Simple, { k: 'assign' }> }).line
    const mid = (midA.target as { name: string }).name
    need(mid !== lo && mid !== hi && isMidForm(midA.value, lo, hi))
    // lo, hi and mid are assigned only in the listed forms: before the loop, and in it.
    for (const a of this.assigns.filter((x) => x.name === lo || x.name === hi || x.name === mid)) {
      if (a.at === loA!.at || a.at === hiA!.at || a.at === first!.at) continue
      need(a.whole && a.op === '=' && a.name !== mid && this.isInside(a.at, s))
      const v = a.value
      if (a.name === lo) need(v.k === 'bin' && v.op === '+' && isName(v.left, mid) && numLit(v.right) === 1)
      else if (inclusive) need(v.k === 'bin' && v.op === '-' && isName(v.left, mid) && numLit(v.right) === 1)
      else need(isName(v, mid))
    }
    need(this.assigns.filter((x) => x.name === mid).length === 1)
    need(isSearchBody(s.body.slice(1), lo, hi, mid))
    const eq = s.body.length === 3 && s.body[1]!.k === 'if' ? s.body[1]!.branches[0]! : undefined
    // A return from the equality exit leaves every loop: only outside loops.
    if (eq && eq.body[0]?.k === 'simple' && eq.body[0].line.k === 'return') need(loops.length === 0)
    for (const v of [lo, hi, mid]) this.searchVars.add(v)
    return { at: s.at, kind: 'search', names: new Map(), index: mid, validFor: src!.name, ...(eq?.cond ? { eqExit: eq.cond } : {}), factor: factor({ size: src!.origin, log: true, kind: 'search', at: s.at, what: `binary search over ${src!.name}` }) }
  }

  /** Whether line `at` lies in the body of statement `s`. */
  private isInside(at: number, s: Extract<Stmt, { k: 'while' }>): boolean {
    return someStmt(s.body, (x) => 'at' in x && x.at === at)
  }

  // --- Locals: types (lessons family 4) -----------------------------------------

  /** The type of a value by its shape, without checks (`val` checks and must agree). */
  private typeOf(n: Node, loops: Loop[]): VT | 'bad' {
    switch (n.k) {
      case 'num':
        return 'num'
      case 'const':
        return n.v === 'None' ? 'none' : 'num'
      case 'name':
        return this.nameVT(n.name, loops) ?? 'bad'
      case 'attr':
        return this.isAttrReceiver(n.obj, loops) ? 'opaque' : 'bad'
      case 'index': {
        const s = isName(n.obj) ? this.sourceOfName(n.obj.name) : undefined
        return s && indexable(s) ? vtOf(s.elem) : 'bad'
      }
      case 'call':
        return this.callType(n, loops)
      case 'unary':
        return n.op === 'not' || this.typeOf(n.arg, loops) === 'num' ? 'num' : 'bad'
      case 'bin':
        return this.typeOf(n.left, loops) === 'num' && this.typeOf(n.right, loops) === 'num' ? 'num' : 'bad'
      case 'cmp':
        return 'num'
      case 'bool': {
        const l = this.typeOf(n.left, loops)
        return l === this.typeOf(n.right, loops) ? l : 'bad'
      }
      case 'comp':
        return n.kind === 'gen' ? 'bad' : 'coll'
      default:
        return 'coll'
    }
  }

  private callType(n: Extract<Node, { k: 'call' }>, loops: Loop[]): VT | 'bad' {
    const c = n.callee
    if (c.k === 'name') {
      if (!GLOBALS.has(c.name)) return this.isBound(c.name) ? 'bad' : 'opaque'
      switch (c.name) {
        case 'len':
        case 'abs':
        case 'int':
        case 'float':
        case 'bool':
        case 'sum':
          return 'num'
        case 'min':
        case 'max': {
          const a = n.args[0]
          if (n.args.length === 1) {
            if (a?.k === 'comp') return 'num'
            const s = isName(a) ? this.sourceOfName(a.name) : undefined
            return s ? vtOf(iterType(s)) : 'bad'
          }
          return n.args.every((x) => this.typeOf(x, loops) === 'num') ? 'num' : 'bad'
        }
        case 'sorted':
        case 'list':
        case 'set':
        case 'tuple':
        case 'dict':
          return 'coll'
        default:
          return 'bad'
      }
    }
    if (c.k !== 'attr' || !isName(c.obj)) return 'bad'
    const o = c.obj.name
    if (!this.isBound(o)) return GLOBALS.has(o) ? 'bad' : 'opaque'
    const l = this.locals.get(o)
    if (l?.k === 'acc') return c.name === 'get' ? 'opaque' : 'none'
    const s = this.sourceOfName(o)
    if (!s) return 'bad'
    if (c.name === 'count') return 'num'
    if (c.name === 'copy') return 'coll'
    if (c.name === 'get') return this.getType(s, n.args[1], (d) => this.typeOf(d, loops))
    return c.name === 'sort' ? 'none' : 'bad'
  }

  /** `d.get(k, default)`: the value type when the default has it; otherwise it may be None (opaque). */
  private getType(s: Source, d: Node | undefined, type: (d: Node) => VT | 'bad'): VT {
    const v = vtOf(s.elem)
    return d !== undefined && v !== 'opaque' && type(d) === v ? v : 'opaque'
  }

  /**
   * Fix round 1: an attribute is read only on a loop's element of a class
   * type of the code's own, or on the result of a helper or a module's
   * function (by the rule, such a call returns its object). Never on None,
   * a `get` result, a container, a primitive or an attribute's value.
   */
  private isAttrReceiver(n: Node, loops: Loop[]): boolean {
    if (isName(n)) {
      for (let k = loops.length - 1; k >= 0; k--) {
        const b = loops[k]!.names.get(n.name)
        if (b) return b.role === 'elem' && b.type === 'object'
      }
      return false
    }
    if (n.k !== 'call') return false
    const c = n.callee
    if (c.k === 'name') return !GLOBALS.has(c.name) && !this.isBound(c.name) && !isExitName(c.name)
    return c.k === 'attr' && isName(c.obj) && !GLOBALS.has(c.obj.name) && !this.isBound(c.obj.name) && !isExitName(c.name)
  }

  private nameVT(name: string, loops: Loop[]): VT | undefined {
    for (let k = loops.length - 1; k >= 0; k--) {
      const b = loops[k]!.names.get(name)
      if (b) return vtOf(b.type)
    }
    const l = this.locals.get(name)
    if (l) return l.k === 'num' ? 'num' : l.k === 'str' ? 'str' : l.k === 'opaque' ? 'opaque' : 'coll'
    const p = this.params.get(name)
    if (!p) return undefined
    if (p.kind === 'int' || p.kind === 'float' || p.kind === 'bool') return 'num'
    if (p.kind === 'literal') return p.literal ?? 'opaque'
    return p.kind === 'fixed' || p.kind === 'other' ? 'opaque' : 'coll'
  }

  /**
   * Family 4: a local is a number (or a str) only when every write is one,
   * by a fixpoint from "all numbers" down (first assignments run before any
   * read, so the induction holds); a mix of scalars is opaque; collections
   * from displays, comprehensions and copies are closed. Anything else refuses.
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

  /**
   * Python integers grow without bound, and a number that doubles each round
   * costs its own length per step. In a loop, a number local is either an
   * accumulator (`+=`/`-=`, or `t = max(t, v)`) whose added values read no
   * accumulator, or a temporary whose writes read only other temporaries, with
   * no cycle. A binary search's lo, hi and mid are checked by their own shape.
   */
  private checkGrowth(): void {
    const inLoop = (name: string): Assign[] => this.assigns.filter((a) => a.name === name && a.inLoop)
    const loopy = [...this.locals].filter(([n, l]) => l.k === 'num' && !this.searchVars.has(n) && inLoop(n).length > 0).map(([n]) => n)
    const loopySet = new Set(loopy)
    const refs = (n: Node): string[] => [...new Set(loopy.filter((l) => mentions(n, l)))]
    const accums = new Set<string>()
    const added = new Map<string, Node[]>()
    for (const name of loopy) {
      for (const a of inLoop(name)) {
        if (a.op !== '=') {
          accums.add(name)
          added.set(name, [...(added.get(name) ?? []), a.value])
        } else if (mentions(a.value, name)) {
          const v = maxMinOther(a.value, name)
          need(v !== undefined)
          accums.add(name)
          added.set(name, [...(added.get(name) ?? []), v!])
        } else added.set(name, [...(added.get(name) ?? []), a.value])
      }
    }
    const bounded = new Set<string>()
    for (let changed = true; changed; ) {
      changed = false
      for (const name of loopy) {
        if (accums.has(name) || bounded.has(name)) continue
        if ((added.get(name) ?? []).every((v) => refs(v).every((r) => bounded.has(r)))) {
          bounded.add(name)
          changed = true
        }
      }
    }
    for (const name of loopy) {
      if (!accums.has(name)) need(bounded.has(name))
      else need((added.get(name) ?? []).every((v) => refs(v).every((r) => bounded.has(r) && loopySet.has(r))))
    }
  }

  // --- Sizes (gate 10, lessons families 2, 3, 6) --------------------------------

  private collectSizes(body: Stmt[]): void {
    const all: Node[] = []
    const walk = (list: Stmt[]): void => {
      for (const s of list) {
        if (s.k === 'simple') {
          const l = s.line
          if (l.k === 'assign') all.push(l.value, l.target)
          else if ((l.k === 'expr' || l.k === 'return') && l.node) all.push(l.node)
        } else if (s.k === 'if') for (const b of s.branches) b.cond && all.push(b.cond)
        else if (s.k === 'for') all.push(s.source)
        else if (s.k === 'while') all.push(s.cond)
        for (const b of bodiesOf(s)) walk(b)
      }
    }
    walk(body)
    // A number parameter that bounds a range is a size.
    for (const n of all) {
      someNode(n, (c) => {
        if (isCallOf(c, 'range')) for (const a of c.args) for (const [name, p] of this.params) if (p.kind === 'int' && mentions(a, name)) this.sizedNumbers.add(name)
        return false
      })
    }
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
    // Size-free: a number written only outside loops, from a parameter plus or minus a literal (never from a call: family 6).
    for (const [name, l] of this.locals) if (l.k === 'num' && this.assigns.every((a) => a.name !== name || !a.inLoop)) this.sizeFree.add(name)
    for (let changed = true; changed; ) {
      changed = false
      for (const name of [...this.sizeFree]) {
        const ok = this.assigns.every((a) => a.name !== name || this.isSizeFreeValue(a.value))
        if (!ok) {
          this.sizeFree.delete(name)
          changed = true
        }
      }
    }
  }

  /** The parameters whose sizes `n` holds ('?' for a size the reader cannot name); index brackets and comprehensions excluded. */
  private sizesOf(n: Node): Set<string> {
    const out = new Set<string>()
    const visit = (m: Node): void => {
      if (isCallOf(m, 'len')) {
        const a = m.args[0]
        const s = isName(a) ? this.sourceOfName(a.name) : undefined
        if (s) out.add(s.origin)
        else if (!(isName(a) && this.isStrValue(a.name))) out.add('?')
        return
      }
      if (m.k === 'unary' && m.op === 'not' && isName(m.arg)) {
        // A collection's truth is its size.
        const s = this.sourceOfName(m.arg.name)
        if (s) out.add(s.origin)
        else if (this.locals.get(m.arg.name)?.k === 'acc' || this.locals.get(m.arg.name)?.k === 'closed') out.add('?')
        else visit(m.arg)
        return
      }
      if (isName(m)) {
        if (this.sizedNumbers.has(m.name)) out.add(m.name)
        for (const o of this.sizeLocals.get(m.name) ?? []) out.add(o)
        return
      }
      if (m.k === 'index') return visit(m.obj)
      if (m.k === 'comp') return
      childrenOf(m).forEach(visit)
    }
    visit(n)
    return out
  }

  /** A str value that is no size: a str element or local. */
  private isStrValue(name: string): boolean {
    return this.locals.get(name)?.k === 'str' || this.loopNames.has(name)
  }

  private namedSizes(n: Node): number {
    return [...this.sizesOf(n)].filter((o) => o !== '?').length
  }

  /** `len(S)` of a source, or a sized number parameter. */
  private directSize(n: Node): boolean {
    if (isCallOf(n, 'len')) return isName(n.args[0]) && this.sourceOfName(n.args[0].name) !== undefined
    return isName(n) && this.sizedNumbers.has(n.name)
  }

  /**
   * Family 2, and a test that may never hold: a stable test is and, or and
   * not over atoms that can each hold alone — a bool parameter, or a
   * comparison of an int or float parameter or a size-free local with another
   * or with an integer literal; at the root also `len(p)` and `not p` of a
   * parameter, which gate 10 then reads. No call, arithmetic, Literal or
   * other value. With each name once on a path (`checkConsistent`), the tests
   * on a path can all hold together.
   */
  private isStable(n: Node, root: boolean): boolean {
    switch (n.k) {
      case 'bool':
        return this.isStable(n.left, root) && this.isStable(n.right, root)
      case 'unary':
        if (n.op !== 'not') return false
        if (root && isName(n.arg) && this.sourceOfName(n.arg.name)?.isParam) return true
        return this.isStable(n.arg, root)
      case 'name':
        return this.params.get(n.name)?.kind === 'bool'
      case 'cmp': {
        if (!EQUALITY.has(n.op) && !ORDER.has(n.op)) return false
        const side = (m: Node): 'lit' | 'var' | undefined => {
          if (numLit(m) !== undefined) return 'lit'
          if (isName(m)) {
            const k = this.params.get(m.name)?.kind
            return k === 'int' || k === 'float' || this.sizeFree.has(m.name) ? 'var' : undefined
          }
          return root && isCallOf(m, 'len') && m.args.length === 1 && m.kw.length === 0 && isName(m.args[0]) && this.sourceOfName(m.args[0].name)?.isParam ? 'var' : undefined
        }
        const l = side(n.left)
        const r = side(n.right)
        return l !== undefined && r !== undefined && (l === 'var' || r === 'var')
      }
      default:
        return false
    }
  }

  /** Family 2: a condition outside loops is stable. */
  private rootAllowed(n: Node): boolean {
    return this.isStable(n, true)
  }

  /** A size-free local's value: an int or float parameter or a size-free local, plus or minus an integer literal (it takes every value its base does). */
  private isSizeFreeValue(n: Node): boolean {
    if (n.k === 'bin' && (n.op === '+' || n.op === '-') && numLit(n.right) !== undefined) n = n.left
    if (!isName(n)) return false
    const k = this.params.get(n.name)?.kind
    return k === 'int' || k === 'float' || this.sizeFree.has(n.name)
  }

  /** Spec gate 10's exception: `len(p) == 0`-like tests and `not p`, through and/or, in an if outside loops whose branch ends in an exit. */
  private approveGuard(b: Branch, env: Env): void {
    if (env.loops.length > 0 || env.hidden || !b.cond) return
    const found: Node[] = []
    const visit = (n: Node): void => {
      if (n.k === 'bool') {
        visit(n.left)
        visit(n.right)
      } else if (n.k === 'cmp' && Object.hasOwn(TINY, n.op) && this.directSize(n.left) && TINY[n.op]!.includes(numLit(n.right) ?? -1)) found.push(n)
      else if (n.k === 'unary' && n.op === 'not' && ((isName(n.arg) && this.sourceOfName(n.arg.name) !== undefined) || this.directSize(n.arg))) found.push(n)
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
    if (n.k === 'unary' && n.op === 'not') {
      if (!this.tinyGuards.has(n)) this.sizesIn(n.arg, env, true)
      return
    }
    if (test) need(this.sizesOf(n).size === 0)
    if (n.k === 'comp') return
    for (const c of childrenOf(n)) this.sizesIn(c, env, false)
  }

  /** A size compared only with an enclosing loop's index, in plain arithmetic; never two sizes. */
  private checkComparison(n: Extract<Node, { k: 'cmp' }>, env: Env): void {
    const left = this.sizesOf(n.left)
    const right = this.sizesOf(n.right)
    if (left.size === 0 && right.size === 0) return
    const indices = new Set(env.loops.flatMap((l) => (l.index && (l.kind === 'count' || l.kind === 'each') ? [l.index] : [])))
    const plain = (m: Node): boolean =>
      numLit(m) !== undefined ||
      this.directSize(m) ||
      (isName(m) && (this.sizeLocals.has(m.name) || indices.has(m.name))) ||
      (m.k === 'bin' && ['+', '-', '*', '//', '%'].includes(m.op) && plain(m.left) && plain(m.right))
    need((EQUALITY.has(n.op) || ORDER.has(n.op)) && plain(n.left) && plain(n.right) && !left.has('?') && !right.has('?'))
    // Family 3: two sizes compared, in any form, may force them equal.
    need(left.size === 0 || right.size === 0)
    need(someNode(left.size > 0 ? n.right : n.left, (m) => isName(m) && indices.has(m.name)))
  }

  // --- Hidden lines (spec "What the reader reads") -----------------------------

  private checkHidden(): void {
    if (this.lines.every((l) => !isBlankedLine(l))) return
    const bound = new Set([...this.params.keys(), ...this.skipped, ...this.locals.keys(), ...this.loopNames, this.unit.name])
    const hidden = this.unit.hidden
    if (!hidden) refuse()
    const scan = hiddenScan(this.lines)
    need(hidden((raw, at) => this.isHiddenOk(raw, at, bound, scan)) === true && scan.open === undefined)
  }

  private isHiddenOk(raw: string, at: number, bound: ReadonlySet<string>, scan: HiddenScan): boolean {
    const kept = this.lines[at]
    if (typeof raw !== 'string' || !Number.isInteger(at) || at < 1 || kept === undefined || !isBlankedLine(kept)) return false
    if (!isInert(raw, kept, 'Python', bound, WORDS, this.places.get(at) ?? STRICT_PLACE, scan, at)) return false
    // A blanked opener is only an else (fix round 1: a hidden test may raise); its body runs at most once where it stands.
    return !this.openers.has(at) || /^else\s*:/.test(raw.trim())
  }

  /** Whether the blanked line at `at` holds an exit word (only a boolean leaves `hidden`). */
  private hiddenExits(at: number): boolean {
    let seen = false
    const ok = this.unit.hidden?.((raw, k) => {
      if (k !== at) return true
      seen = true
      return /\b(?:return|raise)\b/.test(raw)
    })
    return ok === true && seen
  }

  // --- Exits (spec "Nesting and exits", rulings E and F) ---------------------------

  /** Conditions the statements after `s` stand behind: an if branch that may leave means its test was false. */
  private afterGuards(s: Stmt, depth: number): Entry[] {
    if (s.k !== 'if') return []
    // At the root a hidden line may exit (inert rule 4): its branch may leave too.
    const leaves = (body: Stmt[]): boolean => mayTransfer(body) || (depth === 0 && someStmt(body, (x) => x.k === 'hidden'))
    return s.branches.filter((b) => leaves(b.body)).map((b) => (b.cond ? { cond: b.cond, neg: true, depth } : { neg: false, depth, opaque: true }))
  }

  /**
   * An exit from a loop must stand behind a positive `==` between an int,
   * float or str element (bound directly over a parameter) and a literal or a
   * value from another source, which the input can always make false. Its
   * tests read only elements, parameters and literals; it may not stand in an
   * if chain whose every branch leaves.
   */
  private checkExit(kind: 'return' | 'break' | 'continue', env: Env): void {
    need(!env.hidden)
    const loops = env.loops
    if (kind !== 'return') need(loops.length > 0)
    if (kind === 'continue') return
    const exited = kind === 'return' ? loops : loops.slice(-1)
    if (exited.length === 0) return
    const outer = loops.indexOf(exited[0]!)
    const entries = env.path.filter((e) => e.depth > outer)
    const only = exited.length === 1 ? exited[0]! : undefined
    if (only?.kind === 'search' && only.eqExit && entries.length === 1 && entries[0]!.cond === only.eqExit) {
      need(this.isSearchEquality(only.eqExit, only))
      return
    }
    need(entries.every((e) => !e.opaque && e.cond !== undefined && this.readsOnly(e.cond, env)))
    const positives = entries.filter((e) => !e.neg).map((e) => e.cond!)
    need(positives.some((c) => conjuncts(c).some((a) => this.isFalsifiable(a, env))))
    const chain = env.chain
    need(!(chain?.hasElse && chain.branches.every((b) => endsInTransfer(b.body))))
  }

  /** `S[mid] == v`: S the search's int, float or str source, v a literal or a scalar parameter. */
  private isSearchEquality(c: Node, loop: Loop): boolean {
    if (c.k !== 'cmp' || c.op !== '==') return false
    for (const [x, y] of [
      [c.left, c.right],
      [c.right, c.left],
    ] as const) {
      const s = x.k === 'index' && isName(x.obj, loop.validFor) && isName(x.index, loop.index) ? this.sourceOfName(loop.validFor!) : undefined
      const other = numLit(y) !== undefined || (y.k === 'num') || (isName(y) && this.isScalarParam(y.name))
      if (s && ['int', 'float', 'str'].includes(s.elem) && other) return true
    }
    return false
  }

  private isScalarParam(name: string): boolean {
    const k = this.params.get(name)?.kind
    return k === 'int' || k === 'float' || k === 'literal'
  }

  /** An exit test reads only literals, parameters, elements and element reads, through operators. */
  private readsOnly(n: Node, env: Env): boolean {
    switch (n.k) {
      case 'num':
      case 'const':
        return true
      case 'name':
        return this.params.has(n.name) || this.bindingOf(n.name, env)?.role === 'elem'
      case 'attr':
        return this.readsOnly(n.obj, env)
      case 'index':
        return isName(n.obj) && isName(n.index) && this.sourceOfName(n.obj.name) !== undefined && this.isPosition(n.index.name, n.obj.name, env)
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

  /** An element the input chooses: a loop's atom, or `p[i]` with i walking the parameter p. */
  private elemRef(n: Node, env: Env): { origin: string; type: ElemType } | undefined {
    if (isName(n)) {
      const b = this.bindingOf(n.name, env)
      return b?.role === 'elem' && b.atom && b.origin !== undefined ? { origin: b.origin, type: b.type } : undefined
    }
    if (n.k === 'index' && isName(n.obj) && isName(n.index)) {
      const recv = n.obj.name
      const pos = n.index.name
      const p = this.params.get(recv)
      const s = this.sourceOfName(recv)
      const walks = env.loops.some((l) => l.walks === recv && l.index === pos)
      return p && s && indexable(s) && walks ? { origin: p.name, type: s.elem } : undefined
    }
    return undefined
  }

  /** Ruling E: `e == v` on an int, float or str element against a literal or a value from another source. */
  private isFalsifiable(a: Node, env: Env): boolean {
    if (a.k !== 'cmp' || a.op !== '==') return false
    for (const [x, y] of [
      [a.left, a.right],
      [a.right, a.left],
    ] as const) {
      const e = this.elemRef(x, env)
      if (!e || !['int', 'float', 'str'].includes(e.type)) continue
      if (y.k === 'num') return true
      if (isName(y) && this.isScalarParam(y.name) && y.name !== e.origin) return true
      const o = this.elemRef(y, env)
      if (o && o.origin !== e.origin) return true
    }
    return false
  }

  // --- Costly work behind tests ---------------------------------------------------

  /** A stable test without sizes: the same at every iteration. */
  private isInvariant(n: Node): boolean {
    return this.isStable(n, false)
  }

  /**
   * Costly work in a loop counts at every iteration only when every test on
   * its path inside loops is the same at every iteration (and they agree, see
   * `checkConsistent`). A test that varies may never hold: it guards only
   * constant work. Stricter than the TypeScript reader's choose/avoid reading.
   */
  private costly(env: Env, c: Cost): Cost {
    if (env.loops.length > 0 && hasFactors(c)) {
      for (const e of env.path) if (e.depth >= 1) need(!e.opaque && e.cond !== undefined && this.isInvariant(e.cond))
    }
    return c
  }

  /**
   * Stable tests on one path may contradict each other (`k > 0`, then `k < 0`,
   * or `j = k + 1` and `j > 5` after `k <= 0`): every name they read, through
   * size-free locals, may appear only once on the path.
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
      for (const a of this.assigns) if (a.name === name) someNode(a.value, (c) => (isName(c) ? (expand(c.name, seen), false) : false))
    }
    someNode(n, (c) => (isName(c) ? (expand(c.name, new Set()), false) : false))
    return out
  }

  /** A test the reader reads: not trivial, at most one size, consistent with its path, and gate 10. */
  private checkTest(cond: Node, env: Env): void {
    need(!isTrivial(cond))
    need(this.namedSizes(cond) <= 1)
    this.checkConsistent(env.path, cond)
    this.sizesIn(cond, env, true)
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
        // A hidden if's test is unknown (it may never hold): its body must cost 1 and never leave.
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
            if (depth === 0) need(this.rootAllowed(b.cond))
            this.approveGuard(b, here)
            this.checkTest(b.cond, here)
            total = add(total, this.val(b.cond, here, 'test').c)
          }
          const body = this.costOfBlock(b.body, { ...here, path: b.cond ? [...here.path, { cond: b.cond, neg: false, depth }] : here.path, chain: s })
          // A tiny guard's branch, and a branch that leaves a loop, run at most once.
          if (this.guardBranches.has(b.at) || (depth > 0 && mayExit(b.body))) need(!hasFactors(body))
          total = add(total, body)
          if (b.cond) prev.push({ cond: b.cond, neg: true, depth })
        }
        return total
      }
      case 'for': {
        const loop = this.loops.get(s.at)!
        const here: Env = { ...env, at: s.at }
        this.sizesIn(s.source, here, false)
        const header = this.headerCost(loop, here)
        const body = this.costOfBlock(s.body, { ...here, loops: [...env.loops, loop], chain: undefined })
        return add(header, this.costly(here, mul(loop.factor, add(ONE, body))))
      }
      case 'while': {
        const loop = this.loops.get(s.at)!
        const here: Env = { ...env, at: s.at }
        const body = this.costOfBlock(s.body, { ...here, loops: [...env.loops, loop], chain: undefined })
        return this.costly(here, mul(loop.factor, add(ONE, body)))
      }
    }
  }

  /** A header that copies or sorts adds its cost once (spec "Loops"). */
  private headerCost(loop: Loop, env: Env): Cost {
    const h = loop.header
    if (!h) return NOTHING
    return h.sort ? this.sortSite(env, h.recv) : this.site(env, h.recv, 'builtin', h.what)
  }

  private costOfSimple(line: Simple, env: Env): Cost {
    switch (line.k) {
      case 'assign':
        this.sizesIn(line.value, env, false)
        return this.costOfAssign(line, env)
      case 'expr':
        this.sizesIn(line.node, env, false)
        return this.val(line.node, env, 'stmt').c
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
      default:
        return NOTHING
    }
  }

  /** Gate 9 and the locals: a write keeps the local's kind; an accumulator is reset only empty, a dict written only by key. */
  private costOfAssign(line: Extract<Simple, { k: 'assign' }>, env: Env): Cost {
    const t = line.target
    if (t.k === 'index') {
      const name = (t.obj as { name: string }).name
      const l = this.locals.get(name)
      need(l?.k === 'acc' && l.kind === 'dict')
      const k = this.val(t.index, env)
      const v = this.val(line.value, env)
      need((k.vt === 'num' || k.vt === 'str') && v.vt !== 'coll' && this.isFixedOperand(t.index, env))
      return add(k.c, v.c)
    }
    const name = (t as { name: string }).name
    need(!this.params.has(name) && !this.loopNames.has(name))
    const l = this.locals.get(name)
    if (!l) refuse()
    const v = this.val(line.value, env)
    switch (l.k) {
      case 'acc':
        need(isEmptyLiteral(line.value) === l.kind)
        return v.c
      case 'derived':
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
        need(v.vt === 'coll' && line.op === '=')
        return v.c
    }
  }

  /** One linear factor over `recv`'s source, at the current line. */
  private site(env: Env, recv: string, kind: 'builtin', what: string): Cost {
    const s = this.sourceOfName(recv)
    if (!s) refuse()
    return this.costly(env, factor({ size: s.origin, log: false, kind, at: env.at, what }))
  }

  private sortSite(env: Env, recv: string): Cost {
    const s = this.sourceOfName(recv)
    if (!s) refuse()
    const what = `sort of ${recv}`
    return this.costly(env, mul(factor({ size: s.origin, log: false, kind: 'sort', at: env.at, what }), factor({ size: s.origin, log: true, kind: 'sort', at: env.at, what })))
  }

  /** A value: its cost and type. A collection is handed on only where named (returned, sized, iterated, searched). */
  private val(n: Node, env: Env, ctx: Ctx = 'value'): Val {
    const depth = env.loops.length
    switch (n.k) {
      case 'num':
        return { c: NOTHING, vt: 'num' }
      case 'const':
        return { c: NOTHING, vt: n.v === 'None' ? 'none' : 'num' }
      case 'name': {
        const vt = this.nameVT(n.name, env.loops)
        if (vt === undefined) refuse()
        if (vt === 'coll') need(ctx === 'ret')
        if (vt === 'opaque' || vt === 'none') need(ctx !== 'test')
        return { c: NOTHING, vt }
      }
      case 'attr': {
        // Fix round 1: an attribute read raises on None, a container or a primitive.
        need(this.isAttrReceiver(n.obj, env.loops) && ctx !== 'test')
        return { c: this.val(n.obj, env).c, vt: 'opaque' }
      }
      case 'index': {
        // A read by position only at a position its loop proves in range.
        need(isName(n.obj) && isName(n.index))
        const name = (n.obj as { name: string }).name
        const s = this.sourceOfName(name)
        need(indexable(s) && this.isPosition((n.index as { name: string }).name, name, env))
        const vt = vtOf(s!.elem)
        if (vt === 'opaque') need(ctx !== 'test')
        return { c: NOTHING, vt }
      }
      case 'call':
        return this.valCall(n, env, ctx)
      case 'unary': {
        if (n.op === 'not') return { c: this.tinyGuards.has(n) ? NOTHING : this.val(n.arg, env, 'test').c, vt: 'num' }
        // `~` raises on a float.
        need(n.op === '-' || n.op === '+')
        const a = this.val(n.arg, env)
        need(a.vt === 'num')
        return { c: a.c, vt: 'num' }
      }
      case 'bin': {
        // Family 5: arithmetic on numbers only; ** and << grow a number by its own size, and the bitwise operators raise on a float.
        need(ARITHMETIC.has(n.op))
        const l = this.val(n.left, env)
        const r = this.val(n.right, env)
        need(l.vt === 'num' && r.vt === 'num')
        if (n.op === '/' || n.op === '//' || n.op === '%') need(this.isSafeDivisor(n.right, env))
        return { c: add(l.c, r.c), vt: 'num' }
      }
      case 'cmp':
        return { c: this.valCmp(n, env), vt: 'num' }
      case 'bool': {
        this.checkConsistent(env.path, n.left)
        const guard: Entry = { cond: n.left, neg: n.op === 'or', depth }
        const left = this.val(n.left, env, 'test')
        const right = this.val(n.right, { ...env, path: [...env.path, guard] }, ctx === 'test' ? 'test' : 'value')
        // Outside loops, a test that guards costly work holds only what a root condition may (family 2).
        if (depth === 0 && hasFactors(right.c)) need(this.rootAllowed(n.left))
        if (ctx !== 'test') need(left.vt === right.vt)
        return { c: add(left.c, right.c), vt: ctx === 'test' ? 'num' : left.vt }
      }
      case 'list':
      case 'set': {
        need(ctx !== 'test')
        let c = NOTHING
        for (const it of n.items) {
          const v = this.val(it, env)
          need(n.k === 'set' ? v.vt === 'num' || v.vt === 'str' : v.vt !== 'coll')
          c = add(c, v.c)
        }
        return { c, vt: 'coll' }
      }
      case 'dict': {
        need(ctx !== 'test')
        let c = NOTHING
        n.keys.forEach((key, k) => {
          const kv = this.val(key, env)
          const vv = this.val(n.values[k]!, env)
          need((kv.vt === 'num' || kv.vt === 'str') && vv.vt !== 'coll')
          c = add(c, add(kv.c, vv.c))
        })
        return { c, vt: 'coll' }
      }
      case 'comp':
        need(n.kind !== 'gen' && ctx !== 'test')
        return { c: this.costOfComp(n, env, false), vt: 'coll' }
    }
  }

  /** A position its loop proves in range for `recv`: a range or enumerate index over it, or its search's mid. */
  private isPosition(pos: string, recv: string, env: Env): boolean {
    return env.loops.some((l) => l.index === pos && l.validFor === recv)
  }

  /** A divisor the input can keep from zero: a nonzero literal, a number parameter, or a number element bound over a parameter. */
  private isSafeDivisor(n: Node, env: Env): boolean {
    if (n.k === 'num') return n.v !== 0
    if (!isName(n)) return false
    const k = this.params.get(n.name)?.kind
    if (k === 'int' || k === 'float') return true
    const b = this.bindingOf(n.name, env)
    return b?.role === 'elem' && b.atom && (b.type === 'int' || b.type === 'float')
  }

  private valCmp(n: Extract<Node, { k: 'cmp' }>, env: Env): Cost {
    if (n.op === 'in' || n.op === 'not in') return this.membership(n.left, n.right, env)
    const l = this.val(n.left, env)
    const r = this.val(n.right, env)
    need(l.vt !== 'coll' && r.vt !== 'coll')
    // `is` only against None; == and the orderings never on an opaque value (it may be a container, compared deep).
    if (n.op === 'is' || n.op === 'is not') need(n.left.k === 'const' || n.right.k === 'const')
    else need(l.vt !== 'opaque' && r.vt !== 'opaque' && this.isFixedOperand(n.left, env) && this.isFixedOperand(n.right, env))
    // An ordering of an int with a str raises: one kind on both sides.
    if (ORDER.has(n.op)) need((l.vt === 'num' && r.vt === 'num') || (l.vt === 'str' && r.vt === 'str'))
    return add(l.c, r.c)
  }

  /** Spec "Builtins", `x in S` by annotation: a list, Sequence or tuple costs its size; a set, frozenset or dict 1; a str, an untyped value or a list accumulator fails. */
  private membership(left: Node, right: Node, env: Env): Cost {
    need(this.isFixedOperand(left, env))
    const l = this.val(left, env)
    need(l.vt === 'num' || l.vt === 'str')
    need(isName(right))
    const name = (right as { name: string }).name
    const acc = this.locals.get(name)
    if (acc?.k === 'acc') {
      need(acc.kind !== 'list')
      return l.c
    }
    const s = this.sourceOfName(name)
    need(s !== undefined && s.kind !== 'str')
    if (s!.kind === 'set' || s!.kind === 'map') return l.c
    need(isPrimitive(s!.elem))
    return add(l.c, this.site(env, name, 'builtin', `membership in ${name}`))
  }

  /**
   * Task 7 fix round 2, ruling D′ (an allowlist): a comparison operand, a
   * needle or a key costs 1 only when it is a number literal; an int, float or
   * bool parameter; a proven number local or a loop index; an element (or a
   * dict key) bound by a loop or comprehension directly over a parameter; a
   * read `p[i]` of a parameter at a position its loop proves; or arithmetic
   * over these, or `len` of a parameter. Anything else refuses.
   */
  private isFixedOperand(n: Node, env: Env): boolean {
    switch (n.k) {
      case 'num':
        return true
      case 'name': {
        const b = this.bindingOf(n.name, env)
        if (b) return b.role === 'index' || b.role === 'key' || (b.role === 'elem' && b.atom)
        const p = this.params.get(n.name)
        if (p) return p.kind === 'int' || p.kind === 'float' || p.kind === 'bool'
        return this.locals.get(n.name)?.k === 'num'
      }
      case 'index':
        return isName(n.obj) && isName(n.index) && this.sourceOfName(n.obj.name)?.isParam === true && this.isPosition(n.index.name, n.obj.name, env)
      case 'unary':
        return (n.op === '-' || n.op === '+') && this.isFixedOperand(n.arg, env)
      case 'bin':
        return ARITHMETIC.has(n.op) && this.isFixedOperand(n.left, env) && this.isFixedOperand(n.right, env)
      case 'call':
        return isCallOf(n, 'len') && n.args.length === 1 && n.kw.length === 0 && isName(n.args[0]) && this.sourceOfName(n.args[0].name)?.isParam === true
      default:
        return false
    }
  }

  /** Ruling D′ for derived collections: every name in a comprehension's element, value and filters is one of its own targets or a fixed-cost operand. */
  private isFixedBody(n: Node, own: ReadonlySet<string>, env: Env): boolean {
    if (this.isFixedOperand(n, env) || (n.k === 'name' && own.has(n.name))) return true
    if (n.k === 'name' || n.k === 'comp') return false
    if (n.k === 'call') return n.callee.k === 'name' && GLOBALS.has(n.callee.name) && n.args.every((a) => this.isFixedBody(a, own, env)) && n.kw.length === 0
    if (n.k === 'attr') return false
    return childrenOf(n).every((c) => this.isFixedBody(c, own, env))
  }

  /** Arguments to a helper or a module's function: numbers, strings and None only (a collection could be grown, an opaque value is never handed on). */
  private scalarArgs(n: Extract<Node, { k: 'call' }>, env: Env): Cost {
    need(n.kw.length === 0)
    return n.args.reduce((c, a) => {
      const v = this.val(a, env)
      need(v.vt === 'num' || v.vt === 'str' || v.vt === 'none')
      return add(c, v.c)
    }, NOTHING)
  }

  private valCall(n: Extract<Node, { k: 'call' }>, env: Env, ctx: Ctx): Val {
    const callee = n.callee
    // Fix round 1: a call that ends the process is an exit the input cannot avoid.
    need(!(callee.k === 'name' && isExitName(callee.name)) && !(callee.k === 'attr' && isExitName(callee.name)))
    if (callee.k === 'name') {
      if (GLOBALS.has(callee.name)) return this.builtinCall(callee.name, n, env)
      // A helper: 1 by the rule. A bound name, or a type the signature names, is never called.
      need(!this.isBound(callee.name) && !this.signatureNames.has(callee.name))
      return { c: this.scalarArgs(n, env), vt: 'opaque' }
    }
    need(callee.k === 'attr' && isName(callee.obj))
    const { obj, name: m } = callee as { obj: { name: string }; name: string }
    if (!this.isBound(obj.name)) {
      // A module's function: 1 by the rule. A builtin name is no module.
      need(!GLOBALS.has(obj.name))
      return { c: this.scalarArgs(n, env), vt: 'opaque' }
    }
    const l = this.locals.get(obj.name)
    if (l?.k === 'acc') return this.accCall(l.kind, m, n, env)
    // Family 12: a method on the function's own value only from its kind's closed list.
    const s = this.sourceOfName(obj.name)
    if (!s) refuse()
    return this.collectionCall(s, m, n, env, ctx)
  }

  /** Spec "Builtins" on a typed parameter or derived value: count, copy, get, and an in-place sort as a statement outside loops. */
  private collectionCall(s: Source, m: string, n: Extract<Node, { k: 'call' }>, env: Env, ctx: Ctx): Val {
    const args = n.args
    if (m === 'sort') {
      need(s.isParam && this.params.get(s.name)?.kind === 'list' && ctx === 'stmt' && env.loops.length === 0 && args.length === 0 && this.isReverseOnly(n.kw) && isPrimitive(s.elem) && this.sortedInPlace.get(s.name) === 1)
      return { c: this.sortSite(env, s.name), vt: 'none' }
    }
    need(n.kw.length === 0)
    if (m === 'count') {
      need((s.kind === 'list' || s.kind === 'seq') && args.length === 1 && this.isFixedOperand(args[0]!, env))
      const a = this.val(args[0]!, env)
      need(a.vt === 'num' || a.vt === 'str' || a.vt === 'none')
      return { c: add(a.c, this.site(env, s.name, 'builtin', `count on ${s.name}`)), vt: 'num' }
    }
    if (m === 'copy') {
      need(s.isParam && (s.kind === 'list' || s.kind === 'set' || s.kind === 'map') && args.length === 0)
      return { c: this.site(env, s.name, 'builtin', `copy of ${s.name}`), vt: 'coll' }
    }
    need(m === 'get' && s.kind === 'map' && s.isParam && (args.length === 1 || args.length === 2) && this.isFixedOperand(args[0]!, env))
    let c = NOTHING
    const k = this.val(args[0]!, env)
    need(k.vt === 'num' || k.vt === 'str')
    c = add(c, k.c)
    let dvt: VT | undefined
    if (args[1]) {
      const d = this.val(args[1], env)
      need(d.vt !== 'coll')
      c = add(c, d.c)
      dvt = d.vt
    }
    return { c, vt: this.getType(s, args[1], () => dvt ?? 'bad') }
  }

  /** An accumulator grows by append (a list), add or discard (a set), and is read by get (a dict). */
  private accCall(kind: 'list' | 'set' | 'dict', m: string, n: Extract<Node, { k: 'call' }>, env: Env): Val {
    need(n.kw.length === 0)
    const args = n.args
    if (kind === 'list') {
      need(m === 'append' && args.length === 1)
      const v = this.val(args[0]!, env)
      need(v.vt !== 'coll')
      return { c: v.c, vt: 'none' }
    }
    if (kind === 'set') {
      need((m === 'add' || m === 'discard') && args.length === 1 && this.isFixedOperand(args[0]!, env))
      const v = this.val(args[0]!, env)
      need(v.vt === 'num' || v.vt === 'str')
      return { c: v.c, vt: 'none' }
    }
    need(m === 'get' && (args.length === 1 || args.length === 2) && this.isFixedOperand(args[0]!, env))
    const k = this.val(args[0]!, env)
    need(k.vt === 'num' || k.vt === 'str')
    const d = args[1] ? this.val(args[1], env) : undefined
    need(d === undefined || d.vt !== 'coll')
    return { c: add(k.c, d?.c ?? NOTHING), vt: 'opaque' }
  }

  /** A bare source named as a builtin's one argument. */
  private namedSource(a: Node | undefined): Source {
    need(isName(a))
    const s = this.sourceOfName((a as { name: string }).name)
    if (!s) refuse()
    return s
  }

  /** Python builtins: a closed list (spec "Builtins", stricter readings). */
  private builtinCall(f: string, n: Extract<Node, { k: 'call' }>, env: Env): Val {
    const args = n.args
    if (f === 'sorted') {
      need(args.length === 1 && this.isReverseOnly(n.kw))
      const s = this.namedSource(args[0])
      // A parameter only: a derived value may be a sorted run already, as may a parameter sorted in place.
      need(isPrimitive(iterType(s)) && s.isParam && !this.sortedInPlace.has(s.name))
      return { c: this.sortSite(env, s.name), vt: 'coll' }
    }
    need(n.kw.length === 0)
    switch (f) {
      case 'len': {
        need(args.length === 1)
        const a = args[0]!
        if (isName(a)) {
          const vt = this.nameVT(a.name, env.loops)
          need(vt === 'coll' || vt === 'str')
          return { c: NOTHING, vt: 'num' }
        }
        const v = this.val(a, env)
        need(v.vt === 'coll' || v.vt === 'str')
        return { c: v.c, vt: 'num' }
      }
      case 'abs':
      case 'int':
      case 'float':
      case 'bool': {
        need(args.length === 1)
        const v = this.val(args[0]!, env)
        need(v.vt === 'num')
        return { c: v.c, vt: 'num' }
      }
      case 'min':
      case 'max':
      case 'sum': {
        need(args.length >= 1)
        if (args.length === 1) {
          const a = args[0]!
          if (a.k === 'comp' && a.kind === 'gen') return { c: this.costOfComp(a, env, true), vt: 'num' }
          const s = this.namedSource(a)
          const type = iterType(s)
          // sum adds numbers only; min and max order one kind.
          need(f === 'sum' ? type === 'int' || type === 'float' || type === 'bool' : isPrimitive(type))
          return { c: this.site(env, s.name, 'builtin', `${f} of ${s.name}`), vt: vtOf(type) }
        }
        need(f !== 'sum')
        let c = NOTHING
        for (const a of args) {
          const v = this.val(a, env)
          need(v.vt === 'num')
          c = add(c, v.c)
        }
        return { c, vt: 'num' }
      }
      case 'list':
      case 'tuple':
      case 'set':
      case 'dict': {
        if (args.length === 0) return { c: NOTHING, vt: 'coll' }
        need(args.length === 1)
        const s = this.namedSource(args[0])
        if (f === 'set') need(s.kind !== 'str' && ['int', 'float', 'str'].includes(iterType(s)))
        if (f === 'dict') need(s.kind === 'map')
        return { c: this.site(env, s.name, 'builtin', `${f} of ${s.name}`), vt: 'coll' }
      }
      default:
        // range, enumerate and reversed only in a header; any, all and every other builtin refuse.
        refuse()
    }
  }

  /**
   * A comprehension or generator: each `for` clause a loop over a size
   * source, each `if` a test in that loop, the element its body. `numeric`:
   * the element must be a number (sum, min, max).
   */
  private costOfComp(n: Extract<Node, { k: 'comp' }>, env: Env, numeric: boolean): Cost {
    // Task 7 fix round 2, ruling D′: the element, value and filters name only the comprehension's own targets and fixed-cost operands.
    const own = new Set(n.clauses.flatMap((c) => c.targets))
    const fixedIn = (inner: Env): void => need([n.elt, ...(n.value ? [n.value] : []), ...n.clauses.flatMap((c) => c.conds)].every((m) => this.isFixedBody(m, own, inner)))
    const go = (k: number, inner: Env): Cost => {
      if (k === n.clauses.length) {
        fixedIn(inner)
        this.sizesIn(n.elt, inner, false)
        const e = this.val(n.elt, inner)
        if (n.kind === 'set' || n.kind === 'dict') need(e.vt === 'num' || e.vt === 'str')
        else need(e.vt !== 'coll' && (!numeric || e.vt === 'num'))
        if (!n.value) return e.c
        this.sizesIn(n.value, inner, false)
        const v = this.val(n.value, inner)
        need(v.vt !== 'coll')
        return add(e.c, v.c)
      }
      const cl = n.clauses[k]!
      for (const t of cl.targets) need(this.bindingOf(t, inner) === undefined)
      need(cl.targets.length === 1 || cl.targets[0] !== cl.targets[1])
      const loop = this.sourceLoop(cl.source, cl.targets, inner.loops, inner.at, true)
      const header = this.headerCost(loop, inner)
      let body: Env = { ...inner, loops: [...inner.loops, loop], chain: undefined }
      let c = NOTHING
      for (const cond of cl.conds) {
        this.checkTest(cond, body)
        c = add(c, this.val(cond, body, 'test').c)
        body = { ...body, path: [...body.path, { cond, neg: false, depth: body.loops.length }] }
      }
      c = add(c, go(k + 1, body))
      return add(header, this.costly(inner, mul(loop.factor, add(ONE, c))))
    }
    return go(0, env)
  }
}

// ---------------------------------------------------------------------------
// Helpers over shapes

/** `max(name, v)`, `min(name, v)` or with the arguments swapped: `v`, when it does not read `name`. */
function maxMinOther(n: Node, name: string): Node | undefined {
  if (!(isCallOf(n, 'max') || isCallOf(n, 'min')) || n.args.length !== 2 || n.kw.length > 0) return undefined
  const [a, b] = n.args as [Node, Node]
  if (isName(a, name) && !mentions(b, name)) return b
  if (isName(b, name) && !mentions(a, name)) return a
  return undefined
}

/** Spec "Binary search": `(lo + hi) // 2` or `lo + (hi - lo) // 2`. */
function isMidForm(n: Node, lo: string, hi: string): boolean {
  const sum = (m: Node): boolean => m.k === 'bin' && m.op === '+' && isName(m.left, lo) && isName(m.right, hi)
  if (n.k === 'bin' && n.op === '//' && sum(n.left) && numLit(n.right) === 2) return true
  if (n.k === 'bin' && n.op === '+' && isName(n.left, lo)) {
    const r = n.right
    return r.k === 'bin' && r.op === '//' && numLit(r.right) === 2 && r.left.k === 'bin' && r.left.op === '-' && isName(r.left.left, hi) && isName(r.left.right, lo)
  }
  return false
}

/**
 * Ruling F: after `mid`, an optional equality exit (an if, no else, on a
 * comparison reading mid, whose body is one return or break), then one
 * if/else on such a comparison whose branches assign exactly lo and hi, one
 * each, and nothing else.
 */
function isSearchBody(rest: Stmt[], lo: string, hi: string, mid: string): boolean {
  const readsMid = (c: Node | undefined): boolean => c !== undefined && c.k === 'cmp' && (EQUALITY.has(c.op) || ORDER.has(c.op)) && mentions(c, mid)
  const only = (body: Stmt[]): Simple | undefined => (body.length === 1 && body[0]!.k === 'simple' ? body[0]!.line : undefined)
  const target = (b: Branch): string | undefined => {
    const l = only(b.body)
    return l?.k === 'assign' && l.op === '=' && isName(l.target) ? l.target.name : undefined
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

/** A condition no input can change: no names at all, a comparison of a value with itself, or `a or not a` / `a and not a`. */
function isTrivial(n: Node): boolean {
  if (!someNode(n, (m) => m.k === 'name')) return true
  // Fix round 3: a literal operand of and, or or not makes the test always or never hold (`k > 0 or True`).
  const isLiteral = (m: Node): boolean => ['num', 'const', 'list', 'set', 'dict', 'comp'].includes(m.k)
  if (someNode(n, (m) => (m.k === 'bool' && (isLiteral(m.left) || isLiteral(m.right))) || (m.k === 'unary' && m.op === 'not' && isLiteral(m.arg)))) return true
  const same = (a: Node, b: Node): boolean => JSON.stringify(a) === JSON.stringify(b)
  return someNode(n, (m) => (m.k === 'cmp' && same(m.left, m.right)) || (m.k === 'bool' && (same(negate(m.left), m.right) || same(m.left, negate(m.right)))))
}

/** The worst-case cost of a Python unit, its number parameters and its parameter names; undefined for any shape the reader cannot place. */
export function readPython(unit: Unit): { cost: Cost; numeric: string[]; params: string[] } | undefined {
  try {
    return new Reader(unit, unit.full?.lines ?? unit.lines).read()
  } catch {
    return undefined
  }
}
