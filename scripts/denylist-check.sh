#!/usr/bin/env bash
# Fails if denylisted terms appear in tracked files, commit messages, or a
# branch name. See SPEC section 15.2.
#
# Terms come from the DENYLIST environment variable (CI, from a repository
# secret) or, if that is unset, from denylist.txt at the repo root (local,
# gitignored; a linked worktree uses the main checkout's copy). One literal
# term per line, matched case-insensitively as a substring. Blank lines and
# lines starting with # are ignored.
#
# Output names only where a match is (file:line or commit SHA), never the
# term or the matching text, so CI logs on this public repo stay clean.
#
# Usage:
#   denylist-check.sh files [--cached]   tracked files (--cached: the index)
#   denylist-check.sh history            every commit message in history
#   denylist-check.sh text <label>       text on stdin, e.g. a branch name
#
# Exit codes: 0 clean, 1 match found, 2 usage or configuration error.

set -euo pipefail

root=$(git rev-parse --show-toplevel)
# A linked worktree has no copy of the gitignored denylist; use the main checkout's.
main_root=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")

terms=$(mktemp)
trap 'rm -f "$terms" "$terms.raw"' EXIT

if [[ -n "${DENYLIST:-}" ]]; then
  printf '%s\n' "$DENYLIST" > "$terms.raw"
elif [[ -f "$root/denylist.txt" ]]; then
  cp "$root/denylist.txt" "$terms.raw"
elif [[ -f "$main_root/denylist.txt" ]]; then
  cp "$main_root/denylist.txt" "$terms.raw"
else
  echo "denylist: no terms. Create denylist.txt at the repo root (one term per line); see README." >&2
  exit 2
fi
# Strip CR, surrounding whitespace, comments, and blank lines. A blank
# pattern would match every line, so it must never reach grep.
sed -e 's/\r$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$terms.raw" \
  | grep -v -e '^#' -e '^$' > "$terms" || true
rm -f "$terms.raw"

if [[ ! -s "$terms" ]]; then
  echo "denylist: the denylist contains no terms." >&2
  exit 2
fi

mode=${1:-}
case "$mode" in
  files)
    args=(-n -I -i -F -f "$terms")
    [[ "${2:-}" == "--cached" ]] && args=(--cached "${args[@]}")
    # git grep prints path:line:text; keep path:line only.
    if hits=$(git -C "$root" grep "${args[@]}" | cut -d: -f1,2); then
      echo "denylist: denylisted term found at:" >&2
      sed 's/^/  /' <<< "$hits" >&2
      exit 1
    fi
    ;;
  history)
    found=0
    while read -r sha; do
      if git -C "$root" log -1 --format=%B "$sha" | grep -q -i -F -f "$terms"; then
        echo "denylist: denylisted term in the message of commit $sha" >&2
        found=1
      fi
    done < <(git -C "$root" rev-list HEAD)
    exit "$found"
    ;;
  text)
    label=${2:?usage: denylist-check.sh text <label>}
    if grep -q -i -F -f "$terms"; then
      echo "denylist: denylisted term in $label" >&2
      exit 1
    fi
    ;;
  *)
    echo "usage: denylist-check.sh files [--cached] | history | text <label>" >&2
    exit 2
    ;;
esac
