# The Final Commit

A Claude Code mod (plugin of function hooks) that turns dev work into a sci-fi creature-collection game. Creatures are called **Difflings**.

**Read `docs/SPEC.md` before any work.** It is the source of truth for mechanics, numbers, data model, and roadmap. If a change conflicts with the spec, update the spec in the same commit.

Machine-specific notes (host, Jira instance, local paths) live in `CLAUDE.local.md`, which is gitignored. Read it if present. Never copy its contents into tracked files.

## This is a PUBLIC repository

Everything committed is permanent and world-readable. Before every commit, check that no tracked file, commit message, or branch name contains:

- secrets of any kind (tokens, keys, credentials)
- real work content: employer or client names, real issue keys, ticket text, code from other projects
- personal infrastructure: hostnames, IPs, usernames, absolute local paths
- anything PHI-like, even in fixtures
- Star Trek trademarks (Enterprise, Starfleet, Tricorder, Holodeck, Warp Core) or Anthropic marks used as names

Tests, fixtures, docs, and examples use invented projects only (issue key prefix `NOVA-`). See SPEC section 15.

## Build context

- Played over SSH/tmux, sometimes from a phone. Design for a 40-column minimum, no mouse, no images, possibly no audio.
- Load the `plugin-authoring` skill before writing or debugging hooks. Grep the generated `claude-code` types for exact signatures; do not guess the API.
- Commands: `npm run types` (once per Claude Code version), `npm run typecheck`, `npm run validate`, `npm test`. Play: `claude --plugin-dir .`.

## Engine rules learned the hard way (2.1.291)

The validator enforces these, and the docs do not state them:

- `$` reaches only top-level functions of the same file. Never pass `$` or `$.noun` across an import; a same-file adapter may return closures over `$` (see any `repoOf`). Hooks registered by a helper `wireX(on)` are fine if its return value is unused.
- One unmatched `session.start` hook per plugin.
- A `types` contract file exports types only (no `export {}`).
- Surface element tables are a union: narrow with `'Input' in elements`; mobile has no `Input`.

At runtime:

- A `Client` gets keys only after a mouse click; take keys with a focused pane's `autoFocus` `Input` (`onInput` sees each change; a burst can arrive as one).
- A plugin's own `$.ui.close` does not run its own `ui.close` hook: clear pane state yourself.
- A plugin's own `$.command.run` skips that plugin's own hooks, so it cannot run its own commands: call the function directly (same file).
- `$.config.set` writes only single-value, non-secret `userConfig` fields (key `final-commit.<field>`), and only after startup: at `session.start` there are no plugin rows yet. `multiple` and `sensitive` fields are no `/config` rows at all, so no plugin can write them and `/config` does not show them; a stored value of the wrong type (a list for a text field, as a test's `options` can give) fails the load. Each write reloads the plugin; the caller's code still runs to the end.
- Edits made during the session's own turn reload the mod when the turn ends, not before.
- Slash command arguments and output go into the transcript the model reads.
- In tests, nothing answers engine events: stand in for `session.start`, `command.register`, `ui.*`, `process.run` and `model.complete` (operations answer `{ value }`). The kit cannot raise a person's Escape. `FINAL_COMMIT_SEED` makes rolls deterministic. `fs.*` hooks see paths already resolved to absolute (in a test, against the test process's own folder, not `session.start`'s `cwd`): match stand-in files by their relative path at the end, never by an absolute path. A plugin's own `$.agent.spawn` reaches the test's `agent.spawn` hook as an Agent tool call (`subagent_type`, `prompt`), and only an answer in that tool's shape, `{ result: { status: 'async_launched', agentId }, model }`, gives the plugin an `agentId`.

## Rules

1. Game flavor never enters model instructions that affect code. Crew subagent prompts are working instructions only.
2. All tuning numbers live in one config module (`src/config.ts`), never inline.
3. Every `$.store` value carries `schemaVersion`; changes ship with a migration.
4. Prompts never receive raw work data: run the privacy filter (strip literals, fixtures, PHI-like patterns) first. The filter is on by default.
5. Every behavior gets a `*.test.ts`. Use the mocked clock for timing and rolls; seed all randomness.
6. No network calls other than the user's configured work sources (SPEC 4.4) and the session's own model. No telemetry.

## Current phase

v1 "First Diffling" slice is complete (SPEC 12), with flora harvesting, all four cells and crafting. v2 in progress: sync engine, anti-farming, red alert, captain's log, the Bridge pane and crew subagents are done; the source layer is wired (`workSources` setting, per-source sync, catch-up and poll); the plan documents, GitHub Issues and Jira Cloud REST backends are done; the Jira MCP and Linear backends are deferred (SPEC 12), each to be added to `backendsOf` in `hooks/register.tsx` when picked up. v3 in progress (epic FC-14): the puzzle framework is done (FC-15, SPEC 8.4: TypeScript/JavaScript adapter, code filter, Pattern ID and Bug Hunt, the Analyze step in containment, `puzzles` and `puzzleModel` settings). Companion XP, levels and evolution are done (SPEC 9.3); perks stay v4. Next: Trace with runners and the sandbox (FC-16), then the other adapters.
