// k6 load-generation script (issue #33): fires a hot-seat burst (all-VUs-
// race-one-seat, hammer-seat.k6.js's shape) and a background stream
// (one-VU-per-distinct-seat, spread-across-seats.k6.js's shape) concurrently
// within a single k6 invocation — "at the same time" is guaranteed by k6's
// own scenario executor starting both scenarios at t=0, not approximated by
// orchestrating two separate processes. Each stream's status/retry/latency
// metrics are tallied under its own prefixed metric name (bg_* / hot_*)
// rather than the shared booking_*/http_req_duration names the other
// patterns use, since those aggregate across every request in the run and
// would blend the two streams' numbers together — the whole point of this
// pattern is comparing them separately. Supports a background-only variant
// (HOT_SEAT_ID left unset) for the matched no-contention baseline used to
// compute degradation (see run.ts).
//
// Seeding the seat(s) and verifying the DB afterward happen outside k6 (see
// run.ts), matching every other pattern's division of labor.
import http from "k6/http";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";
import exec from "k6/execution";

const bgCreated = new Counter("bg_booking_created");
const bgConflict = new Counter("bg_booking_conflict");
const bgRetryExhausted = new Counter("bg_booking_retry_exhausted");
const bgOtherStatus = new Counter("bg_booking_other_status");
const bgRetries = new Counter("bg_booking_retries");
// Per-stream request counter (rather than reading the shared http_reqs
// metric) so run.ts can read each stream's own throughput off its "rate"
// field without the other stream's requests folded in.
const bgRequests = new Counter("bg_requests");
const bgDuration = new Trend("bg_req_duration");

const hotCreated = new Counter("hot_booking_created");
const hotConflict = new Counter("hot_booking_conflict");
const hotRetryExhausted = new Counter("hot_booking_retry_exhausted");
const hotOtherStatus = new Counter("hot_booking_other_status");
const hotRetries = new Counter("hot_booking_retries");
const hotRequests = new Counter("hot_requests");
const hotDuration = new Trend("hot_req_duration");

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const RUN_ID = __ENV.RUN_ID;
// JSON-encoded array of seat ids, one per background VU — same convention
// as spread-across-seats.k6.js's SEAT_IDS.
const BACKGROUND_SEAT_IDS = __ENV.BACKGROUND_SEAT_IDS ? JSON.parse(__ENV.BACKGROUND_SEAT_IDS) : undefined;
// Left unset by run.ts for the background-only baseline — the hot_seat_stream
// scenario below is only added when this is present, rather than this script
// running a zero-VU scenario.
const HOT_SEAT_ID = __ENV.HOT_SEAT_ID || undefined;
const HOT_CONCURRENCY = Number(__ENV.HOT_CONCURRENCY || 0);

if (!RUN_ID) throw new Error("RUN_ID env var is required");
if (!BACKGROUND_SEAT_IDS || BACKGROUND_SEAT_IDS.length === 0) {
  throw new Error("BACKGROUND_SEAT_IDS env var (JSON array of seat ids) is required");
}
if (HOT_SEAT_ID && !(HOT_CONCURRENCY > 0)) {
  throw new Error("HOT_CONCURRENCY must be a positive integer when HOT_SEAT_ID is set");
}

// Caveat worth knowing when reading this pattern's numbers: both streams'
// requests land on the app's one shared pg Pool (src/db/pool.ts), not on a
// pool-per-stream. Under a mechanism whose lock acquisition blocks
// server-side rather than failing fast (pessimistic's SELECT ... FOR
// UPDATE), a hot-seat request can sit holding a pooled connection for the
// duration of its wait — at high enough hot-stream concurrency, that can
// exhaust the pool before a background request gets a connection at all.
// The resulting background-latency spike would look like a genuine per-seat
// isolation violation (the thing this pattern exists to measure) but is
// actually shared connection-pool contention, not row-lock contention
// between the hot seat and any background seat. Non-blocking mechanisms
// (advisory, ADR-0006) don't hold a connection across a wait for the same
// reason they can't deadlock: there's no wait to hold one across.
const scenarios = {
  background_stream: {
    executor: "per-vu-iterations",
    vus: BACKGROUND_SEAT_IDS.length,
    iterations: 1,
    maxDuration: "60s",
    exec: "backgroundStream",
  },
};

if (HOT_SEAT_ID) {
  scenarios.hot_seat_stream = {
    executor: "per-vu-iterations",
    vus: HOT_CONCURRENCY,
    iterations: 1,
    maxDuration: "60s",
    exec: "hotSeatStream",
  };
}

export const options = {
  // Default trend stats omit p(99); mirrors the other three patterns' need
  // for both p50 (med) and p99 in the mechanism comparison.
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
  scenarios,
};

export function backgroundStream() {
  // __VU is not usable for indexing here: when multiple scenarios run
  // concurrently, k6 draws VU ids for both from one shared pool rather than
  // handing each scenario a contiguous block, so __VU values interleave
  // between background_stream and hot_seat_stream unpredictably (confirmed
  // by direct experimentation, not documented anywhere in k6's own docs).
  // exec.scenario.iterationInTest is scoped to this scenario alone — for a
  // per-vu-iterations scenario with one iteration per VU, it hands out
  // exactly the values 0..(vus-1), each exactly once, letting every
  // background seat get exactly one request regardless of what's running
  // alongside it.
  const seatId = BACKGROUND_SEAT_IDS[exec.scenario.iterationInTest];

  const res = http.post(
    `${BASE_URL}/bookings`,
    JSON.stringify({
      seat_ids: [seatId],
      user_id: `load-bg-user-${__VU}`,
      // Unique per VU within this run, same scheme as the other patterns.
      idempotency_key: `${RUN_ID}-bg-${__VU}`,
    }),
    { headers: { "Content-Type": "application/json" } },
  );

  check(res, { "background: status is 201": (r) => r.status === 201 });

  bgRequests.add(1);
  bgDuration.add(res.timings.duration);
  if (res.status === 201) bgCreated.add(1);
  else if (res.status === 409) bgConflict.add(1);
  else if (res.status === 503) bgRetryExhausted.add(1);
  else bgOtherStatus.add(1);
  bgRetries.add(Number(res.headers["X-Booking-Retries"] ?? 0));
}

export function hotSeatStream() {
  const res = http.post(
    `${BASE_URL}/bookings`,
    JSON.stringify({
      seat_ids: [HOT_SEAT_ID],
      user_id: `load-hot-user-${__VU}`,
      idempotency_key: `${RUN_ID}-hot-${__VU}`,
    }),
    { headers: { "Content-Type": "application/json" } },
  );

  check(res, { "hot: status is 201 or 409": (r) => r.status === 201 || r.status === 409 });

  hotRequests.add(1);
  hotDuration.add(res.timings.duration);
  if (res.status === 201) hotCreated.add(1);
  else if (res.status === 409) hotConflict.add(1);
  else if (res.status === 503) hotRetryExhausted.add(1);
  else hotOtherStatus.add(1);
  hotRetries.add(Number(res.headers["X-Booking-Retries"] ?? 0));
}
