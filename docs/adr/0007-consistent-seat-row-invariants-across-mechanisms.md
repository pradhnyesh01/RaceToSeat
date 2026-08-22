---
status: accepted
---

# Every mechanism maintains the full seat row consistently

`seats.booked_by` and `seats.version` are each only strictly required by one consumer — `booked_by` by the load-test harness's correctness check, `version` by the optimistic-locking mechanism's compare-and-swap. We nonetheless require all five mechanisms to write `booked_by` and bump `version` on every status transition, not just the mechanism that "needs" them. This keeps the shared schema (ADR-0003) behaviorally uniform: the harness's `booked_by` scan works unmodified regardless of which mechanism is running, and `version` becomes a mechanism-independent "seat was mutated N times" audit signal instead of a column whose meaning depends on server configuration.
</content>
