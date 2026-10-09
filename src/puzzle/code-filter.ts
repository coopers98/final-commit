import { PUZZLE } from '../config'
import { filterValues, type PrivacyMode } from './privacy-filter'

// SPEC 5.3 and 8.3 rule 1: code reaches a prompt (and the puzzle pane) only
// through this filter. It follows the C family's grammar (TypeScript and
// JavaScript first): every string, template and regular expression literal
// is blanked to `…` between its delimiters, every comment is removed, then
// the prose filter's value shapes run over what is left. Line count is kept,
// so line numbers from a diff still point at the same code.
//
// It fails closed. Where the scanner cannot be sure what it reads (whether a
// `/` opens a regular expression after `)`, `}`, `!`, `+` or `-`, or at a
// line's start; a literal cut off by the line's end; a template with `${}`
// inside; a backslash before a line break), it marks the line uncertain, and
// that line is blanked whole. A wrong guess changes only its own line, or
// swallows code into a literal, so a misread can hide code but never show a
// literal's contents.

export const BLANK = '…'

/** Characters after which a `/` surely starts a regular expression. */
const REGEX_AFTER = new Set(['(', ',', '=', ':', '[', '&', '|', '?', '{', ';', '*', '%', '<', '~', '^'])
/** Characters after which it may start one or be a division. */
const UNSURE_AFTER = new Set([')', '}', '!', '+', '-'])
const REGEX_AFTER_WORD = /(?:^|[^\w$])(?:return|typeof|instanceof|case|do|else|in|of|new|delete|void|throw|yield|await|default|extends)$/

/** Whether a `/` here opens a regular expression, and whether that is sure. */
function slashOpensRegex(current: string): { isRegex: boolean; isSure: boolean } {
  const line = current.trimEnd()
  // At a line's start it may continue a division from the line before.
  if (line === '') return { isRegex: true, isSure: false }
  const last = line[line.length - 1]!
  if (REGEX_AFTER.has(last)) return { isRegex: true, isSure: true }
  // `=>` surely precedes an expression; a bare `>` may close a type's arguments (`Array<number> / 2`).
  if (last === '>') return { isRegex: true, isSure: line.endsWith('=>') }
  if (UNSURE_AFTER.has(last)) return { isRegex: true, isSure: false }
  // A keyword before it may be a name (`let of = 4; of / 2`) or a property (`x.of / 2`): unsure.
  if (/[\w$]/.test(last)) return REGEX_AFTER_WORD.test(line.slice(-16)) ? { isRegex: true, isSure: false } : { isRegex: false, isSure: true }
  if (last === ']') return { isRegex: false, isSure: true }
  return { isRegex: true, isSure: false }
}

/** `source` with literals blanked and comments removed, line for line, and the 0-based lines the scanner is unsure of. */
export function scanLiterals(source: string): { text: string; uncertain: Set<number>; unterminated: Set<number> } {
  // The current line apart from the lines done: a look back at it never copies the whole output.
  const done: string[] = []
  let out = ''
  let line = 0
  const uncertain = new Set<number>()
  const unterminated = new Set<number>()
  const unsure = () => void uncertain.add(line)
  const newline = () => {
    done.push(out)
    out = ''
    line += 1
  }
  let i = 0
  const n = source.length
  // A hashbang (after a byte order mark too) is a comment to the first line break of any kind.
  if (/^\uFEFF?#!/.test(source)) while (i < n && !'\n\r\u2028\u2029'.includes(source[i]!)) i += 1
  while (i < n) {
    const c = source[i]!
    const next = source[i + 1]
    if (c === '\n') {
      newline()
      i += 1
      continue
    }
    if (c === '/' && next === '/') {
      // A line comment ends at any line break: CR, LS and PS too.
      while (i < n && !'\n\r\u2028\u2029'.includes(source[i]!)) i += 1
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') newline()
        i += 1
      }
      if (i >= n) unsure()
      i += 2
      continue
    }
    if (c === '/') {
      const { isRegex, isSure } = slashOpensRegex(out)
      if (!isSure) unsure()
      if (!isRegex) {
        out += c
        i += 1
        continue
      }
      // To the closing slash outside a character class; flags follow. A regex never spans lines.
      i += 1
      let inClass = false
      while (i < n && source[i] !== '\n' && (inClass || source[i] !== '/')) {
        if (source[i] === '\\') {
          if (source[i + 1] === '\n') break
          i += 1
        } else if (source[i] === '[') inClass = true
        else if (source[i] === ']') inClass = false
        i += 1
      }
      out += `/${BLANK}/`
      if (source[i] === '/') {
        i += 1
        while (i < n && /[a-z]/.test(source[i]!)) i += 1
      } else unsure()
      continue
    }
    if (c === '"' || c === "'") {
      i += 1
      while (i < n && source[i] !== c && source[i] !== '\n') {
        if (source[i] === '\\') {
          // A backslash before a break carries the string onto the next line.
          if (source[i + 1] === '\n') {
            unsure()
            newline()
            unsure()
          }
          i += 2
          continue
        }
        i += 1
      }
      out += `${c}${BLANK}${c}`
      if (source[i] === c) i += 1
      else {
        unsure()
        unterminated.add(line)
      }
      continue
    }
    if (c === '`') {
      // Every line it spans is uncertain once it holds `${}`: braces in strings inside can end it early.
      const from = line
      let hasExpr = false
      let breaks = 0
      let depth = 0
      i += 1
      while (i < n) {
        const d = source[i]!
        if (d === '\\') {
          if (source[i + 1] === '\n') breaks += 1
          i += 2
          continue
        }
        if (d === '\n') breaks += 1
        if (depth === 0 && d === '`') break
        if (d === '$' && source[i + 1] === '{') {
          hasExpr = true
          depth += 1
          i += 2
          continue
        }
        if (depth > 0 && d === '{') depth += 1
        if (depth > 0 && d === '}') depth -= 1
        i += 1
      }
      const isClosed = i < n
      i += 1
      out += `\`${BLANK}\``
      for (let k = 0; k < breaks; k += 1) newline()
      if (hasExpr || !isClosed) for (let k = from; k <= line; k += 1) uncertain.add(k)
      continue
    }
    out += c
    i += 1
  }
  done.push(out)
  // Comments leave trailing spaces behind.
  return { text: done.map(l => l.trimEnd()).join('\n'), uncertain, unterminated }
}

