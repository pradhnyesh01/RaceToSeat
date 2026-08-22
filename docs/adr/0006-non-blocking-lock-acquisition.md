---
status: accepted
---

# Use non-blocking lock acquisition for pessimistic and advisory mechanisms

FR1 requires a losing request to receive `409` "immediately," never queuing indefinitely. Plain `SELECT ... FOR UPDATE` and `pg_advisory_xact_lock` both block the caller until the lock holder's transaction ends, which turns a hot seat into a queue rather than an immediate rejection. The pessimistic and advisory mechanisms instead use `SELECT ... FOR UPDATE NOWAIT` and `pg_try_advisory_xact_lock`, both of which fail instantly if the row/lock is already held, so a losing request returns `409` without waiting on the winner's commit. This also produces a cleaner benchmark: it isolates conflict-detection latency from the winner's transaction duration, which a blocking design would conflate.
</content>
