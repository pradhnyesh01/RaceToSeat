// k6 load-generation script (issue #41, Phase 5's evidence deliverable):
// fires two concurrent streams at a set of already-expired holds —
// confirm_race, several concurrent POST /holds/{id}/confirm attempts per
// hold, and fresh_hold_race, several concurrent fresh POST /holds attempts
// per seat — reproducing the real "expire under load" race between a client
// that's slow to confirm, the reaper's background sweep, and a different
// client trying to claim the now-stale seat. pessimistic only (ADR-0017):
// this is the only mechanism the hold flow exists for.
//
// Seeding the seats+holds, waiting past their TTL, and verifying the DB
// afterward all happen outside k6 (see run.ts) — same division of labor as
// every other pattern.
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";
import exec from "k6/execution";

const confirmCreated = new Counter("confirm_created");
const confirmExpired = new Counter("confirm_expired");
const confirmConflict = new Counter("confirm_conflict");
const confirmNotFound = new Counter("confirm_not_found");
const confirmOtherStatus = new Counter("confirm_other_status");
const confirmRequests = new Counter("confirm_requests");
const confirmDuration = new Trend("confirm_req_duration");

const freshHoldCreated = new Counter("freshhold_created");
const freshHoldConflict = new Counter("freshhold_conflict");
const freshHoldNotFound = new Counter("freshhold_not_found");
const freshHoldOtherStatus = new Counter("freshhold_other_status");
const freshHoldRequests = new Counter("freshhold_requests");
const freshHoldDuration = new Trend("freshhold_req_duration");

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const RUN_ID = __ENV.RUN_ID;
// JSON-encoded arrays, same index i pairs HOLD_IDS[i] with the single seat
// it holds, SEAT_IDS[i] — set by run.ts after seeding N single-seat holds
// via the real POST /holds endpoint and waiting past every one's TTL.
const HOLD_IDS = __ENV.HOLD_IDS ? JSON.parse(__ENV.HOLD_IDS) : undefined;
const SEAT_IDS = __ENV.SEAT_IDS ? JSON.parse(__ENV.SEAT_IDS) : undefined;
// How many concurrent attempts race each individual hold/seat — fixed
// rather than a CLI flag, since --concurrency already controls how many
// distinct holds/seats are seeded (run.ts), matching spread-across-seats'
// "one knob is the seat count" convention.
const ATTEMPTS_PER_SEAT = 5;
// fresh_hold_race retries on 409 ("still held") a bounded number of times
// with a short sleep between attempts, unlike every other pattern's
// one-shot VUs — this is the one place a retry loop belongs: a real client
// that knows a hold is past its TTL but still gets 409 would legitimately
// retry rather than give up immediately, since the only thing standing
// between "expired" and "available" is the reaper's own sweep timer, not a
// permanent condition. confirm_race stays one-shot: the claim under test is
// that a confirm on an already-expired hold *never* succeeds, no matter how
// many concurrent attempts fire, so retrying it would prove nothing extra.
// Sized to comfortably outlast one full REAPER_INTERVAL_MS tick period, but
// to stay well *under* HOLD_TTL_SECONDS too (the exhibit's Method section
// recommends REAPER_INTERVAL_MS well under this budget, and this budget
// well under HOLD_TTL_SECONDS, e.g. 1s / 3s / 8s) — otherwise two different
// failure modes show up: too short a budget vs. the reaper interval looks
// like a stuck seat when it's really just an under-budgeted retry loop, and
// too long a budget vs. the TTL lets a winning VU's own brand-new hold
// expire and get re-won by a still-retrying straggler before the test ends,
// producing a confusing second "winner" for a seat that was never actually
// double-held at any single point in time. run.ts's own
// FRESH_HOLD_RETRY_BUDGET_MS mirrors this budget (it needs the number
// pre-flight, before k6 ever runs) to reject a too-short observed TTL
// before firing — keep both in sync if either changes.
const FRESH_HOLD_MAX_ATTEMPTS = 10;
const FRESH_HOLD_RETRY_SLEEP_SECONDS = 0.3;

