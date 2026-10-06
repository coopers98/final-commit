# The Final Commit

> *Space: the final commit.*

A Claude Code mod that turns real development work into a sci-fi exploration game. Epics are star systems. Missions are units of work. Finishing work triggers encounters with **Difflings**, procedurally generated alien flora and fauna that you contain, collect, and raise as companions. Optional puzzles built from your own diffs boost containment odds and double as interview prep.

Status: v1 "First Diffling" slice implemented (section 12). Repository: github.com/coopers98/final-commit (public). Last updated 2026-10-06.

Not affiliated with or endorsed by Anthropic or Paramount. Claude Code is a product of Anthropic.

---

## 1. Goals and non-goals

**Goals**

1. Make daily dev work more fun without slowing it down.
2. Reward good engineering habits (tests, reviews, ticket hygiene) through game mechanics.
3. Provide low-friction, spaced-repetition interview practice drawn from real work.
4. Stay entirely inside the terminal; playable over SSH, including from a phone.

**Non-goals**

1. The game never changes how Claude writes or edits code. Flavor lives in the UI, not the system prompt.
2. No multiplayer or leaderboards in v1 through v3.
3. No anti-cheat beyond preventing accidental farming. This is a solo game.

---

## 2. Runtime environment

| Item | Decision |
|---|---|
| Host | Any machine running Claude Code. Reference setup: a remote dev host reached over SSH. Machine-specific details live in the gitignored `CLAUDE.local.md`, never in the repo. |
| Access | Claude Code in a terminal, often over SSH and inside tmux. Clients may include desktops and phones. |
| Save data | `$.store` on the host. One save regardless of client device. |
| Required on the host | Claude Code, `git`, `php` CLI (puzzle answer verification), Jira access (MCP connector or API token). |

### Remote terminal constraints (verified against the mod API, Claude Code 2.1.291)

1. **Audio:** `$.audio.play` uses `afplay` on macOS; a Linux terminal has no player and plays nothing. On a Linux host, sounds are silent. The mod API has no way to emit a terminal bell (checked on 2.1.291), so alerts are visual: toasts and the status line.
2. **Latency:** keypresses travel over SSH. A LAN or mesh VPN adds a few ms; cellular adds 50 to 150 ms with jitter. The containment mini-game must calibrate for this (section 7.3).
3. **Focus:** mouse clicks may not pass through tmux/SSH. Interactive screens open from a slash command as **focused dialog panes** (`focus`, `closeOnEscape`, `holdToasts`) holding an `autoFocus` `Input`, which receives every keystroke without a click (verified in tmux at 100 and 40 columns). A `Client` element receives keys only after a mouse click, so it is never used for input. A focused pane with nothing focusable in it sends keys to the main prompt.
4. **Images:** kitty graphics through tmux is unreliable. All art is ASCII/Unicode text.
5. **Width:** a pane opened unprompted only seats at 144+ columns, so every pane opens from a command. The band, status line, and mini-game render at 40 columns minimum. The engine prefixes the status line with the plugin's name (about 18 cells), so the mod's own status text is at most 22.
6. **Height:** a short terminal clips a pane from the top. Panes put decoration first and essentials last, and the band steps aside while a game pane is open.
7. **Transcript:** a slash command's arguments and its output text are recorded in the transcript the model reads. Commands therefore never take work text as arguments (epic text is typed into a pane) and print only short factual lines; game flavor goes in toasts, panes, the band and the status line.

---

## 3. Core loop

```
Epic starts ──> System charted (flora + fauna generated)
     │
     ▼
Mission starts ──> work happens (commits, tests, reviews tracked)
     │
     ▼
Mission completes ──> scored ──> encounter roll
     │                               │
     │                        (encounter!)
     │                               ▼
     │              Scan ─> optional puzzle ─> choose cell ─> containment mini-game
     │                               │
     │                 contained / broke free (retry) / fled
     ▼
Epic completes ──> System surveyed: guaranteed high-rarity encounter + Singularity Cell
```

Flora are harvested (no containment) during missions and used to craft cells.

---

## 4. Work detection

Detection is automatic. Jira is the source of truth; git and session activity are the instant signals. Manual commands exist as overrides only.

### 4.1 Signal map

