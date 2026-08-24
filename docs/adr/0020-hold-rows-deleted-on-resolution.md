---
status: accepted
---

# `holds`/`hold_seats` rows are deleted on resolution, not archived

`DELETE /bookings/{id}` (the only existing precedent for "an outstanding claim resolves" in this codebase) deletes `bookings`/`booking_seats` outright rather than soft-deleting or status-flagging them — a second cancel on the same id 404s rather than succeeding idempotently, by design (see the comment at `src/routes/bookings.ts:118-122`). Holds follow the identical pattern for both resolution paths: confirm's transaction inserts the resulting `bookings`/`booking_seats` row and deletes the matching `holds`/`hold_seats` rows in the same transaction; the reaper's expiry sweep resets the seat(s) and deletes the same rows. There is no `holds.status` column and no `bookings.hold_id` lineage FK — introducing an audit trail solely for holds, when nothing else in the system keeps one, would be an unexplained inconsistency with the cancellation precedent. A hold's outcome is discoverable only from its effect (a `Booking` now exists, or the `Seat` is `available` again), not from a historical record of the hold itself.
