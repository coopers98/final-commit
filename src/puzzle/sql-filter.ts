import { PUZZLE } from '../config'
import { BLANK, CONTROL } from './code-filter'
import { filterValues, type PrivacyMode } from './privacy-filter'

// SPEC 5.3 and 8.3 rule 1, for SQL: the same proof-based design as the other
// code filters. A `.sql` file names no dialect, so the scan must agree with
// every major reading (SQLite, PostgreSQL, MySQL and MariaDB, SQL Server,
// Oracle, and the shapes Snowflake and BigQuery add); wherever two of them
// could disagree on whether a character is in a literal or a comment, it
// blanks every line from there to the end of the file.
//
// A line shows as written (less value shapes) only when the scan is in code
// at its start and end and it opened no string, comment or dollar quote.
// Every other line is blanked to its indent, followed by the `;` the scan
// proved to be code, so statements still end where they should.
//
// The literals and comments, and where readings part:
// - `'...'` and `"..."` (a string in MySQL, an identifier elsewhere) must
//   close on their line, with no backslash (MySQL, BigQuery and PostgreSQL's
//   `E'...'` escape with it); `'''` and `"""` (BigQuery) and Oracle's
//   `q'...'` are never followed.
// - `` `...` `` and `[...]` (identifiers in MySQL, SQLite and SQL Server; a
//   PostgreSQL subscript is code) must close on their line holding nothing
//   that opens a literal or comment, so every reading agrees.
// - `--` then a space or the line's end is a comment everywhere; `--` before
//   anything else (MySQL reads minus signs), `#` (a MySQL comment, a
//   PostgreSQL operator, a SQL Server temporary table) and `//` (a Snowflake
//   comment) are read past only when the rest of the line opens nothing.
// - `/* */` is followed across lines with none nested inside (PostgreSQL and
//   SQL Server nest them; MySQL does not); MySQL's `/*!` and `/*+` hold code.
// - PostgreSQL's `$tag$...$tag$` is followed across lines, and read a second
//   time as code (where `$` is a name's letter, as in MySQL): only a body that
//   both readings leave in code at its close is accepted.
// - A backslash in code (a psql meta-command), SQLite's `$name(...)`
//   parameter holding a quote or comment marker, a lone CR or other line
//   break the split does not see: the rest of the file is blanked.

/** Line breaks or separators the `\n` split does not see. */
const ODD_BREAK = /[\r\u2028\u2029\u000b\u000c\u001c\u001d\u001e\u0085]/

/** Anything that could open, be or close a literal or comment in some reading. */
const OPENER = /['"`[\]#$\\]|--|\/\*|\*\/|\/\//

/** A fragment no reading finds a literal or comment in. */
const isPlainFragment = (s: string) => !OPENER.test(s)

/** A letter, digit, `_`, `$` or any character from 0x80: what a name is made of. */
const isNameChar = (c: string | undefined) => c !== undefined && /[\w$\u0080-\uFFFF]/.test(c)

/** PostgreSQL's dollar-quote opener: `$`, an optional tag (a name without `$`), `$`. */
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uFFFF][\w\u0080-\uFFFF]*)?\$/y

/**
 * SQLite's parameter (`$`, `@`, `:` or `#`, name characters and `::`) then
 * `(`: SQLite reads on to a space or `)` with no regard for quotes. A
 * superset of what SQLite matches, so it only ever blanks more. Its spaces
 * are ASCII ones only (`\s` would stop at a no-break space SQLite reads past).
 */
