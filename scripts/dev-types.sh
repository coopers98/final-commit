#!/usr/bin/env bash
# Copies this machine's Claude Code API declarations into .claude-plugin/types/
# (gitignored) so `npm run typecheck` works without a session having loaded the
# mod. The declarations are not ours to redistribute, so they are never committed.
#
# Source: the plugin-authoring skill writes them when it loads, under
# ${TMPDIR:-/tmp}/claude-<uid>/bundled-skills/<version>/<hash>/plugin-authoring/types/.
# A session started with `claude --plugin-dir .` also lays them in place itself.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
version=$(claude --version | awk '{print $1}')
base="${TMPDIR:-/tmp}/claude-$(id -u)/bundled-skills/$version"
src=$(find "$base" -path '*/plugin-authoring/types/claude-code.d.ts' 2>/dev/null | head -1 || true)

if [[ -z "$src" ]]; then
  echo "dev-types: no declarations for Claude Code $version under $base." >&2
  echo "Load the plugin-authoring skill in a session (or run 'claude --plugin-dir .' once), then retry." >&2
  exit 1
fi

dest="$root/.claude-plugin/types/claude-code"
mkdir -p "$dest"
cp "$src" "$dest/index.d.ts"
echo "dev-types: copied declarations for Claude Code $version"
