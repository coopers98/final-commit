import { PUZZLE } from '../config'
import { BLANK, filterCode } from './code-filter'
import { filterMarkdown } from './markdown-filter'
import { filterPhp } from './php-filter'
import { filterPython } from './python-filter'
import { filterSql } from './sql-filter'
import type { PrivacyMode } from './privacy-filter'

// SPEC 8.3 rule 1: the units worth a puzzle in a mission's changes. Pure:
// the glue reads the diff and the files and hands them in.

/** A unit: a function (or a document's section) the mission touched, already filtered, its lines without blank ones. */
export type Unit = { lang: string; name: string; lines: string[] }

/** One content adapter: which files it claims and how it finds units in filtered source. */
export type ContentAdapter = {
  lang: string
  claims(path: string): boolean
  /** Its language's filter (SPEC 5.3): what the units are read from, line for line. */
  filter(source: string, mode: PrivacyMode): string
  /** A file it will not read at all, judged on the code as written (TypeScript: JSX). */
  rejects?(source: string, path: string): boolean
  /** Units overlapping `changed` (1-based line numbers) in `filtered`, whose line count matches the file's. */
  units(filtered: string, changed: ReadonlySet<number>): Unit[]
}

/** A path a diff may name: relative, inside the folder, plain (git quotes unusual names, which are skipped). */
export function isSafePath(path: string): boolean {
  return path !== '' && !path.startsWith('/') && !path.startsWith('"') && !/^[A-Za-z]:/.test(path) && !path.split(/[\\/]/).includes('..')
}

/**
 * The lines each file gained, from `git diff --unified=0 --dst-prefix=b/`:
 * path to 1-based line numbers in the new file. A file's path is read only
 * in its header (between `diff --git` and its first hunk): a changed line
 * reads `+`, `-` or ` ` first, so it can never pose as one. Deleted files,
 * binaries and unsafe paths give none.
 */
export function changedLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>()
  let path: string | undefined
  let isHeader = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      isHeader = true
      path = undefined
      continue
    }
    if (isHeader && line.startsWith('+++ ')) {
      const target = line.slice(4).trim()
      path = target.startsWith('b/') && isSafePath(target.slice(2)) ? target.slice(2) : undefined
      continue
    }
    if (line.startsWith('@@')) isHeader = false
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk && path) {
      const start = Number(hunk[1])
      const count = hunk[2] === undefined ? 1 : Number(hunk[2])
      const set = out.get(path) ?? new Set<number>()
      for (let n = start; n < start + count; n += 1) set.add(n)
      if (count > 0) out.set(path, set)
    }
  }
  return out
}

/** Matching `{` and `}` from line `from` (0-based): the 0-based line the block closes on, or undefined. */
export function blockEnd(lines: readonly string[], from: number): number | undefined {
  return blockEnds(lines)(from)
}

/**
 * `blockEnd` for every start line at once: braces are matched in one pass,
 * so a file of many candidate lines is read once, not once per line.
 */
export function blockEnds(lines: readonly string[]): (from: number) => number | undefined {
  // Each brace in order, with its line; each `{`'s matching `}` line, or -1 when it never closes.
  const braces: { line: number; isOpen: boolean }[] = []
  for (const [i, l] of lines.entries()) for (const c of l) if (c === '{' || c === '}') braces.push({ line: i, isOpen: c === '{' })
  const closeOf = new Array<number>(braces.length).fill(-1)
  const stack: number[] = []
  for (const [k, b] of braces.entries()) {
    if (b.isOpen) stack.push(k)
    else if (stack.length > 0) closeOf[stack.pop()!] = b.line
  }
  // The first brace at or after each line.
  const firstFrom = new Array<number>(lines.length + 1).fill(braces.length)
  for (let k = braces.length - 1; k >= 0; k -= 1) firstFrom[braces[k]!.line] = k
  for (let i = lines.length - 1; i >= 0; i -= 1) firstFrom[i] = Math.min(firstFrom[i]!, firstFrom[i + 1]!)
  return from => {
    const k = firstFrom[from] ?? braces.length
    const b = braces[k]
    // A `}` first means the block began before `from`; one that never closes has no end.
    if (!b || !b.isOpen || closeOf[k]! < 0) return undefined
    return closeOf[k]
  }
}

