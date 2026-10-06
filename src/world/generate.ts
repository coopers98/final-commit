import { GENERATION, SPRITE, TIERS, type Tier } from '../config'
import { filterProse, type PrivacyMode } from '../puzzle/privacy-filter'
import type { Rng } from '../rng'
import type { Anchors, Biome, Species, Sprite, StarSystem } from '../store/schema'
import { DEFAULT_ANCHORS, assembleSprite, proceduralName } from './parts-library'
import { validateAnchors, validateSprite } from './validate-art'

export type Complete = (req: { system: string; prompt: string }) => Promise<{ ok: true; text: string } | { ok: false; reason: string }>
export type EpicInput = { key: string; title: string; description: string }

// SPEC 15.5: never in generated content. Distinctive marks match anywhere in
// the text with separators removed ("Warp-core", "StarFleet"); short words
// match as whole words only, so "target" or "border" stay usable.
export const BANNED_COMPACT = [
  'enterprise', 'starfleet', 'tricorder', 'holodeck', 'warpcore', 'startrek', 'klingon', 'vulcan', 'romulan',
  'ferengi', 'cardassian', 'bajoran', 'tribble', 'dilithium', 'phaser', 'betazoid', 'andorian', 'tholian',
  'sehlat', 'mugato', 'janeway', 'picard', 'anthropic',
] as const
export const BANNED_WORDS = ['borg', 'gorn', 'targ', 'horta', 'trek', 'kirk', 'spock', 'sulu', 'uhura', 'riker', 'worf', 'sisko', 'claude'] as const

const STAR_CLASSES = ['O9V', 'B3V', 'A1V', 'F5V', 'G2V', 'K2V', 'M4V', 'M8V'] as const

const SYSTEM_PROMPT = [
  'You design fictional alien ecosystems for a terminal game. Reply with one JSON object and nothing else.',
  'Hard constraints:',
  '- Never use anything from the Star Trek franchise (ships, organizations, species, characters, devices) in any name or text: no Enterprise, Starfleet, Tricorder, Holodeck, Warp Core, Klingon, Vulcan, Romulan, Borg, Gorn, Tribble.',
  '- Never name anything after Anthropic or Claude.',
  `- Every sprite is exactly ${SPRITE.rows} strings of exactly ${SPRITE.cols} characters, printable ASCII only (no tabs, no Unicode, no box-drawing characters). Pad with spaces.`,
  `- Anchors are {x, y} cells inside the sprite: x 0 to ${SPRITE.cols - 1}, y 0 to ${SPRITE.rows - 1}.`,
  `- Names are one or two plain ASCII words, at most ${GENERATION.maxNameLength} characters.`,
].join('\n')

const ART_RETRY_PROMPT = [
  'You redraw ASCII sprites for a terminal game. Reply with one JSON object and nothing else.',
  `Each sprite is exactly ${SPRITE.rows} strings of exactly ${SPRITE.cols} characters, printable ASCII only, padded with spaces.`,
].join('\n')

const count = (slots: Record<Tier, number>) => TIERS.reduce((n, t) => n + slots[t], 0)

/** Tier for each slot index, in slot order (common first). */
const slotTiers = (slots: Record<Tier, number>): Tier[] => TIERS.flatMap(t => Array<Tier>(slots[t]).fill(t))

function buildPrompt(title: string, description: string): string {
  const fauna = count(GENERATION.faunaSlots)
  const flora = count(GENERATION.floraSlots)
  return [
    'Theme a star system on this work epic. Use its subject for mood and names only.',
    `Title: ${title}`,
    `Description: ${description}`,
    '',
    'Return JSON with this shape:',
    `{ "system": { "name", "starClass", "lore" (2 sentences), "biomes": [{ "name", "description" }] (2 to ${GENERATION.maxBiomes}) },`,
    `  "fauna": [${fauna} items], "flora": [${flora} items] }`,
    `Each item: { "name", "readout" (one sentence), "behavior" (one sentence), "stages": [sprite, ...], "anchors": { "head", "neck", "hand", "orbit" } }.`,
    `Fauna have ${GENERATION.faunaStages} stages (an evolution line); flora have ${GENERATION.floraStages}.`,
    'List fauna from most ordinary to most remarkable; the last one is a strange anomaly. List flora the same way.',
  ].join('\n')
}

