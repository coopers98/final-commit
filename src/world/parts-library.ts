import { GENERATION, SPRITE } from '../config'
import type { Rng } from '../rng'
import type { Anchors, Sprite } from '../store/schema'

// Procedural fallback art (SPEC 5.2 step 3). Parts are centered into the
// 14-column grid; heads/crowns are 2 rows, bodies/stems 3, legs/roots 2.

const center = (s: string): string => {
  const left = Math.floor((SPRITE.cols - s.length) / 2)
  return (' '.repeat(left) + s).padEnd(SPRITE.cols, ' ')
}

const FAUNA_HEADS = [
  ['.--.', '( oo )'],
  ['^    ^', '( o  o )'],
  ['_..._', '( @ @ )'],
  ['\\  /', '<(o.o)>'],
]
const FAUNA_BODIES = [
  ['/|==|\\', '/ |  | \\', '|  |'],
  ['{    }', '{ ~~ }', '{____}'],
  ['<[  ]>', '<[::]>', '<[__]>'],
  ['/ \\/ \\', '(  ..  )', '\\____/'],
]
const FAUNA_LEGS = [
  ['/    \\', '~~    ~~'],
  ['||  ||', "''  ''"],
  ['/\\  /\\', '/  \\/  \\'],
  ['(_)  (_)', '        '],
]
const FLORA_CROWNS = [
  ['\\ | /', '-- * --'],
  ['.oOo.', '(oOOo)'],
  ['* . *', '\\ * /'],
]
const FLORA_STEMS = [
  ['|', '\\|/', '|'],
  ['}', '{', '}'],
  [')', '(', ')'],
]
const FLORA_ROOTS = [
  ['/|\\', '/_|_\\'],
  ['~~|~~', '~~~~~~~'],
  ['_/ \\_', '/     \\'],
]

export const DEFAULT_ANCHORS: Anchors = {
  head: { x: 7, y: 0 },
  neck: { x: 7, y: 2 },
  hand: { x: 3, y: 3 },
  orbit: { x: 12, y: 0 },
}

/** Each later stage adds markings at the grid's edges, so stages always differ. */
function evolve(rows: string[], stage: number): string[] {
  const out = rows.map(r => [...r])
  const last = SPRITE.cols - 1
  const middle = Math.floor(SPRITE.rows / 2)
  if (stage >= 1) {
    out[0]![1] = '*'
    out[0]![last - 1] = '*'
  }
  if (stage >= 2) {
    out[middle]![0] = '<'
    out[middle]![last] = '>'
    out[SPRITE.rows - 1]![0] = '='
    out[SPRITE.rows - 1]![last] = '='
  }
  return out.map(r => r.join(''))
}

export function assembleSprite(rng: Rng, kind: 'fauna' | 'flora', stages: number): { stages: Sprite[]; anchors: Anchors } {
  const [tops, middles, bottoms] =
    kind === 'fauna' ? [FAUNA_HEADS, FAUNA_BODIES, FAUNA_LEGS] : [FLORA_CROWNS, FLORA_STEMS, FLORA_ROOTS]
  const base = [...rng.pick(tops), ...rng.pick(middles), ...rng.pick(bottoms)].map(center)
  return {
    stages: Array.from({ length: stages }, (_, i) => ({ rows: evolve(base, i) })),
    anchors: DEFAULT_ANCHORS,
  }
}

const ONSETS = ['Br', 'Gl', 'Kr', 'Vel', 'Th', 'Zy', 'Qu', 'Mor', 'Sk', 'Fen', 'Ix', 'Pl']
const NUCLEI = ['a', 'e', 'i', 'o', 'u', 'ae', 'io', 'y']
const CODAS = ['x', 'th', 'rn', 'll', 'p', 'sk', 'm', 'v', 'nd', 'z']

export function proceduralName(rng: Rng): string {
  const name = rng.pick(ONSETS) + rng.pick(NUCLEI) + rng.pick(CODAS) + (rng.chance(GENERATION.extraSyllableChance) ? rng.pick(NUCLEI) : '')
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase()
}