const NOT_A_NAME = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'else', 'do', 'try', 'with', 'new', 'typeof'])

/** The function a line starts, by name; undefined for any other line. */
export function functionName(line: string): string | undefined {
  if (line.length > PUZZLE.maxSignatureChars) return undefined
  const decl = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*(?:\*\s*)?([A-Za-z_$][\w$]*)\s*[<(]/.exec(line)
  if (decl) return decl[1]
  // The rest only for a line that opens a block, and each by an anchored prefix plus plain checks:
  // patterns with several runs that can match the same spaces backtrack badly on long lines.
  const trimmed = line.trimEnd()
  if (!trimmed.endsWith('{')) return undefined
  const arrow = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line)
  if (arrow) {
    // `= (params) =>` or `= param =>`, optionally async, generic or typed: not a call that takes a callback.
    const right = /^\s*(?::[^=]*)?=(.*)=>$/.exec(trimmed.slice(arrow[0].length, -1).trimEnd())?.[1]?.trim()
    // Parameters may hold one level of parentheses (a function-typed parameter).
    return right !== undefined && /^(?:async\s+)?(?:<[^>]*>\s*)?(?:\((?:[^()]|\([^()]*\))*\)|[A-Za-z_$][\w$]*)(?::[^=()]*)?$/.test(right) ? arrow[1] : undefined
  }
  // A method: modifiers, a name, its parameters, an optional return type, then the block. A line
  // ending in `=> {`, or passing a `function`, is a call taking a callback; an arrow inside the
  // parameters is a type.
  if (/=>\s*\{$/.test(trimmed) || /\bfunction\b/.test(trimmed) || line.includes(';')) return undefined
  const method = /^\s*(?:(?:public|private|protected|static|readonly|override|async|get|set)\s+)*(?:\*\s*)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>\s*)?\(/.exec(line)
  if (method && !NOT_A_NAME.has(method[1]!) && /\)\s*(?::.*)?\{$/.test(trimmed)) return method[1]
  return undefined
}

/**
 * Whether `text` may hold JSX. In JavaScript files (which may carry JSX)
 * any `<` right before a letter or `>`, or a `<` and `/` with only space
 * between, rules the file out: a formatter spaces comparisons, so little
 * real code is lost. TypeScript files cannot hold JSX (`<T>` there is a
 * type), so only the plain tag shapes count.
 */
export function hasJsx(text: string, path = ''): boolean {
  if (/\.[cm]?js$/.test(path)) return /<[A-Za-z>]|<\s*\/|\/\s*>/.test(text)
  // Line by line, and spaces only: a multi-line `\s*` here backtracks across blank runs.
  // A triple-slash directive (`/// <reference ... />`) is a comment, not a tag.
  const lines = text.split('\n').filter(l => !/^\s*\/\/\//.test(l))
  if (/<\s*\/|\/\s*>/.test(lines.join('\n'))) return true
  return lines.some(l => /(?:^|[(=?:,{}[!]|=>|&&|\|\||\b(?:return|yield|await))[ \t]*<[A-Za-z>]/.test(l))
}

/** SPEC 8.3 rule 2: TypeScript. */
export const TS_ADAPTER: ContentAdapter = {
  lang: 'TypeScript',
  // TypeScript only (SPEC 8.4): a JavaScript file may hold JSX, whose text is prose with no quotes
  // to blank and whose attribute strings have no escapes; TypeScript rejects JSX in .ts files.
  claims: path => /\.[cm]?ts$/.test(path) && !path.endsWith('.d.ts'),
  filter: filterCode,
  rejects: (source, path) => hasJsx(source, path),
  units(filtered, changed) {
    const lines = filtered.split('\n')
    const endOf = blockEnds(lines)
    // JSX in a .js or .ts file: its text lines are prose the filter cannot tell from code.
    if (lines.some(l => /(?:^|[(=?:,{}]|&&|\|\||\breturn)\s*<[A-Za-z>]/.test(l))) return []
    // Counts up to each line (non-blank lines, changed lines), so a span is sized in one step:
    // nested functions in a long file never re-read their whole bodies.
    const filled = [0]
    const touched = [0]
    for (const [k, l] of lines.entries()) {
      filled.push(filled[k]! + (l.trim() !== '' ? 1 : 0))
      touched.push(touched[k]! + (changed.has(k + 1) ? 1 : 0))
    }
    const out: Unit[] = []
    let i = 0
    while (i < lines.length) {
      const name = functionName(lines[i]!)
      const end = name === undefined ? undefined : endOf(i)
      if (name === undefined || end === undefined) {
        i += 1
        continue
      }
      const size = filled[end + 1]! - filled[i]!
      const isTouched = touched[end + 1]! - touched[i]! > 0
      const body = isTouched && size >= PUZZLE.unitMinLines && size <= PUZZLE.unitMaxLines ? lines.slice(i, end + 1).filter(l => l.trim() !== '') : []
      if (body.length > 0 && !body.some(isUnsafeLine)) {
        out.push({ lang: this.lang, name, lines: dedent(body) })
        i = end + 1
      } else {
        // A long function is skipped whole, but a short one inside it may still be a unit.
        i += 1
      }
    }
    return out
  },
}

/** A Python function's first line: `def name(...)` or `async def`, its signature on that one line. */
export function pythonFunctionName(line: string): string | undefined {
  if (line.length > PUZZLE.maxSignatureChars || !line.trimEnd().endsWith(':')) return undefined
  return /^[ \t]*(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)[ \t]*\(/.exec(line)?.[1]
}

const indentOf = (line: string) => /^[ \t]*/.exec(line)![0].length

/** SPEC 8.3 rule 2: Python. Functions by `def`, their bodies by indentation. */
export const PY_ADAPTER: ContentAdapter = {
  lang: 'Python',
  claims: path => /\.pyi?$/.test(path) && !path.endsWith('.pyi'),
  filter: filterPython,
  units(filtered, changed) {
    const lines = filtered.split('\n')
    // One pass each, so a file of deeply nested defs is never rescanned per def:
    // each def's last body line (its body is every deeper-indented line after it),
    // and counts up to each line of non-blank and changed lines.
    const endOf = new Array<number>(lines.length).fill(-1)
    const open: { at: number; indent: number }[] = []
    let lastFilled = -1
    for (const [k, l] of lines.entries()) {
      if (l.trim() === '') continue
      const indent = indentOf(l)
      while (open.length > 0 && open[open.length - 1]!.indent >= indent) endOf[open.pop()!.at] = lastFilled
      if (pythonFunctionName(l) !== undefined) open.push({ at: k, indent })
      lastFilled = k
    }
    for (const d of open) endOf[d.at] = lastFilled
    const filled = [0]
    const touched = [0]
    for (const [k, l] of lines.entries()) {
      filled.push(filled[k]! + (l.trim() !== '' ? 1 : 0))
      touched.push(touched[k]! + (changed.has(k + 1) ? 1 : 0))
    }
    const out: Unit[] = []
    let i = 0
    while (i < lines.length) {
      const name = endOf[i]! >= 0 ? pythonFunctionName(lines[i]!) : undefined
      const end = endOf[i]!
      if (name === undefined || end <= i) {
        i += 1
        continue
      }
      const size = filled[end + 1]! - filled[i]!
      const isTouched = touched[end + 1]! - touched[i]! > 0
      if (isTouched && size >= PUZZLE.unitMinLines && size <= PUZZLE.unitMaxLines) {
        out.push({ lang: this.lang, name, lines: dedent(lines.slice(i, end + 1).filter(l => l.trim() !== '')) })
        i = end + 1
      } else i += 1
    }
    return out
  },
}

/** A PHP function's or method's first line, by name: modifiers, `function`, a name and `(`. Closures have none. */
export function phpFunctionName(line: string): string | undefined {
  if (line.length > PUZZLE.maxSignatureChars) return undefined
  return /^[ \t]*(?:(?:abstract|final|public|private|protected|static|readonly)[ \t]+)*function[ \t]+&?[ \t]*([A-Za-z_]\w*)[ \t]*\(/i.exec(line)?.[1]
}

/**
 * The line a PHP function's body opens on: the first from `from` that ends
 * in `{`, within `PUZZLE.maxSignatureLines`. None when a line before it may
 * end the declaration or hide its end (a `;` for an abstract method, a `}`,
 * a blanked line).
 */
function phpBodyStart(lines: readonly string[], from: number): number | undefined {
  for (let k = from; k < lines.length && k < from + PUZZLE.maxSignatureLines; k += 1) {
    const l = lines[k]!
    if (l.includes(';') || l.includes('}') || l.includes(BLANK)) return undefined
    if (l.trimEnd().endsWith('{')) return l.indexOf('{') === l.lastIndexOf('{') ? k : undefined
  }
  return undefined
}

/** SPEC 8.3 rule 2: PHP. Functions and methods by `function`, their bodies by braces (a body's `{` may open on a later line, as PSR-12 sets it). */
export const PHP_ADAPTER: ContentAdapter = {
  lang: 'PHP',
  // Blade templates end in .php but are HTML.
  claims: path => path.endsWith('.php') && !path.endsWith('.blade.php'),
  filter: filterPhp,
  units(filtered, changed) {
    const lines = filtered.split('\n')
    const endOf = blockEnds(lines)
    const filled = [0]
    const touched = [0]
    for (const [k, l] of lines.entries()) {
      filled.push(filled[k]! + (l.trim() !== '' ? 1 : 0))
      touched.push(touched[k]! + (changed.has(k + 1) ? 1 : 0))
    }
    const out: Unit[] = []
    let i = 0
    while (i < lines.length) {
      const name = phpFunctionName(lines[i]!)
      const open = name === undefined ? undefined : phpBodyStart(lines, i)
      const end = open === undefined ? undefined : endOf(open)
      if (name === undefined || end === undefined) {
        i += 1
        continue
      }
      const size = filled[end + 1]! - filled[i]!
      const isTouched = touched[end + 1]! - touched[i]! > 0
      const body = isTouched && size >= PUZZLE.unitMinLines && size <= PUZZLE.unitMaxLines ? lines.slice(i, end + 1).filter(l => l.trim() !== '') : []
      if (body.length > 0 && !body.some(isUnsafeLine)) {
        out.push({ lang: this.lang, name, lines: dedent(body) })
        i = end + 1
      } else i += 1
    }
    return out
  },
}

/** An ATX heading's text, without its hashes or closing hashes; undefined for any other line. */
export function headingName(line: string): string | undefined {
  // One space or tab, then the rest: a `[ \t]+` before `.*` backtracks badly on a line that ends in a line separator.
  const m = /^ {0,3}#{1,6}(?:[ \t](.*))?$/.exec(line)
  if (!m) return undefined
  // A closing run of hashes goes when space (or nothing) precedes it; read by hand to stay linear.
  const text = (m[1] ?? '').trimEnd()
  let at = text.length
  while (at > 0 && text[at - 1] === '#') at -= 1
  return (at === 0 || /[ \t]/.test(text[at - 1]!) ? text.slice(0, at) : text).trim()
}

/**
 * SPEC 8.3 rule 2: Markdown. A section runs from an ATX heading to the next
 * one of any level, or the file's end; prose before the first heading and
 * setext headings give no unit.
 */
export const MD_ADAPTER: ContentAdapter = {
  lang: 'Markdown',
  claims: path => /\.(?:md|markdown)$/.test(path),
  filter: filterMarkdown,
  units(filtered, changed) {
    const lines = filtered.split('\n')
    const starts = lines.flatMap((l, k) => (headingName(l) !== undefined ? [k] : []))
    const filled = [0]
    const touched = [0]
    for (const [k, l] of lines.entries()) {
      filled.push(filled[k]! + (l.trim() !== '' ? 1 : 0))
      touched.push(touched[k]! + (changed.has(k + 1) ? 1 : 0))
    }
    const out: Unit[] = []
    for (const [n, i] of starts.entries()) {
      const end = (starts[n + 1] ?? lines.length) - 1
      const name = headingName(lines[i]!)!
      if (name === '' || name === BLANK) continue
      const size = filled[end + 1]! - filled[i]!
      const isTouched = touched[end + 1]! - touched[i]! > 0
      if (!isTouched || size < PUZZLE.unitMinLines || size > PUZZLE.unitMaxLines) continue
      const body = lines.slice(i, end + 1).filter(l => l.trim() !== '')
      if (!body.some(isUnsafeLine)) out.push({ lang: this.lang, name, lines: dedent(body) })
    }
    return out
  },
}

/** A query's first word (any case): the statements a query puzzle is made from. */
const QUERY_START = /^[ \t]*(select|with|insert|update|delete|merge|replace|create(?:[ \t]+or[ \t]+replace)?(?:[ \t]+(?:temp|temporary|materialized|recursive))?[ \t]+view)\b/i

/** A SQL statement's name: its verb and the first table or view it names on its first lines, as `select orders`. */
export function sqlStatementName(lines: readonly string[]): string | undefined {
  const verb = QUERY_START.exec(lines[0] ?? '')?.[1]
  if (verb === undefined) return undefined
  const kind = /view$/i.test(verb) ? 'view' : verb.split(/[ \t]/)[0]!.toLowerCase()
  const text = lines.slice(0, 4).join(' ')
  const target = (kind === 'view' ? /\bview[ \t]+(?:if[ \t]+not[ \t]+exists[ \t]+)?([A-Za-z_][\w.]*)/i : /\b(?:from|into|update|merge[ \t]+into)[ \t]+([A-Za-z_][\w.]*)/i).exec(text)?.[1]
  return target === undefined || /^(?:select|only|lateral)$/i.test(target) ? kind : `${kind} ${target}`
}

/**
 * SPEC 8.3 rule 2: SQL. A unit is a query statement (`SELECT`, `WITH`,
 * `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `REPLACE`, `CREATE VIEW`) from its
 * first line to the line holding the `;` that ends it (blanked lines keep
 * theirs) or the file's end. Blank and `…` lines between statements (comments)
 * start none.
 */
export const SQL_ADAPTER: ContentAdapter = {
  lang: 'SQL',
  claims: path => path.endsWith('.sql'),
  filter: filterSql,
  units(filtered, changed) {
    const lines = filtered.split('\n')
    const out: Unit[] = []
    let start: number | undefined
    const take = (end: number) => {
      const from = start!
      start = undefined
      const body = lines.slice(from, end + 1).filter(l => l.trim() !== '')
      const name = sqlStatementName(body)
      const isTouched = lines.slice(from, end + 1).some((_, k) => changed.has(from + k + 1))
      if (name === undefined || !isTouched || body.length < PUZZLE.unitMinLines || body.length > PUZZLE.unitMaxLines) return
      // A fence could close the one around the query in a prompt.
      if (!body.some(l => l.includes('```'))) out.push({ lang: this.lang, name, lines: dedent(body) })
    }
    for (const [k, l] of lines.entries()) {
      const text = l.trim()
      if (start === undefined && (text === '' || text.startsWith(BLANK))) continue
      start ??= k
      if (l.includes(';')) take(k)
      if (out.length >= PUZZLE.maxUnits) break
    }
    if (start !== undefined) take(lines.length - 1)
    return out
  },
}

export const ADAPTERS: readonly ContentAdapter[] = [TS_ADAPTER, PY_ADAPTER, PHP_ADAPTER, SQL_ADAPTER, MD_ADAPTER]

/**
 * A line a unit is never taken with: JSX, fragments included (its text is
 * prose with no quotes to blank, in a .js or .ts file too), or a fence (it could close the one around code in a prompt).
 * A generic arrow (`= <T>(`) reads as JSX too, which only loses a unit.
 */
export function isUnsafeLine(line: string): boolean {
  return line.includes('```') || /(?:^|[(=?:,{}]|&&|\|\||\breturn)\s*<\/?[A-Za-z>]/.test(line) || /<\/|<>|\/>/.test(line)
}

/** `lines` less their shared leading indent. */
function dedent(lines: string[]): string[] {
  const indent = Math.min(...lines.map(l => l.length - l.trimStart().length))
  return lines.map(l => l.slice(indent))
}