export function parseReply(text: string): unknown {
  const unfenced = text.replace(/`{3}(?:json)?/g, '')
  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    return JSON.parse(unfenced.slice(start, end + 1))
  } catch {
    return undefined
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : fallback)

export function isBanned(text: string): boolean {
  const lower = text.toLowerCase()
  const compact = lower.replace(/[^a-z]/g, '')
  if (BANNED_COMPACT.some(term => compact.includes(term))) return true
  const words = new Set(lower.split(/[^a-z]+/))
  return BANNED_WORDS.some(word => words.has(word))
}

/** A procedural name that passes the same check as a generated one. */
function safeProceduralName(rng: Rng): string {
  let name = proceduralName(rng)
  while (isBanned(name)) name = proceduralName(rng)
  return name
}

function cleanName(v: unknown, rng: Rng): { name: string; replaced: boolean } {
  const ok =
    typeof v === 'string' && /^[\x20-\x7e]+$/.test(v) && v.trim().length > 0 && v.trim().length <= GENERATION.maxNameLength && !isBanned(v)
  return ok ? { name: (v as string).trim(), replaced: false } : { name: safeProceduralName(rng), replaced: true }
}

function cleanText(v: unknown, fallback: string): string {
  const s = str(v, fallback)
  return isBanned(s) ? fallback : s
}

function stagesFrom(v: unknown, expected: number): Sprite[] | undefined {
  if (!Array.isArray(v) || v.length !== expected) return undefined
  if (!v.every(rows => validateSprite(rows).ok)) return undefined
  return v.map(rows => ({ rows: rows as string[] }))
}

type Draft = { species: Species; needsArt: boolean }

function draftSpecies(raw: unknown, id: string, kind: 'fauna' | 'flora', tier: Tier, rng: Rng): Draft {
  const item = isObject(raw) ? raw : {}
  const expected = kind === 'fauna' ? GENERATION.faunaStages : GENERATION.floraStages
  const { name, replaced } = cleanName(item.name, rng)
  const stages = stagesFrom(item.stages, expected)
  const anchors = validateAnchors(item.anchors).ok ? (item.anchors as Anchors) : DEFAULT_ANCHORS
  const species: Species = {
    id, kind, tier, name,
    readout: cleanText(item.readout, 'Readings inconclusive.'),
    behavior: cleanText(item.behavior, 'Behavior unrecorded.'),
    stages: stages ?? [],
    anchors,
    isProcedural: replaced && stages === undefined,
  }
  return { species, needsArt: stages === undefined }
}

function proceduralSystemName(rng: Rng): string {
  return `${safeProceduralName(rng)} ${rng.pick(['Reach', 'Drift', 'Expanse', 'Cluster', 'Verge'])}`
}

export async function generateSystem(args: {
  epic: EpicInput
  systemId: string
  privacy: PrivacyMode
  complete: Complete
  rng: Rng
  now: number
}): Promise<{ system: StarSystem; notes: string[] }> {
  const { epic, systemId, privacy, complete, rng, now } = args
  const notes: string[] = []
  const title = filterProse(epic.title, privacy).text
  const description = filterProse(epic.description, privacy).text

  const answer = await complete({ system: SYSTEM_PROMPT, prompt: buildPrompt(title, description) })
  let parsed: Record<string, unknown> = {}
  if (!answer.ok) notes.push(`model call failed (${answer.reason}); charted a procedural system`)
  else {
    const value = parseReply(answer.text)
    if (isObject(value)) parsed = value
    else notes.push('model reply was not usable JSON; charted a procedural system')
  }

  const head = isObject(parsed.system) ? parsed.system : {}
  const rawFauna = Array.isArray(parsed.fauna) ? parsed.fauna : []
  const rawFlora = Array.isArray(parsed.flora) ? parsed.flora : []

  const drafts: Draft[] = [
    ...slotTiers(GENERATION.faunaSlots).map((tier, i) => draftSpecies(rawFauna[i], `${systemId}:f${i}`, 'fauna', tier, rng)),
    ...slotTiers(GENERATION.floraSlots).map((tier, i) => draftSpecies(rawFlora[i], `${systemId}:p${i}`, 'flora', tier, rng)),
  ]

  // SPEC 5.2 step 3: retry failed art in batches, but only when the model answered at all.
  for (let round = 0; round < SPRITE.maxArtRetries && answer.ok; round += 1) {
    const failing = drafts.filter(d => d.needsArt)
    if (failing.length === 0) break
    const request = failing.map(d => ({
      id: d.species.id,
      name: d.species.name,
      description: d.species.readout,
      stages: d.species.kind === 'fauna' ? GENERATION.faunaStages : GENERATION.floraStages,
    }))
    const retry = await complete({
      system: ART_RETRY_PROMPT,
      prompt: `Draw these creatures. Return { "species": [{ "id", "stages": [sprite, ...] }] }.\n${JSON.stringify(request)}`,
    })
    if (!retry.ok) continue
    const value = parseReply(retry.text)
    const list = isObject(value) && Array.isArray(value.species) ? value.species : []
    for (const item of list) {
      if (!isObject(item)) continue
      const draft = failing.find(d => d.species.id === item.id)
      if (!draft) continue
      const expected = draft.species.kind === 'fauna' ? GENERATION.faunaStages : GENERATION.floraStages
      const stages = stagesFrom(item.stages, expected)
      if (stages) {
        draft.species = { ...draft.species, stages }
        draft.needsArt = false
      }
    }
  }

  for (const d of drafts.filter(x => x.needsArt)) {
    const expected = d.species.kind === 'fauna' ? GENERATION.faunaStages : GENERATION.floraStages
    const art = assembleSprite(rng, d.species.kind, expected)
    d.species = { ...d.species, stages: art.stages, anchors: art.anchors, isProcedural: true }
  }

  const biomes: Biome[] = (Array.isArray(head.biomes) ? head.biomes : [])
    .filter(isObject)
    .slice(0, GENERATION.maxBiomes)
    .map(b => ({ name: cleanText(b.name, 'Uncharted'), description: cleanText(b.description, '') }))

  const systemName = cleanName(head.name, rng)
  return {
    system: {
      id: systemId,
      epicKey: epic.key,
      name: systemName.replaced ? proceduralSystemName(rng) : systemName.name,
      starClass: cleanText(head.starClass, rng.pick(STAR_CLASSES)).slice(0, GENERATION.maxStarClassLength),
      lore: cleanText(head.lore, 'Little is known about this system.'),
      biomes,
      species: drafts.map(d => d.species),
      status: 'open',
      chartedAt: now,
    },
    notes,
  }
}