| Game event | Jira signal | Git / session signal |
|---|---|---|
| System charted | Epic moves to In Progress, or its first child issue starts | First branch created containing a child issue key |
| Mission starts | Story/task moves to In Progress | Checkout of a branch matching `*/<KEY>-*` |
| Mission work tracked | | Commits, test runs, Tactical reviews on that branch during sessions |
| Mission completes | Issue moves to Done | PR merge or branch delete (backup) |
| System surveyed | Epic moves to Done | |

### 4.2 Sync model

1. On `session.start`: one catch-up query, `assignee = currentUser() AND status CHANGED AFTER "<lastSync>"`.
2. During a session: poll every 10 to 15 minutes via `$.clock`.
3. Git signals: observe `tool.call` on `Bash` for `git checkout`, `git switch`, `git commit`, test commands (`php artisan test`, `pest`, `phpunit`, `npm test`). Also read `git` state via `$.process` on session start.
4. **Idempotency:** every processed transition is recorded as `<issueKey>:<transitionId>`. Reloads and restarts never double-award.
5. **Order and waiting** (`src/detect/sync.ts`): transitions apply oldest first; at one instant a start goes before a Done. Each query reaches back one minute before `lastSync`; the processed list (newest 500) drops repeats. The first sync only records its start: nothing earlier is awarded. A transition that cannot apply yet waits: an issue whose epic is still being charted (its start charts the epic, SPEC 4.1), an issue's Done while its epic is still being charted, or an epic Done while an encounter holds the slot. A waiting transition holds back later ones for the same epic, so an issue's Done is never read before its start, and `lastSync` does not move past it.
6. **Mapping:** a chart the tracker starts does not change the active epic. An issue's start makes its epic the active one and starts the mission (timed from the tracker's start, not the poll that saw it), unless a mission is already active (one at a time; the second issue is not tracked) or that issue was completed before. An issue outside any epic is ignored. Done on the active mission completes it; Done on any other issue of a charted epic is logged as an administrative closure (no rewards; its branch can no longer start it). An epic's Done surveys that epic and leaves a different active epic alone.

The sync engine runs against the `WorkSource` interface (`src/detect/work-source.ts`). No backend exists yet, so nothing calls it in a session: the session-start catch-up and the 12-minute poll are wired with the first backend.

### 4.3 Anti-farming

1. A Done issue only rolls an encounter if it has **attached work**: commits on its branch or session activity tied to its key. Administrative closures count toward epic progress only. Applies to tracker closures; `/mission complete` is the manual override and is not checked.
2. Minimum mission duration of 20 minutes from start to done, or a non-empty diff. Together with rule 1: a commit (a non-empty diff) qualifies at once; test runs alone need the 20 minutes. A closure that fails these completes without rewards (no encounter, no Reinforced Cell) and does not use up the first mission's guarantee (D10).
3. Soft cap of 2 encounters per calendar day (host local time, configurable). **Enforced in v1** for mission encounters; epic surveys and developer-mode encounters are exempt.
4. **v1:** a branch only starts a mission when its key belongs to the active epic's project and that mission was never completed, so checkouts cannot pay out twice.
5. **v1:** a plain test run is judged by its exit status. One whose exit status may not be the runner's (piped `| tail`, guarded `|| true`, backgrounded `&`) is judged by the runner's own summary in the end of its output (bun/`claude plugin test`, jest, vitest, pest, pytest, phpunit, go, cargo formats); with no summary visible it counts as not passing. Wrappers that pass the exit status through (`timeout`, `time`, `nice`, `env`) are seen past, and redirections like `2>&1` change nothing. Failed commits are not counted.

### 4.4 Access options

| Option | Notes |
|---|---|
| Atlassian MCP connector | `$.mcp.call(server, tool, args)` uses Claude Code's existing connection and credentials. Simplest if configured on the host. |
| Jira REST + API token | `$.http.fetch` with token from plugin `userConfig` (secret). No dependency on a connector. |

The adapter is an interface (`WorkSource`) so either backend, or a future GitHub Issues backend, plugs in.

### 4.5 Manual overrides

`/epic <KEY>`, `/epic complete`, `/mission <KEY>`, `/mission complete` exist for testing and for work not tracked in Jira. `/epic <KEY>` takes the key only and opens a pane for the title and description (section 2, constraint 7). `/epic complete` is refused while an encounter is waiting, so its guaranteed encounter is never lost.

Other v1 commands: `/contain [reinforced]` (section 7), `/calibrate` (7.3), `/bay` and `/bay companion N` (9), and `/encounter`, which forces an encounter and exists only when the `devMode` setting is on.

