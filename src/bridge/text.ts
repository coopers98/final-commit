// Pure text layout for panes.

function cut(text: string, width: number): string {
  const chars = [...text]
  return chars.length <= width ? text : `${chars.slice(0, Math.max(1, width - 1)).join('')}~`
}

/** `text` broken at spaces into lines of at most `width` (a longer word is cut). Continuations indent two cells. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    const candidate = line === '' ? word : `${line} ${word}`
    if ([...candidate].length <= width || line.trim() === '') line = candidate
    else {
      out.push(line)
      line = `  ${word}`
    }
  }
  out.push(line)
  return out.map(l => cut(l, width))
}
