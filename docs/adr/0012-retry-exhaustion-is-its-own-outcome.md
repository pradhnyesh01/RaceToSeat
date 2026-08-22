---
status: accepted
---

# Exhausted retries surface as their own outcome, not as an ordinary conflict

Optimistic and serializable can each exhaust their retry budget (ADR-0009, ADR-0011) without ever determining whether the seat was genuinely taken. Folding that outcome into the existing `conflict` result (HTTP 409) would make it indistinguishable from a clean loss, which would hide exactly the failure-mode data (NFR4, NFR5) this project's mechanism comparison depends on — a mechanism that quietly reports exhaustion as an ordinary conflict would look artificially clean in the benchmark next to one that doesn't exhaust retries at all. `BookSeatResult` gains a `retry_exhausted` kind, surfaced as HTTP 503, shared by both mechanisms since it's genuinely the same failure category (the mechanism couldn't resolve contention in time) even though the retry policies that lead to it differ. Every `/bookings` response also carries an `X-Booking-Retries` header (`0` for mechanisms that never retry) so the load harness can tally retry rate directly from a k6 run rather than scraping server logs or standing up a separate metrics endpoint.

**Consequence**: the Phase 2 comparison doc and its aggregation script must report retry-exhaustion rate as its own column per mechanism. Bucketing `retry_exhausted` into a generic "failure" tally at the reporting layer would erase the distinction this ADR makes at the API layer.
