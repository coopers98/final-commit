// Every tuning number in the game. Values marked SPEC come from docs/SPEC.md;
// values marked DEFAULT are the v1 playtest defaults recorded in SPEC 16 and
// tuned by playing. Nothing else in src/ may hold a tuning number.

export const TIERS = ['common', 'uncommon', 'rare', 'exotic', 'legendary', 'anomaly'] as const
export type Tier = (typeof TIERS)[number]

export type TierSpec = {
  label: string
  glyph: string
  /** Terminal color name; 'cycle' means the renderer cycles colors. */
  color: string
  encounterOdds: number
  baseContainment: number
  fleeChance: number
}

// SPEC 6.2
export const TIER_SPECS: Record<Tier, TierSpec> = {
  common: { label: 'Common', glyph: '·', color: 'gray', encounterOdds: 0.5, baseContainment: 0.9, fleeChance: 0.1 },
  uncommon: { label: 'Uncommon', glyph: '◇', color: 'green', encounterOdds: 0.28, baseContainment: 0.7, fleeChance: 0.2 },
  rare: { label: 'Rare', glyph: '◆', color: 'blue', encounterOdds: 0.14, baseContainment: 0.45, fleeChance: 0.35 },
  exotic: { label: 'Exotic', glyph: '✦', color: 'magenta', encounterOdds: 0.06, baseContainment: 0.25, fleeChance: 0.5 },
  legendary: { label: 'Legendary', glyph: '★', color: 'yellow', encounterOdds: 0.018, baseContainment: 0.1, fleeChance: 0.65 },
  anomaly: { label: 'Anomaly', glyph: '✺', color: 'cycle', encounterOdds: 0.002, baseContainment: 0.05, fleeChance: 0.8 },
}

// SPEC 6.1, 4.3; firstMissionGuaranteed is DEFAULT
export const ENCOUNTER = {
  baseChance: 0.12,
  perDayChance: 0.12,
  guaranteedAfterDays: 5,
  dailySoftCap: 2,
  firstMissionGuaranteed: true,
  /** Quality an epic-completion encounter rolls with (the best a mission can reach in v1). */
  surveyQuality: 0.5,
} as const

// DEFAULT: rewards. A mission's cells (SPEC 7.2): Reinforced for green tests,
// Stasis for a clean Tactical review; a survey's Singularity Cell.
export const REWARDS = { reinforcedForGreenTests: 1, stasisForCleanReview: 1, singularityForSurvey: 1 } as const

// SPEC 6.4 (range), DEFAULT (mapping): flora samples a completed mission
// harvests, from `min` at quality 0 to `max` at quality 1 (rounded). Each
// sample's species is drawn by its tier's encounter odds (TIER_SPECS).
export const HARVEST = { minSamples: 1, maxSamples: 3 } as const

// SPEC 7.2: cell recipes, and the flora a Singularity Cell spends to activate.
export const CRAFT: Record<'reinforced' | 'stasis', { tier: Tier; samples: number }> = {
  reinforced: { tier: 'common', samples: 3 },
  stasis: { tier: 'rare', samples: 2 },
}
export const SINGULARITY_ACTIVATION = { tier: 'legendary' as Tier, samples: 1 } as const

// DEFAULT (SPEC 6.2 and 7.1 give direction and the +10% maximum)
export const QUALITY = {
  testsGreenWeight: 0.5,
  tacticalCleanWeight: 0.5,
  rarityShiftMax: 0.5,
  containmentBonusMax: 0.1,
} as const

// SPEC 6.3
export type AttachmentClass = 'minor' | 'major' | 'mythic'
export const ATTACHMENT_ODDS = { none: 0.85, minor: 0.11, major: 0.035, mythic: 0.005 } as const
export const ATTACHMENT_ITEMS: Record<AttachmentClass, readonly string[]> = {
  minor: ['scarf', 'antenna tag', 'goggles'],
  major: ['top hat', 'visor', 'cybernetic eye'],
  mythic: ['crown', 'halo', 'orbiting moonlet'],
}

