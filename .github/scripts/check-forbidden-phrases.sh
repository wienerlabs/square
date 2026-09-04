#!/usr/bin/env bash
#
# Fail the build when a tracked file claims the ZK setup is production anything.
#
# The phase-2 trusted setup inherited from aperture has one contribution and no
# beacon (docs/disclosure/zk-setup-status.md). Until the public ceremony lands,
# every surface we control describes it as a demo. This script is what stops
# the old wording from creeping back in.
#
# Patterns come from docs/disclosure/forbidden-phrases.txt — that file is the
# only place to edit. The script self-tests against docs/disclosure/guard-
# fixtures/ before it scans anything, so an emptied or weakened pattern list
# fails loudly instead of passing everything while still reporting green.
#
# Usage:
#   .github/scripts/check-forbidden-phrases.sh              scan the repository
#   .github/scripts/check-forbidden-phrases.sh --self-test  check the guard itself
#   .github/scripts/check-forbidden-phrases.sh --list       print active patterns

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PATTERNS_FILE="$ROOT/docs/disclosure/forbidden-phrases.txt"
FIXTURE_VIOLATIONS="$ROOT/docs/disclosure/guard-fixtures/violations.txt"
FIXTURE_ALLOWED="$ROOT/docs/disclosure/guard-fixtures/allowed.txt"

# docs/disclosure/ is where the forbidden wording is catalogued and negated, so
# scanning it would flag the catalogue itself. .github/ holds this script and
# the workflow that names the patterns.
EXCLUDED_PREFIXES=('docs/disclosure/' '.github/')

# GitHub Actions annotations when running in CI, plain text otherwise.
err() {
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    echo "::error::$*"
  else
    echo "error: $*" >&2
  fi
}

load_patterns() {
  if [[ ! -f "$PATTERNS_FILE" ]]; then
    err "pattern file missing: docs/disclosure/forbidden-phrases.txt"
    exit 1
  fi
  # Strip comments and blank lines; keep everything else verbatim.
  local line
  PATTERNS=()
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line//[[:space:]]/}" ]] && continue
    PATTERNS+=("$line")
  done < "$PATTERNS_FILE"

  if [[ ${#PATTERNS[@]} -eq 0 ]]; then
    err "docs/disclosure/forbidden-phrases.txt contains no patterns — the guard would pass everything"
    exit 1
  fi
}

# Does any pattern match this text? Prints the matching pattern on stdout.
matching_pattern() {
  local text="$1" pattern
  for pattern in "${PATTERNS[@]}"; do
    if printf '%s\n' "$text" | grep -qiE -- "$pattern"; then
      printf '%s\n' "$pattern"
      return 0
    fi
  done
  return 1
}

files_to_scan() {
  local file prefix skip
  while IFS= read -r file; do
    skip=0
    for prefix in "${EXCLUDED_PREFIXES[@]}"; do
      if [[ "$file" == "$prefix"* ]]; then skip=1; break; fi
    done
    [[ $skip -eq 1 ]] && continue
    printf '%s\n' "$file"
    # --others --exclude-standard adds files that are new but not gitignored,
    # so a local run sees what CI will see once the change is committed.
  done < <(git -C "$ROOT" ls-files --cached --others --exclude-standard)
}

self_test() {
  local failures=0 line hit

  if [[ ! -f "$FIXTURE_VIOLATIONS" || ! -f "$FIXTURE_ALLOWED" ]]; then
    err "guard fixtures missing under docs/disclosure/guard-fixtures/"
    return 1
  fi

  # Every line here is a claim the guard must catch. If one slips through, a
  # pattern has been weakened or deleted.
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line//[[:space:]]/}" ]] && continue
    if ! matching_pattern "$line" >/dev/null; then
      err "self-test: this claim is NOT caught by any pattern: $line"
      failures=$((failures + 1))
    fi
  done < "$FIXTURE_VIOLATIONS"

  # Every line here denies the claim and must stay writable. A pattern that
  # fires on these makes honest disclosure impossible, which is worse than
  # useless — and is exactly how the previous guard ended up failing on the
  # repository's own README.
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line//[[:space:]]/}" ]] && continue
    if hit="$(matching_pattern "$line")"; then
      err "self-test: honest wording wrongly flagged by /$hit/: $line"
      failures=$((failures + 1))
    fi
  done < "$FIXTURE_ALLOWED"

  if [[ $failures -gt 0 ]]; then
    err "self-test failed with $failures problem(s)"
    return 1
  fi
  echo "self-test passed: ${#PATTERNS[@]} pattern(s) enforced, fixtures behave as specified"
  return 0
}

scan() {
  local failures=0 pattern file matches
  # Built with a read loop rather than `mapfile`, which macOS's bash 3.2 lacks.
  FILES=()
  while IFS= read -r file; do
    FILES+=("$file")
  done < <(files_to_scan)

  if [[ ${#FILES[@]} -eq 0 ]]; then
    err "no tracked files to scan — refusing to report a pass"
    return 1
  fi

  for pattern in "${PATTERNS[@]}"; do
    # -I skips binaries, -n gives line numbers for the annotation.
    if matches="$(grep -IniE -- "$pattern" "${FILES[@]}" 2>/dev/null)"; then
      while IFS= read -r file; do
        err "forbidden claim (/$pattern/): $file"
        failures=$((failures + 1))
      done <<< "$matches"
    fi
  done

  if [[ $failures -gt 0 ]]; then
    err "$failures forbidden claim(s) found — see docs/disclosure/zk-setup-status.md for the wording to use instead"
    return 1
  fi
  echo "clean: ${#FILES[@]} file(s) scanned against ${#PATTERNS[@]} pattern(s)"
  return 0
}

main() {
  load_patterns
  case "${1:-}" in
    --list)
      printf '%s\n' "${PATTERNS[@]}"
      ;;
    --self-test)
      self_test
      ;;
    '')
      self_test
      scan
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
}

main "$@"