const SQLITE_PARAM = /[$@:#][\w$:\u0080-\uFFFF]*\(([^ \t\n\f\r\v)]*)/g

/**
 * A client command no other reading follows: sqlcmd and SSMS end a batch at a
 * `GO` line (perhaps with a count or a comment after it), and SQL*Plus runs
 * its buffer at a lone `/`, even inside a block comment.
 */
const BATCH_LINE = /^[ \t]*(?:go\b|\/[ \t]*$)/i

/** SQL*Plus's `REM[ARK]` comment and `PRO[MPT]` text lines: never shown. */
const SQLPLUS_TEXT = /^[ \t]*(?:rem(?:a(?:rk?)?)?|pro(?:m(?:pt?)?)?)(?:[ \t]|$)/i

/** SQL*Plus's old `DOC[UMENT]` block, which runs to a `#` line: the rest of the file is blanked. */
const SQLPLUS_DOCUMENT = /^[ \t]*doc(?:u(?:m(?:e(?:nt?)?)?)?)?(?:[ \t]|$)/i

/** Per position, where the run of name characters it is in starts (-1 outside one): one pass a line. */
function nameRuns(line: string): Int32Array {
  const out = new Int32Array(line.length).fill(-1)
  for (let k = 0; k < line.length; k += 1) if (isNameChar(line[k])) out[k] = k > 0 && out[k - 1]! >= 0 ? out[k - 1]! : k
  return out
}

type Code = 'code' | 'comment'
type State = Code | { tag: string; alt: Code } | 'dead'

type Scan = { state: State; semis: number; literal: boolean }

/**
 * Scans `line` from `state`. `dollar` is PostgreSQL's reading, where `$tag$`
 * opens a body; without it `$` is a name's letter. `tail` is set when a line
 * comment runs to the end of what was scanned (it would run on past a cut).
 */
function scan(line: string, from: State, dollar: boolean): Scan & { tail: boolean } {
  let semis = 0
  let literal = false
  const dead = () => ({ state: 'dead' as const, semis, literal: true, tail: false })
  let i = 0
  // Where code resumed after a dollar body closed: a name never runs back past it.
  let codeFrom = 0
  let runs: Int32Array | undefined
  if (from === 'dead') return dead()
  let state: Exclude<State, 'dead'> = from
  for (const m of line.matchAll(SQLITE_PARAM)) if (!isPlainFragment(m[1]!)) return dead()
  for (;;) {
    if (typeof state === 'object') {
      literal = true
      const close = `$${state.tag}$`
      const end = line.indexOf(close, i)
      const body = end < 0 ? line.slice(i) : line.slice(i, end)
      // Snowflake opens a string at `$$`, so a tagged body holds none, counting a `$` of either tag.
      if (state.tag !== '' && line.slice(Math.max(0, i - 1), end < 0 ? line.length : end + 1).includes('$$')) return dead()
      // The other reading: the body as code, which must be code again where the tag closes.
      const alt = scan(body, state.alt, false)
      if (alt.state === 'dead' || typeof alt.state === 'object') return dead()
      if (end < 0) return { state: { tag: state.tag, alt: alt.state }, semis, literal, tail: false }
      if (alt.state !== 'code' || alt.tail) return dead()
      i = end + close.length
      codeFrom = i
      state = 'code'
      continue
    }
    if (state === 'comment') {
      literal = true
      if (i === 0 && BATCH_LINE.test(line)) return dead()
      const end = line.indexOf('*/', i)
      // SQL*Plus may end a statement at a line's last `;` even inside a comment that runs on.
      if (end < 0 && /;[ \t]*$/.test(line)) return dead()
      // PostgreSQL and SQL Server nest comments; MySQL and SQLite do not. Up to the close's `*`, so `/*/` counts.
      if ((end < 0 ? line.slice(i) : line.slice(i, end + 1)).includes('/*')) return dead()
      if (end < 0) return { state: 'comment', semis, literal, tail: false }
      i = end + 2
      state = 'code'
      continue
    }
    if (i >= line.length) return { state: 'code', semis, literal, tail: false }
    const c = line[i]!
    const at = (t: string) => line.startsWith(t, i)
    if (c === ';') {
      semis += 1
      i += 1
      continue
    }
    if (c === '\\' || at('*/')) return dead()
    if (at('--')) {
      // A comment everywhere when a space or the line's end follows; otherwise only where the rest opens nothing.
      const next = line[i + 2]
      // (MySQL reads the rest as code, where more hyphens are minus signs or another comment.)
      if (next !== undefined && next !== ' ' && next !== '\t' && !isPlainFragment(line.slice(i + 2).replace(/-/g, ' '))) return dead()
      return { state: 'code', semis, literal: true, tail: true }
    }
    if (c === '#' || at('//')) {
      // After `//`, from its second `/`: `//*` is a `/` then a comment's opener everywhere else.
      if (!isPlainFragment(line.slice(i + 1))) return dead()
      return { state: 'code', semis, literal: true, tail: true }
    }
    if (at('/*')) {
      // MySQL runs what is in `/*!` (and MariaDB `/*M!`) as code; `/*+` holds optimizer hints.
      if (at('/*!') || at('/*+') || at('/*M!')) return dead()
      literal = true
      i += 2
      state = 'comment'
      continue
    }
    if (c === "'" || c === '"') {
      // BigQuery's triple quotes, and Oracle's `q'` (or `nq'`, after a digit too) whose delimiter lets a quote through.
      if (at(c.repeat(3))) return dead()
      if (c === "'" && /[qQ]/.test(line[i - 1] ?? '')) return dead()
      const end = line.indexOf(c, i + 1)
      if (end < 0 || line.slice(i + 1, end).includes('\\')) return dead()
      literal = true
      i = end + 1
      continue
    }
    if (c === '`' || c === '[') {
      const closer = c === '`' ? '`' : ']'
      const end = line.indexOf(closer, i + 1)
      // A doubled closer is an escape inside the name (SQL Server `]]`, MySQL ``` `` ```).
      if (end < 0 || line[end + 1] === closer || !isPlainFragment(line.slice(i + 1, end))) return dead()
      i = end + 1
      continue
    }
    if (c === '$' && dollar) {
      if (i - 1 >= codeFrom && isNameChar(line[i - 1])) {
        // Part of a name only when the run of name characters before it starts as a name does.
        runs ??= nameRuns(line)
        const r = Math.max(runs[i - 1]!, codeFrom)
        if (!/[A-Za-z_\u0080-\uFFFF]/.test(line[r]!)) return dead()
        i += 1
        continue
      }
      if (/\d/.test(line[i + 1] ?? '')) {
        // A positional parameter.
        i += 1
        while (/\d/.test(line[i] ?? '')) i += 1
        continue
      }
      DOLLAR_TAG.lastIndex = i
      const open = DOLLAR_TAG.exec(line)
      if (open) {
        literal = true
        i += open[0].length
        state = { tag: open[0].slice(1, -1), alt: 'code' }
        continue
      }
    }
    i += 1
  }
}

/** Per line: whether it shows as written, and the code `;` a blanked one keeps. */
export function shownSqlLines(lines: readonly string[]): { shown: boolean; semis: number }[] {
  const out: { shown: boolean; semis: number }[] = []
  let state: State = 'code'
  // A SQL*Plus remark or prompt ending in `-` runs on to the next line.
  let isSqlplusText = false
  for (const [k, line] of lines.entries()) {
    if (state === 'dead' || ODD_BREAK.test(line) || (state === 'code' && SQLPLUS_DOCUMENT.test(line))) {
      state = 'dead'
      out.push({ shown: false, semis: 0 })
      continue
    }
    const from = state
    const s = scan(k === 0 ? line.replace(/^\uFEFF/, '') : line, from, true)
    state = s.state
    const isText: boolean = isSqlplusText || SQLPLUS_TEXT.test(line)
    isSqlplusText = isText && /-[ \t]*$/.test(line)
    const isShown = from === 'code' && s.state === 'code' && !s.literal && !isText && !/['"\\#]|--|\/\*|\*\/|\/\//.test(line)
    out.push({ shown: isShown, semis: s.state === 'dead' ? 0 : s.semis })
  }
  return out
}

/** SPEC 8.3: SQL ready for a prompt and the pane. `off` sends it as written, less control characters. */
export function filterSql(source: string, mode: PrivacyMode): string {
  const clean = source.replace(/\r(?=\n)/g, '')
  if (mode === 'off') return clean.split('\n').map(l => l.replace(CONTROL, '')).join('\n')
  const lines = clean.split('\n')
  const blank = (l: string, semis = 0) => `${/^[ \t]*/.exec(l)![0].slice(0, PUZZLE.maxLineChars)}${BLANK}${semis === 0 ? '' : ` ${';'.repeat(semis)}`}`
  // A file that was not valid UTF-8 may hide a quote in a byte the decoding replaced (a Shift-JIS second byte).
  if (clean.includes('\uFFFD') || lines.some(l => l.length > PUZZLE.maxLineChars)) return lines.map(l => blank(l)).join('\n')
  const shown = shownSqlLines(lines)
  return lines.map((l, i) => (shown[i]!.shown && !new RegExp(CONTROL.source).test(l) ? filterValues(l).text : blank(l, shown[i]!.semis))).join('\n')
}
