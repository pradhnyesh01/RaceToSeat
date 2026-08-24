---
status: accepted
---

# Phase 5 (holds) is implemented for `pessimistic` only, not all six mechanisms

Every prior phase (2–4) extended a new capability across all six `BOOKING_STRATEGY` mechanisms and compared them against each other — that repetition was justified because the project's deliverable is a *comparison*. Phase 5 (hold/TTL/reaper) isn't a mechanism comparison: it's a workflow feature, scoped as a stretch phase at 15% of project time (todo.md's priority notes) against Phase 6's 25%. Re-implementing hold-acquisition, the reaper's race handling, and a dedicated load pattern six times over would spend disproportionate time proving one Postgres phenomenon (row-lock CAS under a TTL) six times rather than once. `pessimistic` was picked as the sole implementation because `SELECT ... FOR UPDATE NOWAIT` gives the simplest mental model for "only one requester can be mid-transaction against this seat" at both hold-time and confirm-time, and it's already deadlock-free by construction (ADR-0006) even across the two-transaction hold→confirm gap. `POST /holds` and `POST /holds/{id}/confirm` return 404 under any other `BOOKING_STRATEGY` (ADR-0019) rather than silently running a different mechanism underneath.
