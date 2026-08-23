// k6 load-generation script (issue #17): fires one concurrent POST /bookings
// request per seat across N distinct, pre-seeded seats — zero conflicts are
// ever expected. Distinct from hammer-seat.k6.js (all VUs racing one seat),
// this establishes each mechanism's raw per-request overhead with no
// contention firing at all. Seeding the seats and verifying the DB
// afterward happen outside k6 (see run.ts), matching hammer-seat.k6.js's
// division of labor.
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
const RUN_ID = __ENV.RUN_ID;
// JSON-encoded array of seat ids, one per VU — SEAT_IDS[__VU - 1] since k6
// VU numbers are 1-indexed.
const SEAT_IDS = __ENV.SEAT_IDS ? JSON.parse(__ENV.SEAT_IDS) : undefined;

if (!RUN_ID) throw new Error("RUN_ID env var is required");
if (!SEAT_IDS || SEAT_IDS.length === 0) {
  throw new Error("SEAT_IDS env var (JSON array of seat ids) is required");
}

export const options = {
  // Default trend stats omit p(99); issue #18's mechanism comparison needs
  // it alongside the default p50 (med) for http_req_duration.
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
  scenarios: {
    spread_across_seats: {
      executor: "per-vu-iterations",
      // One VU per distinct seat: each VU only ever targets its own seat,
      // so this pattern never produces contention on a shared seat.
      vus: SEAT_IDS.length,
      iterations: 1,
      maxDuration: "60s",
    },
  },
};

export default function () {
  const seatId = SEAT_IDS[__VU - 1];

  const res = http.post(
    `${BASE_URL}/bookings`,
    JSON.stringify({
      seat_id: seatId,
      user_id: `load-user-${__VU}`,
      // Unique per VU within this run, same scheme as hammer-seat.k6.js.
      idempotency_key: `${RUN_ID}-${__VU}`,
    }),
    { headers: { "Content-Type": "application/json" } },
  );

  check(res, {
    "status is 201": (r) => r.status === 201,
  });

  if (res.status === 201) createdCount.add(1);
  else if (res.status === 409) conflictCount.add(1);
  else if (res.status === 503) retryExhaustedCount.add(1);
  else otherStatusCount.add(1);

  retriesCount.add(Number(res.headers["X-Booking-Retries"] ?? 0));
}
