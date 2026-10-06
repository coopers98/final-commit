import { ATTACHMENT_ITEMS, ATTACHMENT_ODDS, type AttachmentClass } from '../config'
import type { Rng } from '../rng'

export type Attachment = { class: AttachmentClass; item: string }

/** SPEC 6.3: independent of tier. */
export function rollAttachment(rng: Rng): Attachment | undefined {
  const cls = rng.weighted({ ...ATTACHMENT_ODDS })
  if (cls === 'none') return undefined
  return { class: cls, item: rng.pick(ATTACHMENT_ITEMS[cls]) }
}
