#!/usr/bin/env bash
# Compiles every published interface and every deployable example, then asserts
# that each interface circuit's verifier key is byte-identical to the one the
# example contract deploys (scripts/check-keys.mjs lists the pairs).
#
#   scripts/build.sh                 incremental (skips a target whose output is
#                                    newer than every .compact source)
#   scripts/build.sh --force         recompile everything
#   scripts/build.sh --interfaces    interfaces only (seconds; skips the slow
#                                    example contracts and the key check)
#
# Requires the `compact` CLI on PATH (or COMPACT_BIN set) with the toolchain
# versions pinned in package.json.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPACT="${COMPACT_BIN:-compact}"
command -v "$COMPACT" >/dev/null 2>&1 || { echo "error: '$COMPACT' not found on PATH; set COMPACT_BIN" >&2; exit 2; }

FORCE=0
INTERFACES_ONLY=0
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    --interfaces) INTERFACES_ONLY=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

# example directory : integration module base name
TOKENS=(fungible nft multi)
declare -a MODULES=(FungibleTokenReadable NonFungibleTokenReadable MultiTokenReadable)

newest_source() {
  find "$ROOT/compact" -name '*.compact' -print0 | xargs -0 stat -f '%m' 2>/dev/null | sort -rn | head -1
}
NEWEST_SRC="$(newest_source)"

compile() { # $1 src  $2 outdir  $3 label
  local src="$1" out="$2" label="$3"
  local manifest="$out/compiler/contract-manifest.json"
  if [ "$FORCE" -eq 0 ] && [ -f "$manifest" ]; then
    local m; m="$(stat -f '%m' "$manifest")"
    if [ "$m" -ge "$NEWEST_SRC" ]; then echo "  up to date: $label"; return 0; fi
  fi
  rm -rf "$out"; mkdir -p "$out"
  echo "  compiling: $label"
  "$COMPACT" compile "$src" "$out" | sed 's/^/    /'
  # The generated contract/index.js is ESM; Node only treats it as such if the
  # directory declares it. The compiler does not write this file.
  printf '{ "type": "module" }\n' > "$out/contract/package.json"
}

echo "== interfaces =="
for i in "${!TOKENS[@]}"; do
  t="${TOKENS[$i]}"; m="${MODULES[$i]}"
  compile "$ROOT/compact/integrations/openzeppelin/$m.Interface.compact" "$ROOT/build/$t/interface" "$t/interface ($m.Interface.compact)"
done

if [ "$INTERFACES_ONLY" -eq 1 ]; then
  echo "(--interfaces: skipping example contracts and the key check)"
  exit 0
fi

echo "== examples (deployable contracts; minutes) =="
for t in "${TOKENS[@]}"; do
  compile "$ROOT/compact/examples/$t/Full.compact" "$ROOT/build/$t/full" "$t/full (examples/$t/Full.compact)"
done

echo "== verifier key identity =="
exec node "$ROOT/scripts/check-keys.mjs"