// SPEC 7.2
export type Cell = 'standard' | 'reinforced' | 'stasis' | 'singularity'
export const CELLS: Record<Cell, { bonus: number; label: string }> = {
  standard: { bonus: 0, label: 'Standard' },
  reinforced: { bonus: 0.15, label: 'Reinforced' },
  stasis: { bonus: 0.3, label: 'Stasis' },
  singularity: { bonus: 0.5, label: 'Singularity' },
}

// SPEC 7.1
export const CONTAINMENT_CAP = 0.98

// SPEC 8 (types, bonus ends), DEFAULT (the rest). Analyze Specimen.
export type PuzzleType = 'pattern-id' | 'complexity-read' | 'trace' | 'bug-hunt'
export const PUZZLE = {
  /** The type each tier asks for; a type not built yet falls back down this order (SPEC 8). */
  typeByTier: {
    common: 'pattern-id', uncommon: 'complexity-read', rare: 'trace', exotic: 'bug-hunt', legendary: 'design-probe', anomaly: 'deep-expedition',
  } as Record<Tier, string>,
  /** Types in tier order, lowest first: a tier falls back to the nearest built one at or below it. */
  typeOrder: ['pattern-id', 'complexity-read', 'trace', 'bug-hunt', 'design-probe', 'deep-expedition'] as readonly string[],
  /** Bonus for a right answer, +10% at Common to +25% at Legendary (SPEC 8). */
  bonusByTier: { common: 0.1, uncommon: 0.14, rare: 0.17, exotic: 0.21, legendary: 0.25, anomaly: 0.25 } as Record<Tier, number>,
  /** Up to this much more for a fast right answer: all of it at once, none at `fastWithinMs`. */
  fastBonusMax: 0.05,
  fastWithinMs: 60_000,
  /** Units kept from one mission's changes, and their size in lines. */
  maxUnits: 6,
  unitMinLines: 4,
  unitMaxLines: 40,
  /** A file with a longer line (minified code) is blanked whole: the filter is not run over it. */
  maxLineChars: 2_000,
  /** A longer line is never read as a function's first line (its patterns backtrack on long lines). */
  maxSignatureChars: 300,
  /** PHP: lines a signature may run over before its body's `{` (PSR-12 puts it on its own line). */
  maxSignatureLines: 12,
  /** Changed files read for units, and the largest read. */
  maxFiles: 20,
  maxFileBytes: 262_144,
  /** git calls while preparing. */
  gitTimeoutMs: 10_000,
  /** Model calls: Sonnet by default (setting), small answers. */
  defaultModel: 'sonnet' as GenerationModel,
  maxTokens: 1_500,
  timeoutMs: 90_000,
  /** What a generated puzzle may be, in characters. */
  maxQuestionChars: 160,
  maxChoiceChars: 60,
  maxExplanationChars: 320,
  /** Bug Hunt: choices offered (lines), and the fewest candidate lines a unit needs. */
  choices: 4,
  /**
   * SPEC 8.2, D4: spaced repetition. Where the game picks a puzzle's category
   * (Bug Hunt's defect), each category weighs 1, plus this much times its miss
   * rate over the recent answers: one missed every time comes up 4 times as
   * often as one never answered or always right.
   */
  weakWeight: 3,
  /** SPEC 8.1 rule 4: disputed puzzles kept for review, newest last. */
  maxDisputes: 50,
} as const

/** SPEC 8: the Analyze pane's size and layout, and the readability gates on puzzle units. */
export const PUZZLE_VIEW = {
  /** Share of the terminal's columns the dock is asked for: at least `twoColumnMin`, leaving the transcript `minTranscriptColumns`. */
  dockShare: 0.6,
  minTranscriptColumns: 40,
  /** Body columns from which the code and the panel sit side by side; the panel's width there. */
  twoColumnMin: 80,
  panelColumns: 30,
  /** Rows the code window keeps when the panel sits beneath it. */
  minCodeRows: 3,
  /** Rows the panel's Input takes. */
  inputRows: 1,
  /** Inline: rows asked for beyond the code and choices (heading, question, result, hints), and rows left to the prompt. */
  panelReserveRows: 8,
  inlineReserveRows: 6,
  /** A unit is skipped past these shares of blanked lines or placeholder words; Bug Hunt changes no line past the second. */
  maxBlankShare: 0.5,
  maxPlaceholderShare: 1 / 3,
} as const

