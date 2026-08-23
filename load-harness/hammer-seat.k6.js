// k6 load-generation script (issue #5): fires N concurrent POST /bookings
// requests at one seat. Seeding the target seat and verifying the DB
// afterward happen outside k6 (see run.ts) — k6 has no first-class Postgres
// client, and this keeps the script itself doing exactly one job: generate
// concurrent load.
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const createdCount = new Counter("booking_created");
const conflictCount = new Counter("booking_conflict");
// 503 (ADR-0012's retry_exhausted kind) tallied separately from other
// unexpected statuses (issue #18) so retry-exhaustion rate can be reported
// as its own column rather than folded into a generic failure tally.
const retryExhaustedCount = new Counter("booking_retry_exhausted");
const otherStatusCount = new Counter("booking_other_status");
// Tallies the X-Booking-Retries header (ADR-0012, issue #17) across every
// response, so retry rate is captured from the same run as throughput/
// latency/conflict counts rather than a separate pass.
const retriesCount = new Counter("booking_retries");

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const SEAT_ID = __ENV.SEAT_ID;
const RUN_ID = __ENV.RUN_ID;
const CONCURRENCY = Number(__ENV.CONCURRENCY || 1000);

if (!SEAT_ID) throw new Error("SEAT_ID env var is required");
if (!RUN_ID) throw new Error("RUN_ID env var is required");

export const options = {
  // Default trend stats omit p(99); issue #18's mechanism comparison needs
  // it alongside the default p50 (med) for http_req_duration.
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
  scenarios: {
    hammer_one_seat: {
      executor: "per-vu-iterations",
      // Each of the CONCURRENCY virtual users runs exactly one iteration —
      // this simulates CONCURRENCY distinct users racing for the same seat,
      // not one client retrying (see issue #5's idempotency-key note).
      vus: CONCURRENCY,
      iterations: 1,
      maxDuration: "60s",
    },
  },
};

export default function () {
  const res = http.post(
    `${BASE_URL}/bookings`,
    JSON.stringify({
      seat_ids: [SEAT_ID],
      user_id: `load-user-${__VU}`,
      // Unique per VU within this run: RUN_ID changes every invocation, __VU
      // is unique within one run. bookings.idempotency_key is a plain TEXT
      // unique column, so no UUID format is required.
      idempotency_key: `${RUN_ID}-${__VU}`,
    }),
    { headers: { "Content-Type": "application/json" } },
  );

  check(res, {
    "status is 201 or 409": (r) => r.status === 201 || r.status === 409,
  });

  if (res.status === 201) createdCount.add(1);
  else if (res.status === 409) conflictCount.add(1);
  else if (res.status === 503) retryExhaustedCount.add(1);
  else otherStatusCount.add(1);

  retriesCount.add(Number(res.headers["X-Booking-Retries"] ?? 0));
}
