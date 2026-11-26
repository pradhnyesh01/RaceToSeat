#!/usr/bin/env bash
# Runs TLC (from a pinned tla2tools.jar, inside a pinned JRE Docker image — no
# local Java needed) over the SeatBooking (F1) and DeadlockFreedom (F2) models.
#
#   formal/check.sh                     positive checks: every invariant must HOLD
#   formal/check.sh --negative-control  every checker must be shown to FAIL:
#                                         NaiveMutualExclusion -> MutualExclusion violated
#                                         PartialAtomicity     -> Atomicity violated
#                                         Witness              -> NoContendedOutcome violated (vacuity guard)
#                                         DeadlockUnsorted     -> NoWaitForCycle violated (F2: unsorted blocking deadlocks)
#                                         DeadlockUnsortedStuck-> TLC "Deadlock reached" (same, without the cycle checker)
#                                         DeadlockSortedWitness-> NoHoldAndWait violated (vacuity guard)
#                                         DeadlockNowaitWitness-> NoConflictAbort violated (vacuity guard)
#                                       Lifecycle*           -> F3 (SeatLifecycle.tla): see LC_NEGATIVE below
#                                       Crash*               -> F4 (CrashRecovery.tla): see CR_NEGATIVE below
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

# F2 (DeadlockFreedom.tla): configs named Deadlock*; entries use the same name:expect form.
# expect "@stuck" means TLC's own deadlock check (exit 11, "Deadlock reached"), not an invariant.
DL_POSITIVE=(DeadlockSorted DeadlockNowait)
DL_NEGATIVE=(DeadlockUnsorted:NoWaitForCycle DeadlockUnsortedStuck:@stuck DeadlockSortedWitness:NoHoldAndWait DeadlockNowaitWitness:NoConflictAbort)

# F3 (SeatLifecycle.tla): configs named Lifecycle*. Safety and liveness are separate runs.
# expect "@temporal" means a liveness violation (TLC exit 13, "Temporal properties were violated").
LC_POSITIVE=(LifecycleSafety LifecycleLiveReaper LifecycleLiveSeat)
LC_NEGATIVE=(
  LifecycleNoExpiryCheck:NoConfirmOnExpired LifecycleReplayConfirm:HoldConfirmedAtMostOnce
  LifecycleUnguardedReaper:ReapOnlyExpired LifecycleStaleReaper:SeatStatusAgrees
  LifecycleStaleReaperExclusion:SeatBelongsToAtMostOne
  LifecycleWitnessExpiryDuringConfirm:NoExpiryDuringConfirm LifecycleWitnessConfirmWonAfterExpiry:NoConfirmWonAfterExpiry
  LifecycleWitnessReuseAfterReap:NoReuseAfterReap LifecycleWitnessBookingBlockedByHold:NoBookingBlockedByHold
  LifecycleWitnessCancelAfterConfirm:NoCancelAfterConfirm
  LifecycleLiveNoFairness:@temporal LifecycleLiveReaperDisabled:@temporal
  LifecycleLiveNoTimeFairness:@temporal LifecycleLiveNoCommitFairness:@temporal
)

