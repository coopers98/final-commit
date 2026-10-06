// Seeded PRNG (mulberry32). Every random decision in the game takes an Rng,
// so tests pass a fixed seed and production seeds from crypto.

export type Rng = {
  /** Uniform in [0, 1). */
  next(): number
  /** Integer in [0, maxExclusive). */
  int(maxExclusive: number): number
  /** True with probability p (p <= 0 never, p >= 1 always). */
  chance(p: number): boolean
  pick<T>(items: readonly T[]): T
  /** A key chosen in proportion to its weight. Throws if all weights are 0. */
  weighted<K extends string>(weights: Record<K, number>): K
}

export function createRng(seed: number): Rng {
  let s = seed >>> 0

  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const int = (maxExclusive: number): number => Math.floor(next() * maxExclusive)

  return {
    next,
    int,
    chance: p => (p <= 0 ? false : p >= 1 ? true : next() < p),
    pick: items => {
      if (items.length === 0) throw new Error('pick from an empty list')
      return items[int(items.length)] as (typeof items)[number]
    },
    weighted: weights => {
      const entries = Object.entries(weights) as [keyof typeof weights, number][]
      const total = entries.reduce((sum, [, w]) => sum + Math.max(0, w), 0)
      if (total <= 0) throw new Error('weighted pick needs a positive weight')
      let r = next() * total
      for (const [key, w] of entries) {
        if (w <= 0) continue
        r -= w
        if (r < 0) return key
      }
      // Floating-point edge: return the last key with weight.
      return entries.filter(([, w]) => w > 0).at(-1)![0]
    },
  }
}

export function seedFromCrypto(): number {
  const word = new Uint32Array(1)
  crypto.getRandomValues(word)
  return word[0]!
}