/** `source` with literals blanked and comments removed, line for line. */
export function stripLiterals(source: string): string {
  return scanLiterals(source).text
}

/** Control characters (escape sequences among them) a terminal would act on. Tab is kept. */
// eslint-disable-next-line no-control-regex
export const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

/** Words after which a `/` may open a regular expression: a line with one is never shown. */
const WORDS_BEFORE_REGEX = new Set((
  'return typeof instanceof case do else in of new delete void throw yield await default extends as from get set ' +
  'async let static satisfies keyof infer is asserts import export const var function class if while for switch'
).split(' '))

/**
 * Whether every `/` on `line` is surely a division: right after a word
 * that is not a keyword, a number or `]`, and not part of `//`, `/*` or `*` + `/`.
 */
function slashesAreDivision(line: string): boolean {
  for (let k = line.indexOf('/'); k >= 0; k = line.indexOf('/', k + 1)) {
    if (line[k + 1] === '/' || line[k + 1] === '*' || line[k - 1] === '*' || line[k - 1] === '/') return false
    // Back over spaces, then over a word: a loop, as a regex here backtracks on long lines.
    let j = k - 1
    while (j >= 0 && (line[j] === ' ' || line[j] === '\t')) j -= 1
    let w = j
    while (w >= 0 && /[\w$]/.test(line[w]!)) w -= 1
    if (w < j) {
      if (WORDS_BEFORE_REGEX.has(line.slice(w + 1, j + 1))) return false
      continue
    }
    if (line[j] !== ']') return false
  }
  return true
}

/**
 * A line that can show as written: no quote, backtick or backslash (so no
 * string, template or escape on it), no HTML-like comment, every slash a
 * division (so no regular expression or comment), no line separator.
 */
