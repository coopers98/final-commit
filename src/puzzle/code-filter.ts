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

/** SPEC 8.3: code ready for a prompt and the pane. `off` sends it as written, as for epic text, less control characters. */
export function filterCode(source: string, mode: PrivacyMode): string {
  // A CR before LF goes; a lone CR is a control character below. Either way the line count holds.
  const clean = source.replace(/\r(?=\n)/g, '')
  if (mode === 'off') return clean.split('\n').map(l => l.replace(CONTROL, '')).join('\n')
  const { text, uncertain } = scanLiterals(clean)
  // Line by line, so no value shape can swallow a line break.
  return text
    .split('\n')
    .map((l, i) => (uncertain.has(i) ? `${l.slice(0, l.length - l.trimStart().length)}${BLANK}` : filterValues(l.replace(CONTROL, '')).text))
    .join('\n')
}
