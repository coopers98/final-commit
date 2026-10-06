# The Final Commit

> *Space: the final commit.*

A mod for Claude Code that turns your real development work into a sci-fi
exploration game. Epics become star systems, issues become missions, and
finishing work turns up **Difflings**: procedurally generated alien flora and
fauna you contain, collect, and raise as companions. Optional puzzles built
from your own diffs improve your odds and double as interview practice.

It runs entirely in the terminal: ASCII art, keyboard only, 40 columns
minimum, playable over SSH and tmux, including from a phone.

**Status: pre-alpha.** There is no playable code yet. The design is in
[docs/SPEC.md](docs/SPEC.md).

## Install

Not yet available. Install instructions will be added with the first
playable release.

## What data the mod sends, and where

The game is built from your own work, so some of it is sent to a model.

**What is sent to the model:**

- epic titles and descriptions, to theme each star system
- filtered code excerpts from your diffs, to build puzzles

**Where it goes:** only through your own Claude Code session and account.
The mod makes no network calls other than to your configured Jira instance.

**No telemetry. No analytics.** No data leaves your machine except as
described above.

**Privacy filter, on by default.** Before any epic text or code reaches a
prompt, the filter strips string literals, fixture data, and PHI-like patterns
(names, dates of birth, medical record numbers, SSN-shaped values), so prompts
receive structure rather than data. You can turn it off, but it is never off
unless you do so. Options for stricter rules will be documented here when the
filter ships.

**Your responsibility:** check whether your employer permits sending work
content through Claude Code before pointing this mod at work projects.

## Contributing

This repository is public, and history is permanent. Never commit secrets,
real work content (employer or client names, real issue keys, ticket text),
hostnames, IPs, usernames, or local paths. Tests, fixtures, and examples use
invented projects with the issue key prefix `NOVA-`. See
[SPEC section 15](docs/SPEC.md#15-public-repository-guardrails).

### Local guardrail hooks

Two git hooks in `scripts/hooks/` block a commit before it happens:

- `pre-commit` scans staged changes with [gitleaks](https://github.com/gitleaks/gitleaks)
  and checks the staged files against your denylist
- `commit-msg` checks the commit message and branch name against your
  denylist

CI runs the same checks, so the hooks only catch problems earlier.

1. Install gitleaks 8.30 or later and make sure `gitleaks` is on your `PATH`.
   The pre-commit hook refuses to commit without it.
2. Create `denylist.txt` at the repository root. It is gitignored. Put one
   term per line: names of employers and clients, real project keys,
   hostnames, anything that must never appear here. Matching is
   case-insensitive and substring-based; lines starting with `#` are comments.

   ```
   # denylist.txt
   examplecorp
   ACME-
   my-laptop
   ```

3. Point git at the hooks:

   ```sh
   git config core.hooksPath scripts/hooks
   ```

To check everything by hand:

```sh
scripts/denylist-check.sh files      # tracked files
scripts/denylist-check.sh history    # every commit message
gitleaks git --redact --config .gitleaks.toml .
```

Machine-specific notes go in `CLAUDE.local.md` (gitignored). Start from
`CLAUDE.local.md.example`.

### Reporting security issues

See [SECURITY.md](SECURITY.md). Do not open a public issue.

## License

[MIT](LICENSE)

## Not affiliated

The Final Commit is an independent project. It is not affiliated with,
endorsed by, or sponsored by Anthropic or Paramount. Claude Code is a product
of Anthropic.
