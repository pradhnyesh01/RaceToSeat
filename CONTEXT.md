# RaceToSeat

A concurrency-safe seat booking backend for a fixed-inventory reservation system (movie theater seats), built to compare five database concurrency-control mechanisms, plus an unguarded control, against a hard per-seat mutual-exclusion guarantee.

## Language

**Mechanism**:
One of the five interchangeable ways of claiming Seats that the project compares: unique constraint, pessimistic locking, optimistic locking, advisory locks, serializable isolation. All five serve the same API and are selected per process. A Mechanism is judged on its cost and its failure behaviour; every one of them also sits on the Backstop, so a Mechanism's *own* contribution to correctness is only visible with the Backstop removed.
_Avoid_: Strategy, approach, algorithm (a strategy is the code that implements a Mechanism, not the thing being compared)

**Control**:
The deliberately unguarded read-then-write way of claiming Seats, kept as the baseline every Mechanism is compared against. It is not a Mechanism. With the Backstop in place it no longer double-books, so its measured rows describe "the Control on top of the Backstop"; only the project's earliest evidence shows it without one.
_Avoid_: Naive mechanism, baseline mechanism

**Backstop**:
The uniqueness guarantee the shared schema enforces beneath every Mechanism and the Control: a Seat can belong to at most one Booking, whichever way the claim was made. It is why the Control stopped double-booking, and why "all six pass" does not by itself show that each Mechanism is correct on its own. The unique-constraint Mechanism is the Backstop with nothing placed in front of it; the other four place a coordination step in front of it.
_Avoid_: Constraint (the unique-constraint Mechanism is a different thing: the same guarantee relied on as the *only* defense), safety net, fallback

**Event**:
One bookable instance of a showing at a venue — what a moviegoer calls a showtime. The concrete domain is movie theaters; this is not modeled as a generic reservable-thing abstraction for other domains (concerts, flights).
_Avoid_: Showtime, showing, venue (a venue hosts Events, it isn't one)

**Seat**:
A specific physical seat for one specific Event. Seat 14B at the 7pm showing and seat 14B at the 9pm showing of the same movie in the same room are two distinct Seat rows, not one seat referenced twice.
_Avoid_: Venue seat, seat assignment

**Idempotency Key**:
A client-generated token, globally unique across all users, attached to one attempt to claim Seats — either a Booking directly or a Hold. Two requests carrying the same key represent the same attempt regardless of who submitted them, and must never produce two Bookings or two Holds — including after the first one is gone. A key outlives its Booking or Hold: once that is Cancelled, Confirmed or reaped, the key is kept for a retention window (default 24 hours, `IDEMPOTENCY_RETENTION_SECONDS`), and a request carrying it in that window is a stale duplicate of an attempt that already happened — answered **key released** (HTTP 410), never a replay and never a new Booking or Hold. Only after the window is a key treated as new, so "never two" is a guarantee within the retention window, not forever. A client that really wants the seat again after cancelling or letting a Hold expire uses a new key.
_Avoid_: Request ID, dedupe key

**Key released**:
The answer to a request whose Idempotency Key already created a Booking or Hold that no longer exists, within the retention window: HTTP 410 with the reason (`cancelled`, `confirmed` or `expired`) and the id the key had created. Distinct from a replay (the Booking/Hold still exists, so the client gets it back as a 201) and from a conflict (a different attempt took the Seat).
_Avoid_: Expired key, duplicate

**Booking**:
A record that one or more Seats were claimed together, atomically, for one user in a single request. Succeeds only if every requested Seat was claimed; if any requested Seat was unavailable, none are booked.
_Avoid_: Reservation, order, group booking (a Booking IS the group — there's no separate concept for it; it's just a Booking whose seat set has size >1)

**Hold**:
A temporary, time-limited claim on a Seat, not yet a Booking. Expires back to `available` if not confirmed into a Booking before its TTL elapses.
_Avoid_: Reservation, lock (a lock is an implementation mechanism, not this domain concept)

**Cancel**:
Deleting a Booking, releasing every Seat it claimed back to `available`. Not ownership-gated — any caller holding a valid Booking id can cancel it, matching the project's minimal-identifier stance (no full auth system). Distinct from a Hold's expiry, which also returns a Seat to `available` but happens automatically via TTL, not by request.
_Avoid_: Reservation, un-book, refund (no payment concept exists in this domain)

**Confirm**:
Converting a Hold into a Booking, before the Hold's TTL elapses. Not ownership-gated, matching Cancel's precedent — any caller holding a valid Hold id can confirm it. Distinct from booking directly (`POST /bookings`), which claims Seats immediately with no prior Hold involved.
_Avoid_: Complete, finalize

**Reaper**:
The process responsible for returning an expired Hold's Seats to `available`. Runs continuously and automatically; never invoked per-request.
_Avoid_: Cleanup job, garbage collector (those imply removing data broadly, not this domain-specific TTL-expiry role)

**Fault**:
A deliberately injected failure of the connection, network, or process between the application and its database, introduced to test whether the system's guarantees survive it. Distinct from an ordinary losing request (a `409`), which is the system working as designed.
_Avoid_: Chaos event, outage, error (an error is what a client observes; a Fault is what was done to the system)

**Ambiguous outcome**:
The position a client is in when a Fault severs its connection after it sent a request but before a response arrived: it cannot know whether its Booking or Hold exists. Resolved only by retrying with the same Idempotency Key, which must yield exactly one Booking or Hold, never two.
_Avoid_: Timeout, unknown state, lost response

**Oracle**:
The ground-truth check that decides whether a run violated a guarantee, read from the stored Seat, Booking, and Hold state after the run — never inferred from HTTP responses, which a Fault can make misleading.
_Avoid_: Assertion, test check, verifier

**Correctness violation**:
An Oracle failure: a Seat claimed by more than one Booking or Hold, a Booking holding fewer Seats than requested, a retried Idempotency Key that produced a second Booking or Hold, a Seat left unreleased after faults were removed, or a Booking the server answered `201` for that is absent after the database was restarted. The only outcome that fails Phase 6.
_Avoid_: Bug, failure, incident

**Robustness finding**:
A failure observed under a Fault that leaves every Oracle intact — a crashed process, a hung request, a lock that is not released promptly. Reported and ticketed for follow-up, but does not itself fail Phase 6.
_Avoid_: Correctness issue, bug, outage
