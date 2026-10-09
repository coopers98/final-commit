import { PUZZLE } from '../config'
import { filterCode } from './code-filter'
import type { PrivacyMode } from './privacy-filter'
import { ADAPTERS, changedLines, type Unit } from './units'

// SPEC 8: a puzzle's material is the code a mission changed: its commits
// and anything still uncommitted, against the last commit before it started.
// The glue hands in git and file reads; everything read is filtered here
// before it is kept (SPEC 8.3), and nothing unfiltered leaves this function.

export type MaterialIo = {
  /** Runs git with these arguments in the session's folder. */
  git(args: readonly string[]): Promise<{ exitCode: number; stdout: string }>
  /** A file's text, or undefined when it cannot be read. */
  read(path: string): Promise<string | undefined>
}

/** git's empty tree: the base when the repository has no commit from before the mission. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** Filtered units from the code changed since `startedAt`, at most `PUZZLE.maxUnits`. */
export async function missionUnits(io: MaterialIo, startedAt: number, mode: PrivacyMode): Promise<Unit[]> {
  const before = await io.git(['rev-list', '-1', `--before=${new Date(startedAt).toISOString()}`, 'HEAD'])
  if (before.exitCode !== 0 && before.stdout.trim() === '') {
    // Not a git repository, or one without a HEAD: nothing to read.
    const head = await io.git(['rev-parse', '--verify', '--quiet', 'HEAD'])
    if (head.exitCode !== 0) return []
  }
  const base = before.stdout.trim() || EMPTY_TREE
  // Paths relative to the session's folder; the working tree, so uncommitted work counts.
  const diff = await io.git(['diff', '--relative', '--unified=0', '--no-color', '--no-ext-diff', base])
  if (diff.exitCode !== 0) return []
  const units: Unit[] = []
  let files = 0
  for (const [path, changed] of changedLines(diff.stdout)) {
    const adapter = ADAPTERS.find(a => a.claims(path))
    if (!adapter || files >= PUZZLE.maxFiles) continue
    files += 1
    const text = await io.read(path)
    if (text === undefined || text.length > PUZZLE.maxFileBytes) continue
    units.push(...adapter.units(filterCode(text, mode), changed))
    if (units.length >= PUZZLE.maxUnits) break
  }
  return units.slice(0, PUZZLE.maxUnits)
}
