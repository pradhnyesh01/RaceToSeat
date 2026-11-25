// k6 load-generation script (issue #50, chaos C3): fires several concurrent
// POST /holds/{id}/confirm attempts at each of a set of still-LIVE holds —
// the confirm half of the hold flow, run while a Fault is injected. Unlike
// hold-expiry-race.k6.js (every hold already expired, so no confirm may
// succeed) this is the pattern where confirms are *meant* to succeed, so an
// Ambiguous outcome — a confirm that committed but whose response was lost —
// is actually possible and the chaos harness's retry-after-Fault recovery has
// something to prove. pessimistic only (ADR-0017).
//
// Seeding the holds (through the real POST /holds), the Fault, the retry and
// the verdict all live outside k6 (load-harness/chaos/runHolds.ts).
import http from "k6/http";
import { check } from "k6";
import exec from "k6/execution";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const HOLD_IDS = __ENV.HOLD_IDS ? JSON.parse(__ENV.HOLD_IDS) : undefined;
// Concurrent confirm attempts per hold: >1 so a hold's confirms race each
// other (409 "being confirmed", idempotent replay) as well as the Fault.
const ATTEMPTS_PER_HOLD = Number(__ENV.ATTEMPTS_PER_HOLD || 3);

if (!HOLD_IDS || HOLD_IDS.length === 0) throw new Error("HOLD_IDS env var (JSON array of hold ids) is required");

export const options = {
  scenarios: {
    confirm_race: {
      executor: "per-vu-iterations",
      vus: HOLD_IDS.length * ATTEMPTS_PER_HOLD,
      iterations: 1,
      maxDuration: "60s",
    },
  },
};

export default function () {
  const holdId = HOLD_IDS[exec.scenario.iterationInTest % HOLD_IDS.length];
  // Bodyless, no Content-Type: see hold-expiry-race.k6.js (FST_ERR_CTP_EMPTY_JSON_BODY).
  const res = http.post(`${BASE_URL}/holds/${holdId}/confirm`, null);
  check(res, {
    "confirm: status is 201, 409, 410, or 404": (r) => [201, 409, 410, 404].includes(r.status),
  });
}