---

## 5. Star systems (epics)

### 5.1 Generation

When an epic is charted, **one** `$.model.complete` call generates the full ecosystem, themed from the epic's title and description.

**Engine-controlled (never left to the model):**

- Rarity slots per system: 6 Common, 4 Uncommon, 3 Rare, 2 Exotic, 1 Legendary, 1 hidden Anomaly (fauna); 4 Common, 3 Uncommon, 2 Rare, 1 Legendary (flora).
- Stat ranges by tier, containment rates, flee rates, attachment rolls.
- Grid size and anchor schema for art.

**Model-generated:**

- System name, star class, planets/biomes, lore blurb.
- Per species: name, scan readout, behavior notes, evolution line (3 stages for fauna), ASCII art per stage, anchor points.

### 5.2 Art validation

1. Each sprite is a fixed **14 x 7** grid of monospace-safe characters.
2. Validator checks dimensions, character width (no wide or ambiguous-width glyphs), and a silhouette of at least 5 non-space cells (a first-stage hatchling is often drawn that small).
3. On failure: retry that species up to 2 times, telling the model what was wrong with each sprite; then fall back to a procedurally assembled sprite from a parts library.
4. Each sprite declares anchors: `head`, `neck`, `hand`, `orbit`. Attachments render on top at these anchors in code.

### 5.3 Privacy filter

Before any epic text or code reaches a prompt: strip string literals, fixture data, and anything matching PHI-like patterns (names, DOBs, MRNs, SSN shapes). Required for regulated codebases (healthcare, finance). On by default; opt-out only. Prompts receive structure, not data.

v1 filters epic prose (`src/puzzle/privacy-filter.ts`); the code filter for puzzles (literals in code, fixtures) comes with v3. The `privacyMode` setting:

| Mode | Replaces |
|---|---|
| `standard` | Quoted text, issue keys, URLs, emails, IPs and hostnames, phone numbers, SSN-, date- and ID-shaped values (including labelled record numbers), ages, ZIP codes, names after a title or a role word (`Dr.`, `patient`), long numbers. |
| `strict` (default) | Everything in `standard`, plus every capitalized word not on a short allowlist of common title words and technical acronyms. |
| `off` | Nothing. |

The epic key never enters a prompt. Known limit: a lowercase name in plain prose cannot be told from an ordinary word in any mode.

### 5.4 Closed systems

**Open decision D1.** Default: a system stays revisitable after its epic closes, at 25% of its normal encounter rate. Alternative: locks permanently (urgency).

---

## 6. Encounters

### 6.1 Encounter roll (per completed mission)

- Base 12%, plus 12% per day since the last encounter.
- Guaranteed on the first completed mission at day 5 or later.
- Epic completion: guaranteed encounter with rarity rolled from a boosted table (no Commons).

### 6.2 Rarity

| Tier | Encounter odds | Base containment | Flee per failed attempt | Color | Glyph |
|---|---|---|---|---|---|
| Common | 50% | 90% | 10% | gray | `·` |
| Uncommon | 28% | 70% | 20% | green | `◇` |
| Rare | 14% | 45% | 35% | blue | `◆` |
| Exotic | 6% | 25% | 50% | purple | `✦` |
| Legendary | 1.8% | 10% | 65% | gold | `★` |
| Anomaly | 0.2% | 5% | 80% | cycling | `✺` |

Mission quality shifts rarity odds upward (tests run and passing, Tactical review clean). It does not change encounter frequency.

Color is never the only indicator: every tier has a glyph and a text label (colorblind-safe, theme-safe).

### 6.3 Attachments (independent of tier)

| Class | Odds | Examples |
|---|---|---|
| None | 85% | |
| Minor | 11% | scarf, antenna tag, goggles |
| Major | 3.5% | top hat, visor, cybernetic eye |
| Mythic | 0.5% | crown, halo, orbiting moonlet |

Catalog tracks every species x tier x attachment combination seen.

### 6.4 Flora

Flora are harvested automatically on completed missions (1 to 3 samples by mission score). Flora never flee. Samples craft cells (section 7.2).

---

## 7. Containment

### 7.1 Flow

