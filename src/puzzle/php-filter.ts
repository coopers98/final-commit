import { PUZZLE } from '../config'
import { BLANK, CONTROL } from './code-filter'
import { filterValues, type PrivacyMode } from './privacy-filter'

// SPEC 5.3 and 8.3 rule 1, for PHP: the same proof-based design as the
// TypeScript and Python filters. A line shows as written (less value shapes)
// only when it is plain code: the scan is in code at its start, and it holds
// no quote, backtick, `#`, `//`, `/*`, `*/`, `<<<` or PHP tag. Every other line
// is blanked to its indent, followed by the braces the scan proved to be code
// (PHP's blocks are its braces, so they are all the structure a unit needs).
//
// PHP's literals: strings in single quotes (escapes `\\` and `\'` only) and in
// double quotes or backticks (with `$name` and `{$...}` or `${...}`
// interpolation, whose expressions may hold quotes); heredoc and nowdoc
// (`<<<`); comments `//` and `#` to the line's end (`#[` opens an attribute,
// which is code, but a comment after `->` or before PHP 8), and `/* */`. Text outside `<?php ... ?>` is inline HTML.
// The scan tracks one state across lines: in code, or in a block comment.
// Wherever it cannot be sure (a file that does not open with `<?php`, a
// closing tag `?>` anywhere, `__halt_compiler`, a string that reaches its
// line's end, a `{$...}` or `${...}` field holding more than names,
// properties, indexes and calls, a `"$name[...]"` index that is not a
// number, name or variable, a heredoc
// or nowdoc, a lone CR or other line break the split does not see), it
// blanks every line from there to the end of the file.

/** The opening tag: `<?php` then a space or the line's end, any case, after a byte order mark. */
const OPEN_TAG = /^\uFEFF?<\?php(?=[ \t]|$)/i

/** Ends a line's trust: a closing tag (PHP 5's `%>` and `</script>` too; inline HTML may follow), or raw data after `__halt_compiler`. */
const DEAD_ON_LINE = /\?>|%>|<\/script|__halt_compiler/i

/** Line breaks or separators the `\n` split does not see. */
const ODD_BREAK = /[\r\u2028\u2029\u000b\u000c\u001c\u001d\u001e\u0085]/

/**
 * An interpolated expression the scan can step over: names, properties,
 * indexes and calls, with no quote, brace, comment, tag or heredoc possible.
 */
const SIMPLE_FIELD = /^[\w$\-> [\]().,:]*$/

/** In a double-quoted string or backtick, a variable and its index's `[` (PHP's names take any byte from 0x80). */
const SIMPLE_INDEX_OPEN = /^\$[A-Za-z_\u0080-\uFFFF][\w\u0080-\uFFFF]*\[/

/** An index the scan can step over: a number, a name or a variable, then `]`. */
const SIMPLE_INDEX = /^(?:-?\d+|[A-Za-z_\u0080-\uFFFF][\w\u0080-\uFFFF]*|\$[A-Za-z_\u0080-\uFFFF][\w\u0080-\uFFFF]*)\]/

type State = 'code' | 'comment' | 'dead'

/**
 * Scans one line from `state` (code or comment): the state at its end, and
 * the braces met in code, in order. Strings must close on the line.
 */
