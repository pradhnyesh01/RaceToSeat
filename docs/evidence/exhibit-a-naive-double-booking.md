# Exhibit A — naive strategy double-books a seat under concurrent load

Phase 0 deliverable (todo.md): evidence that the naive read-then-write booking
logic (`src/strategies/naive.ts`) allows more than one winner per seat under
concurrency, with no locking to prevent it.

## Method

`load-harness/run.ts` seeds one fresh seat, then delegates the actual
concurrent request firing to a k6 script (`load-harness/hammer-seat.k6.js`,
issue #5) — N virtual users, each sending exactly one `POST /bookings` for
that seat with a unique `idempotency_key`. After k6 finishes, `run.ts` reads
`booking_seats` directly — not the HTTP responses — to count how many
distinct bookings actually claimed the seat.

```bash
docker compose up -d     # schema applies automatically on a fresh volume
npm run db:seed
npm run start             # BOOKING_STRATEGY=naive (default)
npm run harness:naive -- --concurrency 1000
```

## Results (two independent runs, 1,000 concurrent requests each)

| Run | Winners (should be 1) | HTTP 201s | HTTP 409s |
|---|---|---|---|
| [naive-load-run-2026-08-22T13-09-15-310Z.json](naive-load-run-2026-08-22T13-09-15-310Z.json) | **14** | 14 | 986 |
| [naive-load-run-2026-08-22T13-09-21-520Z.json](naive-load-run-2026-08-22T13-09-21-520Z.json) | **50** | 50 | 950 |

Both runs violate NFR1 / the PRD's single hard pass/fail gate ("of N
simultaneous requests for the same seat, exactly 1 succeeds"). Every request
that got a 201 read the seat as `available` in its `SELECT` before any of the
concurrent writers had committed — the classic lost-update race described in
problem-statement.md.

## Next step

Phase 1 (todo.md) replaces this with the unique-constraint and pessimistic-
locking mechanisms and re-runs this same harness to confirm exactly one
winner per seat.