1. **Scan:** creature art, tier, readout.
2. **Analyze (optional puzzle):** section 8. Skippable.
3. **Choose cell.**
4. **Seal the Lattice** mini-game.
5. **Final roll:** base rate + cell bonus + puzzle bonus + mini-game bonus + mission quality bonus (max +10%), capped at 98%.
6. On failure: flee roll. If it does not flee, it broke free; retry with a new cell. If it flees, it is logged as **Escaped** with its silhouette in the catalog.

The attempt itself is always guaranteed: Standard Cells are unlimited.

### 7.2 Cells

| Cell | Bonus | Source |
|---|---|---|
| Standard | +0% | Unlimited |
| Reinforced | +15% | Full test suite passing on mission complete; or craft from 3 Common flora |
| Stasis | +30% | Tactical review with no findings; or craft from 2 Rare flora |
| Singularity | +50% | Epic completion only (requires 1 Legendary flora to activate) |

### 7.3 Seal the Lattice (mini-game)

A needle sweeps across a bar; press **Space** inside the green zone to seal a lock.

| Tier | Locks | Zone | Speed | Twist |
|---|---|---|---|---|
| Common | 1 | Wide | Slow | |
| Uncommon | 2 | Wide | Medium | |
| Rare | 3 | Medium | Medium | Zone shifts after each lock |
| Exotic | 3 | Narrow | Fast | Needle reverses randomly |
| Legendary | 4 | Narrow | Fast | A miss breaks one sealed lock |
| Anomaly | 5 | Very narrow | Erratic | Zone flickers |

- Each sealed lock adds containment bonus; center hits add a precision bonus.
- **One seal per pass:** after a seal, presses miss until the needle has left the zone, so mashing Space or holding it down cannot win. Each miss costs bonus (section 16).
- **Latency calibration:** one-time `/calibrate` (press Space on a beat 8 times); measured median offset is stored per device and applied as hit-window shift. A device is the attached tmux client (its tty and terminal type) when under tmux, else `TERM` plus the SSH client address; it is stored only as a salted hash. Containment suggests `/calibrate` when the current device has no measurement.
- **Escape** pauses, never fails: the encounter stays waiting and `/contain` resumes it.
- **Enter** throws the cell early, with whatever bonus the sealed locks have earned.
- **Results stay up** until Enter or Esc. The finished pane keeps a focused input, so a late Space lands in the pane, never in the prompt (where a leading space turns the next slash command into a chat message). The same goes for `/calibrate`.
- Implementation: the model is pure (`src/contain/lattice-model.ts`) and runs in the plugin on a 40 ms `$.clock.every` timer; the focused pane's `Input` delivers Space presses (a burst of key repeats can arrive as one change), each judged at the time it arrives. Surfaces without `Input` (mobile) get Seal and Throw buttons.

---

## 8. Puzzles: Analyze Specimen

Optional, multiple choice (keys 1 to 4), target under 60 seconds. Generated from the triggering mission's diff after the privacy filter.

| Tier | Type | Source | Skill trained |
|---|---|---|---|
| Common | Pattern ID | Problem themed on epic domain | Algorithm pattern recognition |
| Uncommon | Complexity Read | Function from the diff | Big-O analysis |
| Rare | Code Trace | Method from the diff + generated inputs | Mental execution |
| Exotic | Bug Hunt | Function from the diff with injected defect | Code review |
| Legendary | Design Probe | Epic architecture extrapolated | System design |
| Anomaly | Deep Expedition | Domain-themed algorithm problem, solved in a scratch file, tests run by the mod | Writing code under time pressure |

**Bonus:** correct answer +10% (Common) scaling to +25% (Legendary); fast-correct adds up to +5%. Wrong answers cost nothing and show an explanation.

### 8.1 Answer-key integrity

1. **Code Trace:** run the snippet with local `php` via `$.process`; displayed answer must match real output.
2. **Bug Hunt:** the injected bug is a known diff; the answer key is mechanical.
3. **Pattern ID / Design Probe:** second independent model call must agree; disagreement discards the puzzle.
4. **Dispute key** logs bad puzzles to the store for review.

### 8.2 Training layer

- Accuracy tracked per category (sliding window, heaps, two pointers, N+1, etc.).
- Weak categories resurface more often (spaced repetition).
- `/dossier` pane shows accuracy by category and trend.

**Open decisions:** D4 puzzle balance (weak spots vs strengths vs even); D5 Deep Expedition on demand via `/expedition` or Anomaly-only.

---

## 9. The Bridge (UI)

