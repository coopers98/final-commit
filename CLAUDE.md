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
- Commands: `claude plugin validate .`, `tsc -p .`, `claude plugin test .`

## Rules

1. Game flavor never enters model instructions that affect code. Crew subagent prompts are working instructions only.
2. All tuning numbers live in one config module (`src/config.ts`), never inline.
3. Every `$.store` value carries `schemaVersion`; changes ship with a migration.
4. Prompts never receive raw work data: run the privacy filter (strip literals, fixtures, PHI-like patterns) first. The filter is on by default.
5. Every behavior gets a `*.test.ts`. Use the mocked clock for timing and rolls; seed all randomness.
6. No network calls other than the user's configured Jira and the session's own model. No telemetry.

## Current phase

v1: playable loop. First task: public repo guardrails (SPEC 15.6) before any game code.
