import { PUZZLE } from '../config'
import { BLANK, CONTROL } from './code-filter'
import { filterProse, filterValues, type PrivacyMode } from './privacy-filter'

// SPEC 5.3 and 8.3 rule 1, for Markdown: line for line, prose lines go
// through the prose filter and everything that is not prose is blanked to
// its indent: fenced and indented code, HTML blocks, HTML comments and
// front matter. A line shows only when nothing before its text (spaces,
// tabs, `>`, list markers) holds a tab or a run of four spaces, so it can
// never be indented code in any container. The scan fails closed: where it cannot be sure how a
// renderer reads a line (a fence it cannot see close, a fence marker that
// opens nothing, a container a fence may have left, a line break the split
// does not see, a line over the length limit), it blanks, and a construct
// left open blanks the rest of the file.

/** Line breaks a renderer may see inside one of our lines: from one on, nothing is shown. */
const BREAK = /[\r\u2028\u2029\u000b\u000c\u001c\u001d\u001e\u0085]/

/** A blockquote prefix: up to three spaces, `>`, an optional space or tab, repeated. */
const QUOTE = /^(?: {0,3}>[ \t]?)*/

/** Spaces and list markers before a line's content (`- `, `1. `, `2) `), then a fence. */
const FENCE_OPEN = /^((?:[ \t]|[-*+][ \t]|\d{1,9}[.)][ \t])*)(`{3,}|~{3,})(.*)$/

/** A fence marker anywhere on a line. */
const MARKER = /`{3}|~{3}/

/**
 * The markers and whitespace before a line's text: spaces, tabs, `>`, and
 * list markers (`-`, `*`, `+`, `1.`, `1)` before a space or tab). Read by
 * hand, so it is linear.
 */
export function prefixOf(line: string): string {
  let i = 0
  while (i < line.length) {
    const c = line[i]!
    const next = line[i + 1]
    if (c === ' ' || c === '\t' || c === '>') i += 1
    else if ((c === '-' || c === '*' || c === '+') && (next === ' ' || next === '\t')) i += 1
    else if (c >= '0' && c <= '9') {
      let j = i
      while (j < line.length && j - i < 9 && line[j]! >= '0' && line[j]! <= '9') j += 1
      if ((line[j] === '.' || line[j] === ')') && (line[j + 1] === ' ' || line[j + 1] === '\t')) i = j + 1
      else break
    } else break
  }
  return line.slice(0, i)
}

/**
 * Whether a line can be shown at all: indented code, in any container,
 * needs four columns of whitespace before its text, so a line whose prefix
 * holds no tab and no run of four spaces is never code by indentation.
 */
export const isPlainPrefix = (line: string): boolean => {
  const prefix = prefixOf(line)
  return !prefix.includes('\t') && !prefix.includes('    ')
}

/**
 * HTML the scan does not follow: a raw-text element (`<script>`, `<pre>`,
 * `<style>`, `<textarea>`) anywhere on a line, a processing instruction,
 * a declaration, CDATA or a comment opener; and the inline code elements
 * (`<code>`, `<kbd>`, `<samp>`, `<tt>`, `<var>`), whose text the prose
 * filter would not quote. Their extent depends on how a
 * renderer nests them with paragraphs and other blocks, so the rest of the
 * file is blanked, except for a line that is one whole comment.
 */
const RAW_HTML = /<(?:script|pre|style|textarea|code|kbd|samp|tt|var)\b|<[?!]/i

/** A line's text that is one complete comment and nothing after it: a block that ends on its own line. */
const LONE_COMMENT = /^<!--(?:(?!-->)[^])*-->[ \t]*$/

/**
 * How a line's backtick runs read: `split` when a run has no partner of
 * its length on the line (a code span a renderer may continue on the next
 * line), `double` when a run of two or more pairs up (a span the prose
 * filter's single-backtick quoting does not read), else `plain`. Linear.
 * A renderer skips an escaped backtick, and one inside an autolink or a
 * tag, so the count cannot be trusted on a line with a backtick and a
 * backslash before one, or any `<`: that line reads `split`.
 */
export function backtickRuns(line: string): 'plain' | 'double' | 'split' {
  if (!line.includes('`')) return 'plain'
  if (line.includes('\\`') || line.includes('<')) return 'split'
  const counts = new Map<number, number>()
  for (let i = 0; i < line.length; ) {
    if (line[i] !== '`') {
      i += 1
      continue
    }
    let j = i
    while (line[j] === '`') j += 1
    counts.set(j - i, (counts.get(j - i) ?? 0) + 1)
    i = j
  }
  if ([...counts.values()].some(n => n % 2 === 1)) return 'split'
  return [...counts.keys()].some(k => k >= 2) ? 'double' : 'plain'
}

/** A line's text that starts with a tag: an HTML block may open on it, which the scan does not follow. */
const TAG_START = /^<[A-Za-z/!?]/

type Fence = { char: string; length: number; quotes: number; column: number; isBroken: boolean }

type State =
  | { kind: 'prose' }
  | { kind: 'front'; close: RegExp }
  | { kind: 'fence'; fence: Fence }
  | { kind: 'dead' }

/** The line split at its blockquote prefix: how many `>` it holds, and the rest. */
function unquote(line: string): { quotes: number; rest: string } {
  const prefix = QUOTE.exec(line)![0]
  let quotes = 0
  for (const c of prefix) if (c === '>') quotes += 1
  return { quotes, rest: line.slice(prefix.length) }
}

/** Whether `line` closes `fence`: same quote depth, only spaces before it at the fence's own column, then only whitespace. */
function closesFence(line: string, fence: Fence): boolean {
  if (fence.isBroken) return false
  const { quotes, rest } = unquote(line)
  if (quotes !== fence.quotes) return false
  const m = /^( *)(`+|~+)[ \t]*$/.exec(rest)
  return m !== null && m[1]!.length === fence.column && m[2]![0] === fence.char && m[2]!.length >= fence.length
}

/**
 * Which lines are prose, by a scan that blanks whatever it cannot show is
 * prose (see the top of this file). A fence closes only on a line at its
 * own column and quote depth, so a closer a renderer could read as a new
 * opener (after the fence's container ended) never closes it; a line at a
 * different quote depth, or left of the fence's column, breaks the fence
 * and the rest of the file is blanked.
 */
export function shownMarkdownLines(lines: readonly string[]): boolean[] {
  const shown: boolean[] = []
  let state: State = { kind: 'prose' }
  for (const [i, raw] of lines.entries()) {
    // A byte order mark is not content: every check reads the first line without it.
    const line = i === 0 ? raw.replace(/^\uFEFF/, '') : raw
    const isBlank = /^[ \t]*$/.test(line)
    // A line too long to read cheaply, or a line break the split does not see: nothing more is shown.
    if (state.kind === 'dead' || line.length > PUZZLE.maxLineChars || BREAK.test(line)) {
      state = { kind: 'dead' }
      shown.push(false)
      continue
    }
    if (state.kind !== 'prose') {
      if (state.kind === 'fence') {
        const f = state.fence
        if (closesFence(line, f)) state = { kind: 'prose' }
        else {
          const { quotes, rest } = unquote(line)
          if (quotes !== f.quotes || (!/^[ \t]*$/.test(rest) && /^ */.exec(rest)![0].length < f.column && f.column > 0)) f.isBroken = true
          // A marker that could close it anywhere but its own column, or any marker once the fence is broken:
          // a renderer may close or open a fence there. (A shorter run, the other character or an info string is content.)
          const isCloser = /^[ \t]*(`+|~+)[ \t]*$/.exec(rest)
          if (MARKER.test(line) && (f.isBroken || (isCloser !== null && isCloser[1]![0] === f.char && isCloser[1]!.length >= f.length))) state = { kind: 'dead' }
        }
      } else if (MARKER.test(line)) {
        // A fence marker the scan cannot account for: a renderer may open a fence on it.
        state = { kind: 'dead' }
      } else if (state.kind === 'front') {
        // A renderer without front matter reads these lines as Markdown: HTML here is followed no better than in prose.
        if (RAW_HTML.test(line) || TAG_START.test(line.slice(prefixOf(line).length))) state = { kind: 'dead' }
        else if (state.close.test(line)) state = { kind: 'prose' }
      }
      // A blank line shows as itself: it holds nothing.
      shown.push(state.kind === 'prose' && isBlank)
      continue
    }
    // Front matter: only on the first line.
    const first = i === 0 ? line.trimEnd() : ''
    if (first === '---' || first === '+++') {
      state = { kind: 'front', close: first === '---' ? /^---[ \t]*$/ : /^\+\+\+[ \t]*$/ }
      shown.push(false)
      continue
    }
    if (isBlank) {
      shown.push(true)
      continue
    }
    const isPlain = isPlainPrefix(line)
    const { quotes, rest } = unquote(line)
    // A fence marker: a fence the scan opens (on a plain line only), or one it cannot account for, which blanks the rest of the file.
    if (MARKER.test(line)) {
      const open = isPlain ? FENCE_OPEN.exec(rest) : null
      state = open !== null && !(open[2]![0] === '`' && open[3]!.includes('`')) && !line.includes('<')
        ? { kind: 'fence', fence: { char: open[2]![0]!, length: open[2]!.length, quotes, column: open[1]!.length, isBroken: open[1]!.includes('\t') } }
        : { kind: 'dead' }
      shown.push(false)
      continue
    }
    // HTML: its text after every marker in any order (`- > <script>` too). A line that is one whole
    // comment is blanked alone; any other HTML the scan does not follow blanks the rest of the file.
    const content = line.slice(prefixOf(line).length)
    if (RAW_HTML.test(line) || TAG_START.test(content)) {
      state = LONE_COMMENT.test(content) ? state : { kind: 'dead' }
      shown.push(false)
      continue
    }
    // Inline code: a span that may run onto the next line blanks the rest of the file; a double-backtick span blanks its line.
    const ticks = backtickRuns(line)
    if (ticks === 'split') state = { kind: 'dead' }
    // Indented code (a tab or four spaces before the text) is never shown; anything else here is prose.
    shown.push(isPlain && ticks === 'plain')
  }
  return shown
}

