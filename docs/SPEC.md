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
| Required on the host | Claude Code and `git`. Optional: access to a work source (section 4.4), and the runtimes puzzle runners use (section 8.3; a missing one only narrows the puzzle types). |

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

Detection is automatic. The configured work sources (section 4.4: a tracker, or plan documents when there is none) are the source of truth; git and session activity are the instant signals. Manual commands exist as overrides only. Jira terms below stand for any source.

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
5. **Order and waiting** (`src/detect/sync.ts`): every source is read first, then all their transitions apply as one list, oldest first, so one source's later change never takes what another's earlier one needed (a survey taking the encounter slot a mission's roll needed); at one instant a start goes before a Done. Each query reaches back one minute before `lastSync`; the processed list (newest 500) drops repeats. The first sync only records its start: nothing earlier is awarded. A transition that cannot apply yet waits: an issue whose epic is still being charted (its start charts the epic, SPEC 4.1), an issue's Done while its epic is still being charted, or an epic Done while an encounter holds the slot. A waiting transition holds back later ones for the same epic, so an issue's Done is never read before its start. An issue's start waiting on a chart that is running also holds back later starts in every epic, so the first issue started becomes the mission; one waiting on a failed chart sitting out its retry (rule 5 of 4.4) holds back no other epic. A waiting transition is kept in its source's record (`waiting`, the newest 100) and tried again at each sync, and `lastSync` moves on: the query window stays one poll wide however long something waits, so a change applied long ago never falls out of the processed list while still being read.
6. **Mapping:** a chart the tracker starts does not change the active epic. An issue's start makes its epic the active one and starts the mission (timed from the tracker's start, not the poll that saw it), unless a mission is already active (one at a time; the second issue is not tracked) or that issue was completed before. An issue outside any epic is ignored. Done on the active mission completes it; Done on any other issue of a charted epic is logged as an administrative closure (no rewards; its branch can no longer start it). An epic's Done surveys that epic and leaves a different active epic alone.

The sync engine runs against the `WorkSource` interface (`src/detect/work-source.ts`), once per configured source (`src/detect/sources.ts`, 4.4). The wiring runs the catch-up in the background at session start, so a slow tracker never holds up the session, then polls every 12 minutes. One sync runs at a time: a poll that finds the last one still running skips. A chart a source started syncs again when it finishes (once more after a running sync, if one is), so the mission waiting on it starts without waiting for the next poll. Sources are built once per session start. With no source configured nothing polls.

### 4.3 Anti-farming

1. A Done issue only rolls an encounter if it has **attached work**: commits on its branch or session activity tied to its key. Administrative closures count toward epic progress only. Applies to tracker closures; `/mission complete` is the manual override and is not checked.
2. Minimum mission duration of 20 minutes from start to done, or a non-empty diff. Together with rule 1: a commit (a non-empty diff) qualifies at once; test runs alone need the 20 minutes. A closure that fails these completes without rewards (no encounter, no cells, no flora) and does not use up the first mission's guarantee (D10).
3. Soft cap of 2 encounters per calendar day (host local time, configurable). **Enforced in v1** for mission encounters; epic surveys and developer-mode encounters are exempt.
4. **v1:** a branch only starts a mission when its key belongs to the active epic's project and that mission was never completed, so checkouts cannot pay out twice.
5. **v1:** a test run is judged by its exit status where that status is the runner's: the runner ran last in the command and surely ran. After an `&&` (other than a `cd`, taken to succeed) it may never have run, and followed only by `&&` (and pipes after those) a failure may be a later command's: either way a success means it passed, and a failure is decided by the summary. Quoted text, escaped characters and heredoc bodies are never split into commands, a backslash line continuation joins its lines, an `&&` or `||` counts only within its own list (up to a `;`, new line or `&`), and a trailing `;` or new line follows nothing. Where the status may not be the runner's at all (piped `| tail`, guarded `|| true` or after an `||`, backgrounded `&`, or followed by `;` or a new line, as in `npm test; echo done`), it is judged by the runner's own summary in the end of its output (bun/`claude plugin test`, jest, vitest, pest, pytest, phpunit, go, cargo formats); with no summary visible it counts as not passing. A lint or type check is judged the same way, but linters print no common summary: after `&&` only a success counts (a pass), and otherwise an unknown status gives no verdict. Tests and lint in one command are judged apart, each by the last of its kind. Wrappers that pass the exit status through (`timeout`, `time`, `nice`, `env`) are seen past, and redirections like `2>&1` change nothing. Failed commits are not counted.

### 4.4 Work sources

