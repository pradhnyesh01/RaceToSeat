// A total time budget for a retry loop (issue #59, finding R6, ADR-0027).
//
// The retry loops cap *how many* attempts a request may make. Under a slow
// link every attempt costs many round trips, so a count cap alone can let a
// request run for several multiples of the client's own timeout (serializable
// at 125 ms added per chunk: 22 of 30 clients gave up before the fifth retry
// finished). The per-statement bounds of ADR-0026 do not help, because no
// single statement is slow; it is the number of attempts times the slowness.
//
// This is deliberately NOT a deadline that interrupts anything: a statement in
// flight is still ADR-0026's to bound, and an attempt already running always
// finishes. It only decides whether to START another attempt, using the last
// attempt's own duration as the estimate of what one more costs — so the total
// stays near the budget instead of overshooting it by a whole attempt, with no
// guess about the link's speed baked in. The first attempt is never refused.
export interface RetryBudgetOptions {
  // Total time budget for the whole retry loop; defaults to config.retryBudgetMs (ADR-0027).
  budgetMs?: number;
}

export class RetryBudget {
  private readonly startedAt: number;
  private lapStartedAt: number;

  constructor(
    private readonly budgetMs: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.startedAt = now();
    this.lapStartedAt = this.startedAt;
  }

  // Call once after each attempt that failed in a retriable way, before deciding to go again.
  // True when another attempt, assumed to cost as much as the one that just failed (the time
  // since the previous call, or since construction for the first), would end past the budget.
  wouldOverrun(): boolean {
    const t = this.now();
    const lastAttemptMs = t - this.lapStartedAt;
    this.lapStartedAt = t;
    return t - this.startedAt + lastAttemptMs > this.budgetMs;
  }
}