/** Private-use code points: a span's place while the prose filter runs. Dropped from the source first. */
const PRIVATE = /[\uE000-\uF8FF]/g
const SPAN_MARK = '\uE000'
const FIRST_SPAN = 0xe100

/**
 * A name whose value is a secret: a whole run of name characters holding `key`, `token`, `secret`, `pass` (`passwd`,
 * `password`), `pwd`, `auth`, `credential` or `private`, of any length. Tried only where a run starts (each rule's
 * lookbehind), so the word is looked for once per run, and a long run (`key-key-key…`) is not tried every way.
 */
const SECRET_NAME = String.raw`(?=[\w.-]*?(?:key|token|secret|pass|pwd|auth|credential|private))[\w.-]+`
/** A value taken whole: a quoted string (backslash escapes and doubled quotes kept inside, to its closing quote or the line's end), else a run of non-space. */
const SECRET_VALUE = String.raw`(?:"(?:[^"\\\n]|\\.|"")*"?|'(?:[^'\\\n]|\\.|'')*'?|\S+)`

/**
 * Token shapes a span may hold, in order: connection-string passwords, JWTs, bearer and basic credentials, known
 * prefixes, secret assignments and password flags (the name is kept), `user:password` after `-u`/`--user`, `-p`
 * passwords, long base64 runs and long runs mixing letters and digits. A blocklist: a secret of another shape still shows.
 */