# F4 (CrashRecovery.tla): configs named Crash*. Same name:expect form; "@temporal" as above.
# CrashFindingSpuriousConflict is not a control but a documented finding (RF2): the invariant is
# violated on purpose, because the behavior it names is real (README "Findings"). RF1 (#60) is
# fixed: CrashFindingKeyReuse / CrashFindingHoldKeyReuse (a key creates at most one Booking / Hold
# ever) are now POSITIVE checks, and what they used to show is kept as the negative controls
# CrashForgetKeys* (no tombstone: today's pre-fix behavior) and CrashNoInsertGuard* (tombstone
# lookup but no insert-time guard: the lookup-then-insert window).
CR_POSITIVE=(CrashSafety CrashFindingKeyReuse CrashFindingHoldKeyReuse CrashLiveRecovery)
CR_NEGATIVE=(
  CrashNoLookup:AmbiguousRetryNotRefused CrashNoKeyDedupe:KeyAtMostOneBooking CrashNoKeyDedupeHold:KeyAtMostOneHold
  CrashLoseCommitted:CommittedPersists CrashKeepLocks:NoOrphanState CrashKeepUncommitted:SeatStatusAgrees
  CrashNoExpiryCheck:NoConfirmOnExpired
  CrashForgetKeys:BookingKeyCreatesAtMostOne CrashForgetKeysHold:HoldKeyCreatesAtMostOne
  CrashNoInsertGuard:BookingKeyCreatesAtMostOne CrashNoInsertGuardHold:HoldKeyCreatesAtMostOne
  CrashFindingSpuriousConflict:KeyNeverFalselyRefused
  CrashWitnessReleasedBooking:NoReleasedBooking CrashWitnessReleasedHold:NoReleasedHold
  CrashWitnessReleasedRace:NoReleasedRace
  CrashWitnessAmbiguousCommit:NoAmbiguousCommit CrashWitnessReplayAmbiguousBooking:NoReplayAfterAmbiguousBooking
  CrashWitnessReplayAmbiguousHold:NoReplayAfterAmbiguousHold CrashWitnessReplayAmbiguousConfirm:NoReplayAfterAmbiguousConfirm
  CrashWitnessKeyRace:NoKeyRaceReplay CrashWitnessWaitOnKeyRow:NoWaitOnKeyRow
  CrashWitnessUnblockedByCrash:@temporal CrashWitnessSeatReuseAfterCrash:NoSeatReuseAfterMidCrash
  CrashWitnessConfirmCrashMidTxn:NoConfirmCrashMidTxn CrashWitnessReapAfterConfirmCrash:NoReapAfterConfirmCrash
  CrashWitnessConfirmRetryAfterMidCrash:NoRetryConfirmAfterMidCrash
  CrashLiveNoFairness:@temporal CrashLiveKeepPending:@stuck
)

# module_of <config-name>: the TLA+ module a config belongs to.
module_of() {
  case "$1" in
    Deadlock*) echo DeadlockFreedom.tla ;;
    Lifecycle*) echo SeatLifecycle.tla ;;
    Crash*) echo CrashRecovery.tla ;;
    *) echo SeatBooking.tla ;;
  esac
}

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
      -nowarning -workers auto -metadir /tmp/tlc-states -config "$1.cfg" "$(module_of "$1")" 2>&1
}

failures=0

run_positive() {
  local name="$1" out rc
  out="$(tlc "$name")"; rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "PASS  $name  ($(grep -E '^[0-9]+ states generated, [0-9]+ distinct states found' <<<"$out" | tail -1 | sed -E 's/^([0-9]+) states generated, ([0-9]+) distinct.*/\1 states, \2 distinct/'))"
  else
    echo "FAIL  $name  (TLC exit $rc)"; echo "$out" | sed 's/^/      /'; failures=$((failures + 1))
  fi
}

run_negative() {
  local name="${1%%:*}" expect="${1##*:}" out rc
  out="$(tlc "$name")"; rc=$?
  local want_rc=12 want_text="Invariant $expect is violated"
  if [[ "$expect" == "@stuck" ]]; then want_rc=11; want_text="Deadlock reached"; fi
  if [[ "$expect" == "@temporal" ]]; then want_rc=13; want_text="Temporal properties were violated"; fi
  if [[ $rc -eq $want_rc ]] && grep -q "$want_text" <<<"$out"; then
    echo "PASS  $name  (expected '$want_text' found; trace length $(grep -cE '^State [0-9]+:' <<<"$out"))"
    [[ -n "${FORMAL_SHOW_TRACE:-}" ]] && echo "$out" | sed 's/^/      /'
  else
    echo "FAIL  $name  (wanted TLC exit $want_rc + '$want_text'; got exit $rc)"; echo "$out" | sed 's/^/      /'
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
  for n in "${POSITIVE[@]}" "${DL_POSITIVE[@]}" "${LC_POSITIVE[@]}" "${CR_POSITIVE[@]}"; do run_positive "$n"; done
fi
if [[ "$mode" == --negative-control || "$mode" == --all ]]; then
  echo "== Negative controls: checkers must be shown to fail =="
  for n in "${NEGATIVE[@]}" "${DL_NEGATIVE[@]}" "${LC_NEGATIVE[@]}" "${CR_NEGATIVE[@]}"; do run_negative "$n"; done
fi

if [[ $failures -ne 0 ]]; then echo "formal:check FAILED ($failures)"; exit 1; fi
echo "formal:check OK"
