// k6 load-generation script (issue #25): the adversarial deadlock harness.
// Fires both orderings of many disjoint 2-seat pairs concurrently — for pair
// [A, B], one VU books seat_ids: [A, B] while a paired VU simultaneously
// books seat_ids: [B, A]. A mechanism that locks seats one at a time in
// request order (naive/unique_constraint/optimistic/serializable, pre-Phase-3
// -ordering-fix) can have one VU hold A waiting on B while the other holds B
// waiting on A — a classic wait-for cycle. Seeding the pairs and verifying
// the DB afterward happen outside k6 (see run.ts), matching hammer-seat.k6.js
// and spread-across-seats.k6.js's division of labor.
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const createdCount = new Counter("booking_created");
const conflictCount = new Counter("booking_conflict");
// 503 (ADR-0012's retry_exhausted kind) tallied separately from other
// unexpected statuses (issue #18) so retry-exhaustion rate can be reported
// as its own column. Here it doubles as the deadlock-rate signal (ADR-0015):
// a deadlock abort that exhausts withDeadlockRetry's budget surfaces as this
// same 503, with no new instrumentation (issue #25's acceptance criterion).
const retryExhaustedCount = new Counter("booking_retry_exhausted");
const otherStatusCount = new Counter("booking_other_status");
// Tallies the X-Booking-Retries header (ADR-0012, issue #17) across every
// response, so retry rate is captured from the same run as throughput/
// latency/conflict counts rather than a separate pass.
const retriesCount = new Counter("booking_retries");

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const RUN_ID = __ENV.RUN_ID;
// Client-side request timeout (issue #49, chaos latency Faults): the deadline
// after which a real client gives up and is left in an Ambiguous outcome.
// Defaults to k6's own default (60s), so no non-chaos run changes.
const REQUEST_TIMEOUT = __ENV.REQUEST_TIMEOUT || "60s";
// JSON-encoded array of [seatIdA, seatIdB] pairs. Pair index p is served by
// VUs (2p + 1) and (2p + 2) (k6 VU numbers are 1-indexed) — the first fires
// seat_ids: [A, B], the second seat_ids: [B, A], so both orderings of the
// same pair race each other.
const SEAT_PAIRS = __ENV.SEAT_PAIRS ? JSON.parse(__ENV.SEAT_PAIRS) : undefined;

if (!RUN_ID) throw new Error("RUN_ID env var is required");
if (!SEAT_PAIRS || SEAT_PAIRS.length === 0) {
  throw new Error("SEAT_PAIRS env var (JSON array of [seatIdA, seatIdB] pairs) is required");
}

export const options = {
  // Default trend stats omit p(99); issue #18's mechanism comparison needs
  // it alongside the default p50 (med) for http_req_duration.
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
  scenarios: {
    deadlock_pairs: {
      executor: "per-vu-iterations",
      // Two VUs per pair, one per ordering — see SEAT_PAIRS comment above.
      vus: SEAT_PAIRS.length * 2,
      iterations: 1,
      maxDuration: "60s",
    },
  },
};

export default function () {
  const pairIndex = Math.floor((__VU - 1) / 2);
  const pair = SEAT_PAIRS[pairIndex];
  const seatIds = (__VU - 1) % 2 === 0 ? [pair[0], pair[1]] : [pair[1], pair[0]];

  const res = http.post(
    `${BASE_URL}/bookings`,
    JSON.stringify({
      seat_ids: seatIds,
      user_id: `load-user-${__VU}`,
      // Unique per VU within this run, same scheme as hammer-seat.k6.js.
      idempotency_key: `${RUN_ID}-${__VU}`,
    }),
    { headers: { "Content-Type": "application/json" }, timeout: REQUEST_TIMEOUT },
  );

  // Unlike hammer-seat/spread-seats, 503 (retry_exhausted) is an expected
  // outcome here, not a surprise — it's the very thing this harness is
  // built to measure (ADR-0015) — so it counts as a passing check too.
  check(res, {
    "status is 201, 409, or 503": (r) => r.status === 201 || r.status === 409 || r.status === 503,
  });

  if (res.status === 201) createdCount.add(1);
  else if (res.status === 409) conflictCount.add(1);
  else if (res.status === 503) retryExhaustedCount.add(1);
  else otherStatusCount.add(1);

  retriesCount.add(Number(res.headers["X-Booking-Retries"] ?? 0));
}