const SECRET_RULES: readonly { pattern: RegExp; to: string }[] = [
  // The password runs to the token's last `@`, so one holding `@` or `/` is hidden whole (a port and path before an `@` too).
  { pattern: /(?<![\w+.-])([a-z][\w+.-]{0,30}:\/\/[^\s:/@]*:)\S*@/gi, to: '$1[secret]@' },
  { pattern: /\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, to: '[secret]' },
  { pattern: /\b((?:Bearer|Basic)[ \t]+)\S+/gi, to: '$1[secret]' },
  { pattern: /\b(?:gh[oprsu]_|github_pat_|sk_|pk_|rk_|sk-|xox[abprs]-|AKIA|AIza)[\w-]{6,}/g, to: '[secret]' },
  { pattern: new RegExp(String.raw`(?<![\w.-])(${SECRET_NAME}["']?[ \t]*[=:]{1,2}[ \t]*)${SECRET_VALUE}`, 'gi'), to: '$1[secret]' },
  { pattern: new RegExp(String.raw`((?<![\w.-])--?${SECRET_NAME}[ \t]+)(?!-)${SECRET_VALUE}`, 'gi'), to: '$1[secret]' },
  { pattern: /((?<![\w-])(?:-u|--user)(?:[ \t]+|=)?[^\s:]*:)\S+/g, to: '$1[secret]' },
  // `-pVALUE`: any value after a mysql, mariadb or sshpass command, else one that is not a lowercase flag (`-print`);
  // after sshpass, `-p VALUE` too.
  { pattern: /(?<![\w-])(-p)(?<=\b(?:mysql|mariadb|sshpass)\w*\b.*-p)\S+/g, to: '$1[secret]' },
  { pattern: /(?<![\w-])(-p[ \t]+)(?<=\bsshpass\b.*)(?!-)\S+/g, to: '$1[secret]' },
  { pattern: /(?<![\w-])(-p)(?![a-z]+(?!\S))\S+/g, to: '$1[secret]' },
  { pattern: /(?<![\w+/=-])(?=[\w+/=-]*\d)[\w+/-]{30,}={0,2}/g, to: '[secret]' },
  // Tried only where a run starts (a suffix of a run is never longer), so a long run is read once, not from every `-`.
  { pattern: /(?<![\w-])(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{20,}/g, to: '[secret]' },
]

/** A backtick span's text as the pane shows it: secret shapes, then the value shapes (URLs, emails, IDs, ...). */
export function filterSpan(text: string): string {
  let out = text
  for (const { pattern, to } of SECRET_RULES) out = out.replace(pattern, to)
  return filterValues(out).text
}

/** Text ending in a title or role word, or a name: a span right after it is a name (`Dr. `Roe``, `patient `Jane``, `Dr. Jane `Roe``). */
// Each branch ends in one run of its own space class, so a long run of spaces is split one way only.
const AFTER_TITLE = /(?:\b(?:Mr|Mrs|Ms|Mx|Dr|Prof)\.?\s*|\b(?:patient|pt|client|member|resident)[\s:.,]*|\[name\][\s,]*)$/i

/**
 * A shown prose line for the pane only, never a prompt: backtick spans kept
 * through `filterSpan`, the rest through the prose filter without strict's
 * capitalized-word rule. Each span waits as a private-use mark while the
 * prose filter runs, so a quote around a span is still caught whole, and a
 * mark a rule swallowed is not put back.
 */
function localProse(line: string, mode: PrivacyMode): string {
  const spans: string[] = []
  const marked = line.replace(CONTROL, '').replace(PRIVATE, '').replace(/`([^`]*)`/g, (_, text: string) => {
    spans.push(text)
    return SPAN_MARK + String.fromCharCode(FIRST_SPAN + spans.length - 1)
  })
  const prose = filterProse(marked, mode === 'strict' ? 'standard' : mode).text
  // Marks go back one at a time against the line built so far, so a span after a titled span is a name too.
  let out = ''
  let from = 0
  for (const m of prose.matchAll(/\uE000([\uE100-\uF8FF])/g)) {
    out += prose.slice(from, m.index)
    out += AFTER_TITLE.test(out) ? '[name]' : `\`${filterSpan(spans[m[1]!.charCodeAt(0) - FIRST_SPAN] ?? '')}\``
    from = m.index + m[0].length
  }
  return (out + prose.slice(from)).replace(PRIVATE, '')
}