function scanLine(line: string, state: 'code' | 'comment'): { state: State; braces: string } {
  let braces = ''
  let i = 0
  if (state === 'comment') {
    const end = line.indexOf('*/')
    if (end < 0) return { state: 'comment', braces }
    i = end + 2
  }
  while (i < line.length) {
    const c = line[i]!
    if (c === '{' || c === '}') {
      braces += c
      i += 1
      continue
    }
    if (c === '/' && line[i + 1] === '/') return { state: 'code', braces }
    // `#[` opens an attribute, except where PHP reads it as a comment (after `->`, or before PHP 8).
    // Only an end in code agrees with both readings; its braces may be comment, so none are kept.
    if (c === '#' && line[i + 1] === '[') return { state: scanLine(line.slice(i + 2), 'code').state === 'code' ? 'code' : 'dead', braces }
    if (c === '#') return { state: 'code', braces }
    if (c === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2)
      if (end < 0) return { state: 'comment', braces }
      i = end + 2
      continue
    }
    if (line.startsWith('<<<', i)) return { state: 'dead', braces }
    if (c === "'" || c === '"' || c === '`') {
      const interpolates = c !== "'"
      let j = i + 1
      while (j < line.length && line[j] !== c) {
        // An interpolated expression is code, and may hold strings: followed only when it surely holds none.
        // As PHP reads it, a backslash's next character is never one (`\{$` is a literal `\{`, then a variable).
        const at = interpolates && (line.startsWith('{$', j) || line.startsWith('${', j)) ? j : undefined
        if (at !== undefined) {
          const end = line.indexOf('}', at + 2)
          if (end < 0 || !SIMPLE_FIELD.test(line.slice(at + 2, end))) return { state: 'dead', braces }
          j = end + 1
          continue
        }
        // `$name[` opens an index in which a quote does not end the string: stepped over only when it is a
        // number, a name or a variable and its `]`.
        const index = interpolates ? SIMPLE_INDEX_OPEN.exec(line.slice(j)) : null
        if (index) {
          const step = SIMPLE_INDEX.exec(line.slice(j + index[0].length))
          if (!step) return { state: 'dead', braces }
          j += index[0].length + step[0].length
          continue
        }
        j += line[j] === '\\' ? 2 : 1
      }
      if (j >= line.length) return { state: 'dead', braces }
      i = j + 1
      continue
    }
    i += 1
  }
  return { state: 'code', braces }
}

/** A line with nothing on it that could open, be or close a literal, a comment or a tag. */
export function isPlainPhpLine(line: string): boolean {
  return !/['"`#]|\/\/|\/\*|\*\/|<<<|<\?|\?>|%>|<\/script/i.test(line) && !DEAD_ON_LINE.test(line)
}

/** Per line: whether it shows as written, and the code braces a blanked one keeps. */
export function shownPhpLines(lines: readonly string[]): { shown: boolean; braces: string }[] {
  const out: { shown: boolean; braces: string }[] = []
  // Only a file that opens in PHP is code at all; anything before the tag is inline HTML.
  let state: State = lines.length > 0 && OPEN_TAG.test(lines[0]!) ? 'code' : 'dead'
  for (const [k, line] of lines.entries()) {
    if (state === 'dead' || ODD_BREAK.test(line) || DEAD_ON_LINE.test(line)) {
      state = 'dead'
      out.push({ shown: false, braces: '' })
      continue
    }
    const from = state
    const rest = k === 0 ? line.replace(OPEN_TAG, '') : line
    const scan = scanLine(rest, from)
    state = scan.state
    const isShown = k > 0 && from === 'code' && scan.state === 'code' && isPlainPhpLine(line)
    // A line left dead keeps no braces: what the scan read on it may be wrong.
    out.push({ shown: isShown, braces: scan.state === 'dead' ? '' : scan.braces })
  }
  return out
}

/** SPEC 8.3: PHP ready for a prompt and the pane. `off` sends it as written, less control characters. */
export function filterPhp(source: string, mode: PrivacyMode): string {
  const clean = source.replace(/\r(?=\n)/g, '')
  if (mode === 'off') return clean.split('\n').map(l => l.replace(CONTROL, '')).join('\n')
  const lines = clean.split('\n')
  const blank = (l: string, braces = '') => `${/^[ \t]*/.exec(l)![0].slice(0, PUZZLE.maxLineChars)}${BLANK}${braces === '' ? '' : ` ${braces}`}`
  if (lines.some(l => l.length > PUZZLE.maxLineChars)) return lines.map(l => blank(l)).join('\n')
  const shown = shownPhpLines(lines)
  return lines.map((l, i) => (shown[i]!.shown && !new RegExp(CONTROL.source).test(l) ? filterValues(l).text : blank(l, shown[i]!.braces))).join('\n')
}
