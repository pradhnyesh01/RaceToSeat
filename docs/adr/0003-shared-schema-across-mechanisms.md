---
status: accepted
---

# One shared seat schema across all five concurrency mechanisms

PRD §7 requires benchmarking five concurrency-control mechanisms "under identical load profiles" for direct comparison (§9: "Comparative benchmark table/plot across ≥3 mechanisms"). We use a single `seats` table shape (`status`, `version`, `booked_by`, `held_until`) for every mechanism; each mechanism differs only in the SQL executed against that shared shape (row lock, advisory lock, unique-constraint insert, CAS on `version`, or a `SERIALIZABLE` transaction), never in table design. This keeps the benchmark honest — a throughput or latency difference reflects the locking strategy, not incidental schema differences between mechanism variants.
</content>
