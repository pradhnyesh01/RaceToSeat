---
status: accepted
---

# Bake in the full seat status lifecycle from Phase 0

The Phase 0 schema already includes a `held_until` column, implying a three-state seat lifecycle (`available` / `held` / `booked`), even though the Hold API (`POST /holds`, reaper) isn't built until Phase 5 (stretch). We adopt the full three-state enum starting in Phase 0 across all five mechanisms, simply never transitioning a seat into `held` until Phase 5 wires up the hold flow. The alternative — a two-state (`available`/`booked`) model now, with `held` added later — would mean touching the status-transition logic of all five already-implemented mechanisms a second time when Phase 5 arrives.
</content>
