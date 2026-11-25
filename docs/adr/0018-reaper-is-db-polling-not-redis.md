---
status: accepted
---

# The hold reaper polls Postgres directly; no Redis

todo.md's Phase 5 entry names "background worker / Redis TTL" as alternatives without resolving between them. PRD.md's Architecture section chose Postgres specifically because it "supports all five [now six] in-scope concurrency mechanisms without switching databases" — introducing Redis as a second stateful dependency, solely to get TTL expiry for one stretch-phase feature, would undercut that single-datastore rationale for a feature that doesn't need it. The reaper is instead a polling loop (default 5s interval, overridable via env var for the load-test harness) issuing `UPDATE seats SET status = 'available' ... WHERE status = 'held' AND held_until < now()`. `seats.held_until`/`booked_by` — reserved but unused since Phase 0 (schema.sql) — stay denormalized directly on `seats` rather than being dropped in favor of a `holds`-table-only design, so this scan stays a plain indexed query instead of a three-way join running on a timer. Confirm's own precondition check (`status = 'held' AND held_until > now()`, same transaction as its row lock) acts as a lazy backstop regardless of the reaper's cadence, so a hold can never be confirmed past expiry even in the window before the reaper next runs.