// SPEC 8.3 rules 3 and 4 (shape), DEFAULT (numbers). Trace: a unit run by a
// runner on generated inputs. A runner's command and limits; one now (node),
// `python3`, `php` and `sqlite3` take their own rows when their adapters land.
export type RunnerName = 'node'
export const RUNNERS: Record<RunnerName, { binary: string; emptyHome: string; maxOldSpaceMb: number; timeoutMs: number; outputMaxChars: number }> = {
  node: { binary: 'node', emptyHome: '/nonexistent', maxOldSpaceMb: 32, timeoutMs: 10_000, outputMaxChars: 65_536 },
}
export const TRACE = {
  /** Each call of the function, inside the runner; and all of them together. */
  callTimeoutMs: 1_000,
  totalMs: 4_000,
  /** A result: nesting depth and its JSON's length, inside the runner. */
  maxDepth: 8,
  maxValueChars: 2_000,
  /** Probed once per session. */
  probeTimeoutMs: 5_000,
  /** Input tuples generated per unit, and units tried (one runner call each). */
  candidates: 6,
  maxUnits: 2,
  /** Generated inputs: integers in [min, max], arrays of 0 to maxArrayLength items. */
  intMin: -5,
  intMax: 12,
  maxArrayLength: 5,
  /** Words a string input is drawn from: short, lowercase, invented. */
  words: ['nova', 'comet', 'orbit', 'flux', 'quark', 'ion', 'zeta', 'lumen'] as readonly string[],
  /** The answer and each choice, as compact JSON, in characters. */
  maxAnswerChars: 40,
} as const

// SPEC 5.2. A first-stage hatchling is often drawn in 5 to 7 cells: the minimum admits it.
export const SPRITE = { cols: 14, rows: 7, maxArtRetries: 2, minSilhouetteCells: 5 } as const

// SPEC 7.3 (shape), DEFAULT (numbers)
export type LatticeTwist = 'none' | 'shift' | 'reverse' | 'break' | 'flicker'
export const LATTICE: Record<Tier, { locks: number; zone: number; sweepMs: number; twist: LatticeTwist }> = {
  common: { locks: 1, zone: 0.3, sweepMs: 2000, twist: 'none' },
  uncommon: { locks: 2, zone: 0.3, sweepMs: 1400, twist: 'none' },
  rare: { locks: 3, zone: 0.18, sweepMs: 1400, twist: 'shift' },
  exotic: { locks: 3, zone: 0.1, sweepMs: 900, twist: 'reverse' },
  legendary: { locks: 4, zone: 0.1, sweepMs: 900, twist: 'break' },
  anomaly: { locks: 5, zone: 0.06, sweepMs: 700, twist: 'flicker' },
}
export const LATTICE_SHARED = {
  barCells: 30,
  frameMs: 40,
  centerFraction: 0.3,
  lockBonusTotal: 0.2,
  centerHitBonus: 0.02,
  maxBonus: 0.25,
  reverseChancePerSecond: 0.6,
  flickerPeriodMs: 300,
  flickerVisibleFraction: 0.7,
  erraticJitter: 0.35,
  /** Each miss (including a press while the needle is still inside a zone it just sealed) costs this much bonus. */
  missPenalty: 0.03,
} as const

// DEFAULT
export const CALIBRATION = { beats: 8, beatIntervalMs: 750, maxAbsOffsetMs: 400 } as const

