#!/usr/bin/env bash
# Runs TLC (from a pinned tla2tools.jar, inside a pinned JRE Docker image — no
# local Java needed) over the SeatBooking model.
#
#   formal/check.sh                     positive checks: every invariant must HOLD
#   formal/check.sh --negative-control  every checker must be shown to FAIL:
#                                         NaiveMutualExclusion -> MutualExclusion violated
#                                         PartialAtomicity     -> Atomicity violated
#                                         Witness              -> NoContendedOutcome violated (vacuity guard)
#   formal/check.sh --all               both, in that order
#
# Exit 0 only if every selected check behaves as expected. A positive check
# fails on any non-zero TLC exit; a negative check fails unless TLC exits 12
# (invariant violation) AND names exactly the expected invariant, so a parse
# error or a different violation can never masquerade as "violation found".
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tla2tools.pin
source "$HERE/tla2tools.pin"
CACHE="$HERE/.cache"
JAR="$CACHE/tla2tools.jar"

POSITIVE=(MutualExclusion Atomicity)
# name:expected-violated-invariant
NEGATIVE=(NaiveMutualExclusion:MutualExclusion PartialAtomicity:Atomicity Witness:NoContendedOutcome)

sha256_of() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

fetch_jar() {
  if [[ ! -f "$JAR" ]]; then
    mkdir -p "$CACHE"
    echo "Downloading tla2tools.jar $TLA_VERSION ..."
    curl -fsSL -o "$JAR.tmp" "$TLA_URL" || { echo "FAIL: download of $TLA_URL failed" >&2; rm -f "$JAR.tmp"; exit 2; }
    mv "$JAR.tmp" "$JAR"
  fi
  local actual; actual="$(sha256_of "$JAR")"
  if [[ "$actual" != "$TLA_SHA256" ]]; then
    echo "FAIL: $JAR sha256 $actual != pinned $TLA_SHA256 (deleting it)" >&2
    rm -f "$JAR"; exit 2
  fi
}

# tlc <config-name>: prints TLC output on stdout, returns TLC's exit code.
tlc() {
  docker run --rm \
    -v "$JAR:/tla/tla2tools.jar:ro" -v "$HERE:/spec:ro" -w /spec \
    "$JRE_IMAGE" \
    java -XX:+UseParallelGC -cp /tla/tla2tools.jar tlc2.TLC \
      -nowarning -workers auto -metadir /tmp/tlc-states -config "$1.cfg" SeatBooking.tla 2>&1
}

failures=0

run_positive() {
  local name="$1" out rc
  out="$(tlc "$name")"; rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "PASS  $name  ($(grep -E 'distinct states found' <<<"$out" | head -1 | sed -E 's/^([0-9]+) states generated, ([0-9]+) distinct.*/\1 states, \2 distinct/'))"
  else
    echo "FAIL  $name  (TLC exit $rc)"; echo "$out" | sed 's/^/      /'; failures=$((failures + 1))
  fi
}

run_negative() {
  local name="${1%%:*}" expect="${1##*:}" out rc
  out="$(tlc "$name")"; rc=$?
  if [[ $rc -eq 12 ]] && grep -q "Invariant $expect is violated" <<<"$out"; then
    echo "PASS  $name  (expected violation of $expect found; trace length $(grep -cE '^State [0-9]+:' <<<"$out"))"
    [[ -n "${FORMAL_SHOW_TRACE:-}" ]] && echo "$out" | sed 's/^/      /'
  else
    echo "FAIL  $name  (wanted TLC exit 12 + 'Invariant $expect is violated'; got exit $rc)"; echo "$out" | sed 's/^/      /'
    failures=$((failures + 1))
  fi
}

mode="${1:-positive}"
case "$mode" in
  positive|--positive|--all|--negative-control) ;;
  *) echo "usage: $0 [--negative-control|--all]" >&2; exit 64 ;;
esac

docker info >/dev/null 2>&1 || { echo "FAIL: Docker daemon not reachable" >&2; exit 2; }
fetch_jar

if [[ "$mode" == positive || "$mode" == --positive || "$mode" == --all ]]; then
  echo "== Positive checks: invariants must hold =="
  for n in "${POSITIVE[@]}"; do run_positive "$n"; done
fi
if [[ "$mode" == --negative-control || "$mode" == --all ]]; then
  echo "== Negative controls: checkers must be shown to fail =="
  for n in "${NEGATIVE[@]}"; do run_negative "$n"; done
fi

if [[ $failures -ne 0 ]]; then echo "formal:check FAILED ($failures)"; exit 1; fi
echo "formal:check OK"
