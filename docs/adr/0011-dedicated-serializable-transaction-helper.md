---
status: accepted
---

# Serializable isolation gets its own transaction helper, not a parameter on the shared one

`withTransaction` (`src/db/pool.ts`) and `runTransactionalBooking` (`src/strategies/idempotency.ts`) are shared by every mechanism and always issue a plain `BEGIN`. The serializable mechanism instead needs `BEGIN ISOLATION LEVEL SERIALIZABLE` plus a retry loop on Postgres's `40001` serialization-failure code. Rather than making either shared helper isolation-level-aware, a new `withSerializableTransaction` sits alongside `withTransaction` in `pool.ts`, keeping this serializable-only retry concern out of the four other mechanisms that funnel through the same shared code. Its retry policy — capped at 5 attempts with a 1–5ms jittered backoff — deliberately differs from optimistic locking's (capped at 3, no backoff; see ADR-0009): optimistic's CAS retry only fires on a narrow, rare race (a concurrent cancellation), while serialization failures are expected to scale with ordinary concurrency, so a tight unjittered retry loop here would itself distort the p99 latency numbers this project exists to measure.