// SPEC 5.1 (slots), DEFAULT (model and limits)
export type GenerationModel = 'opus' | 'sonnet' | 'haiku'
export const GENERATION = {
  defaultModel: 'opus' as GenerationModel,
  maxTokens: 16_000,
  timeoutMs: 180_000,
  // Sized to an epic of five to ten missions (SPEC 5.1); flora tiers are the ones cell recipes use (7.2).
  faunaSlots: { common: 3, uncommon: 2, rare: 1, exotic: 1, legendary: 1, anomaly: 1 } as Record<Tier, number>,
  floraSlots: { common: 2, uncommon: 0, rare: 1, exotic: 0, legendary: 1, anomaly: 0 } as Record<Tier, number>,
  faunaStages: 3,
  floraStages: 1,
  maxNameLength: 24,
  maxBiomes: 4,
  maxStarClassLength: 8,
  /** Chance a procedural name gets a second vowel group. */
  extraSyllableChance: 0.5,
} as const

// DEFAULT: /scan (SPEC 9.4). Unmet lifeforms of `namedTiers` are named; of
// `hiddenTiers` never shown; the rest are counted, or drawn as a silhouette
// once resolved.
export const SCAN = {
  namedTiers: ['common', 'uncommon'] as readonly Tier[],
  hiddenTiers: ['anomaly'] as readonly Tier[],
  silhouetteChar: '#',
} as const

// SPEC 8.2, DEFAULT: the Dossier. A category keeps its last `recentWindow`
// answers. With at least `minAnswers` of them, its recent accuracy against
// its overall accuracy reads `up` (at least `trendMargin` above), `down` (at
// least that far below) or `steady`; with fewer, no trend. The weakest
// category is marked once it has `minAnswers` answers and a miss. Groups
// follow `typeOrder`, with these labels; a type not listed follows, by id.
export const DOSSIER = {
  recentWindow: 10,
  minAnswers: 5,
  trendMargin: 0.1,
  typeOrder: ['pattern-id', 'complexity-read', 'bug-hunt', 'trace'] as readonly string[],
  typeLabels: { 'pattern-id': 'Pattern ID', 'complexity-read': 'Complexity Read', 'bug-hunt': 'Bug Hunt', trace: 'Trace' } as Record<string, string>,
} as const

