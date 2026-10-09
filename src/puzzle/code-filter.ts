import { filterValues, type PrivacyMode } from './privacy-filter'

// SPEC 5.3 and 8.3 rule 1: code reaches a prompt (and the puzzle pane) only
// through this filter. It follows the C family's grammar (TypeScript and
// JavaScript first): every string, template and regular expression literal
// is blanked to `…` between its delimiters, every comment is removed, then
// the prose filter's value shapes run over what is left. Line count is kept,
// so line numbers from a diff still point at the same code.
//
// It fails closed: a line where a quote is left over once the literals are
// blanked (a literal the scanner misread) is blanked whole, so a misread can
// hide code but never show a literal's contents. A template literal's `${}`
// expressions are blanked with its text.

export const BLANK = '…'

/** Characters after which a `/` starts a regular expression, not a division. */
const REGEX_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^'])
const REGEX_AFTER_WORD = /(?:^|[^\w$])(?:return|typeof|instanceof|case|do|else|in|of|new|delete|void|throw|yield|await)$/

/** Whether a `/` at this point of `out` opens a regular expression literal. */
function opensRegex(out: string): boolean {
  const line = out.slice(out.lastIndexOf('\n') + 1).trimEnd()
  if (line === '') return true
  return REGEX_AFTER.has(line[line.length - 1]!) || REGEX_AFTER_WORD.test(line)
}

/** `source` with literals blanked and comments removed, line for line. */
export function stripLiterals(source: string): string {
  let out = ''
  let i = 0
  const n = source.length
  while (i < n) {
    const c = source[i]!
    const next = source[i + 1]
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n'
        i += 1
      }
      i += 2
      continue
    }
    if (c === '/' && opensRegex(out)) {
      // To the closing slash outside a character class; flags follow. A regex never spans lines.
      i += 1
      let inClass = false
      while (i < n && source[i] !== '\n' && (inClass || source[i] !== '/')) {
        if (source[i] === '\\') i += 1
        else if (source[i] === '[') inClass = true
        else if (source[i] === ']') inClass = false
        i += 1
      }
      out += `/${BLANK}/`
      if (source[i] === '/') {
        i += 1
        while (i < n && /[a-z]/.test(source[i]!)) i += 1
      }
      continue
    }
    if (c === '"' || c === "'") {
      i += 1
      while (i < n && source[i] !== c && source[i] !== '\n') i += source[i] === '\\' ? 2 : 1
      out += `${c}${BLANK}${c}`
      if (source[i] === c) i += 1
      continue
    }
    if (c === '`') {
      i += 1
      let lines = 0
      let depth = 0
      while (i < n) {
        const d = source[i]!
        if (d === '\\') {
          i += 2
          continue
        }
        if (d === '\n') lines += 1
        if (depth === 0 && d === '`') break
        if (d === '$' && source[i + 1] === '{') {
          depth += 1
          i += 2
          continue
        }
        if (depth > 0 && d === '{') depth += 1
        if (depth > 0 && d === '}') depth -= 1
        i += 1
      }
      i += 1
      out += `\`${BLANK}\`${'\n'.repeat(lines)}`
      continue
    }
    out += c
    i += 1
  }
  // Comments leave trailing spaces behind.
  return out.split('\n').map(l => l.trimEnd()).join('\n')
}

/** A line with a quote left over once its blanked literals are set aside: something was misread. */
export function hasStrayQuote(line: string): boolean {
  return /["'`]/.test(line.replace(new RegExp(`(["'\`])${BLANK}\\1`, 'g'), ''))
}

/** Control characters (escape sequences among them) a terminal would act on. Tab is kept. */
// eslint-disable-next-line no-control-regex
export const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

/** SPEC 8.3: code ready for a prompt and the pane. `off` sends it as written, as for epic text, less control characters. */
export function filterCode(source: string, mode: PrivacyMode): string {
  // A CR before LF goes; a lone CR is a control character below. Either way the line count holds.
  const clean = source.replace(/\r(?=\n)/g, '')
  if (mode === 'off') return clean.split('\n').map(l => l.replace(CONTROL, '')).join('\n')
  // Line by line, so no value shape can swallow a line break.
  return stripLiterals(clean)
    .split('\n')
    .map(l => {
      if (hasStrayQuote(l)) return `${l.slice(0, l.length - l.trimStart().length)}${BLANK}`
      return filterValues(l.replace(CONTROL, '')).text
    })
    .join('\n')
}
