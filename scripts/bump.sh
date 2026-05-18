#!/usr/bin/env bash
# Bump the application version across all canonical sources.
#
# Usage:
#   ./bump.sh --version <X.Y.Z[-prerelease][+build]>
#   ./bump.sh --help
#
# Updates:
#   - VERSION                       (root, source of truth)
#   - server/version.go             (Go Version constant — exposed via /api/config/app)
#   - web/package.json              (top-level "version" field)
#   - k8s/helm/codeci/Chart.yaml    (version + appVersion — drives helm-rendered image tags)
#
# Idempotent: re-running with the same version is a no-op (still rewrites files).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

usage() {
  cat <<EOF
bump.sh — set the application version everywhere

Usage:
  ./bump.sh --version <X.Y.Z[-prerelease][+build]>
  ./bump.sh --help

Examples:
  ./bump.sh --version 1.2.3
  ./bump.sh --version 1.2.3-rc.1

Files updated:
  VERSION
  server/version.go
  web/package.json
EOF
}

err() { printf 'bump.sh: %s\n' "$*" >&2; }

NEW_VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      [[ $# -ge 2 ]] || { err "--version requires a value"; exit 2; }
      NEW_VERSION="$2"
      shift 2
      ;;
    --version=*)
      NEW_VERSION="${1#--version=}"
      shift
      ;;
    -h|--help)
      usage; exit 0
      ;;
    *)
      err "unknown argument: $1"
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$NEW_VERSION" ]]; then
  err "--version is required"
  usage >&2
  exit 2
fi

# Validate semver: MAJOR.MINOR.PATCH with optional -prerelease and +build.
SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'
if ! [[ "$NEW_VERSION" =~ $SEMVER_RE ]]; then
  err "invalid version: '$NEW_VERSION' (expected X.Y.Z, optionally -prerelease or +build)"
  exit 2
fi

VERSION_FILE="$REPO_ROOT/VERSION"
GO_FILE="$REPO_ROOT/server/version.go"
PKG_FILE="$REPO_ROOT/web/package.json"
CHART_FILE="$REPO_ROOT/k8s/helm/codeci/Chart.yaml"

[[ -f "$GO_FILE"  ]] || { err "missing $GO_FILE"; exit 1; }
[[ -f "$PKG_FILE" ]] || { err "missing $PKG_FILE"; exit 1; }
[[ -f "$CHART_FILE" ]] || { err "missing $CHART_FILE"; exit 1; }

# In-place edit using a tmp file — works on both BSD (macOS) and GNU sed.
inplace() {
  local file="$1" expr="$2"
  local tmp; tmp="$(mktemp "${file}.bump.XXXXXX")"
  sed -E "$expr" "$file" > "$tmp"
  mv "$tmp" "$file"
}

# 1) VERSION
printf '%s\n' "$NEW_VERSION" > "$VERSION_FILE"

# 2) server/version.go — replace the literal in `var Version = "..."`.
if ! grep -qE '^var[[:space:]]+Version[[:space:]]*=[[:space:]]*"[^"]*"' "$GO_FILE"; then
  err "could not find 'var Version = \"...\"' in $GO_FILE"
  exit 1
fi
inplace "$GO_FILE" "s|^(var[[:space:]]+Version[[:space:]]*=[[:space:]]*\")[^\"]*(\")|\1${NEW_VERSION}\2|"

# 3) web/package.json — replace the *top-level* "version" only (the first
#    occurrence; package.json's top-level keys are at indent depth 2, and
#    "version" is conventionally near the top).
if ! grep -qE '^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$PKG_FILE"; then
  err "could not find top-level \"version\" in $PKG_FILE"
  exit 1
fi
# Use awk for a precise first-match replacement so we don't touch nested
# "version" fields (e.g. inside dependency declarations).
tmp_pkg="$(mktemp "${PKG_FILE}.bump.XXXXXX")"
awk -v ver="$NEW_VERSION" '
  !done && /^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"[^"]*"/ {
    sub(/"version"[[:space:]]*:[[:space:]]*"[^"]*"/, "\"version\": \"" ver "\"")
    done = 1
  }
  { print }
' "$PKG_FILE" > "$tmp_pkg"
mv "$tmp_pkg" "$PKG_FILE"

# 4) k8s/helm/codeci/Chart.yaml — update both `version:` and `appVersion:`.
if ! grep -qE '^version:' "$CHART_FILE"; then
  err "could not find 'version:' in $CHART_FILE"
  exit 1
fi
inplace "$CHART_FILE" "s|^version:[[:space:]]*.*$|version: ${NEW_VERSION}|"
inplace "$CHART_FILE" "s|^appVersion:[[:space:]]*.*$|appVersion: \"${NEW_VERSION}\"|"

echo "bumped to $NEW_VERSION:"
echo "  VERSION                       $NEW_VERSION"
echo "  server/version.go             $(grep -E '^var[[:space:]]+Version' "$GO_FILE")"
echo "  web/package.json              $(grep -m1 -E '^[[:space:]]*"version"' "$PKG_FILE" | sed -E 's/^[[:space:]]+//')"
echo "  k8s/helm/codeci/Chart.yaml    $(grep -E '^(version|appVersion):' "$CHART_FILE" | tr '\n' ' ')"
