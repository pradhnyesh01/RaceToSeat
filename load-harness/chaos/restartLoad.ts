// Sustained load with a client-side acknowledgement ledger (issue #51, C4).
//
// Why this is not one of the k6 scripts. Every k6 pattern fires each request
// once, finishes in a few hundred milliseconds, and reports only status codes
// in aggregate. C4 needs two things they cannot give: load that is still being
// applied while a database server is taken away and brought back (seconds, not
// milliseconds), and a per-request record of which Booking id the server
// *promised* (a 201 body) so the durability Oracle can ask the database
// whether the promise was kept.
//
// Clients behave as the retry contract tells them to (ADR-0025/0026): a request
// that got no answer, a 502, a 504 or any other 5xx is retried with the SAME
// Idempotency Key until it gets a definitive answer or its deadline passes. A
// 409 is a definitive loss, a 201 a win. Nothing here decides pass or fail.
import type { AcknowledgedBooking, AcknowledgedHold } from "./durabilityOracle.js";
import type { BookingIntent } from "./oracles.js";

export type LoadKind = "spread" | "hammer" | "holds";

export interface LoadPlan {
  kind: LoadKind;
  runId: string;
  baseUrl: string;
  seatIds: string[];
  // spread: concurrent workers, each taking the next unclaimed seat.
  // hammer: workers racing every seat in lockstep rounds.
  // holds: like spread, but each seat is held and (for a fraction) confirmed.
  workers: number;
  // Pause after each request/round, so the load lasts long enough for a fault
  // to land in the middle of it.
  thinkMs: number;
  // holds only: share of acknowledged Holds the worker goes on to Confirm.
  confirmFraction: number;
  // A request that has not been definitively answered this long after its
  // first attempt is abandoned and recorded as such.
  retryDeadlineMs: number;
  // Single attempt timeout.
  attemptTimeoutMs: number;
}

export interface RequestEvent {
  // What was asked, for the timeline.
  op: "book" | "hold" | "confirm";
  key: string;
  attempt: number;
  // ms on the run's clock when the attempt was sent / finished.
  sentAtMs: number;
  doneAtMs: number;
  // HTTP status, 0 = no answer (connection error or client timeout).
  status: number;
  // Short reason for status 0.
  error?: string;
}

export interface LoadResult {
  intents: (BookingIntent & { userId: string })[];
  ackedBookings: AcknowledgedBooking[];
  ackedHolds: AcknowledgedHold[];
  events: RequestEvent[];
  // Requests (logical, not attempts) by final outcome.
  finals: Record<string, number>;
  // Logical requests abandoned with the outcome still unknown.
  abandoned: number;
}

export interface LoadHandle {
  // Resolves when `n` acknowledged bookings/holds (201 to the first request of
  // a logical operation) have been seen.
  whenAcked(n: number): Promise<void>;
  ackCount(): number;
  done: Promise<LoadResult>;
  // Ask the workers to stop starting new work (in-flight requests finish).
  stop(): void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// A cyclic barrier: every worker waits for all the others before the next round.
class Barrier {
  private waiting: (() => void)[] = [];
  constructor(private parties: number) {}
  async arrive(): Promise<void> {
    if (this.parties <= 0) return;
    await new Promise<void>((resolve) => {
      this.waiting.push(resolve);
      if (this.waiting.length >= this.parties) {
        const all = this.waiting;
        this.waiting = [];
        for (const r of all) r();
      }
    });
  }
  // A worker that has finished must not strand the others.
  leave(): void {
    this.parties -= 1;
    if (this.parties > 0 && this.waiting.length >= this.parties) {
      const all = this.waiting;
      this.waiting = [];
      for (const r of all) r();
    }
  }
}

export function startLoad(plan: LoadPlan, clock: () => number): LoadHandle {
  const events: RequestEvent[] = [];
  const intents: (BookingIntent & { userId: string })[] = [];
  const ackedBookings: AcknowledgedBooking[] = [];
  const ackedHolds: AcknowledgedHold[] = [];
  const finals: Record<string, number> = {};
  let abandoned = 0;
  let stopped = false;
  let acks = 0;
  const waiters: { n: number; resolve: () => void }[] = [];
  const noteAck = () => {
    acks += 1;
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (acks >= waiters[i]!.n) waiters.splice(i, 1)[0]!.resolve();
    }
  };

  const final = (name: string) => {
    finals[name] = (finals[name] ?? 0) + 1;
  };

