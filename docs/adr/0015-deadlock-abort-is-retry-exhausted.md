---
status: accepted
---

# A deadlock abort is retry_exhausted, not its own result kind

Postgres's deadlock detector aborting one side of a multi-seat transaction (`40P01`) is, from the client's perspective, exactly ADR-0012's definition of `retry_exhausted`: the mechanism never learned whether the requested seat set was genuinely available, only that it couldn't resolve contention within its bounded retry budget. Rather than adding a fourth `BookSeatResult` kind (e.g. `deadlock_exhausted`) that would mean almost the same thing to a caller as `retry_exhausted` already does, a deadlock abort that exhausts `withDeadlockRetry`'s budget (ADR-0014) — or `serializable`'s extended loop — surfaces as the existing `retry_exhausted` kind (HTTP 503). This keeps the API's failure-mode vocabulary at the two outcomes ADR-0012 already established (`conflict`: a clean loss; `retry_exhausted`: contention that couldn't be resolved in time) rather than growing a third category the client has no reason to act on any differently. It also means the adversarial deadlock harness's deadlock-rate metric is read off the same `X-Booking-Retries`/`retry_exhausted` signal every other exhibit already reports, with no new instrumentation.
