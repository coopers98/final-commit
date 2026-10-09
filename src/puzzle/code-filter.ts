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
const REGEX_AFTER = new Set(['(', ',', '=', ':', '[', '&', '|', '?', '{', ';', '*', '%', '<', '>', '~', '^'])
/** Characters after which it may start one or be a division. */
const UNSURE_AFTER = new Set([')', '}', '!', '+', '-'])
const REGEX_AFTER_WORD = /(?:^|[^\w$])(?:return|typeof|instanceof|case|do|else|in|of|new|delete|void|throw|yield|await)$/

/** Whether a `/` here opens a regular expression, and whether that is sure. */
function slashOpensRegex(out: string): { isRegex: boolean; isSure: boolean } {
  const line = out.slice(out.lastIndexOf('\n') + 1).trimEnd()
  // At a line's start it may continue a division from the line before.
  if (line === '') return { isRegex: true, isSure: false }
  const last = line[line.length - 1]!
  if (REGEX_AFTER.has(last)) return { isRegex: true, isSure: true }
  if (UNSURE_AFTER.has(last)) return { isRegex: true, isSure: false }
  if (/[\w$]/.test(last)) return { isRegex: REGEX_AFTER_WORD.test(line), isSure: true }
  if (last === ']') return { isRegex: false, isSure: true }
  return { isRegex: true, isSure: false }
}

/** `source` with literals blanked and comments removed, line for line, and the 0-based lines the scanner is unsure of. */
export function scanLiterals(source: string): { text: string; uncertain: Set<number> } {
  let out = ''
  let line = 0
  const uncertain = new Set<number>()
  const unsure = () => void uncertain.add(line)
  const newline = () => {
    out += '\n'
    line += 1
  }
  let i = 0
  const n = source.length
  while (i < n) {
    const c = source[i]!
    const next = source[i + 1]
    if (c === '\n') {
      newline()
      i += 1
      continue
    }
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1
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
      else unsure()
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
  // Comments leave trailing spaces behind.
  return { text: out.split('\n').map(l => l.trimEnd()).join('\n'), uncertain }
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
    const before = line.slice(0, k).trimEnd()
    const word = /[\w$]+$/.exec(before)?.[0]
    if (word !== undefined) {
      if (WORDS_BEFORE_REGEX.has(word)) return false
      continue
    }
    if (!before.endsWith(']')) return false
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
export function shownLines(lines: readonly string[]): boolean[] {
  const shown: boolean[] = []
  let state: 'code' | 'comment' | 'dead' = 'code'
  for (const [index, line] of lines.entries()) {
    // A hashbang is a comment.
    if (index === 0 && line.startsWith('#!')) {
      shown.push(false)
      continue
    }
    if (state === 'dead') {
      shown.push(false)
      continue
    }
    if (state === 'comment') {
      const end = line.indexOf('*/')
      if (end >= 0) state = /['"`\\/]/.test(line.slice(end + 2)) ? 'dead' : 'code'
      shown.push(false)
      continue
    }
    if (/\\\s*$/.test(line) || /[\u2028\u2029]/.test(line)) {
      state = 'dead'
      shown.push(false)
      continue
    }
    // `//` and `/*` always open a comment where the scan is in code, so one is sure when nothing
    // before it on the line (a quote, backtick, backslash or slash) could have left code.
    const neutral = (text: string) => !/['"`\\/]/.test(text)
    const slash = line.indexOf('/')
    if (slash >= 0 && line[slash + 1] === '/' && neutral(line.slice(0, slash))) {
      shown.push(false)
      continue
    }
    const open = line.indexOf('/*')
    if (open >= 0 && open === slash && neutral(line.slice(0, open))) {
      const close = line.indexOf('*/', open + 2)
      // After a comment that ends on its line, only neutral text keeps the scan sure.
      if (close < 0) state = 'comment'
      else if (!neutral(line.slice(close + 2))) state = 'dead'
      shown.push(false)
      continue
    }
    // A backtick is trusted only on a line with no other quote, slash or backslash to hide it:
    // one inside a string, regex or comment would pair with a real one.
    const ticks = [...line].filter(c => c === '`').length
    if (open >= 0 || (ticks > 0 && (ticks !== 2 || /['"\/\\]/.test(line) || !isClosedTemplate(line)))) {
      state = 'dead'
      shown.push(false)
      continue
    }
    shown.push(state === 'code' && ticks === 0 && isPlainLine(line))
  }
  return shown
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
  const scanned = scanLiterals(clean).text.split('\n')
  const shown = shownLines(lines)
  return lines
    .map((l, i) => (shown[i] && !new RegExp(CONTROL.source).test(l) ? filterValues(l).text : blankLine(l, scanned[i] ?? '')))
    .join('\n')
}
