import { filterValues, type PrivacyMode } from './privacy-filter'

// SPEC 5.3 and 8.3 rule 1: code reaches a prompt (and the puzzle pane) only
// through this filter. It follows the C family's grammar (TypeScript and
// JavaScript first): every string and template literal is blanked to `…`
// between its quotes, every comment is removed, then the prose filter's
// value shapes run over what is left. Line count is kept, so line numbers
// from a diff still point at the same code.
//
// Known limits: a regular expression literal is read as code, so a quote
// inside one can blank the rest of its line; a template literal's `${}`
// expressions are blanked with its text.

export const BLANK = '…'

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
    if (c === '"' || c === "'") {
      // A string ends at its quote, or at the line's end (a regex literal read as code).
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

/** SPEC 8.3: code ready for a prompt. `off` sends it as written, as for epic text. */
export function filterCode(source: string, mode: PrivacyMode): string {
  if (mode === 'off') return source
  // Line by line, so no value shape can swallow a line break.
  return stripLiterals(source).split('\n').map(l => filterValues(l).text).join('\n')
}