Each source is an adapter behind the `WorkSource` interface (`src/detect/work-source.ts`); the sync (4.2) never knows which one it reads. Sources are chosen in the `workSources` setting (names, comma-separated text, like every list setting here: a list field would not appear in `/config` nor be writable by `/setup`, 4.6), and **several can run at once in one save** (D2). A source is named by its backend: `plans`, `github`, `jira`, `linear`. A backend may run several sources, each named apart and failing on its own (GitHub: one per repository, `github:owner/repo`, rule 6), and a source may keep one record per project (plans, rule 3). A backend's own settings (a token, a prefix, folders) are fields of its own, and they ship with it. The name keys the source's sync record (`fc:sync:<name>`: its own `lastSync` and processed list), so two sources never share processed keys, and a source added later starts from its own first sync. Game keys stay as each source maps them (rule 2). Two sources that map to the same key mean the same mission, so give each source its own prefix. A name this build has no backend for, or one whose settings are incomplete, gets one toast at session start and is ignored. Within one sync an epic that one source's change starts charting counts as charting for every change after it, so it is charted once.

| Source | Access | Epic | Mission | Timeline |
|---|---|---|---|---|
| Jira MCP | `$.mcp.call` through an attached Atlassian connector, using its credentials | Epic | Story or task | Issue changelog |
| Jira REST | `$.http.fetch` to a Jira Cloud site, with an API token from a secret `userConfig` field | The issue's epic, else its project's backlog | An issue assigned to you | Status-category change date |
| GitHub Issues | `gh` via `$.process` (its own auth) | The issue's parent, else its milestone, else the repo's backlog | An issue assigned to you; being assigned starts it | Issue timeline events |
| Linear | GraphQL `$.http.fetch` with an API key from a secret field | Project | Issue | Issue history |
| Plan documents | Files only, via `$.fs`; no tracker, no network | A plan file, keyed by its first heading | A keyed checklist task | Changes between reads |

1. **Jira:** MCP is preferred when a connector is attached, REST otherwise (D3). Both are one adapter with two transports: the mapping in `src/detect/jira.ts` takes a `JiraTransport`, and REST is the first (rule 7).
2. **Keys:** a source maps its ids to game keys (`[A-Z][A-Z0-9]{1,9}-N`). Jira and Linear keys are used as they are; GitHub issue `#12` in a repo becomes that repo's configured prefix plus the number (`NOVA-12`). The mapping is stable across reads, so idempotency (4.2) holds.
3. **Plan documents** (D13, `src/detect/plans.ts`): each `.md` file directly in the `plansFolders` (comma-separated; default `docs/plans`) is an epic, keyed by the key in its first heading. The folders are relative to the project: an absolute path, a home path or a `..` segment in the setting is dropped. The rest of the heading is the epic's title, and the prose before the first task is its description. Each checklist task (`- [ ]`, `* [ ]`, `+ [ ]`) with a key is a mission, titled by the rest of its text.
   - **Keys** are explicit only. A key is the first one in brackets anywhere in the text (`SHA-256 migration (NOVA-7)`, `[NOVA-7](url) x`), else one leading it (`NOVA-7 x`, `**NOVA-7**: x`). A key-shaped term mid-text (`UTF-8`) is never one, and one leading the text loses to a bracketed key; write the key first or in brackets. A plan whose first heading has no key, or a task without one, is skipped with a debug-log line naming its line number, never its text, so inserting or rewording a task never moves a key. Each key is kept the first time it is read (folder order, then file name): a later plan of the same epic is skipped whole, and a repeated task key is dropped from the later plan.
   - **Parsing:** checklists inside fenced code are ignored (a fence closes only on its own character, at least as long). Files over 256 KiB and links are skipped. A byte-order mark and Windows line ends are handled.
   - **Statuses:** `- [~]` marks a task in progress (as do a branch checkout of its key and `/mission`), and `- [x]` is its Done. A task seen going from to do straight to done between two reads is reported started, then done: its mission completes, though without rewards when no work was tracked on it (4.3). A task first seen already done (a plan added or moved in, a key rewritten) is old work: recorded, never reported. All tasks done is the epic's Done, reported after its tasks. A task's start is its epic's start: there is no separate epic transition. A reopened epic reports its next Done again.
   - **What it keeps:** the source saves what it last read per project folder (`fc:plans:<id>`, the id a hash of the path), and each project has its own sync record (`fc:sync:plans:<id>`, through `WorkSource.record`), so a change waiting in one project is never skipped by another's sync. Its changes are logged, timed when they were seen, and kept until no sync can ask for them again (at most 1,000). Transition ids carry the time of the project's baseline, its first read, which reports nothing. A task missing from a read keeps its status, so a file briefly missing reports nothing when it returns. A missing folder has no plans. The plans themselves are never written.
   - **Known limit:** a read that catches a file half written, with only its finished tasks present, can report the epic done early.