| Surface | Content |
|---|---|
| **Bridge pane** (`/bridge`) | Active system, current mission, hull (test pass rate), shields (lint), fuel (context remaining), crew status, captain's log tail. Built (basic): hull is this session's test runs (judged as missions judge them), shields the last lint or type-check verdict by exit status (eslint, tsc, phpstan, pint, ruff and the like; a piped run gives none), fuel the context window left from `$.session.usage()`, plus a red alert and a waiting encounter. Crew status: each officer idle, busy, or its last result. Keys send the crew: `e` Engineering runs the tests, `l` Engineering runs lint and type checks (its `LINT: PASS`/`FAIL` line sets the shields), `s` asks Science a typed question, `t` Tactical reviews the branch; a run sent from here reports in the report pane, never taking over a pane in use. While the Bridge is open the companion draws at its foot and the band steps aside. Drawn from the save at draw time, redrawn with the band. |
| **Band above prompt** | Active companion sprite (animated idle), mood, tiny mission indicator |
| **Status line** | `★ /contain · NOVA-142 · Kepler~` style summary: a waiting encounter first, then a system being charted (`/ charting NOVA-1 42s`, a spinner and seconds), then the mission, then the system, within 22 columns (section 2, constraint 5). A charting interrupted by a hot reload is reported by a toast at the next start, never left spinning |
| **Toasts** | Encounters, containment results, level ups. Rate limited. |
| **Report pane** | Opens on `/mission complete` and `/epic complete` and stays until dismissed (a toast vanishes before a long name is read): commits, test runs, cells earned, and the creature that turned up with its sprite. Enter goes straight to containment (`r` then Enter uses a Reinforced Cell); Esc leaves the encounter waiting. |
| **Specimen Bay pane** (`/bay`) | Collection grid, set companion, catalog completion per system. v1: a list, and `/bay companion N` |
| **Dossier pane** (`/dossier`) | Puzzle accuracy |

### 9.1 Crew (subagents)

| Officer | Role |
|---|---|
| Engineering | Runs and interprets tests |
| Science | Research, docs, reading code |
| Tactical | Security review before push |

Crew are real subagent types via `$.agent`. Their prompts are working instructions only; no role-play voice in model output.

Built: each is registered at session start as `final-commit:engineering`, `final-commit:science` and `final-commit:tactical` (`src/crew/roster.ts`), read-only (no edit tools; the prompt forbids changing files, committing or pushing), dispatched by the model or the user through the Agent tool. Tactical ends with `VERDICT: CLEAN` or `VERDICT: ISSUES`. The Bridge sends them too (SPEC 9). A background run's finish also reaches the main conversation, as any background agent's does. A clean verdict during a mission sets `tacticalClean` (mission quality, SPEC 16) only once the mission has a commit to review, and any later commit clears it: the new code is unreviewed. A verdict with issues clears it too. The Bridge shows each officer as idle, busy, or its last result; a Tactical verdict also toasts.

### 9.2 Alerts

- **Red alert:** failed test run or failed tool call during a mission. The status line leads with `! RED ALERT` for 8 s; a toast at most once per 5 minutes. A Bash call counts only as a failed test run (judged as in 4.3 rule 5): a shell command exiting non-zero (`grep` with no match) is routine. A call the user interrupted is not a failure (the engine flags none, so the error text decides). No sound (D7).
- **Captain's log:** `/captains-log` generates a stardate-stamped session summary (standup notes) via `$.model.fork`, in the background, and shows it in the report pane (lines wrap); if a game pane is open when it finishes, a toast says it was recorded instead. The prompt is a plain working instruction; the stardate is added in code (`YYDDD.T`: year, day of year, tenth of the day). The newest 20 entries are saved.

### 9.3 Companion

- One active Diffling shown in the band as a compact block at the right edge: the sprite trimmed to its drawing, its name, tier, mood and mission one per line beside it. The rest of the band is left to whatever draws beneath (the engine, other plugins). With too few rows for the sprite, one line.
- The band is drawn again after a `/clear`, which resets session state without a session start.
- While the Bridge pane is open the companion moves into it, at its foot, and the band steps aside; closing the Bridge brings it back.
- Reacts to events: build pass (eats), stack trace (flinches), idle 10+ min (sleeps).
- Earns XP from completed missions; evolves at levels 10 and 25.
- **Perks affect game mechanics only** (encounter odds, harvest yield). Never code behavior.

---

## 10. Data model (`$.store`, 4 MiB cap)

