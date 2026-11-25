# formal/ — TLA+ model of seat acquisition and multi-seat Booking

Phase 6, formal track, ticket F1 (#43). Model-checked with TLC, run from a pinned
`tla2tools.jar` inside a pinned JRE Docker image — no local Java required.

```bash
npm run formal:check                     # invariants must HOLD on the default model
npm run formal:check:negative            # every checker must be shown to FAIL
bash formal/check.sh --all               # both
FORMAL_SHOW_TRACE=1 npm run formal:check:negative   # also print the counterexample traces
```

Exit status is non-zero on any violation (positive mode) or on any control that
*fails to fail* (negative mode). A negative control only passes if TLC exits 12
**and** names the expected invariant, so a parse error or a different violation
cannot pass for "violation found".

## Files

| File | Role |
|---|---|
| `SeatBooking.tla` | The spec. `ClaimMode` selects the claim primitive. |
| `MutualExclusion.cfg` | `atomic`, invariant `MutualExclusion` (+ `TypeOK`). Must pass. |
| `Atomicity.cfg` | `atomic`, invariant `Atomicity` (+ `TypeOK`). Must pass. |
| `NaiveMutualExclusion.cfg` | `naive`, `MutualExclusion`. **Negative control: must be violated.** |
| `PartialAtomicity.cfg` | `partial`, `Atomicity`. **Negative control: must be violated.** |
| `Witness.cfg` | `atomic`, `NoContendedOutcome`. **Vacuity guard: must be violated** — shows the default model reaches a committed two-seat Booking alongside a conflict-aborted request, so the passing invariants aren't passing on a model that never contends. |
| `tla2tools.pin` | Pinned TLC version, download URL, SHA-256, and JRE image digest. |
| `check.sh` | The runner behind the npm scripts. Downloads the jar into `.cache/` (gitignored) on first use and refuses to run it if its SHA-256 differs from the pin. |

## Claim primitives (`ClaimMode`)

- **`atomic`** (default) — check-and-claim of one seat is one atomic step that also sees
  *in-flight* claims. Models `SELECT … FOR UPDATE NOWAIT` (`pessimistic`, ADR-0006) and the
  unique-index entry of an in-flight `INSERT … ON CONFLICT` (`unique_constraint`, ADR-0008). A
  request that finds a seat already claimed aborts and rolls back all its claims (HTTP 409).
- **`naive`** — unguarded read-then-write with **no unique backstop**: the availability read
  sees committed rows only; the write after it is unconditional. This is `naive.ts` as it
  behaved *before* ADR-0008. Expected to violate `MutualExclusion`.
- **`partial`** — per-seat `INSERT … ON CONFLICT DO NOTHING` whose affected-row count is
  ignored, so a request commits whichever seats it won. Not a mechanism in `src/`; it exists so
  the `Atomicity` checker is also shown capable of failing. Expected to violate `Atomicity`.

## Invariants

- **MutualExclusion** — a seat belongs to at most one *committed* Booking.
- **Atomicity** — a committed Booking holds exactly the seats it requested; a request that
  never started or aborted leaves no rows behind. (In a transactional model this is largely
  true by construction; the invariant exists to catch a spec — or a SQL path — that commits
  partial results, which `partial` demonstrates.)

## Abstractions

1. **One Event, one seat pool.** Seat rows, `seats.status`, and `booking_seats` rows are collapsed
   into one thing: `rows[r]`, the seats request `r` has written a claim for.
2. **Visibility.** A claim is invisible to others' plain reads until its transaction commits
   (read committed), but under `atomic` it is already visible to *claim attempts* — that is what a
   held row lock or an in-flight unique-index entry is.
3. **No blocking.** `atomic` fails fast on contention (NOWAIT / ON CONFLICT), matching ADR-0006.
   Blocking acquisition and lock ordering are modeled in F2 (#45), not here, so request-internal
   seat order is nondeterministic and irrelevant.
4. **Single attempt.** Each request runs once: no retries, no idempotency key, no cancellation,
   no crash or ambiguous commit. Holds/Confirm/Reaper/Cancel are F3 (#46); faults and idempotent
   retry are F4 (#47).
5. **Not modeled:** `optimistic`'s version column, `advisory` locks, `serializable`'s SSI. The
   model treats them as realizations of the same "atomic claim" contract; F5 (#48) maps spec
   actions to the SQL that implements them.
6. **No liveness.** Safety only (`Spec` has no fairness); reaper liveness is F3.

## Small-scope bounds

3 requests, 3 seats, seat sets of size 1 or 2. `want` is *not* fixed in the config: `Init`
ranges over every assignment of one of the 6 admissible seat sets to each request (216 initial
states), so contention patterns (shared seat, overlapping pairs, identical pairs, disjoint) are
all covered exhaustively rather than by a hand-picked scenario. Default model: 59,550 states
generated, 23,262 distinct; exhaustive within these bounds. Small-scope evidence is not a proof
for arbitrary N — it is the small-scope hypothesis: counterexamples to protocols like this one
almost always appear at two or three participants (the naive control's trace is 7 states).

## Pinning

TLC 2.19 (`tla2tools.jar` v1.7.4), SHA-256 `936a2620…8e88`; full value, URL and the JRE image
digest in `tla2tools.pin`. The checksum was computed from the release asset at pin time (GitHub
published no asset digest for v1.7.4), so it guards against later drift or tampering, not against
a compromised original download.
