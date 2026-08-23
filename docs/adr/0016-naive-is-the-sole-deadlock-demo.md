---
status: accepted
---

# naive is the sole adversarial-deadlock demo; other deadlock-capable mechanisms ship pre-ordered

`naive`, `unique_constraint`, `optimistic`, and `serializable` all perform a blocking `UPDATE` on `seats` as part of their per-seat write, so all four can deadlock across an unordered multi-seat set; `pessimistic` (`FOR UPDATE NOWAIT`) and `advisory` (`pg_try_advisory_xact_lock`) cannot (ADR-0006). Rather than taking each of the four deadlock-capable mechanisms through its own genuinely-broken-then-fixed before/after cycle, only `naive` gets that treatment (Phase 3, todo.md), mirroring Phase 0's naive/Exhibit A precedent: its multi-seat extension is committed without consistent seat-id ordering first, run against a real adversarial overlapping-seat-set workload to capture a genuine nonzero deadlock rate, then fixed with ordering and re-measured for the "after." `unique_constraint`, `optimistic`, and `serializable` ship with ordering applied from their first multi-seat commit, with no separate demo — the underlying Postgres phenomenon (an unordered wait-for cycle on row locks) is identical across all four, so re-proving it mechanism-by-mechanism would spend real implementation time on evidence already established once, against todo.md's own priority note to keep Phase 3 inside its allotted share of the project timeline.
