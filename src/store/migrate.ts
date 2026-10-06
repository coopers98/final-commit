import { STORE } from '../config'
import { KEYS, type StoreLike } from './repo'
import type { SaveMeta, Versioned } from './schema'

/**
 * Migrations keyed by the version they upgrade FROM. Version 1 is the first
 * schema, so the table is empty; a schema change adds `1: async store => {...}`
 * and bumps STORE.schemaVersion in the same commit (CLAUDE.md rule 3).
 */
const MIGRATIONS: Record<number, (store: StoreLike) => Promise<void>> = {}

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
