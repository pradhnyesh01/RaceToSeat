# Exhibit A — naive strategy double-books a seat under concurrent load

Phase 0 deliverable (todo.md): evidence that the naive read-then-write booking
logic (`src/strategies/naive.ts`) allows more than one winner per seat under
concurrency, with no locking to prevent it.

## Method

`load-harness/hammer-seat.ts` seeds one fresh seat, fires N concurrent
`POST /bookings` requests at it (unique `user_id`/`idempotency_key` per
request, same `seat_id`), then reads `booking_seats` directly — not the HTTP
responses — to count how many distinct bookings actually claimed the seat.

```bash
npm run db:migrate
npm run db:seed
npm run start            # BOOKING_STRATEGY=naive (default)
npm run harness:naive -- --concurrency 1000
```

## Results (two independent runs, 1,000 concurrent requests each)

| Run | Winners (should be 1) | HTTP 201s | HTTP 409s |
|---|---|---|---|
| [naive-load-run-2026-08-22T12-06-22-459Z.json](naive-load-run-2026-08-22T12-06-22-459Z.json) | **5** | 5 | 995 |
| [naive-load-run-2026-08-22T12-06-28-834Z.json](naive-load-run-2026-08-22T12-06-28-834Z.json) | **50** | 50 | 950 |

Both runs violate NFR1 / the PRD's single hard pass/fail gate ("of N
simultaneous requests for the same seat, exactly 1 succeeds"). Every request
that got a 201 read the seat as `available` in its `SELECT` before any of the
concurrent writers had committed — the classic lost-update race described in
problem-statement.md.

## Next step

Phase 1 (todo.md) replaces this with the unique-constraint and pessimistic-
locking mechanisms and re-runs this same harness to confirm exactly one
winner per seat.