All keys prefixed `fc:`. Every value carries `schemaVersion`.

```ts
type SaveMeta     = { schemaVersion: number; createdAt: string }
type SyncState    = { lastSync: number | null; processed: string[] /* <issueKey>:<transitionId> */ }
type LogEntry     = { at: number; stardate: string; lines: string[] }
type StarSystem   = { id: string; epicKey: string; name: string; starClass: string;
                      biomes: Biome[]; species: Species[]; status: 'open'|'surveyed';
                      chartedAt: string; surveyedAt?: string }
type Species      = { id: string; kind: 'fauna'|'flora'; tier: Tier; name: string;
                      readout: string; stages: Sprite[]; anchors: Anchors }
type Sprite       = { rows: string[] /* 7 rows x 14 cols */ }
type Specimen     = { id: string; speciesId: string; systemId: string; tier: Tier;
                      attachment?: Attachment; level: number; xp: number; stage: 0|1|2;
                      containedAt: string; nickname?: string }
type Mission      = { issueKey: string; systemId: string; startedAt: string;
                      completedAt?: string; commits: number; testRuns: number;
                      testsGreen: boolean; tacticalClean: boolean; score?: number }
type Inventory    = { reinforced: number; stasis: number; singularity: number;
                      flora: Record<string /* speciesId */, number> }
type CatalogEntry = { speciesId: string; tier: Tier; attachment?: string;
                      status: 'seen'|'contained'|'escaped' }
type PuzzleStat   = { category: string; attempts: number; correct: number; lastSeen: string }
```

**Budget:** ~20 to 40 KB per system. Archive policy: surveyed systems older than 12 months compact to catalog-only (art dropped except contained species).

**Migrations:** `schemaVersion` bump runs a migration in `session.start` before anything reads.

---

## 11. Mod structure

```
.claude-plugin/plugin.json        name, version, description, types, userConfig
hooks/hooks.json                  { "modules": ["./register.tsx"] }
hooks/register.tsx                core wiring: session start, /epic, /mission, /encounter, Bash observer
types/index.d.ts                  $.state contract (views the panes and band draw)
src/
  config.ts                       every tuning number (section 16)
  rng.ts, runtime.ts              seeded PRNG; pure helpers shared by wiring files
  game.ts                         game actions over the save (pure)
  store/                          schema.ts, repo.ts, migrate.ts
  detect/git.ts                   branch -> issue key, Bash command signals
  detect/work-source.ts, sync.ts  tracker interface (4.4); transitions -> game actions (4.2)
  crew/                           roster.ts (agent specs, verdicts; pure); crew-wire.ts (spawn -> finished turn)
  world/                          generate.ts, validate-art.ts, parts-library.ts
  encounter/                      roll.ts, rarity.ts, attachments.ts, quality.ts
  contain/                        lattice-model.ts, calibrate-math.ts, resolve.ts (pure);
                                  lattice.tsx, calibrate.tsx (panes)
  puzzle/privacy-filter.ts        section 5.3
  bridge/                         status.ts, bay.ts, bridge.ts, alert.ts, log.ts, text.ts (pure); band.tsx, bay-pane.tsx, bridge-pane.tsx
tests/                            *.test.ts(x) (claude plugin test)
```

The engine's validator only lets `$` reach top-level functions of the file that uses it, so each wiring file (`hooks/register.tsx`, `src/contain/*.tsx`, `src/bridge/*-pane.tsx`) has its own small store adapter; everything else is pure and takes plain values.