4. **Privacy:** a source's titles and descriptions reach a prompt only through the privacy filter (5.3), like `/epic` text. Nothing a source returns is ever written to the repository; tests use invented `NOVA-` data and recorded fake responses, never a live tracker.
5. A source that fails (offline, expired token, or a transition it reported that could not be applied) is reported once by toast for each outage (sources failing alike in one sync share one toast) and retried at the next poll; the others keep running. A source that cannot be read keeps its `lastSync`, so the next poll reads the same changes again. A transition that throws while applying waits, with that source's later ones, for the next poll; what applied before it is recorded, so it is never applied twice. A source that recovers and fails again is reported again. A chart a source started that fails is not tried at every poll. Its epic waits 30 minutes, then double that after each failure in a row, up to 6 hours. Its issues stay waiting meanwhile. Only the first failure in a row is toasted, and a chart that succeeds ends the run. `/epic` charts are unaffected.
6. **GitHub Issues** (`src/detect/github.ts`): the `githubRepos` setting lists each repository with its prefix (`owner/repo=NOVA`, comma-separated). Several repos can be read at once; a repeated repo, or a prefix already taken, is rejected, as two repos' `#12` would be one key. Each repo is a source of its own, named `github:owner/repo`, with its own sync record: it fails on its own (a typo, a rename, a gh login that cannot see it) and is told once per outage (rule 5), its `lastSync` holding so nothing is lost once it is reachable again, while the other repos keep running.
   - **Epics:** GitHub repos rarely keep epics, so an issue's epic is whatever structure the repo uses, in order. Its parent issue (keyed like any issue: `NOVA-1`); a parent in another listed repo keys the epic with that repo's prefix, and one in an unlisted repo falls through, with a debug-log line. Else its milestone (`NOVA-M3`). Else the repo's standing backlog (`NOVA-BACKLOG`), so a loose ticket is still a mission. A milestone or the backlog shares the repo's prefix, so it is one project with its missions and a branch checkout of a mission key starts it (4.3 rule 4); a parent in another listed repo has that repo's prefix, so its missions start from assignment, not from a branch. The backlog is often the active system, so a branch checkout of an issue that belongs to a parent or milestone may start its mission in the backlog instead (being assigned through GitHub always places it right). A parent's close (a closed issue with sub-issues) or a milestone's close is the epic's Done; the backlog is never surveyed. The backlog's epic text is a generic title, so no work text reaches its prompt. `/scan` takes these keys.
   - **Missions:** every issue assigned to you is a mission, including one with sub-issues of its own. Being assigned to you (by anyone) starts it. Its close (whatever the reason) is its Done: it completes the mission when that mission is the active one, and is otherwise an administrative closure (4.2 rule 6). A reopen is reported back to to do, which the game ignores.
   - **Reads:** each poll runs GraphQL queries through `gh api graphql`: who you are (once per session), your issues updated since the sync's `since` (filtered to you on GitHub's side, with their parent, milestone and assignment, close and reopen events since then), issues closed since (numbers and close events only), and closed milestones, last updated first, paged until one was last updated before `since` (a milestone's `updatedAt` moves with its issues long after it closed, and is never earlier than its close); those closed since count. Each transition is timed by its event and keyed by the event's id (an epic's close by `epic-` and the id, so an issue that is both your mission and an epic keeps both), so the source keeps no state between reads. A failure is reported by gh's own first error line, cut to 120 characters; the mod never sees a token.
   - **Known limits:** when more than 500 of your issues (20 pages of 25) changed since the last read, the source fails and says so instead of skipping some; as the window since the last read only grows, it then fails at every poll: that many changes are beyond what it handles. Closed epics are read up to 2,000 per poll; past that the rest are not read, with a debug-log line. More than 1,000 closed milestones updated in one poll, and the rest are not read, with a debug-log line. An issue you were unassigned from no longer counts as yours, so its later close is not read. At most 50 events per issue per read are taken. Sources apply their changes one after another, each in time order: with a parent in another repo listed first, an epic closed in the same poll as your sub-issue is surveyed first, and its encounter, waiting to be contained, takes the slot the mission's own roll needed (one sync applying every source's changes in one time order would fix it).
7. **Jira Cloud** (`src/detect/jira.ts`): Cloud sites only (`https://<name>.atlassian.net`); Server and Data Center are not read. The `jiraSite`, `jiraEmail` and `jiraToken` settings (the token a secret field, kept by Claude Code in secure storage) authenticate with Basic auth over REST API v3. A site that is not an atlassian.net address over https is refused, so the token goes only to the atlassian.net site the person set (a mistyped name sends it to that site). Missing or invalid settings leave the source incomplete (a toast at start, and the reason in the debug log).
   - **Epics:** an issue's epic is its parent when that parent is an epic (Jira Cloud's epic level); else its project's standing backlog (`NOVA-BACKLOG`, as GitHub's, never surveyed, its prompt carrying only the word "Backlog"). A sub-task, whose parent is not an epic, goes in the backlog. An epic's description is read once per session when one of your issues under it starts (its epic may be charted then), as plain text from its document format, cut to 2,000 characters, and reaches the prompt only through the filter. An epic whose description cannot be read is charted from its title alone, with a debug-log line, and never holds back the rest.
   - **Missions:** an issue assigned to you, other than an epic. Its status category moving to In Progress starts it, and to Done is its Done (it completes the active mission, and is otherwise an administrative closure, 4.2 rule 6); back to To Do is reported and ignored.
   - **Reads:** each poll runs two searches on the enhanced search endpoint (`/rest/api/3/search/jql`, paged by its token alone, as `isLast` may be absent): your issues whose status category changed in the window, and epic-level issues whose category moved to Done in it. Epic-level types are read once per session from the site's issue types (hierarchy level 1, by name, as a site may rename Epic); a site with none skips that search. The window is whole minutes back from Jira's own clock (`statusCategoryChangedDate >= -Nm`, one minute to spare), so neither a time zone nor the local clock can shift it, and nothing is filtered by the local clock afterwards: processed keys drop the repeats the overlap brings. Each change is timed by the issue's `statuscategorychangedate` and keyed by its category and that time, so no state is kept between reads. Jira's search index is eventually consistent: the sync's 60-second overlap is the margin for a change indexed late.
   - **Departure from the changelog** (table above, SPEC 4.2): the changelog endpoints are not used. Jira gives each issue's latest category change only, so an issue started and finished between two polls is seen Done alone: an administrative closure unless it is the active mission, like any tracker's Done. No start is made up, which would chart its epic and switch the active epic for every stale ticket closed in bulk. Work counts only while a mission runs (4.3), so no reward is lost by it.
   - **Failures** are short and never carry the request or its token: 401 names the settings to check, 403 and 429 say so, others give Jira's own first error message, cut to 120 characters.
   - **Known limits:** more than 20 pages of your issues changing in one poll fails the read rather than skip any; more than 20 pages of closed epics, and the rest are not read, with a debug-log line (a page holds up to 100, fewer when Jira returns short pages). An issue reassigned away from you is no longer read. The window reaches a minute or two before the source's first sync, and nothing is filtered by the local clock, so an issue moved to In Progress in that minute or two may start a mission although the first sync awards nothing (4.2 rule 5); a filter by the local clock would bring back the clock skew the window avoids.


