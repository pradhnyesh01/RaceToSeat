---
status: accepted
---

# `POST /holds` and its confirm endpoint are gated by `BOOKING_STRATEGY=pessimistic`

`BOOKING_STRATEGY` (ADR-0002) is a process-level env var that is the single source of truth for which concurrency mechanism is live for the whole process. Phase 5's hold flow is implemented for `pessimistic` only (ADR-0017); running it under a process configured for a different strategy would mean either erroring at request time with no config-level signal, or silently executing pessimistic-style locking underneath a `BOOKING_STRATEGY` value that claims otherwise — a mismatch between what the config says and what actually executes that ADR-0002's whole premise exists to prevent. `POST /holds` and `POST /holds/{id}/confirm` are instead not registered at all — a 404 — unless the process is running with `BOOKING_STRATEGY=pessimistic`. These are the first strategy-gated routes in the app; every other endpoint (`GET /seats`, `POST /bookings`, `DELETE /bookings/{id}`) works identically regardless of which of the six mechanisms is configured.