  // One logical operation: send, and on an ambiguous answer retry the same
  // request. Returns the definitive response, or undefined if abandoned.
  async function call(op: RequestEvent["op"], key: string, path: string, body: unknown): Promise<{ status: number; body: any } | undefined> {
    const first = Date.now();
    for (let attempt = 0; ; attempt += 1) {
      const sentAtMs = clock();
      let status = 0;
      let parsed: any;
      let error: string | undefined;
      try {
        const res = await fetch(`${plan.baseUrl}${path}`, {
          method: "POST",
          headers: body === undefined ? {} : { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(plan.attemptTimeoutMs),
        });
        status = res.status;
        const text = await res.text();
        try {
          parsed = text ? JSON.parse(text) : undefined;
        } catch {
          parsed = undefined;
        }
      } catch (err) {
        const e = err as Error & { cause?: { code?: string } };
        error = e.name === "TimeoutError" ? "client-timeout" : (e.cause?.code ?? e.message).slice(0, 60);
      }
      events.push({ op, key, attempt, sentAtMs, doneAtMs: clock(), status, error });
      const definitive = status === 200 || status === 201 || (status >= 400 && status < 500);
      if (definitive) return { status, body: parsed };
      if (Date.now() - first > plan.retryDeadlineMs || stopped) return undefined;
      await sleep(Math.min(1000, 100 * 2 ** Math.min(attempt, 4)));
    }
  }

  const think = () => (plan.thinkMs > 0 ? sleep(plan.thinkMs * (0.5 + Math.random())) : Promise.resolve());

  async function book(seatId: string, key: string, userId: string): Promise<void> {
    intents.push({ idempotencyKey: key, userId, seatIds: [seatId] });
    const r = await call("book", key, "/bookings", { seat_ids: [seatId], user_id: userId, idempotency_key: key });
    if (!r) {
      abandoned += 1;
      final("abandoned");
    } else if (r.status === 201 && r.body?.id) {
      ackedBookings.push({ idempotencyKey: key, userId, seatIds: [seatId], bookingId: r.body.id });
      final("201");
      noteAck();
    } else {
      final(String(r.status));
    }
  }

  async function hold(seatId: string, key: string, userId: string): Promise<void> {
    const r = await call("hold", key, "/holds", { seat_ids: [seatId], user_id: userId, idempotency_key: key });
    if (!r) {
      abandoned += 1;
      final("hold-abandoned");
      return;
    }
    if (!(r.status === 201 && r.body?.id)) {
      final(`hold-${r.status}`);
      return;
    }
    const ack: AcknowledgedHold = { holdId: r.body.id, seatIds: [seatId], userId, heldUntil: r.body.held_until };
    ackedHolds.push(ack);
    final("hold-201");
    noteAck();
    if (Math.random() >= plan.confirmFraction) return;
    const c = await call("confirm", `${key}:confirm`, `/holds/${ack.holdId}/confirm`, undefined);
    if (!c) {
      final("confirm-abandoned");
    } else if (c.status === 201 && c.body?.id) {
      ack.confirmedBookingId = c.body.id;
      final("confirm-201");
    } else {
      final(`confirm-${c.status}`);
    }
  }

  const workerCount = Math.max(1, plan.workers);
  let cursor = 0;

  async function spreadWorker(w: number): Promise<void> {
    while (!stopped) {
      const i = cursor++;
      if (i >= plan.seatIds.length) return;
      const seatId = plan.seatIds[i]!;
      if (plan.kind === "holds") await hold(seatId, `${plan.runId}-s${i}`, `load-user-${i}`);
      else await book(seatId, `${plan.runId}-s${i}`, `load-user-${i}`);
      await think();
    }
  }

  const barrier = new Barrier(workerCount);
  async function hammerWorker(w: number): Promise<void> {
    try {
      for (let i = 0; i < plan.seatIds.length && !stopped; i += 1) {
        await book(plan.seatIds[i]!, `${plan.runId}-h${i}-w${w}`, `load-user-w${w}`);
        await barrier.arrive();
        await think();
      }
    } finally {
      barrier.leave();
    }
  }

  const done = (async (): Promise<LoadResult> => {
    const run = plan.kind === "hammer" ? hammerWorker : spreadWorker;
    await Promise.all(Array.from({ length: workerCount }, (_, w) => run(w)));
    return { intents, ackedBookings, ackedHolds, events, finals, abandoned };
  })();

  return {
    whenAcked(n) {
      if (acks >= n) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push({ n, resolve }));
    },
    ackCount: () => acks,
    done,
    stop() {
      stopped = true;
    },
  };
}
