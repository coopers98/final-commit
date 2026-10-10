import { PUZZLE } from '../config'
import { BLANK, CONTROL } from './code-filter'
import { filterValues, type PrivacyMode } from './privacy-filter'

// SPEC 5.3 and 8.3 rule 1, for Python: the same proof-based design as the
// TypeScript filter (code-filter.ts). A line shows as written (less value
// shapes) only when it is plain code: no quote, `#` or backslash on it, and
// the scan is in code at its start. Every other line is blanked to its
// indent (Python's blocks are its indentation, so the indent is all the
// structure a unit needs).
//
// Python's literals: strings in single or double quotes, alone or tripled,
// with a prefix (r, b, u, f, t and pairs; any prefix but r, b and u is read
// as one with `{}` fields, like an f-string or 3.14's template strings); comments from `#`
// to the line's end. Only a triple-quoted string spans lines (or any string,
// after a backslash at a line's end), so the scan tracks one state: in code,
// or in a triple-quoted string it opened at a place it can prove. Wherever
// it cannot be sure (an f-string or t-string with a `{`, which may hold quotes or run on;
// a string that reaches its line's end; a triple quote it cannot pair; a
// backslash at a line's end; a backslash in a triple-quoted string; a lone
// CR or other line break the split does not see), it blanks every line from
// there to the end of the file.

const TRIPLE = /'''|"""/

/** A string prefix: up to two letters right before a quote. */
const PREFIX = /[A-Za-z]{1,2}$/

/**
 * Prefixes whose strings hold no fields: r, b, u and their pairs. Any other
 * (f, t for 3.14's template strings, or one a later Python adds) is read as
 * one whose `{}` fields may hold anything.
 */
const isPlainPrefix = (prefix: string) => /^[rRbBuU]{0,2}$/.test(prefix)

/**
 * Where a line's code state ends: `code` when every string it opens closes
 * on it (and it is not continued), `dead` when that cannot be shown. The
 * line holds no triple quote (the caller handles those). A `#` outside a
 * string ends the line as a comment.
 */
function singleQuotedLine(line: string): 'code' | 'dead' {
  let i = 0
  while (i < line.length) {
    const c = line[i]!
    if (c === '#') return 'code'
    if (c === '\\') return 'dead'
    if (c !== '"' && c !== "'") {
      i += 1
      continue
    }
    const prefix = PREFIX.exec(line.slice(Math.max(0, i - 2), i))?.[0] ?? ''
    // A prefix only counts when it stands alone, not as the end of a longer name (`self` before a quote is not one).
    const isPrefix = prefix !== '' && !/[\w]/.test(line[i - prefix.length - 1] ?? '')
    const isFormat = isPrefix && !isPlainPrefix(prefix)
    let j = i + 1
    while (j < line.length && line[j] !== c) {
      if (line[j] === '\\') {
        j += 2
        continue
      }
      // A replacement field may hold quotes or run past the line (PEP 701): not provable.
      if (isFormat && line[j] === '{') return 'dead'
      j += 1
    }
    if (j >= line.length) return 'dead'
    i = j + 1
  }
  return 'code'
}

/** A line with no quote, `#` or backslash: nothing on it can be inside a literal or a comment. */
export function isPlainPythonLine(line: string): boolean {
  return !/['"#\\`]/.test(line)
}

/** Which lines show as written, by a scan that only trusts what it can prove (see above). */
export function shownPythonLines(lines: readonly string[]): boolean[] {
  const shown: boolean[] = []
  let state: 'code' | 'string' | 'dead' = 'code'
  let closer = ''
  for (const line of lines) {
    if (state === 'dead' || /[\r\u2028\u2029\u000b\u000c\u001c\u001d\u001e\u0085]/.test(line)) {
      state = 'dead'
      shown.push(false)
      continue
    }
    if (state === 'string') {
      // A backslash could escape a quote of the closer: not provable.
      if (line.includes('\\')) state = 'dead'
      else {
        const end = line.indexOf(closer)
        // After the string, only neutral text keeps the scan sure.
        if (end >= 0) state = /['"#\\]/.test(line.slice(end + 3)) ? 'dead' : 'code'
      }
      shown.push(false)
      continue
    }
    // A `#` before any quote or backslash is surely a comment: the rest of the line is.
    const first = line.search(/['"#\\]/)
    if (first >= 0 && line[first] === '#') {
      shown.push(false)
      continue
    }
    const triple = TRIPLE.exec(line)
    if (triple) {
      // Sure only as the line's first quote, after neutral text, with a prefix that is not f
      // (an f-string's fields may hold anything), and with no backslash in it.
      const at = triple.index
      const before = line.slice(0, at)
      const prefix = PREFIX.exec(before)?.[0] ?? ''
      const isPrefix = prefix !== '' && !/\w/.test(before[before.length - prefix.length - 1] ?? '')
      const isSure = !/['"#\\]/.test(before) && !(isPrefix && !isPlainPrefix(prefix)) && !line.includes('\\')
      if (!isSure) state = 'dead'
      else {
        closer = triple[0]
        const end = line.indexOf(closer, at + 3)
        if (end < 0) state = 'string'
        else if (/['"#\\]/.test(line.slice(end + 3))) state = 'dead'
      }
      shown.push(false)
      continue
    }
    if (/\\\s*$/.test(line)) {
      state = 'dead'
      shown.push(false)
      continue
    }
    if (/['"]/.test(line)) {
      state = singleQuotedLine(line)
      shown.push(false)
      continue
    }
    shown.push(isPlainPythonLine(line))
  }
  return shown
}

/** SPEC 8.3: Python ready for a prompt and the pane. `off` sends it as written, less control characters. */
export function filterPython(source: string, mode: PrivacyMode): string {
  const clean = source.replace(/\r(?=\n)/g, '')
  if (mode === 'off') return clean.split('\n').map(l => l.replace(CONTROL, '')).join('\n')
  const lines = clean.split('\n')
  const blank = (l: string) => `${/^[ \t]*/.exec(l)![0].slice(0, PUZZLE.maxLineChars)}${BLANK}`
  if (lines.some(l => l.length > PUZZLE.maxLineChars)) return lines.map(blank).join('\n')
  const shown = shownPythonLines(lines)
  return lines.map((l, i) => (shown[i] && !new RegExp(CONTROL.source).test(l) ? filterValues(l).text : blank(l))).join('\n')
}
