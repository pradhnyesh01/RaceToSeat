---
status: accepted
---

# Add a shared UNIQUE constraint on booking_seats.seat_id

PRD §7 describes the unique-constraint mechanism as `INSERT ... ON CONFLICT DO NOTHING` against a unique `(seat_id)` index, but ADR-0003 commits every mechanism to one shared schema, differing only in the SQL each executes — not in table design. We resolve the tension by adding the `UNIQUE` constraint to the shared schema itself rather than scoping it to one mechanism, making it a defense-in-depth backstop for every mechanism (pessimistic, advisory, serializable, and naive), not just the one demonstrating it. This follows CLAUDE.md's "correctness over convenience" priority over keeping the naive baseline forever reproducible.

## Consequences

Re-running the naive strategy after this lands no longer reproduces Exhibit A's double-booking live: a concurrent `INSERT` into `booking_seats` for an already-claimed seat now fails at the constraint instead of silently succeeding. Phase 0's captured Exhibit A evidence (`docs/evidence/`) remains the historical "before" record; Phase 1's before/after comparison (todo.md) compares against that record rather than a live naive re-run. `naive.ts`'s insert path must additionally catch this new unique-violation and return `409` (matching FR1's "never a silent overwrite"), not let it surface as an uncaught `500`.
