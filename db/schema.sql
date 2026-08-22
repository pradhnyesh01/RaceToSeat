-- RaceToSeat schema
--
-- Shared across all five concurrency-control mechanisms (ADR-0003): every
-- mechanism differs only in the SQL it runs against this shape, never in the
-- shape itself.

CREATE TYPE seat_status AS ENUM ('available', 'held', 'booked');
-- Full three-state lifecycle from Phase 0 (ADR-0004), even though the hold
-- flow (POST /holds, reaper) isn't wired up until Phase 5. No mechanism ever
-- transitions a seat into 'held' before then.

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
    seat_id UUID NOT NULL REFERENCES seats (id),
    PRIMARY KEY (booking_id, seat_id)
);

CREATE INDEX booking_seats_seat_id_idx ON booking_seats (seat_id);
