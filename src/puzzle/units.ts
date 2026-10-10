import { PUZZLE } from '../config'
import { filterCode } from './code-filter'
import { filterPython } from './python-filter'
import type { PrivacyMode } from './privacy-filter'

// SPEC 8.3 rule 1: the units worth a puzzle in a mission's changes. Pure:
// the glue reads the diff and the files and hands them in.

/** A unit: a function the mission touched, already filtered, its lines without blank ones. */
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
    const out: Unit[] = []
    let i = 0
    while (i < lines.length) {
      const name = pythonFunctionName(lines[i]!)
      if (name === undefined) {
        i += 1
        continue
      }
      // The body: every following line indented deeper, blank lines included, to the first that is not.
      const base = indentOf(lines[i]!)
      let end = i
      for (let k = i + 1; k < lines.length; k += 1) {
        const l = lines[k]!
        if (l.trim() === '') continue
        if (indentOf(l) <= base) break
        end = k
      }
      const body = lines.slice(i, end + 1).filter(l => l.trim() !== '')
      let isTouched = false
      for (let n = i + 1; n <= end + 1 && !isTouched; n += 1) isTouched = changed.has(n)
      if (end > i && isTouched && body.length >= PUZZLE.unitMinLines && body.length <= PUZZLE.unitMaxLines) {
        out.push({ lang: this.lang, name, lines: dedent(body) })
        i = end + 1
      } else i += 1
    }
    return out
  },
}

export const ADAPTERS: readonly ContentAdapter[] = [TS_ADAPTER, PY_ADAPTER]

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