export function isPlainLine(line: string): boolean {
  return !/['"`\\\u2028\u2029]/.test(line) && !line.includes('<!--') && !line.includes('-->') && slashesAreDivision(line)
}

/**
 * The line states, by a scan that only ever trusts what it can prove:
 * `shown` lines are plain code outside any comment or literal; everything
 * else is blanked. Once the scan cannot be sure where it is (a template
 * that spans lines, or one with `${}` beside a quote or slash; an odd
 * backtick; a backslash at a line's end; code after a comment's end), every
 * line from there on is blanked.
 */
export function shownLines(lines: readonly string[], unterminated: ReadonlySet<number> = new Set()): boolean[] {
  return lineStates(lines, unterminated).shown
}

/**
 * `shownLines`, and which lines the scan was in code for from start to end
 * (`trusted`): only those keep their braces when blanked, as a line after
 * the scan went dead or inside a comment may hold a literal's braces.
 */
export function lineStates(lines: readonly string[], unterminated: ReadonlySet<number> = new Set(), uncertain: ReadonlySet<number> = new Set()): { shown: boolean[]; trusted: boolean[] } {
  const shown: boolean[] = []
  const trusted: boolean[] = []
  let state: 'code' | 'comment' | 'dead' = 'code'
  for (const [index, line] of lines.entries()) {
    const was = state
    const push = (isShown: boolean) => {
      shown.push(isShown)
      // An HTML-like comment's braces are a comment's: the literal scanner does not know them.
      trusted.push(was === 'code' && state === 'code' && !line.includes('<!--') && !line.includes('-->'))
    }
    // A string the literal scanner saw run to the line's end (it may go on), or a quote on a line
    // the scanner guessed at (a guessed regex can hide one): the scan cannot be sure from here.
    if (state === 'code' && (unterminated.has(index) || (uncertain.has(index) && /['"`]/.test(line)))) state = 'dead'
    // A hashbang (after a byte order mark too) is a comment, to the first line break of any kind.
    if (index === 0 && /^\uFEFF?#!/.test(line)) {
      if (/[\r\u2028\u2029]/.test(line)) state = 'dead'
      push(false)
      continue
    }
    if (state === 'dead') {
      push(false)
      continue
    }
    if (state === 'comment') {
      const end = line.indexOf('*/')
      if (end >= 0) state = /['"`\\/]|<!--|-->/.test(line.slice(end + 2)) ? 'dead' : 'code'
      push(false)
      continue
    }
    // A lone CR, LS or PS is a line break to JavaScript that this scan, splitting at LF, would not see.
    if (/\\\s*$/.test(line) || /[\r\u2028\u2029]/.test(line)) {
      state = 'dead'
      push(false)
      continue
    }
    // `//` and `/*` always open a comment where the scan is in code, so one is sure when nothing
    // before it on the line (a quote, backtick, backslash or slash) could have left code.
    const neutral = (text: string) => !/['"`\\/]|<!--|-->/.test(text)
    const slash = line.indexOf('/')
    if (slash >= 0 && line[slash + 1] === '/' && neutral(line.slice(0, slash))) {
      push(false)
      continue
    }
    const open = line.indexOf('/*')
    if (open >= 0 && open === slash && neutral(line.slice(0, open))) {
      const close = line.indexOf('*/', open + 2)
      // After a comment that ends on its line, only neutral text keeps the scan sure.
      if (close < 0) state = 'comment'
      else if (!neutral(line.slice(close + 2))) state = 'dead'
      push(false)
      continue
    }
    // A backtick is trusted only on a line with no other quote, slash or backslash to hide it:
    // one inside a string, regex or comment would pair with a real one.
    const ticks = [...line].filter(c => c === '`').length
    if (open >= 0 || (ticks > 0 && (ticks !== 2 || /['"\/\\]/.test(line) || !isClosedTemplate(line)))) {
      state = 'dead'
      push(false)
      continue
    }
    push(state === 'code' && ticks === 0 && isPlainLine(line))
  }
  return { shown, trusted }
}

/** A line's two backticks surely open and close one template: no `${}` beside a quote or slash, and every `${` closed before the second. */
function isClosedTemplate(line: string): boolean {
  const a = line.indexOf('`')
  const b = line.indexOf('`', a + 1)
  const inside = line.slice(a + 1, b)
  if (!inside.includes('${')) return true
  if (/['"\/\\]/.test(line)) return false
  let depth = 0
  for (let k = 0; k < inside.length; k += 1) {
    if (inside[k] === '$' && inside[k + 1] === '{') {
      depth += 1
      k += 1
    } else if (depth > 0 && inside[k] === '{') depth += 1
    else if (depth > 0 && inside[k] === '}') depth -= 1
  }
  return depth === 0
}

/** A blanked line: its indent, `…`, and its braces in order (from the scanner's reading), so blocks still match. */
function blankLine(original: string, scanned: string): string {
  // Spaces and tabs only: other whitespace (vertical tab, form feed, line separators) is not passed on.
  const indent = /^[ \t]*/.exec(original)![0]
  const braces = scanned.replace(/[^{}]/g, '')
  const lead = /^}*/.exec(braces)![0]
  return `${indent}${lead}${BLANK}${braces.slice(lead.length)}`
}

/**
 * SPEC 8.3: code ready for a prompt and the pane. A line shows as written
 * (less value shapes) only when it is plain code outside any literal or
 * comment (`shownLines`); every other line is blanked to its braces. `off`
 * sends it as written, as for epic text, less control characters.
 */
export function filterCode(source: string, mode: PrivacyMode): string {
  // A CR before LF goes; a lone CR is a control character below. Either way the line count holds.
  const clean = source.replace(/\r(?=\n)/g, '')
  if (mode === 'off') return clean.split('\n').map(l => l.replace(CONTROL, '')).join('\n')
  const lines = clean.split('\n')
  // Minified code: every line blank, and no scan of it (the scan's cost grows with line length).
  if (lines.some(l => l.length > PUZZLE.maxLineChars)) return lines.map(l => `${/^[ \t]*/.exec(l)![0].slice(0, PUZZLE.maxLineChars)}${BLANK}`).join('\n')
  const { text, uncertain, unterminated } = scanLiterals(clean)
  const scanned = text.split('\n')
  const { shown, trusted } = lineStates(lines, unterminated, uncertain)
  return lines
    // Braces only from a line both scans were sure of: otherwise they could be a literal's.
    .map((l, i) => (shown[i] && !new RegExp(CONTROL.source).test(l) ? filterValues(l).text : blankLine(l, trusted[i] && !uncertain.has(i) ? (scanned[i] ?? '') : '')))
    .join('\n')
}
