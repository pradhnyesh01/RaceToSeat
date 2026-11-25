---
status: accepted
---

# Every checker gets a negative control, and none of them may touch production code

An Oracle that has never been seen to fail proves nothing: a clean chaos run is only evidence if the same pipeline demonstrably goes red on a run that *should* fail. But the only ways to make this project's own code violate its guarantee are to weaken it — add a `DISABLE_SAFETY` flag, an injected bug, a test-only branch — and that is exactly the kind of production-code surface a correctness project must not carry. So every control is built outside `src/` and `db/schema.sql`, in two layers (issue #44):

**Unit controls — hand-corrupted databases.** `test/chaos/oracles.test.ts` runs each Oracle query against a database corrupted by hand in exactly the way that Oracle exists to catch (a seat in two Bookings, a multi-seat Booking missing a seat, a key with two Bookings, a leaked row lock, ...), expects the specific violation kind, and pairs each with a clean-state twin proving the Oracle isn't simply always red. A mutation check was done once by hand: replacing the Oracles' verdict with an unconditional pass makes 20 of those 28 tests fail (the other 8 are the clean twins).

**End-to-end control — the real pipeline against a weakened database.** The production schema's `UNIQUE(seat_id)` constraints (ADR-0008) are what stop `naive` from double-booking on the shared schema, so the control runs `naive` against a *scratch database* whose schema is `db/schema.sql` applied verbatim and then those constraints dropped by name (`load-harness/chaos/scratchDb.ts`). The same app code, driver, k6 load, replay and Oracles run end to end, with `--expect-violations` inverting the exit code: the control *fails* if the Oracles flag nothing. The scratch schema is derived from the real file rather than hand-copied so it can't drift, and constraints are dropped without `IF EXISTS` so a renamed constraint breaks the control loudly instead of leaving it vacuously passing. The dev/test database, the schema file, and every strategy are untouched; the scratch database is created and dropped within the run. A matching run of `naive` on the real schema must stay green — the control only counts if both halves hold.

**Rejected:** a test-only toggle or fault-injection hook in the strategies (puts a way to be wrong into production code, and the control would then be testing the toggle, not the system); a second hand-maintained "weak schema" file (drifts); mocking the Oracles' inputs (tests the Oracle's JS, not its SQL against a real database).

**Consequence for later tickets:** every new Oracle, Fault, or checker added in C2–C5 (and the formal track's own negative controls) ships with its control in the same ticket, built the same way.
