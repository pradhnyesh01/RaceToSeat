# RaceToSeat

A concurrency-safe seat booking backend for a fixed-inventory reservation system (movie theater seats), built to compare five database concurrency-control mechanisms against a hard per-seat mutual-exclusion guarantee.

## Language

**Event**:
One bookable instance of a showing at a venue — what a moviegoer calls a showtime. The concrete domain is movie theaters; this is not modeled as a generic reservable-thing abstraction for other domains (concerts, flights).
_Avoid_: Showtime, showing, venue (a venue hosts Events, it isn't one)

**Seat**:
A specific physical seat for one specific Event. Seat 14B at the 7pm showing and seat 14B at the 9pm showing of the same movie in the same room are two distinct Seat rows, not one seat referenced twice.
_Avoid_: Venue seat, seat assignment

**Idempotency Key**:
A client-generated token, globally unique across all users, attached to one booking attempt. Two requests carrying the same key represent the same attempt regardless of who submitted them, and must never produce two bookings.
_Avoid_: Request ID, dedupe key

**Booking**:
A record that one or more Seats were claimed together, atomically, for one user in a single request. Succeeds only if every requested Seat was claimed; if any requested Seat was unavailable, none are booked.
_Avoid_: Reservation, order, group booking (a Booking IS the group — there's no separate concept for it; it's just a Booking whose seat set has size >1)

**Hold**:
A temporary, time-limited claim on a Seat, not yet a Booking. Expires back to `available` if not confirmed into a Booking before its TTL elapses.
_Avoid_: Reservation, lock (a lock is an implementation mechanism, not this domain concept)

**Cancel**:
Deleting a Booking, releasing every Seat it claimed back to `available`. Not ownership-gated — any caller holding a valid Booking id can cancel it, matching the project's minimal-identifier stance (no full auth system). Distinct from a Hold's expiry, which also returns a Seat to `available` but happens automatically via TTL, not by request.
_Avoid_: Reservation, un-book, refund (no payment concept exists in this domain)