if (!RUN_ID) throw new Error("RUN_ID env var is required");
if (!HOLD_IDS || HOLD_IDS.length === 0) throw new Error("HOLD_IDS env var (JSON array of hold ids) is required");
if (!SEAT_IDS || SEAT_IDS.length !== HOLD_IDS.length) {
  throw new Error("SEAT_IDS env var (JSON array, same length as HOLD_IDS) is required");
}

export const options = {
  // Default trend stats omit p(99); mirrors every other pattern's need for
  // both p50 (med) and p99, even though this pattern's own deliverable is
  // correctness, not throughput.
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
  scenarios: {
    confirm_race: {
      executor: "per-vu-iterations",
      vus: HOLD_IDS.length * ATTEMPTS_PER_SEAT,
      iterations: 1,
      maxDuration: "60s",
      exec: "confirmRace",
    },
    fresh_hold_race: {
      executor: "per-vu-iterations",
      vus: SEAT_IDS.length * ATTEMPTS_PER_SEAT,
      iterations: 1,
      maxDuration: "60s",
      exec: "freshHoldRace",
    },
  },
};

export function confirmRace() {
  // __VU is not usable for indexing here, same reason as
  // cross-seat-isolation.k6.js's backgroundStream: two scenarios running
  // concurrently draw VU ids from one shared pool, not a contiguous block
  // per scenario. iterationInTest is scoped to this scenario alone and
  // hands out 0..(vus-1) exactly once each.
  const holdId = HOLD_IDS[exec.scenario.iterationInTest % HOLD_IDS.length];

  // Bodyless (matches the route's own contract) — no Content-Type header
  // either: Fastify's JSON body parser rejects an empty body when
  // Content-Type is application/json (FST_ERR_CTP_EMPTY_JSON_BODY, a real
  // 400 this pattern doesn't need to also be testing).
  const res = http.post(`${BASE_URL}/holds/${holdId}/confirm`, null);

  check(res, {
    "confirm: status is 201, 409, 410, or 404": (r) => [201, 409, 410, 404].includes(r.status),
  });

  confirmRequests.add(1);
  confirmDuration.add(res.timings.duration);
  if (res.status === 201) confirmCreated.add(1);
  else if (res.status === 410) confirmExpired.add(1);
  else if (res.status === 409) confirmConflict.add(1);
  else if (res.status === 404) confirmNotFound.add(1);
  else confirmOtherStatus.add(1);
}

export function freshHoldRace() {
  const seatId = SEAT_IDS[exec.scenario.iterationInTest % SEAT_IDS.length];
  // Stable across retries within one VU — a real retry, not a new attempt
  // each time (an idempotency key that changed per attempt would defeat the
  // point of retrying at all).
  const idempotencyKey = `${RUN_ID}-freshhold-${__VU}`;

  let res;
  for (let attempt = 0; attempt < FRESH_HOLD_MAX_ATTEMPTS; attempt += 1) {
    res = http.post(
      `${BASE_URL}/holds`,
      JSON.stringify({
        seat_ids: [seatId],
        user_id: `load-freshhold-user-${__VU}`,
        idempotency_key: idempotencyKey,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
    if (res.status !== 409) break;
    sleep(FRESH_HOLD_RETRY_SLEEP_SECONDS);
  }

  check(res, {
    "fresh hold: status is 201 or 409": (r) => r.status === 201 || r.status === 409,
  });

  freshHoldRequests.add(1);
  freshHoldDuration.add(res.timings.duration);
  if (res.status === 201) freshHoldCreated.add(1);
  else if (res.status === 409) freshHoldConflict.add(1);
  else if (res.status === 404) freshHoldNotFound.add(1);
  else freshHoldOtherStatus.add(1);
}
