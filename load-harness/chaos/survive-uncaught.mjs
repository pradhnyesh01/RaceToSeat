// Harness-side scaffolding, NOT production behavior (ADR-0022): preloaded into
// the app-under-test (via NODE_OPTIONS=--import) only when the chaos run is
// started with --survive-uncaught.
//
// The first backend-kill run found that the unmodified app crashes the whole
// process on the first killed connection (an unhandled 'error' event on a
// checked-out pg Client). That is a Robustness finding, recorded as found —
// but it also ends the run after one kill, hiding everything behind it
// (whether a kill mid-transaction masks its root cause, whether a dead
// client poisons the pool, whether the Oracles hold across many kills).
// This preload lets the process outlive that one finding so those can be
// observed, without touching src/: the fix for the crash itself belongs to
// its own ticket (C5), and until it lands this is how later findings stay
// visible. Every swallowed exception is logged, so the report still counts
// how often the production code would have died.
process.on("uncaughtException", (err) => {
  console.error(`[chaos preload] swallowed uncaughtException: ${err && err.message}`);
});