### 4.5 Manual overrides

`/epic <KEY>`, `/epic complete`, `/mission <KEY>`, `/mission complete`, `/mission reopen <KEY>` exist for testing and for work no source tracks. `/epic <KEY>` takes the key only and opens a pane for the title and description (section 2, constraint 7). `/epic complete` is refused while an encounter is waiting, so its guaranteed encounter is never lost. `/mission complete` asks first, in a confirmation pane, when the mission has open items: no test run yet or the last one failed, no lint or type check yet or the last one failed (a mission keeps its last lint verdict as the Bridge's shields judge it). Enter completes it anyway; Esc keeps it active. Where the pane cannot open, the command says so and completes nothing; `/mission complete anyway` skips the question. A tracker's Done never asks. `/mission <KEY>` typed while an epic is being charted, with no mission active, is queued: it starts on that epic, which becomes the active one, (the latest one charting in the key's project, else the latest of all) when its charting finishes, timed from when it was typed. One mission waits at a time; a second `/mission` replaces it. A charting that fails or is cut off by a reload drops the queued mission, with a toast.

`/mission reopen <KEY>` undoes the latest completion of KEY, for a mission completed by mistake: its log entry goes, so `/mission` can start it again (and a branch or a tracker too, once no earlier completion of the same key is logged), and what the completion recorded giving (`Mission.reward`) is taken back: one from the completed count if it counted (never back to zero once an encounter has happened, so the first mission's guarantee cannot be had twice), and its Reinforced and Stasis Cells and flora samples as far as they are still held (a spent cell or sample is kept, and said). An encounter it led to and scan signals it resolved stay. It does not start the mission, and refuses the active one.

Other v1 commands: `/contain [reinforced|stasis|singularity]` (section 7), `/craft [reinforced|stasis]` (7.2), `/calibrate` (7.3), `/bay` and `/bay companion N` (9), and `/encounter`, which forces an encounter and exists only when the `devMode` setting is on.

### 4.6 Setup

`/setup` (`src/setup/`) opens a pane that walks through how work is tracked, one question at a time, and saves the answers as the plugin's own settings through `$.config.set`, as a change in `/config` would. Typed into the pane, the answers skip the transcript the model reads.

1. **Sources:** which of `plans`, `github`, `jira` to read, starting from the current `workSources` (`plans` when none is set). An empty answer reads none.
2. **Each chosen source's settings**, starting from their current values: plan folders (inside the project); repositories as `owner/repo=PREFIX` (an empty list starts from this project's repo, read through `gh repo view`, with a prefix from its name: the initials of a hyphenated name, `final-commit` is `FC`, else its first letters); the Jira site (an `https://<name>.atlassian.net` address) and email. A wrong answer stays on its question, says what is wrong and keeps what was typed.
3. **Review:** each answer, a mark on what changes, and whether the Jira API token is set. The token is a secret field, and the engine lets no plugin write one (nor read it into anything shown): the review says to set `jiraToken` in the plugin's own settings, and never shows it. Enter saves; Esc before then cancels with nothing saved.
4. **Save:** only changed settings of chosen sources are written, the source list last, so each source starts with its settings. A source dropped keeps its settings, unread. Each write reloads the plugin with the new settings, and the writes still finish. A refused write is shown with its reason. While saving, the pane takes no input (a second Enter cannot write twice), and saving is never stopped halfway: if the pane is closed meanwhile, a toast says what was saved. Between two writes a sync may run with some settings saved and others not yet, which can show a failure toast once. An empty plan-folders answer is refused, as an empty setting reads `docs/plans`.

The engine makes plugin settings rows for single-value fields only, and only once the session has started: list fields and secret fields are not rows, so they appear in no `/config` and no plugin can write them. Hence every list setting is comma-separated text. A list stored under the earlier list fields (before `/setup`) is the wrong type for these text fields and fails the plugin's load: clear it from `pluginConfigs` in the settings file.

---

## 5. Star systems (epics)

### 5.1 Generation

When an epic is charted, **one** `$.model.complete` call generates the full ecosystem, themed from the epic's title and description.

**Engine-controlled (never left to the model):**

- Rarity slots per system: 3 Common, 2 Uncommon, 1 Rare, 1 Exotic, 1 Legendary, 1 hidden Anomaly (fauna); 2 Common, 1 Rare, 1 Legendary (flora, the tiers cell recipes use, 7.2). Sized to an epic of five to ten missions, so a system can come to feel known.
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

With the plans, GitHub and Jira sources (4.4), a plan file's first heading and opening prose, a GitHub parent issue's title and body or milestone's title and description, or a Jira epic's summary and description, are epic text. They come from files in the project or from an issue anyone may have written on a public repository, so they reach the generation prompt as untrusted text (filtered, like typed text). That prompt only makes game content, and its output is validated (5.2).

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

Color is never the only indicator: every tier has a glyph and a text label (colorblind-safe, theme-safe). Tier colors draw a creature's sprite and name wherever it appears (report, containment, band, Bridge, `/bay`, `/scan`); the Anomaly's color cycles. The Bridge's status lines use theme keys (`success`, `warning`, `error`) so they follow the person's theme: the red alert, hull (all passing, some, none), shields (up or down) and fuel (below 25%, below 10%). Tuned in `COLORS` (`src/config.ts`).

### 6.3 Attachments (independent of tier)

| Class | Odds | Examples |
|---|---|---|
| None | 85% | |
| Minor | 11% | scarf, antenna tag, goggles |
| Major | 3.5% | top hat, visor, cybernetic eye |
| Mythic | 0.5% | crown, halo, orbiting moonlet |

Catalog tracks every species x tier x attachment combination seen.

### 6.4 Flora

Flora are harvested automatically on completed missions with attached work (4.3): 1 to 3 samples by mission quality `q` (16), `1 + 2q` rounded. Each sample picks a tier by its encounter odds (6.2) among the tiers the system's flora has, then a species of that tier: with 2 Common, 1 Rare and 1 Legendary flora, about 76% Common, 21% Rare and 3% Legendary. Flora never flee. A harvested species counts as met (`seen` in the catalog), so `/scan` names it. Samples are kept per species and spent on cells (section 7.2).

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
| Stasis | +30% | Tactical review with no findings (the mission's clean verdict, 9.1, on completion); or craft from 2 Rare flora |
| Singularity | +50% | Epic completion only (requires 1 Legendary flora to activate) |

`/craft <cell>` spends the samples, from any system, largest piles first; `/craft` alone lists the recipes and the flora held. A Singularity Cell is usable only while a Legendary sample is held, and throwing it spends one; without one, `/contain singularity` loads a Standard Cell and says why. The cell is chosen by `/contain`'s argument (a name, or `r`, `s`, `x`) or by that key on the report pane. `/bay` shows the cells and flora held.

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

Puzzle types are defined by the skill they train, not by a language; a content adapter (8.3) says which types it can make from its kind of content.

| Tier | Type | Code | SQL | Plan documents | Skill trained |
|---|---|---|---|---|---|
| Common | Pattern ID | Algorithm pattern, themed on the epic | Query pattern | The approach a plan takes | Pattern recognition |
| Uncommon | Complexity Read | Big-O of a function from the diff | Index use or full scan | | Cost analysis |
| Rare | Trace | A function from the diff run on generated inputs | The rows a query returns | A decision followed through the document | Mental execution |
| Exotic | Bug Hunt | Injected defect | Injected bad join or filter | Injected contradiction | Review |
| Legendary | Design Probe | Architecture extrapolated from the epic | Schema design | Gaps in the plan | System design |
| Anomaly | Deep Expedition | Domain-themed problem solved in a scratch file, tests run by the mod | | | Writing code under time pressure |

A tier whose type the adapter cannot make falls back to the nearest type below it that it can, so every mission's content can yield a puzzle.

**Bonus:** correct answer +10% (Common) scaling to +25% (Legendary); fast-correct adds up to +5%. Wrong answers cost nothing and show an explanation.

### 8.1 Answer-key integrity

1. **Trace:** run the snippet with the language's runner (8.3) via `$.process`; the displayed answer must match the real output. Where no runner can, the type falls back (above).
2. **Bug Hunt:** the injected bug is a known diff; the answer key is mechanical.
3. **Pattern ID / Design Probe:** second independent model call must agree; disagreement discards the puzzle.
4. **Dispute key** logs bad puzzles to the store for review.

### 8.2 Training layer

- Accuracy tracked per category (sliding window, heaps, two pointers, N+1, etc.).
- Weak categories resurface more often (spaced repetition).
- `/dossier` pane shows accuracy by category and trend.

### 8.3 Adapters

1. **Content adapters**, one per kind of content, claim files by extension or path. Each extracts the units worth a puzzle from the mission's diff (functions, methods, queries, document sections), gives the privacy filter its grammar (how its literals and comments are written), lists the types it supports, and says how each type's answer is checked: **run** (a runner executes it), **mechanical** (known by construction, such as an injected defect) or **agreement** (a second independent model call must agree, or the puzzle is discarded).
2. **First adapters** (D14): PHP, TypeScript/JavaScript, Python, SQL and Markdown. Another language is one adapter plus a runner.
3. **Runners**, one per runtime (`php`, `node`, `python3`, `sqlite3`), each with its command and timeout. Whether a runner's binary exists is checked once per session; without it, run-checked types fall back.
4. **Sandbox** (D15): Trace runs only a unit the adapter can show is self-contained (no file, network, process or environment access, no imports beyond the language's core), in a fresh temporary directory, with a short timeout and its output capped. A unit that cannot be shown self-contained is never run; its tier falls back.

**Open decisions:** D4 puzzle balance (weak spots vs strengths vs even); D5 Deep Expedition on demand via `/expedition` or Anomaly-only.

---

## 9. The Bridge (UI)

| Surface | Content |
|---|---|
| **Bridge pane** (`/bridge`) | Active system, current mission, hull (test pass rate), shields (lint), fuel (context remaining), crew status, captain's log tail. Built (basic): hull is this session's test runs (judged as missions judge them), shields the last lint or type-check verdict by exit status (eslint, tsc, phpstan, pint, ruff and the like; a piped run gives none), fuel the context window left from `$.session.usage()`, plus a red alert and a waiting encounter. Crew status: each officer idle, busy, or its last result. Keys send the crew: `e` Engineering runs the tests, `l` Engineering runs lint and type checks (its `LINT: PASS`/`FAIL` line sets the shields and the active mission's lint verdict, 4.5), `s` asks Science a typed question, `t` Tactical reviews the branch; a run sent from here reports in the report pane, never taking over a pane in use. Every officer's last report, whoever sent it, is saved (`fc:crew-reports`, on this machine only) and `1` to `3` reopen Engineering's, Science's or Tactical's; the crew lines are numbered to match and marked `(report)`. While the Bridge is open the companion draws at its foot and the band steps aside. Drawn from the save at draw time, redrawn with the band. |
| **Band above prompt** | Active companion sprite (animated idle), mood, tiny mission indicator |
| **Status line** | `★ /contain · NOVA-142 · Kepler~` style summary: a waiting encounter first, then a system being charted (`/ charting NOVA-1 42s`, a spinner and seconds), then the mission, then the system, within 22 columns (section 2, constraint 5). A charting interrupted by a hot reload is reported by a toast at the next start, never left spinning |
| **Toasts** | Encounters, containment results, level ups. Rate limited. |
| **Report pane** | Opens on `/mission complete` and `/epic complete` and stays until dismissed (a toast vanishes before a long name is read): commits, test runs, cells earned, and the creature that turned up with its sprite. Enter goes straight to containment (`r`, `s` or `x` then Enter uses a Reinforced, Stasis or Singularity Cell, each offered while one is usable); Esc leaves the encounter waiting. |
| **Specimen Bay pane** (`/bay`) | The cells and flora held, collection grid, set companion, the catalog of everything met across systems (no per-system completion: an epic holds too few missions to meet a whole system). v1: a list, and `/bay companion N` |
| **Scan pane** (`/scan [KEY]`) | What the sensors know about a system (9.4) |
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

### 9.4 Scan

`/scan` opens a pane for the active epic's system, `/scan <KEY>` for any charted one: name, star class, biomes, then lifeforms by kind and tier. The command's output names no species; the pane does.

| Lifeform | Shown as |
|---|---|
| Met (any tier) | Name, readout, best status reached: seen, escaped or contained |
| Unmet Common or Uncommon | Name and readout, *not yet encountered* |
| Unmet Rare, Exotic or Legendary | A count of unidentified signals, or its first-stage silhouette once resolved; never the name |
| Anomaly | Not shown |

A system holds far more lifeforms than an epic has missions, so the scan reports what was learned ("Met 2 here, 1 contained"), never a completion ratio. Learning does not need an encounter: a completed mission with no encounter (and with attached work, 4.3) resolves one hidden signal, lowest tier first, into a silhouette; a survey resolves every one left. Resolved signals are saved as species ids (`fc:resolved`). The tiers are tuned in `SCAN` (`src/config.ts`).

---

## 10. Data model (`$.store`, 4 MiB cap)

All keys prefixed `fc:`. Every value carries `schemaVersion`.

```ts
type SaveMeta     = { schemaVersion: number; createdAt: string }
type SyncState    = { lastSync: number | null; processed: string[] /* <issueKey>:<transitionId> */;
                      waiting: WorkTransition[] /* 4.2 rule 5 */ }  // one per source: fc:sync:<name>
type PlansState   = { epoch: number; tasks: Record<string, { status }>; doneEpics: string[]; log: WorkTransition[]; seq: number }  // fc:plans:<id>
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
                      testsGreen: boolean; lint: 'pass'|'fail'|null;
                      tacticalClean: boolean; score?: number;
                      reward?: { counted: boolean; reinforced: number; stasis: number;
                                 flora: Record<string /* speciesId */, number> } /* set when completed */ }
type Inventory    = { reinforced: number; stasis: number; singularity: number;
                      flora: Record<string /* speciesId */, number> }
type CatalogEntry = { speciesId: string; tier: Tier; attachment?: string;
                      status: 'seen'|'contained'|'escaped' }
type PuzzleStat   = { category: string; attempts: number; correct: number; lastSeen: string }
```

**Budget:** ~10 to 20 KB per system. Archive policy: surveyed systems older than 12 months compact to catalog-only (art dropped except contained species).

**Migrations:** `schemaVersion` bump runs a migration in `session.start` before anything reads. Schema 2 added `Mission.lint` (null on older missions) and restamped every value. Schema 3 keeps sync state per work source (`fc:sync:<name>`). It drops the single `fc:sync` record, which no source owned, and restamps every value. Schema 4 records what each completed mission gave (`Mission.reward`) for `/mission reopen`; older log entries get it by the rules that applied (an administrative closure, with no time and no work, gave nothing; any other completion counted, with a Reinforced Cell when its tests were green). This is a guess for one kind: a tracker's Done on the active mission with no work attached (4.3) gave nothing but is read as counted. Tracker sync shipped days before schema 4 and before any release, so few saves can hold one. Schema 5 adds the Stasis Cells and flora a completion gave to `Mission.reward` (none on older entries: no mission gave either before). Schema 6 gives each sync record a `waiting` list, empty at first: a record held back at an older `lastSync` reads its waiting changes again at its next sync.

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
  detect/sources.ts               configured sources: names -> backends, one sync per source (4.4)
  detect/plans.ts                 plan documents source: parse, diff reads (4.4 rule 3)
  detect/github.ts                GitHub Issues source: gh GraphQL, timeline events -> transitions (4.4)
  detect/jira.ts                  Jira Cloud source: REST search, status-category changes -> transitions (4.4)
  setup/                          wizard.ts (the /setup questions and answers; pure); setup-pane.tsx (the pane, $.config.set) (4.6)
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

The "First Diffling" slice is implemented, with flora harvesting, all four cells and flora crafting (pulled forward from v4 so harvested flora has a use). Every behavior is covered by `claude plugin test`; containment, calibration, the band and the epic form were also played live in tmux.

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
- Work sources (4.4): Jira REST (done, Cloud), GitHub Issues (done), plan documents (done); several at once
- Deferred until there is a user for them: Jira MCP, Linear (4.4); they slot into `backendsOf` when picked up
- Session catch-up sync, polling, idempotency (done: per-source sync records, `workSources` setting, catch-up and poll wired; first backend: plan documents)
- `/setup` wizard for the sources (4.6, done)
- Anti-farming rules (done for tracker closures)
- Crew subagents, red alert, captain's log (done)

### v3: Puzzles
- Content adapters and runners (8.3): PHP, TypeScript/JavaScript, Python, SQL, Markdown
- Pattern ID, Complexity Read, Trace, Bug Hunt
- Answer verification, dispute key
- Dossier pane, spaced repetition

### v4: Depth
- Evolution, companion perks
- Design Probe, Deep Expedition
- Anomaly tier, closed-system behavior

---

## 13. Open decisions

| ID | Question | Default until decided |
|---|---|---|
| D1 | Closed systems: revisitable or locked? | Revisitable at 25% rate |
| D2 | Several work sources: one save or separate saves? | Decided: one save; several sources at once, keys namespaced per source (4.4) |
| D3 | Atlassian MCP connector or API token? | Decided: both; MCP when a connector is attached, REST otherwise |
| D4 | Puzzle balance | Even split, weighted toward weakest categories by spaced repetition |
| D5 | Deep Expedition: on demand or Anomaly-only? | Both: `/expedition` on demand, plus Anomaly trigger |
| D6 | Epics contributed to but not owned: chart a system? | Yes, if you have at least one completed child issue |
| D7 | Audio on headless hosts | Assume none: visual alerts are primary |
| D9 | License | MIT |
| D8 | Phone play expected? | Yes: calibration required in v1 |
| D10 | Does the first completed mission guarantee an encounter? | Decided: yes (onboarding; otherwise about 8 missions at 12%) |
| D11 | Privacy filter default | Decided: `strict` |
| D12 | Which trackers? | Decided: Jira (MCP and REST), GitHub Issues, Linear, and plan documents for work with no tracker |
| D13 | Plan document format | Decided: markdown checklists; `- [ ]` to do, `- [~]` in progress, `- [x]` done; explicit keys only (4.4) |
| D14 | First puzzle adapters | Decided: PHP, TypeScript/JavaScript, Python, SQL, Markdown |
| D15 | How Trace runs code | Decided: self-contained units only, in a temporary directory with a timeout; no container |

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
- Where it goes: only through the user's own Claude Code session and account. The mod makes no other network calls except to the user's configured work sources.
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
| `docs/GUIDE.md` | Player's guide: how the game plays, its odds and rewards, for players rather than builders |
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
| Mission quality `q` (0 to 1) | `0.5` if tests ran and passed during the mission, plus `0.5` for a clean Tactical review (9.1) |
| Quality shift on rarity | Non-Common encounter weights times `1 + 0.5 * q`, renormalized |
| Quality bonus on containment | `+0.10 * q` |
| Epic survey encounter | Quality 0.5, no Commons |
| Reinforced Cells for a green mission | 1 |
| Stasis Cells for a clean Tactical review | 1 |
| Singularity Cells for a survey | 1 |
| Flora harvest | `1 + 2q` samples, rounded (1 to 3) |
| Lattice bonus | Up to `+20%` for all locks (`0.20 * sealed / locks`), `+2%` per center hit, `-3%` per miss, between 0 and `+25%` |
| Lattice zones | Fraction of the 30-cell bar: wide 0.30, medium 0.18, narrow 0.10, very narrow 0.06; center = middle 30% of the zone |
| Lattice speeds | One sweep: slow 2000 ms, medium 1400 ms, fast 900 ms, erratic 700 ms with +/-35% jitter; frame every 40 ms |
| Lattice twists | Exotic reverses with probability 0.6 per second; Anomaly zone flickers every 300 ms, visible 70% of the time |
| Calibration | 8 beats 750 ms apart after a 1 s lead-in; offset = median press error, clamped to +/-400 ms |
| Companion | Reacts to an event for 60 s; sleeps after 10 idle minutes; blinks every 3 s; the sprite shows when the band has at least 9 rows |
| Generation | Opus by default (setting), 16,000 output tokens, 180 s timeout, names at most 24 characters, 2 to 4 biomes |
| Tracker sync | Poll every 12 minutes; each query reaches back 60 s; 500 processed transitions kept; 100 waiting transitions kept per record |
| Jira Cloud | Pages of up to 100, at most 20 pages per query per poll; epic description cut to 2,000 characters; Jira errors cut to 120 characters |
| GitHub Issues | Pages of 25 (your issues), 100 (closed epics) and 50 (closed milestones), at most 20 pages per repo and query per poll; epic description cut to 2,000 characters; gh errors cut to 120 characters; 30 s per gh call |
| Plan documents | Folder `docs/plans`; files up to 256 KiB; at most 1,000 changes kept for the sync; epic description cut to 2,000 characters |
| Failed source chart | Retried after 30 minutes, doubling per failure in a row, at most 6 hours |
| Red alert | Status flash 8 s; toast cooldown 5 minutes |
| Captain's log | 20 entries kept; at most 12 lines each |
| Bridge | Gauges 10 cells wide; 3 lines of the newest captain's log |
| Crew | At most 40 turns per officer run; a Bridge report shows at most 40 lines |
