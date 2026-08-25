# Exhibit F — Phase 5 hold-expiry-under-load evidence

Phase 5 deliverable (todo.md, issue #41): evidence that the hold → confirm →
expire flow (issues #38-#40, `pessimistic` only, ADR-0017) survives the real
"expire under load" race — a client slow to confirm, the reaper's background
sweep, and a different client trying to claim the now-stale seat, all firing
at once — with no double-confirm and no permanently stuck seat.

## Method

`load-harness/hold-expiry-race.k6.js` (`run.ts --pattern hold-expiry`)
seeds `--concurrency` distinct seats, holds every one of them via a real
`POST /holds` call, waits until every seeded hold's own `held_until` has
passed, then fires two concurrent streams at each one: 5 concurrent
`POST /holds/{id}/confirm` attempts per hold (one-shot — the claim under
test is that confirm *never* succeeds post-expiry, so retrying it would
prove nothing extra), and 5 concurrent fresh `POST /holds` attempts per
seat (each retrying on `409` with a short sleep, up to 10 attempts — a real
client that knows a hold is past its TTL but still sees `409` would
legitimately retry, since the only thing standing between "expired" and
"available" is the reaper's own sweep timer). `--repeat` reseeds fresh
seats/holds each attempt rather than resetting via an API call — there's no
hold-cancellation endpoint to reset one through.

Run against a short `HOLD_TTL_SECONDS` and `REAPER_INTERVAL_MS`, sized so
three budgets stay cleanly nested — `REAPER_INTERVAL_MS` < the fresh-hold
retry budget (10 attempts × 0.3s ≈ 3s worst case) < `HOLD_TTL_SECONDS` —
so the wait-past-expiry step stays fast, the reaper has genuinely raced the
burst rather than having swept long before it fired, and a winning fresh
hold can't itself expire and get re-won by a still-retrying straggler
before the run ends (that doesn't break correctness, but it does produce a
confusing second "winner" for a seat that was never actually double-held at
any single point in time):

```bash
docker compose up -d
npm run db:migrate
HOLD_TTL_SECONDS=8 REAPER_INTERVAL_MS=1000 BOOKING_STRATEGY=pessimistic PORT=3000 npm run start
BOOKING_STRATEGY=pessimistic npm run harness -- --pattern hold-expiry --concurrency 200 --repeat 3

npm run harness:aggregate -- --exhibit f   # this script — reads docs/evidence/*.json, writes this file
```

## Results

Report: [pessimistic-hold-expiry-load-run-2026-08-25T08-48-13-427Z.json](pessimistic-hold-expiry-load-run-2026-08-25T08-48-13-427Z.json) (3 repeat(s), 200 seat(s) per repeat).

| Attempt | Seats held | Confirm 201 | Confirm 410 | Confirm 409 | Confirm 404 | Fresh-hold 201 | Fresh-hold 409 | Late confirms | Stuck seats | Fresh-hold winners |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 200 | 0 | 0 | 0 | 1000 | 200 | 800 | 0 | 0 | 200/200 |
| 2 | 200 | 0 | 0 | 0 | 1000 | 200 | 800 | 0 | 0 | 200/200 |
| 3 | 200 | 0 | 668 | 332 | 0 | 200 | 800 | 0 | 0 | 200/200 |


Confirm's split between `410`/`404` varies attempt to attempt (compare
attempt 3 above to attempts 1-2) — the reaper sweeps on its own fixed
interval, independent of exactly when any given hold's TTL elapses, so
whether a confirm attempt catches a hold still present-but-expired (`410`,
confirm's own lazy backstop, ADR-0018) or already-reaped (`404`) depends on
where that hold's expiry lands relative to the reaper's tick schedule —
genuine timing variability, not a bug. Both outcomes are equally valid
evidence for "no late-succeeding confirms."

**Totals across 3 repeat(s), 600 seat(s):**

| Late-succeeding confirms | Permanently stuck seats | Fresh-hold winners |
|---|---|---|
| **0** | **0** | 600/600 |

**PASS** — zero late-succeeding confirms, zero permanently stuck seats, and every seat was successfully re-claimed by a fresh hold once released.

## Reading the columns

- **Confirm 201/410/409/404**: HTTP status tally across every one-shot
  confirm attempt in the repeat, straight from k6's `--summary-export`.
  `410` (expired, confirm's own lazy backstop, ADR-0018) and `404` (hold
  not found — the reaper already swept its rows) are both expected outcomes
  here; `201` never should be, since every confirm in this pattern only
  ever fires after its hold's TTL has passed.
- **Fresh-hold 201/409**: HTTP status tally across every fresh `POST /holds`
  attempt's *final* try (after any internal 409 retries) — `409` here means
  the seat still hadn't been released by the time that VU's retry budget
  ran out, not that it never will be.
- **Late confirms**: ground truth, not HTTP status — bookings found via the
  synthesized `hold-confirm:<id>` idempotency key
  (`pessimisticConfirm.ts`'s `confirmIdempotencyKey`) for any hold this run
  seeded. The single hard correctness claim this exhibit exists to test.
- **Stuck seats**: ground truth — seats still `status = 'held'` with
  `held_until` in the past, read directly from `seats`, well after the k6
  run finished. Proves the reaper (issue #40) actually closes the loop, not
  just that *a* fresh hold happened to win within the burst window.
- **Fresh-hold winners**: ground truth — seats whose current `hold_seats`
  row belongs to a hold id this run did *not* seed, i.e. a fresh attempt
  won the seat back after release.

## Next step

Phase 5 (todo.md) is complete: hold creation (#38), confirm (#39), the
reaper (#40), and this evidence run (#41) are all shipped. No further
follow-up ticket from this exhibit.
