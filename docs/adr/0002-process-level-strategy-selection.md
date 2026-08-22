---
status: accepted
---

# Select the concurrency-control strategy per-process, not per-request

PRD §7 describes the five concurrency mechanisms as sitting "behind a configurable strategy flag," which could be read as a per-request choice (e.g. a request header). We fix the strategy at process startup instead (e.g. `BOOKING_STRATEGY=pessimistic`), so a single running server instance always uses exactly one mechanism for the lifetime of the process. Letting a client choose its own concurrency strategy per request isn't representative of a real system, and mixing mechanisms against the same seat rows within one benchmark run would contaminate the throughput/latency comparison the project's evidence depends on. To benchmark a different mechanism, restart the server (or point the load harness at a separately-configured instance).
</content>
