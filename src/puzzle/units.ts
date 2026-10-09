import { PUZZLE } from '../config'

// SPEC 8.3 rule 1: the units worth a puzzle in a mission's changes. Pure:
// the glue reads the diff and the files and hands them in.

/** A unit: a function the mission touched, already filtered, its lines without blank ones. */
export type Unit = { lang: string; name: string; lines: string[] }

/** One content adapter: which files it claims and how it finds units in filtered source. */
export type ContentAdapter = {
  lang: string
  claims(path: string): boolean
  /** Units overlapping `changed` (1-based line numbers) in `filtered`, whose line count matches the file's. */
  units(filtered: string, changed: ReadonlySet<number>): Unit[]
}

/**
 * The lines each file gained, from `git diff --unified=0`: path to 1-based
 * line numbers in the new file. Deleted files and binaries give none.
 */
export function changedLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>()
  let path: string | undefined
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim()
      path = target === '/dev/null' ? undefined : target.replace(/^b\//, '')
      continue
    }
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
  let depth = 0
  let isOpen = false
  for (let i = from; i < lines.length; i += 1) {
    for (const c of lines[i]!) {
      if (c === '{') {
        depth += 1
        isOpen = true
      } else if (c === '}') {
        depth -= 1
        if (isOpen && depth === 0) return i
        if (depth < 0) return undefined
      }
    }
  }
  return undefined
}

const NOT_A_NAME = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'else', 'do', 'try', 'with', 'new', 'typeof'])

/** The function a line starts, by name; undefined for any other line. */
export function functionName(line: string): string | undefined {
  const decl = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[<(]/.exec(line)
  if (decl) return decl[1]
  const arrow = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:<[^>]*>\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+?)?\s*=>\s*\{\s*$/.exec(line)
  if (arrow) return arrow[1]
  const method = /^\s*(?:(?:public|private|protected|static|readonly|override|async|get|set)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^;]*\)\s*(?::\s*[^{;]+)?\{\s*$/.exec(line)
  if (method && !NOT_A_NAME.has(method[1]!)) return method[1]
  return undefined
}

/** SPEC 8.3 rule 2: TypeScript and JavaScript. */
export const TS_ADAPTER: ContentAdapter = {
  lang: 'TypeScript',
  claims: path => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path) && !path.endsWith('.d.ts'),
  units(filtered, changed) {
    const lines = filtered.split('\n')
    const out: Unit[] = []
    let i = 0
    while (i < lines.length) {
      const name = functionName(lines[i]!)
      const end = name === undefined ? undefined : blockEnd(lines, i)
      if (name === undefined || end === undefined) {
        i += 1
        continue
      }
      const body = lines.slice(i, end + 1).filter(l => l.trim() !== '')
      let isTouched = false
      for (let n = i + 1; n <= end + 1 && !isTouched; n += 1) isTouched = changed.has(n)
      if (isTouched && body.length >= PUZZLE.unitMinLines && body.length <= PUZZLE.unitMaxLines) {
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

export const ADAPTERS: readonly ContentAdapter[] = [TS_ADAPTER]

/** `lines` less their shared leading indent. */
function dedent(lines: string[]): string[] {
  const indent = Math.min(...lines.map(l => l.length - l.trimStart().length))
  return lines.map(l => l.slice(indent))
}
