import { SPRITE } from '../config'

export type ArtCheck = { ok: true } | { ok: false; errors: string[] }

/** Printable ASCII: the only characters guaranteed one cell wide in every terminal. */
export function isSpriteChar(ch: string): boolean {
  if (ch.length !== 1) return false
  const code = ch.charCodeAt(0)
  return code >= 0x20 && code <= 0x7e
}

export function validateSprite(rows: unknown): ArtCheck {
  if (!Array.isArray(rows) || !rows.every(r => typeof r === 'string')) {
    return { ok: false, errors: ['sprite must be a list of strings'] }
  }
  const errors: string[] = []
  if (rows.length !== SPRITE.rows) errors.push(`expected ${SPRITE.rows} rows, got ${rows.length}`)
  let filled = 0
  rows.forEach((row: string, i) => {
    const chars = [...row]
    if (chars.length !== SPRITE.cols) errors.push(`row ${i + 1} is ${chars.length} wide, expected ${SPRITE.cols}`)
    const bad = chars.filter(c => !isSpriteChar(c))
    if (bad.length > 0) errors.push(`row ${i + 1} has characters outside printable ASCII`)
    filled += chars.filter(c => c !== ' ' && isSpriteChar(c)).length
  })
  if (filled < SPRITE.minSilhouetteCells) errors.push('silhouette is empty or too sparse')
  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

const ANCHOR_NAMES = ['head', 'neck', 'hand', 'orbit'] as const

export function validateAnchors(anchors: unknown): ArtCheck {
  if (typeof anchors !== 'object' || anchors === null) return { ok: false, errors: ['anchors missing'] }
  const errors: string[] = []
  for (const name of ANCHOR_NAMES) {
    const p = (anchors as Record<string, unknown>)[name] as { x?: unknown; y?: unknown } | undefined
    const ok =
      typeof p === 'object' && p !== null &&
      Number.isInteger(p.x) && Number.isInteger(p.y) &&
      (p.x as number) >= 0 && (p.x as number) < SPRITE.cols &&
      (p.y as number) >= 0 && (p.y as number) < SPRITE.rows
    if (!ok) errors.push(`anchor ${name} is missing or outside the ${SPRITE.cols}x${SPRITE.rows} grid`)
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}