// SPEC 8.4, DEFAULT: Complexity Read (spec docs/superpowers/specs/2026-10-13-complexity-read-design.md).
// The question's rule line, the distractors for each answer, and per language the
// builtins the readers know: everything not listed fails closed.
export const COMPLEXITY = {
  maxQuestionChars: 160,
  /** Task 7 fix round 1, ruling A: the largest magnitude a shown number literal may have (2^31 - 1). A literal beyond a type's range is constant against it (PHP's 64-bit ints, TS's `1e400` = Infinity, any Python int below `1e400`), which would make a guard always or never true. */
  maxLiteral: 2_147_483_647,
  ruleText: "Worst case. Built-in operations over a whole collection (search, copy, sum, join, map, filter) cost its size; sorts size × log size; hash lookups and appends 1; comparing or hashing one element 1; other calls 1. Sizes: a collection's or string's length, or a number's value.",
  distractors: {
    'O(log n)': ['O(1)', 'O(n)', 'O(n log n)'],
    'O(n)': ['O(log n)', 'O(n log n)', 'O(n²)'],
    'O(n log n)': ['O(n)', 'O(n²)', 'O(log n)'],
    'O(n²)': ['O(n)', 'O(n log n)', 'O(n³)'],
    'O(n³)': ['O(n²)', 'O(n log n)', 'O(n)'],
    'O(n·m)': ['O(n + m)', 'O(n²)', 'O(n)'],
    'O(n + m)': ['O(n·m)', 'O(n)', 'O(n²)'],
  } as Record<string, readonly string[]>,
  // Spec "Builtins", per language: { sort, linear, constant, fails, derive, mutate, globals, iterators },
  // each a readonly string[] copied from the spec.
  builtins: {
    TypeScript: {
      sort: ['sort', 'toSorted'],
      linear: ['includes', 'indexOf', 'lastIndexOf', 'find', 'findIndex', 'findLast', 'findLastIndex', 'filter', 'map', 'reduce', 'reduceRight', 'some', 'every', 'forEach', 'slice', 'concat', 'join', 'toReversed', 'entries', 'keys', 'values', 'Array.from', 'Object.keys', 'Object.values', 'Object.entries', 'Set', 'Map', 'JSON.stringify', 'Math.max', 'Math.min'],
      constant: ['has', 'get', 'set', 'add', 'delete', 'push', 'pop', 'at', 'length', 'size', 'charAt', 'charCodeAt', 'codePointAt', 'Math', 'Number', 'parseInt'],
      fails: ['flat', 'flatMap', 'split', 'replace', 'replaceAll', 'splice', 'Object.assign', 'JSON.parse', 'structuredClone', 'eval', 'Function', 'arguments', 'Reflect'],
      derive: ['filter', 'map', 'slice', 'toSorted', 'toReversed', 'Array.from', 'Object.keys', 'Object.values', 'Object.entries'],
      mutate: ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin', 'set', 'add', 'delete', 'clear'],
      // The ECMAScript global functions, constructors and namespaces, and the reflective names that reach bound values unnamed.
      globals: ['AggregateError', 'Array', 'ArrayBuffer', 'Atomics', 'BigInt', 'BigInt64Array', 'BigUint64Array', 'Boolean', 'DataView', 'Date', 'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'Error', 'escape', 'eval', 'EvalError', 'FinalizationRegistry', 'Float32Array', 'Float64Array', 'Function', 'globalThis', 'Int8Array', 'Int16Array', 'Int32Array', 'Intl', 'isFinite', 'isNaN', 'Iterator', 'JSON', 'Map', 'Math', 'Number', 'Object', 'parseFloat', 'parseInt', 'Promise', 'Proxy', 'RangeError', 'ReferenceError', 'Reflect', 'RegExp', 'Set', 'SharedArrayBuffer', 'String', 'Symbol', 'SyntaxError', 'TypeError', 'Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array', 'unescape', 'URIError', 'WeakMap', 'WeakRef', 'WeakSet', 'arguments', 'this'],
      iterators: ['forEach', 'map', 'filter', 'find', 'findIndex', 'some', 'every', 'reduce'],
    },
    // The reader counts fewer than these lists name (spec "Stricter readings (Python reader, Task 6)"):
    // `index`, `any` and `all` refuse; every name here stays a word no hidden line may hold.
    Python: {
      sort: ['sorted', 'sort'],
      linear: ['count', 'copy', 'list', 'set', 'dict', 'tuple', 'sum', 'min', 'max', 'index', 'any', 'all'],
      constant: ['len', 'append', 'add', 'discard', 'get', 'pop', 'abs', 'int', 'float', 'bool'],
      fails: ['insert', 'remove', 'extend', 'update', 'join', 'split', 'replace', 'map', 'filter', 'zip', 'iter', 'next', 'print', 'pow', 'str', 'repr', 'format', 'exec', 'eval', 'compile', 'getattr', 'setattr', 'delattr', 'hasattr', 'locals', 'vars', 'globals', 'dir', '__import__', '__dict__', '__class__', '__builtins__'],
      derive: ['sorted', 'list', 'set', 'tuple', 'copy'],
      mutate: ['append', 'extend', 'insert', 'remove', 'pop', 'clear', 'update', 'add', 'discard', 'sort', 'reverse', 'setdefault', 'popitem'],
      // Python's builtin functions and names (exception classes aside: calling one is a helper call).
      globals: ['__build_class__', '__debug__', '__doc__', '__import__', '__loader__', '__name__', '__package__', '__spec__', 'abs', 'aiter', 'all', 'anext', 'any', 'ascii', 'bin', 'bool', 'breakpoint', 'bytearray', 'bytes', 'callable', 'chr', 'classmethod', 'compile', 'complex', 'copyright', 'credits', 'delattr', 'dict', 'dir', 'divmod', 'enumerate', 'eval', 'exec', 'exit', 'filter', 'float', 'format', 'frozenset', 'getattr', 'globals', 'hasattr', 'hash', 'help', 'hex', 'id', 'input', 'int', 'isinstance', 'issubclass', 'iter', 'len', 'license', 'list', 'locals', 'map', 'max', 'memoryview', 'min', 'next', 'object', 'oct', 'open', 'ord', 'pow', 'print', 'property', 'quit', 'range', 'repr', 'reversed', 'round', 'set', 'setattr', 'slice', 'sorted', 'staticmethod', 'str', 'sum', 'super', 'tuple', 'type', 'vars', 'zip'],
      iterators: ['range', 'enumerate', 'reversed', 'items', 'keys', 'values'],
    },
    // Spec "Stricter readings (PHP reader, Task 7)". Names are matched case-folded. Every global function
    // not in `sort`, `linear` or `constant` refuses the unit; every name here stays a word no hidden line may hold.
    PHP: {
      sort: ['sort', 'rsort', 'asort', 'arsort', 'ksort', 'krsort', 'usort', 'uasort', 'uksort'],
      linear: ['in_array', 'array_search', 'array_keys', 'array_values', 'array_sum', 'array_reverse', 'array_flip', 'max', 'min', 'array_slice', 'array_map', 'array_filter', 'array_reduce'],
      constant: ['count', 'strlen', 'isset', 'empty', 'array_key_exists', 'array_key_first', 'array_key_last', 'abs', 'intdiv', 'max', 'min'],
      // implode: its cost grows with its separator's length, and no literal separator is ever shown (fix round 1, ruling B).
      fails: ['implode', 'array_merge', 'array_unique', 'array_column', 'array_push', 'array_pop', 'array_shift', 'array_unshift', 'array_splice', 'array_walk', 'array_fill', 'array_combine', 'array_diff', 'array_intersect', 'range', 'str_repeat', 'explode', 'str_split', 'substr', 'strpos', 'str_contains', 'str_replace', 'str_pad', 'sprintf', 'unset', 'list', 'call_user_func', 'call_user_func_array', 'compact', 'extract', 'eval', 'create_function', 'func_get_args', 'func_get_arg', 'get_defined_vars', 'iterator_to_array', 'json_encode', 'json_decode', 'serialize', 'unserialize', 'preg_match', 'preg_replace', 'echo', 'print', 'global', 'static', 'new', 'clone', 'match', 'switch', 'case', 'try', 'catch', 'finally', 'include', 'include_once', 'require', 'require_once', 'declare', 'instanceof'],
      derive: ['array_keys', 'array_values', 'array_reverse', 'array_filter', 'array_map'],
      mutate: ['sort', 'rsort', 'asort', 'arsort', 'ksort', 'krsort', 'usort', 'uasort', 'uksort', 'array_push', 'array_pop', 'array_shift', 'array_unshift', 'array_splice', 'unset', 'shuffle', 'array_walk'],
      // Common PHP global functions and language constructs besides the lists above: never shown unlisted, never in a hidden line.
      globals: ['array_chunk', 'array_count_values', 'array_diff_key', 'array_fill_keys', 'array_intersect_key', 'array_is_list', 'array_key_exists', 'array_pad', 'array_product', 'array_rand', 'array_replace', 'array_walk_recursive', 'arsort', 'boolval', 'ceil', 'chr', 'ctype_digit', 'current', 'date', 'define', 'defined', 'end', 'file_get_contents', 'file_put_contents', 'filter_var', 'floatval', 'floor', 'fn', 'function_exists', 'get_class', 'gettype', 'htmlspecialchars', 'in_array', 'intval', 'is_array', 'is_bool', 'is_callable', 'is_float', 'is_int', 'is_null', 'is_numeric', 'is_object', 'is_string', 'iterator_count', 'key', 'lcfirst', 'ltrim', 'mb_strlen', 'mb_substr', 'method_exists', 'next', 'number_format', 'ord', 'pow', 'preg_split', 'print_r', 'property_exists', 'rand', 'random_int', 'reset', 'round', 'rtrim', 'shuffle', 'sleep', 'sqrt', 'str_ends_with', 'str_starts_with', 'strcmp', 'strrev', 'strtolower', 'strtoupper', 'strval', 'time', 'trigger_error', 'trim', 'ucfirst', 'var_dump', 'var_export', 'array_flip', 'this', 'self', 'parent', 'GLOBALS'],
      iterators: ['array_map', 'array_filter', 'array_reduce', 'usort', 'uasort', 'uksort'],
    },
  } as Record<string, Record<'sort' | 'linear' | 'constant' | 'fails' | 'derive' | 'mutate' | 'globals' | 'iterators', readonly string[]>>,
  // Spec "What the reader reads", rules 3 and 4: a hidden line holds none of
  // the loop or closure words or symbols, and an exit word only in place.
  loopWords: ['for', 'foreach', 'while', 'do'] as readonly string[],
  closureWords: ['function', 'fn', 'lambda', 'def', 'class', 'yield', 'goto'] as readonly string[],
  /** `...` is spread; Python's `*` and `**` unpacking is read by its place. */
  inertSymbols: ['=>', '...'] as readonly string[],
  exitWords: ['return', 'break', 'continue', 'throw', 'raise', 'exit', 'die'] as readonly string[],
  /** Parts of a function or method name that may end the process or raise a signal: a call whose name holds one (any case) is an exit, in a shown or a hidden line, in every language. */
  exitNameParts: ['exit', 'kill', 'abort', 'quit', 'die', 'signal', 'segv', 'crash', 'panic', 'terminate'] as readonly string[],
  /** Python type names that are no class of the code's own: an element of one takes no attribute read (it may be None, a container or a primitive). */
  pythonNotClasses: ['Any', 'AnyStr', 'Optional', 'Union', 'Literal', 'None', 'NoneType', 'Type', 'Self', 'Never', 'NoReturn', 'List', 'Dict', 'Set', 'FrozenSet', 'Tuple', 'Sequence', 'MutableSequence', 'Mapping', 'MutableMapping', 'AbstractSet', 'MutableSet', 'Iterable', 'Iterator', 'Generator', 'Collection', 'Container', 'Reversible', 'Sized', 'Hashable', 'Callable', 'Awaitable', 'Coroutine', 'AsyncIterable', 'AsyncIterator', 'Deque', 'DefaultDict', 'Counter', 'OrderedDict', 'ChainMap', 'Text', 'ByteString', 'TypeVar', 'Protocol', 'Generic', 'Final', 'ClassVar', 'Annotated', 'TypedDict', 'NamedTuple'] as readonly string[],
  /** Python words a hidden line may not hold besides the lists: statements that raise, unbind or reach other scopes. */
  pythonHiddenWords: ['assert', 'del', 'global', 'nonlocal', 'await', 'async', 'import'] as readonly string[],
} as const

// DEFAULT: drawing colors (SPEC 6.2, 9). Tier colors are in TIER_SPECS; the
// Anomaly's `cycle` steps through `cycle` every `cycleMs`. Status colors are
// theme keys, so they follow the person's light or dark theme.
export const COLORS = {
  cycle: ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta'] as readonly string[],
  cycleMs: 1_000,
  good: 'success',
  caution: 'warning',
  bad: 'error',
  /** Hull below this pass rate is a warning; at zero, an error. */
  hullCautionBelow: 1,
  /** Fuel percent below these is a warning, then an error. */
  fuelCautionBelow: 25,
  fuelBadBelow: 10,
} as const

// SPEC 10
export const STORE = { prefix: 'fc:', schemaVersion: 10 } as const

// DEFAULT: companion band (SPEC 9.3) and pane timings
export const COMPANION = { reactMs: 60_000, sleepAfterMs: 600_000, blinkEveryMs: 3_000, blinkMs: 200, spriteMinRows: 9, spriteGap: 2, besideMinColumns: 6 } as const
export const PANES = { calibrationLeadInMs: 1_000, calibrationBeatGlowMs: 150, calibrationTickMs: 25 } as const

// SPEC 9.3 (evolution levels), DEFAULT (the rest): companion XP. The active
// companion earns `missionBase + round(missionQuality * q)` for a completed
// mission that counted, `survey` for an epic survey. Level L to L + 1 takes
// `levelBase + levelStep * (L - 1)` XP, up to `maxLevel`. `evolveAt[i]` is
// the level stage i + 1 is reached at; evolution never reverts.
export const COMPANION_XP = { missionBase: 10, missionQuality: 10, survey: 25, levelBase: 15, levelStep: 5, maxLevel: 99, evolveAt: [10, 25] as readonly number[] } as const

// DEFAULT: the status line shares 40 columns with the engine's own prefix (about 18 cells).
export const STATUS = { maxColumns: 22 } as const

// DEFAULT: the status line's charting indicator (a spinner frame per step).
export const CHARTING = { spinnerMs: 400, frames: ['|', '/', '-', '\\'] } as const

// DEFAULT: how long a git call from the Bash observer may take, and how much
// of a command's output (its end, where runners print summaries) is read.
export const GIT = { timeoutMs: 5_000, outputTailChars: 4_000 } as const

// SPEC 4.2: tracker sync. A poll every 12 minutes (inside the 10 to 15 the
// SPEC gives); each query reaches back `overlapMs` before the last sync so a
// tracker clock a little behind ours loses nothing (idempotency drops repeats).
// `maxWaiting`: changes one record keeps waiting (rule 5), the newest kept.
export const SYNC = { pollMs: 720_000, overlapMs: 60_000, maxProcessed: 500, maxWaiting: 100 } as const

// DEFAULT: a chart a work source started that failed waits `firstMs` before
// it is tried again, doubling with each failure in a row up to `maxMs`.
export const CHART_RETRY = { firstMs: 1_800_000, maxMs: 21_600_000 } as const

// DEFAULT: plan documents (SPEC 4.4 rule 3). Folders read when the setting
// is empty; files larger than `maxFileBytes` are skipped; `keepLog` changes
// are kept for the sync to read back; an epic's description is cut to
// `maxDescriptionChars` before the privacy filter sees it.
export const PLANS = { defaultFolders: ['docs/plans'] as readonly string[], maxFileBytes: 262_144, keepLog: 1_000, maxDescriptionChars: 2_000 } as const

// DEFAULT: GitHub Issues (SPEC 4.4). Issues per GraphQL page: your own
// (with bodies, so fewer) and closed epics (numbers only); the most recently
// updated closed milestones per page; the most pages one
// poll reads per repo and query; an epic's description is cut to
// `maxDescriptionChars`; an error shown from gh to `maxErrorChars`; one gh
// call may take `timeoutMs`.
export const GITHUB = { minePageSize: 25, epicsPageSize: 100, milestonesPageSize: 50, maxPages: 20, maxDescriptionChars: 2_000, maxErrorChars: 120, timeoutMs: 30_000 } as const

// DEFAULT: Jira Cloud (SPEC 4.4 rule 7). Issues per search page and the most
// pages one poll reads per query; an epic's description is cut to
// `maxDescriptionChars`; Jira's own error text to `maxErrorChars`.
export const JIRA = { pageSize: 100, maxPages: 20, maxDescriptionChars: 2_000, maxErrorChars: 120 } as const

// SPEC 4.3 rules 1 and 2: what a tracker-closed mission needs to roll an encounter.
export const ANTI_FARMING = { minMissionMs: 1_200_000 } as const

// DEFAULT: SPEC 9.2 red alert. The status line flashes on every alert; a toast at most once per cooldown.
export const RED_ALERT = { flashMs: 8_000, toastCooldownMs: 300_000 } as const

// DEFAULT: SPEC 9.2 captain's log. Entries kept in the save, and the most lines one shows.
export const CAPTAINS_LOG = { keep: 20, maxLines: 12 } as const

// DEFAULT: the Bridge pane (SPEC 9). Gauge bar width in cells, and log lines shown from the newest entry.
export const BRIDGE = { gaugeCells: 10, logLines: 3 } as const

// DEFAULT: crew subagents (SPEC 9.1). The most turns each officer takes.
// `reportLines`: the most lines of a report the report pane shows for a crew run launched from the Bridge.
export const CREW = { maxTurns: { engineering: 40, science: 40, tactical: 40 }, reportLines: 40 } as const
