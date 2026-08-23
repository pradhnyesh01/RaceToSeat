---
status: accepted
---

# Advisory-lock key is derived via hashtext(seat_id), accepting bounded collision risk

`pg_try_advisory_xact_lock` (used non-blocking per ADR-0006) takes a `bigint` or two `int4`s, not the UUID `seats.id` we actually have. We derive the key as `pg_try_advisory_xact_lock(hashtext(seat_id::uuid::text))`, the single-`bigint` overload, rather than splitting the UUID across the two-`int4` overload to shrink the collision space further. The `::uuid` cast before `::text` is load-bearing, not decorative: `hashtext` hashes raw bytes, so two differently-cased spellings of the same UUID would otherwise hash to different lock keys and both acquire — canonicalizing through the `uuid` type first (which Postgres always renders lowercase) matches how every other mechanism's exclusion already compares seat identity, via a real `uuid`-typed column. This accepts a documented, near-zero risk that two unrelated seats hash to the same 64-bit key and get serialized against each other under load. That risk is a throughput concern (NFR2 — a hot seat degrading unrelated seats), not a correctness one: the row's `status` check inside the lock is still the actual gate against double-booking, so a collision can only ever cause unnecessary contention, never a lost mutual-exclusion guarantee.
