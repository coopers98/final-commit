import { STORE, TIERS, type Tier } from '../config'
import type {
  CatalogEntry, Calibration, Inventory, Mission, PendingEncounter, SaveMeta, Specimen, StarSystem, Versioned,
} from './schema'

export type StoreLike = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}

const p = STORE.prefix
export const KEYS = {
  meta: `${p}meta`,
  systemPrefix: `${p}system:`,
  system: (id: string) => `${p}system:${id}`,
  activeMission: `${p}mission:active`,
  missionLog: `${p}missions`,
  specimens: `${p}specimens`,
  inventory: `${p}inventory`,
  catalog: `${p}catalog`,
  pending: `${p}pending`,
  calibration: `${p}calibration`,
} as const

export function createMemoryStore(): StoreLike & { dump(): Record<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    get: async key => structuredClone(data.get(key)),
    set: async (key, value) => void data.set(key, structuredClone(value)),
    delete: async key => void data.delete(key),
    keys: async () => [...data.keys()],
    dump: () => Object.fromEntries(data),
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isTier = (v: unknown): v is Tier => typeof v === 'string' && (TIERS as readonly string[]).includes(v)

function stamp<T extends object>(value: T): Versioned<T> {
  return { ...value, schemaVersion: STORE.schemaVersion }
}

function strip<T>(value: Versioned<T>): T {
  const { schemaVersion: _drop, ...rest } = value as Versioned<T> & Record<string, unknown>
  return rest as T
}

export type Repo = ReturnType<typeof createRepo>

export function createRepo(store: StoreLike, log: (line: string) => void = () => {}) {
  /** Reads a versioned record: undefined when missing; a malformed value is logged and read as missing. */
  async function readOptional<T>(key: string, isValid: (v: Record<string, unknown>) => boolean): Promise<T | undefined> {
    const raw = await store.get(key)
    if (raw === undefined) return undefined
    // A value from another schema version is never read as this one (migrate() runs first).
    if (!isObject(raw) || raw.schemaVersion !== STORE.schemaVersion || !isValid(raw)) {
      log(`final-commit: ignored a malformed value at ${key}`)
      return undefined
    }
    return strip(raw as Versioned<T>)
  }

  async function readRecord<T>(key: string, fallback: T, isValid: (v: Record<string, unknown>) => boolean): Promise<T> {
    return (await readOptional<T>(key, isValid)) ?? fallback
  }

  async function readList<T>(key: string, isItemValid: (v: unknown) => boolean): Promise<T[]> {
    const wrapper = await readRecord<{ items: T[] }>(key, { items: [] }, v => Array.isArray(v.items))
    const items = wrapper.items.filter(isItemValid)
    if (items.length !== wrapper.items.length) log(`final-commit: dropped malformed entries at ${key}`)
    return items
  }

  const writeList = <T>(key: string, items: T[]) => store.set(key, stamp({ items }))

  return {
    /** Undefined until migrate() has run. */
    meta: () => readOptional<SaveMeta>(KEYS.meta, v => typeof v.completedMissions === 'number'),
    /**
     * Reads the current meta, applies `change`, writes it back. Always use this
     * rather than writing a meta read earlier: other work (a background /epic,
     * the Bash observer) may have changed it in between.
     */
    patchMeta: async (change: (meta: SaveMeta) => SaveMeta): Promise<SaveMeta> => {
      const current = await readOptional<SaveMeta>(KEYS.meta, v => typeof v.completedMissions === 'number')
      if (!current) throw new Error('final-commit: save not migrated; migrate() must run at session start')
      const next = change(current)
      await store.set(KEYS.meta, stamp(next))
      return next
    },

    system: (id: string) => readOptional<StarSystem>(KEYS.system(id), v => typeof v.id === 'string' && Array.isArray(v.species)),
    // One key per system, listed from the store's keys: there is no shared
    // index to read-modify-write, so systems charted at once cannot lose each other.
    saveSystem: (system: StarSystem) => store.set(KEYS.system(system.id), stamp(system)),
    systemIds: async () =>
      (await store.keys()).filter(k => k.startsWith(KEYS.systemPrefix)).map(k => k.slice(KEYS.systemPrefix.length)),

    activeMission: () => readOptional<Mission>(KEYS.activeMission, v => typeof v.issueKey === 'string'),
    saveActiveMission: (m: Mission) => store.set(KEYS.activeMission, stamp(m)),
    clearActiveMission: () => store.delete(KEYS.activeMission),
    missionLog: () => readList<Mission>(KEYS.missionLog, v => isObject(v) && typeof v.issueKey === 'string'),
    appendMission: async (m: Mission) => writeList(KEYS.missionLog, [...(await readList<Mission>(KEYS.missionLog, isObject)), m]),

    specimens: () => readList<Specimen>(KEYS.specimens, v => isObject(v) && typeof v.id === 'string' && isTier(v.tier)),
    addSpecimen: async (s: Specimen) => writeList(KEYS.specimens, [...(await readList<Specimen>(KEYS.specimens, v => isObject(v) && isTier(v.tier))), s]),

    inventory: () =>
      readRecord<Inventory>(
        KEYS.inventory,
        { reinforced: 0, stasis: 0, singularity: 0, flora: {} },
        v => typeof v.reinforced === 'number' && typeof v.stasis === 'number' && typeof v.singularity === 'number' && isObject(v.flora),
      ),
    saveInventory: (inv: Inventory) => store.set(KEYS.inventory, stamp(inv)),

    catalog: () => readList<CatalogEntry>(KEYS.catalog, v => isObject(v) && typeof v.speciesId === 'string' && isTier(v.tier)),
    saveCatalog: (entries: CatalogEntry[]) => writeList(KEYS.catalog, entries),

    pending: () => readOptional<PendingEncounter>(KEYS.pending, v => typeof v.id === 'string' && typeof v.speciesId === 'string' && isTier(v.tier)),
    savePending: (e: PendingEncounter) => store.set(KEYS.pending, stamp(e)),
    clearPending: () => store.delete(KEYS.pending),

    calibration: () => readRecord<Calibration>(KEYS.calibration, { clients: {}, salt: '' }, v => isObject(v.clients) && typeof v.salt === 'string'),
    saveCalibration: (c: Calibration) => store.set(KEYS.calibration, stamp(c)),
  }
}
