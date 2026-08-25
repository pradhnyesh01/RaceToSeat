-- RaceToSeat schema
--
-- Shared across all five concurrency-control mechanisms (ADR-0003): every
-- mechanism differs only in the SQL it runs against this shape, never in the
-- shape itself.

CREATE TYPE seat_status AS ENUM ('available', 'held', 'booked');
-- Full three-state lifecycle from Phase 0 (ADR-0004). The hold flow
-- (POST /holds, reaper) lands in Phase 5, `pessimistic` only (ADR-0017) — no
-- other mechanism ever transitions a seat into 'held'.

CREATE TABLE events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE seats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES events (id),
    label TEXT NOT NULL,
    status seat_status NOT NULL DEFAULT 'available',
    version INTEGER NOT NULL DEFAULT 0,
    held_until TIMESTAMPTZ,
    booked_by TEXT,
    UNIQUE (event_id, label)
);

-- Partial index for the reaper's driving predicate (issue #40,
-- `WHERE status = 'held' AND held_until < now()`), found missing in code
-- review: without it, every sweep — on a timer for the life of the process
-- — does a full sequential scan of `seats`, most of which will never be
-- `held` at any given moment. Partial (not a plain composite index) so it
-- only indexes the small, currently-held subset instead of growing with the
-- table's total historical seat count.
CREATE INDEX seats_held_expiry_idx ON seats (held_until) WHERE status = 'held';

CREATE TABLE bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Booking is modeled as always potentially multi-seat from Phase 0 onward
-- (ADR-0005): a single-seat booking is just a booking_seats row count of 1.
-- The UNIQUE constraint on idempotency_key is the dedupe mechanism for FR1 —
-- see RaceToSeat#1, referenced from todo.md Phase 5.

CREATE TABLE booking_seats (
    booking_id UUID NOT NULL REFERENCES bookings (id),
    seat_id UUID NOT NULL REFERENCES seats (id) UNIQUE,
    PRIMARY KEY (booking_id, seat_id)
);
-- UNIQUE(seat_id) is a defense-in-depth backstop shared by every mechanism,
-- not just the unique-constraint one (ADR-0008): no seat can ever appear in
-- more than one booking, regardless of which strategy raced to insert it.
-- Its index also covers the seat_id lookups that used to need a separate one.

CREATE TABLE holds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Mirrors bookings' shape (ADR-0005) for the identical reason: a hold is
-- always potentially multi-seat, so `holds` is the one ID a client confirms
-- against and `hold_seats` is the grouping. `holds`/`hold_seats` exist purely
-- for that grouping, not as the source of truth for a hold's validity —
-- seats.held_until (below) is that source of truth, so the reaper's expiry
-- scan and confirm's own expiry check both read it directly with no join
-- (ADR-0018). Rows here are deleted on both resolution paths — confirmed
-- into a booking, or reaped after expiry — mirroring DELETE /bookings/{id}'s
-- existing full-delete behavior; there is deliberately no status column and
-- no historical record of a resolved hold (ADR-0020).

CREATE TABLE hold_seats (
    hold_id UUID NOT NULL REFERENCES holds (id),
    seat_id UUID NOT NULL REFERENCES seats (id) UNIQUE,
    PRIMARY KEY (hold_id, seat_id)
);
-- UNIQUE(seat_id) mirrors booking_seats' own backstop (ADR-0008): no seat can
-- be part of more than one live hold at a time.
