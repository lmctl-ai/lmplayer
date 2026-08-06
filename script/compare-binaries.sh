#!/usr/bin/env bash
# Compare two opencode-fork binaries (bun --compile standalone executables:
# the Bun runtime with the bundled/minified app JS appended). A raw byte diff
# is mostly runtime noise, so this checks identity first, then falls back to
# diffing embedded strings (paths, version tags, error text) as a proxy for
# "did the app bundle actually change".
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <binary-a> <binary-b>" >&2
  exit 2
fi

a="$1"
b="$2"

for f in "$a" "$b"; do
  if [ ! -r "$f" ]; then
    echo "error: cannot read '$f' (missing or permission denied — try sudo/sudo -u)" >&2
    exit 1
  fi
done

size_a=$(stat -c %s "$a")
size_b=$(stat -c %s "$b")
echo "== size =="
printf '  %-10s %12d bytes  %s\n' "a" "$size_a" "$a"
printf '  %-10s %12d bytes  %s\n' "b" "$size_b" "$b"

echo "== sha256 =="
sha_a=$(sha256sum "$a" | cut -d' ' -f1)
sha_b=$(sha256sum "$b" | cut -d' ' -f1)
echo "  a: $sha_a"
echo "  b: $sha_b"

if [ "$sha_a" = "$sha_b" ]; then
  echo "== result: IDENTICAL (sha256 matches, byte-for-byte the same file) =="
  exit 0
fi

echo "== result: DIFFERENT =="

echo "== embedded version tag =="
# Note: -m1 stops reading after the first match, which makes `strings` (the
# upstream writer) receive SIGPIPE; piped through `|` that trips `pipefail`
# even though grep itself succeeded. Using process substitution instead of a
# pipe keeps grep's exit status the only one that matters here.
ver_a=$(grep -m1 -oE '[0-9]+\.[0-9]+\.[0-9]+-dev-[0-9]+' < <(strings -n 6 "$a") || echo "(not found)")
ver_b=$(grep -m1 -oE '[0-9]+\.[0-9]+\.[0-9]+-dev-[0-9]+' < <(strings -n 6 "$b") || echo "(not found)")
echo "  a: $ver_a"
echo "  b: $ver_b"

echo "== first differing byte =="
cmp "$a" "$b" || true

tmp_a=$(mktemp)
tmp_b=$(mktemp)
trap 'rm -f "$tmp_a" "$tmp_b"' EXIT

echo "== extracting printable strings (>=8 chars) for a text-level diff =="
strings -n 8 "$a" | sort -u > "$tmp_a"
strings -n 8 "$b" | sort -u > "$tmp_b"

echo "== string-level diff (added/removed lines only, capped at 200) =="
diff "$tmp_a" "$tmp_b" | grep -E '^[<>]' | head -200 || echo "  (no line-level differences in extracted strings)"

echo
echo "note: minified/bundled JS often reshuffles unrelated content on every"
echo "build (generated identifiers, embedded timestamps), so some diff noise"
echo "here does not necessarily mean a functional change — check the version"
echo "tag above and, if needed, rebuild both from the same commit to confirm."
