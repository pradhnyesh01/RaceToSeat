---
status: accepted
---

# Use raw node-postgres instead of an ORM

The project's core deliverable is comparing five Postgres concurrency-control mechanisms (`SELECT ... FOR UPDATE`, `pg_advisory_xact_lock`, `SERIALIZABLE` isolation, an optimistic version-column compare-and-swap, and `INSERT ... ON CONFLICT`), each depending on precise transaction and locking semantics. An ORM's query abstraction would obscure exactly the SQL behavior under test, and advisory locks and explicit isolation levels don't map cleanly onto typical ORM APIs anyway. We use `pg` (node-postgres) directly and hand-write the SQL for all booking logic, across all five mechanisms.
</content>
