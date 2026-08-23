---
status: accepted
---

# Optimistic-locking retries are conditional on a fresh read, not blind

The optimistic mechanism's CAS is `UPDATE seats SET status = 'booked', version = version + 1 WHERE id = $1 AND version = $2 AND status = 'available'` — the explicit `status = 'available'` guard is redundant with the version match (ADR-0007 bumps `version` on every status transition, so a matching version already implies the status hasn't changed) but costs nothing and guards against future drift in that invariant. A CAS failure here almost always means the seat is now permanently `booked`, where retrying is pointless — the one legitimate exception is a race with a concurrent cancellation (`DELETE /bookings/{id}`), which also bumps `version` and returns the seat to `available`. On CAS failure we re-read the row and retry the CAS only if the fresh read still shows `available`; otherwise we return `conflict` immediately. The retry is capped at 3 attempts with no backoff, since it only ever fires on this narrow cancellation race rather than on routine contention.