Validate: `npm run validate`  Type check: `npm run types && npm run typecheck` (local only: the engine's API declarations are not redistributable, so CI has no types)  Test: `npm test`
Load during dev: `claude --plugin-dir .`

Public repository rules: see section 15.

---

## 12. Roadmap

### v1: Playable loop (target: first Diffling in week one)

The "First Diffling" slice is implemented: every item below except flora harvesting and Stasis/Singularity Cells (only Standard and Reinforced exist). Every behavior is covered by `claude plugin test`; containment, calibration, the band and the epic form were also played live in tmux.

- Public repo guardrails in place before the first code commit (section 15.6)
- Store schema + migrations
- Manual `/epic`, `/mission`, `/mission complete` + git branch detection
- Privacy filter (section 5.3), on by default, before system generation sends any epic text to the model
- System generation with art validation and parts-library fallback
- Encounter roll, rarity, attachments
- Seal the Lattice + calibration
- Specimen Bay, companion in band, status line
- Bridge pane (basic)

### v2: Automatic detection
- Jira `WorkSource` (MCP and REST)
- Session catch-up sync, polling, idempotency (sync engine done against the interface; wired with the first backend)
- Anti-farming rules (done for tracker closures)
- Crew subagents, red alert, captain's log (done)

### v3: Puzzles
- Pattern ID, Complexity Read, Code Trace, Bug Hunt
- Answer verification, dispute key
- Dossier pane, spaced repetition

### v4: Depth
- Evolution, companion perks
- Flora crafting
- Design Probe, Deep Expedition
- Anomaly tier, closed-system behavior

---

## 13. Open decisions

| ID | Question | Default until decided |
|---|---|---|
| D1 | Closed systems: revisitable or locked? | Revisitable at 25% rate |
| D2 | Multiple Jira instances: one save or separate saves per instance? | Separate saves, keyed by instance URL hash |
| D3 | Atlassian MCP connector or API token? | Support both; prefer MCP if present |
| D4 | Puzzle balance | Even split, weighted toward weakest categories by spaced repetition |
| D5 | Deep Expedition: on demand or Anomaly-only? | Both: `/expedition` on demand, plus Anomaly trigger |
| D6 | Epics contributed to but not owned: chart a system? | Yes, if you have at least one completed child issue |
| D7 | Audio on headless hosts | Assume none: visual alerts are primary |
| D9 | License | MIT |
| D8 | Phone play expected? | Yes: calibration required in v1 |
| D10 | Does the first completed mission guarantee an encounter? | Decided: yes (onboarding; otherwise about 8 missions at 12%) |
| D11 | Privacy filter default | Decided: `strict` |

---

## 14. Verify during v1

1. Whether a mod can emit a terminal bell (BEL) that reaches the SSH client. **Answered: no API for it (2.1.291).**
2. Frame clock smoothness of `every(ms)` over SSH + tmux at 30 to 60 ms intervals. **Answered for local tmux:** a plugin timer at 33 ms redrew a pane about 29 times a second; a `Client`'s own clock ran at about 49 ms per 40 ms tick. Not yet measured over cellular SSH.
3. Focused dialog pane behavior inside tmux (keys captured without mouse). **Answered:** see section 2, constraint 3.
4. `$.store` behavior under concurrent sessions on one host (two tmux windows). Open.

---

## 15. Public repository guardrails

This repository is public from the first commit. Git history is permanent: anything pushed, even if later deleted, must be treated as disclosed.

### 15.1 Never in the repo

| Category | Examples | Where it goes instead |
|---|---|---|
| Secrets | Jira API tokens, MCP credentials, any API key | Secret `userConfig` fields (stored by Claude Code, not the repo) |
| Work data | Real epic titles, issue keys, ticket text, code from employer or client projects | Nowhere. Tests and docs use invented projects (key prefix `NOVA-`) |
| Regulated data | Anything PHI-like, even in a fixture or screenshot | Nowhere. The privacy filter's own tests need PHI *shapes*; they use values that are synthetic by construction (SSN 000-00-0000, 555-01xx phone numbers, example.com, names like "Testperson") |
| Personal infrastructure | Hostnames, Tailscale names, IPs, usernames, local paths | `CLAUDE.local.md` (gitignored) |
| Save data | `$.store` exports, debug dumps, generated systems from real epics | Gitignored `.final-commit/` directory if ever written to disk |
| Logs | Transcripts, model prompts or responses containing work content | Gitignored or not written at all |

### 15.2 Automated enforcement

1. **GitHub secret scanning + push protection:** enable in repo Settings > Code security (free for public repos). Blocks pushes containing known token formats.
2. **gitleaks pre-commit hook** locally and as a CI job, with a custom rule for Atlassian tokens (`ATATT...`).
3. **Denylist check:** `scripts/denylist-check.sh` fails if tracked files, commit messages, or the branch name contain terms from a denylist (employer names, client names, real project keys, hostnames). One literal term per line, matched case-insensitively as a substring. Locally the terms come from a gitignored `denylist.txt` and run in the `pre-commit` and `commit-msg` hooks (`git config core.hooksPath scripts/hooks`). CI reads them from the `DENYLIST` repository secret, so the denylist itself is never public. Output names only the location of a match, never the term. Pull requests from forks receive no secrets, so they skip the check with a warning; it runs again on merge to `main`.
4. **`.gitignore`** covers `CLAUDE.local.md`, `.env*` (except `.env.example`), `.final-commit/`, `*.log`, editor and OS files.
5. **Branch protection on `main`:** CI must pass (validate, typecheck, tests, gitleaks, denylist).
6. **Dependabot** for dependency updates; keep dependencies minimal.

### 15.3 Commit hygiene

1. Commit with the GitHub noreply email (`<id>+coopers98@users.noreply.github.com`) so a personal address is not published in history.
2. Commit messages and branch names never reference real work tickets or projects.
3. Example screenshots or GIFs use a demo save with invented systems only.

### 15.4 Data handling disclosure (README)

Users' own work flows into model prompts. The README must state plainly:

- What is sent to the model: epic titles and descriptions (for system theming) and filtered code excerpts (for puzzles).
- Where it goes: only through the user's own Claude Code session and account. The mod makes no other network calls except to the user's configured Jira.
- No telemetry. No analytics. No data leaves the user's machine except as above.
- The privacy filter is on by default, and how to configure stricter rules.
- Users are responsible for whether their employer permits sending work content through Claude Code.

### 15.5 Naming and trademarks

- No Paramount Star Trek marks (Enterprise, Starfleet, Tricorder, Holodeck, Warp Core, etc.) in names, commands, identifiers, creature names, or generated content. The system generation prompt includes this as a hard constraint.
- No Anthropic marks in the product name. "Claude Code" appears only descriptively ("a mod for Claude Code").
- Non-affiliation notice in README.

### 15.6 Repo files required before first code commit

| File | Purpose |
|---|---|
| `LICENSE` | MIT (D9) |
| `README.md` | Pitch, install, data handling disclosure, non-affiliation notice |
| `SECURITY.md` | How to report vulnerabilities privately (GitHub private vulnerability reporting) |
| `.gitignore` | Section 15.2 item 4 |
| `.gitleaks.toml` | Custom rules |
| `.github/workflows/ci.yml` | Validate, typecheck, test, gitleaks, denylist |
| `.github/dependabot.yml` | Dependency updates |
| `scripts/denylist-check.sh`, `scripts/hooks/` | Denylist check and local git hooks (section 15.2 items 2 and 3) |
| `CLAUDE.local.md.example` | Template for machine-specific notes |

---

## 16. Tuning defaults (v1)

The spec left these numbers open. They are the playtest defaults, approved 2026-10-06, and live in `src/config.ts` with every other tuning number.

| Item | Default |
|---|---|
| Mission quality `q` (0 to 1) | `0.5` if tests ran and passed during the mission, plus `0.5` for a clean Tactical review (v2), so at most 0.5 in v1 |
| Quality shift on rarity | Non-Common encounter weights times `1 + 0.5 * q`, renormalized |
| Quality bonus on containment | `+0.10 * q` |
| Epic survey encounter | Quality 0.5, no Commons |
| Reinforced Cells for a green mission | 1 |
| Lattice bonus | Up to `+20%` for all locks (`0.20 * sealed / locks`), `+2%` per center hit, `-3%` per miss, between 0 and `+25%` |
| Lattice zones | Fraction of the 30-cell bar: wide 0.30, medium 0.18, narrow 0.10, very narrow 0.06; center = middle 30% of the zone |
| Lattice speeds | One sweep: slow 2000 ms, medium 1400 ms, fast 900 ms, erratic 700 ms with +/-35% jitter; frame every 40 ms |
| Lattice twists | Exotic reverses with probability 0.6 per second; Anomaly zone flickers every 300 ms, visible 70% of the time |
| Calibration | 8 beats 750 ms apart after a 1 s lead-in; offset = median press error, clamped to +/-400 ms |
| Companion | Reacts to an event for 60 s; sleeps after 10 idle minutes; blinks every 3 s; the sprite shows when the band has at least 9 rows |
| Generation | Opus by default (setting), 16,000 output tokens, 180 s timeout, names at most 24 characters, 2 to 4 biomes |
| Tracker sync | Poll every 12 minutes; each query reaches back 60 s; 500 processed transitions kept |
| Red alert | Status flash 8 s; toast cooldown 5 minutes |
| Captain's log | 20 entries kept; at most 12 lines each |
| Bridge | Gauges 10 cells wide; 3 lines of the newest captain's log |
| Crew | At most 40 turns per officer run; a Bridge report shows at most 40 lines |