/**
 * SPEC 8.3: Markdown ready for a prompt and the pane. `off` sends it as
 * written, less control characters. `local` (puzzle view spec, section 4)
 * is for text that never leaves the machine: spans and capitalized words
 * are shown, everything else is filtered as for a prompt.
 */
export function filterMarkdown(source: string, mode: PrivacyMode, opts: { local?: boolean } = {}): string {
  const lines = source.replace(/\r(?=\n)/g, '').split('\n')
  if (mode === 'off') return lines.map(l => l.replace(CONTROL, '')).join('\n')
  const shown = shownMarkdownLines(lines)
  const blank = (l: string) => (/^[ \t]*$/.test(l) ? '' : `${/^[ \t]*/.exec(l)![0].slice(0, PUZZLE.maxLineChars)}${BLANK}`)
  // A shown line's backtick spans are single, paired and free of escapes and `<` (backtickRuns), so a renderer pairs them
  // left to right, as this does: off the local path each is quoted before the prose filter, whose other rules could take an opening backtick.
  const prose = opts.local ? (l: string) => localProse(l, mode) : (l: string) => filterProse(l.replace(CONTROL, '').replace(/`[^`]*`/g, '[quoted]'), mode).text
  return lines.map((l, i) => (shown[i] && l.length <= PUZZLE.maxLineChars ? prose(l) : blank(l))).join('\n')
}
