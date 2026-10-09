import { PUZZLE } from '../config'
import { filterCode } from './code-filter'
import type { PrivacyMode } from './privacy-filter'
import { ADAPTERS, changedLines, isSafePath, type Unit } from './units'

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

/**
 * From `git diff --raw -z`: the paths whose new side is a regular file
 * (mode 100644 or 100755), added or modified. Symlinks (120000),
 * submodules and deletions are left out.
 */
export function regularFiles(raw: string): Set<string> {
  const out = new Set<string>()
  const parts = raw.split('\0')
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = /^:\d{6} (\d{6}) \S+ \S+ ([AM])/.exec(parts[i]!.trim())
    const path = parts[i + 1]!
    if (meta && (meta[1] === '100644' || meta[1] === '100755') && isSafePath(path)) out.add(path)
  }
  return out
}

/**
 * Whether `text` may hold JSX. In JavaScript files (which may carry JSX)
 * any `<` right before a letter or `>`, or a `<` and `/` with only space
 * between, rules the file out: a formatter spaces comparisons, so little
 * real code is lost. TypeScript files cannot hold JSX (`<T>` there is a
 * type), so only the plain tag shapes count.
 */
export function hasJsx(text: string, path = ''): boolean {
  if (/\.[cm]?js$/.test(path)) return /<[A-Za-z>]|<\s*\/|\/\s*>/.test(text)
  // Line by line, and spaces only: a multi-line `\s*` here backtracks across blank runs.
  return text.split('\n').some(l => /(?:^|[(=?:,{}[!]|=>|&&|\|\||\b(?:return|yield|await))[ \t]*<[A-Za-z>]/.test(l)) || /<\s*\/|\/\s*>/.test(text)
}

/** Filtered units from the code changed since `startedAt`, at most `PUZZLE.maxUnits`. */
export async function missionUnits(io: MaterialIo, startedAt: number, mode: PrivacyMode): Promise<Unit[]> {
  const before = await io.git(['rev-list', '-1', `--before=${new Date(startedAt).toISOString()}`, 'HEAD'])
  if (before.exitCode !== 0 && before.stdout.trim() === '') {
    // Not a git repository, or one without a HEAD: nothing to read.
    const head = await io.git(['rev-parse', '--verify', '--quiet', 'HEAD'])
    if (head.exitCode !== 0) return []
  }
  const base = before.stdout.trim() || EMPTY_TREE
  // Paths relative to the session's folder; the working tree, so uncommitted work counts. The
  // format is pinned, whatever git config says: plain prefixes, no conversion drivers.
  // No fsmonitor command from the folder's own config.
  const git = (args: readonly string[]) => io.git(['-c', 'core.fsmonitor=false', ...args])
  const pinned = ['--relative', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/']
  const raw = await git(['diff', ...pinned, '--raw', '-z', base])
  const diff = await git(['diff', ...pinned, '--unified=0', base])
  if (raw.exitCode !== 0 || diff.exitCode !== 0) return []
  const files = regularFiles(raw.stdout)
  const units: Unit[] = []
  let read = 0
  for (const [path, changed] of changedLines(diff.stdout)) {
    const adapter = ADAPTERS.find(a => a.claims(path))
    // Only a regular file git reported changed: never a symlink, which could point outside the folder.
    if (!adapter || !files.has(path) || read >= PUZZLE.maxFiles) continue
    read += 1
    const text = await io.read(path)
    if (text === undefined || text.length > PUZZLE.maxFileBytes) continue
    // JSX, read in the code as written: the filter blanks its tags, but not the prose between them.
    if (hasJsx(text, path)) continue
    const filtered = filterCode(text, mode)
    // Line numbers from the diff must still point at the same lines.
    if (filtered.split('\n').length !== text.replace(/\r(?=\n)/g, '').split('\n').length) continue
    units.push(...adapter.units(filtered, changed))
    if (units.length >= PUZZLE.maxUnits) break
  }
  return units.slice(0, PUZZLE.maxUnits)
}
