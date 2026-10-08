import { REWARDS, STORE } from '../config'
import { KEYS, type StoreLike } from './repo'
import type { SaveMeta, Versioned } from './schema'

/**
 * Migrations keyed by the version they upgrade FROM. A schema change adds one
 * and bumps STORE.schemaVersion in the same commit (CLAUDE.md rule 3). Each
 * step restamps every value it upgrades, meta last, since the repo reads only
 * values of the current version.
 */
const MIGRATIONS: Record<number, (store: StoreLike) => Promise<void>> = {
  // 1 -> 2: missions keep their last lint verdict (`lint`).
  1: async store => {
    const withLint = (m: unknown) => (isObject(m) && !('lint' in m) ? { ...m, lint: null } : m)
    for (const key of await store.keys()) {
      if (!key.startsWith(STORE.prefix) || key === KEYS.meta) continue
      const value = await store.get(key)
      if (!isObject(value) || value.schemaVersion !== 1) continue
      let next: Record<string, unknown> = { ...value, schemaVersion: 2 }
      if (key === KEYS.activeMission) next = withLint(next) as Record<string, unknown>
      if (key === KEYS.missionLog && Array.isArray(value.items)) next = { ...next, items: value.items.map(withLint) }
      await store.set(key, next)
    }
    await store.set(KEYS.meta, { ...((await store.get(KEYS.meta)) as object), schemaVersion: 2 })
  },
  // 2 -> 3: sync state is kept per work source (`fc:sync:<name>`). The single
  // `fc:sync` record belonged to no source (none was wired), so it is dropped.
  2: async store => {
    await store.delete(`${STORE.prefix}sync`)
    for (const key of await store.keys()) {
      if (!key.startsWith(STORE.prefix) || key === KEYS.meta) continue
      const value = await store.get(key)
      if (isObject(value) && value.schemaVersion === 2) await store.set(key, { ...value, schemaVersion: 3 })
    }
    await store.set(KEYS.meta, { ...((await store.get(KEYS.meta)) as object), schemaVersion: 3 })
  },
  // 3 -> 4: completed missions record what they gave (`reward`), so /mission
  // reopen can take it back. Older entries get it by the rules that applied:
  // an administrative closure (no time, no work) gave nothing; any other
  // completion counted, with a Reinforced Cell when its tests were green.
  3: async store => {
    const withReward = (m: unknown) => {
      if (!isObject(m) || 'reward' in m) return m
      const isClosure = m.startedAt === m.completedAt && m.commits === 0 && m.testRuns === 0
      return { ...m, reward: isClosure ? { counted: false, reinforced: 0 } : { counted: true, reinforced: m.testsGreen === true ? REWARDS.reinforcedForGreenTests : 0 } }
    }
    for (const key of await store.keys()) {
      if (!key.startsWith(STORE.prefix) || key === KEYS.meta) continue
      const value = await store.get(key)
      if (!isObject(value) || value.schemaVersion !== 3) continue
      let next: Record<string, unknown> = { ...value, schemaVersion: 4 }
      if (key === KEYS.missionLog && Array.isArray(value.items)) next = { ...next, items: value.items.map(withReward) }
      await store.set(key, next)
    }
    await store.set(KEYS.meta, { ...((await store.get(KEYS.meta)) as object), schemaVersion: 4 })
  },
  // 4 -> 5: a reward also records Stasis Cells and flora harvested. No
  // mission gave either before, so older rewards get none.
  4: async store => {
    const withMore = (m: unknown) =>
      isObject(m) && isObject(m.reward) && !('stasis' in m.reward) ? { ...m, reward: { ...m.reward, stasis: 0, flora: {} } } : m
    for (const key of await store.keys()) {
      if (!key.startsWith(STORE.prefix) || key === KEYS.meta) continue
      const value = await store.get(key)
      if (!isObject(value) || value.schemaVersion !== 4) continue
      let next: Record<string, unknown> = { ...value, schemaVersion: 5 }
      if (key === KEYS.missionLog && Array.isArray(value.items)) next = { ...next, items: value.items.map(withMore) }
      await store.set(key, next)
    }
    await store.set(KEYS.meta, { ...((await store.get(KEYS.meta)) as object), schemaVersion: 5 })
  },
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const freshMeta = (now: number): SaveMeta => ({
  createdAt: now,
  firstTrackedAt: null,
  lastEncounterAt: null,
  completedMissions: 0,
  activeEpicKey: null,
  companionId: null,
  encountersToday: { day: '', count: 0 },
})

/** Runs before anything reads the store (SPEC 10). Returns the current meta. */
export async function migrate(store: StoreLike, now: number, log: (line: string) => void = () => {}): Promise<SaveMeta> {
  const raw = await store.get(KEYS.meta)
  if (raw === undefined) {
    const meta = freshMeta(now)
    await store.set(KEYS.meta, { ...meta, schemaVersion: STORE.schemaVersion })
    return meta
  }
  if (typeof raw !== 'object' || raw === null || typeof (raw as { schemaVersion?: unknown }).schemaVersion !== 'number') {
    log('final-commit: save metadata was unreadable; started a fresh one (other saved data kept)')
    const meta = freshMeta(now)
    await store.set(KEYS.meta, { ...meta, schemaVersion: STORE.schemaVersion })
    return meta
  }
  let version = (raw as Versioned<SaveMeta>).schemaVersion
  if (version > STORE.schemaVersion) {
    throw new Error(`final-commit: save is schema ${version}, newer than this build (${STORE.schemaVersion}); update the mod`)
  }
  while (version < STORE.schemaVersion) {
    const step = MIGRATIONS[version]
    if (step === undefined) throw new Error(`final-commit: no migration from schema ${version}`)
    await step(store)
    version += 1
  }
  const { schemaVersion: _v, ...meta } = (await store.get(KEYS.meta)) as Versioned<SaveMeta>
  return { ...freshMeta(now), ...meta }
}
