---
status: accepted
---

# Model Booking as always potentially multi-seat

`Booking` is `bookings(id, user_id, idempotency_key, created_at)` joined to `booking_seats(booking_id, seat_id)`, from Phase 0 onward — a single-seat booking is simply the case where `booking_seats` has one row. We rejected starting with a `seat_id` column directly on `bookings` (single-seat only) and migrating to a join table when Phase 3 adds multi-seat support: the "exactly one winner per seat" guarantee requires the same per-seat lock/claim logic regardless of set size, so deferring the join table would only mean paying for a schema migration later, with no simplification gained in the meantime.
</content>
