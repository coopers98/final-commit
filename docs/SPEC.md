# The Final Commit

> *Space: the final commit.*

A Claude Code mod that turns real development work into a sci-fi exploration game. Epics are star systems. Missions are units of work. Finishing work triggers encounters with **Difflings**, procedurally generated alien flora and fauna that you contain, collect, and raise as companions. Optional puzzles built from your own diffs boost containment odds and double as interview prep.

Status: design spec, pre-v1. Repository: github.com/coopers98/final-commit (public). Last updated 2026-10-06.

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

### Remote terminal constraints (verified against the mod API, Claude Code 2.1.289)

1. **Audio:** `$.audio.play` uses `afplay` on macOS; a Linux terminal has no player and plays nothing. On a Linux host, sounds are silent. Fallbacks: toasts, status line flashes, and (to verify) emitting a terminal bell that the client terminal maps to a sound or visual.
2. **Latency:** keypresses travel over SSH. A LAN or mesh VPN adds a few ms; cellular adds 50 to 150 ms with jitter. The containment mini-game must calibrate for this (section 7.3).
3. **Focus:** mouse clicks may not pass through tmux/SSH. Interactive screens open as **focused dialog panes** (`focus`, `closeOnEscape`, `holdToasts`) so they take keys without a click.
4. **Images:** kitty graphics through tmux is unreliable. All art is ASCII/Unicode text.
5. **Width:** a pane opened unprompted only seats at 144+ columns. On narrow terminals, the bridge opens via command; the band, status line, and mini-game must render at 40 columns minimum.

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

### 4.3 Anti-farming

1. A Done issue only rolls an encounter if it has **attached work**: commits on its branch or session activity tied to its key. Administrative closures count toward epic progress only.
2. Minimum mission duration of 20 minutes from start to done, or a non-empty diff.
3. Soft cap of 2 encounters per calendar day (host local time, configurable).

### 4.4 Access options

| Option | Notes |
|---|---|
| Atlassian MCP connector | `$.mcp.call(server, tool, args)` uses Claude Code's existing connection and credentials. Simplest if configured on the host. |
| Jira REST + API token | `$.http.fetch` with token from plugin `userConfig` (secret). No dependency on a connector. |

The adapter is an interface (`WorkSource`) so either backend, or a future GitHub Issues backend, plugs in.

### 4.5 Manual overrides

`/epic`, `/mission`, `/mission complete` exist for testing and for work not tracked in Jira.

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
2. Validator checks dimensions, character width (no wide or ambiguous-width glyphs), and non-empty silhouette.
3. On failure: retry that species up to 2 times; then fall back to a procedurally assembled sprite from a parts library.
4. Each sprite declares anchors: `head`, `neck`, `hand`, `orbit`. Attachments render on top at these anchors in code.

### 5.3 Privacy filter

Before any epic text or code reaches a prompt: strip string literals, fixture data, and anything matching PHI-like patterns (names, DOBs, MRNs, SSN shapes). Required for regulated codebases (healthcare, finance). On by default; opt-out only. Prompts receive structure, not data.

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
- **Latency calibration:** one-time `/calibrate` (press Space on a beat 8 times); measured median offset is stored per client and applied as hit-window shift. Recalibrate prompt if the client changes (detect via terminal size/env heuristics).
- **Escape** pauses, never fails.
- Implementation: a `Client` element in a focused dialog pane; `every(ms)` frame clock for the needle, `onKey` for input.

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
| **Bridge pane** (`/bridge`) | Active system, current mission, hull (test pass rate), shields (lint), fuel (context remaining), crew status, captain's log tail |
| **Band above prompt** | Active companion sprite (animated idle), mood, tiny mission indicator |
| **Status line** | `★ NOVA-142 · Kepler-7b · 2 cells` style summary |
| **Toasts** | Encounters, containment results, level ups. Rate limited. |
| **Specimen Bay pane** (`/bay`) | Collection grid, set companion, catalog completion per system |
| **Dossier pane** (`/dossier`) | Puzzle accuracy |

### 9.1 Crew (subagents)

| Officer | Role |
|---|---|
| Engineering | Runs and interprets tests |
| Science | Research, docs, reading code |
| Tactical | Security review before push |

Crew are real subagent types via `$.agent`. Their prompts are working instructions only; no role-play voice in model output.

### 9.2 Alerts

- **Red alert:** failed test run or failed tool call during a mission. Toast + status flash + sound if available.
- **Captain's log:** `/captains-log` generates a stardate-stamped session summary (standup notes) via `$.model.fork`.

### 9.3 Companion

- One active Diffling shown in the band.
- Reacts to events: build pass (eats), stack trace (flinches), idle 10+ min (sleeps).
- Earns XP from completed missions; evolves at levels 10 and 25.
- **Perks affect game mechanics only** (encounter odds, harvest yield). Never code behavior.

---

## 10. Data model (`$.store`, 4 MiB cap)

All keys prefixed `fc:`. Every value carries `schemaVersion`.

```ts
type SaveMeta     = { schemaVersion: number; createdAt: string; lastSync: string }
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
final-commit/
  .claude-plugin/plugin.json        name, version, description, types, userConfig
  hooks/hooks.json                  { "modules": ["./register.tsx"] }
  hooks/register.tsx                wires events to modules below
  src/
    detect/       WorkSource interface, jira-mcp.ts, jira-rest.ts, git.ts
    world/        generate.ts (system gen), validate-art.ts, parts-library.ts
    encounter/    roll.ts, rarity.ts, attachments.ts
    contain/      lattice.tsx (mini-game), calibrate.tsx, resolve.ts
    puzzle/       generate.ts, verify.ts, privacy-filter.ts, stats.ts
    bridge/       pane.tsx, band.tsx, status.ts, alerts.ts, crew.ts
    store/        schema.ts, migrate.ts, repo.ts
  types/index.d.ts                  PluginState contract
  tests/                            *.test.ts (claude plugin test)
  assets/sounds/                    optional; macOS clients only
docs/SPEC.md
CLAUDE.md
```

Validate: `claude plugin validate .`  Type check: `tsc -p .`  Test: `claude plugin test .`
Load during dev: `claude --plugin-dir <path>` or hot reload in session.

Public repository rules: see section 15.

---

## 12. Roadmap

### v1: Playable loop (target: first Diffling in week one)
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
- Session catch-up sync, polling, idempotency
- Anti-farming rules
- Crew subagents, red alert, captain's log

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

---

## 14. Verify during v1

1. Whether a mod can emit a terminal bell (BEL) that reaches the SSH client.
2. Frame clock smoothness of `every(ms)` over SSH + tmux at 30 to 60 ms intervals.
3. Focused dialog pane behavior inside tmux (keys captured without mouse).
4. `$.store` behavior under concurrent sessions on one host (two tmux windows).

---

## 15. Public repository guardrails

This repository is public from the first commit. Git history is permanent: anything pushed, even if later deleted, must be treated as disclosed.

### 15.1 Never in the repo

| Category | Examples | Where it goes instead |
|---|---|---|
| Secrets | Jira API tokens, MCP credentials, any API key | Secret `userConfig` fields (stored by Claude Code, not the repo) |
| Work data | Real epic titles, issue keys, ticket text, code from employer or client projects | Nowhere. Tests and docs use invented projects (key prefix `NOVA-`) |
| Regulated data | Anything PHI-like, even in a fixture or screenshot | Nowhere |
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
