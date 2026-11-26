// Imported FIRST by runRestart.ts (ESM evaluates imports in source order).
// The harness imports one constant (the confirm-key format) from src/ so it can
// never drift from the app's own, and src/config.ts refuses to load without a
// DATABASE_URL. The C4 runner owns its own Postgres and has no shared database
// URL to offer, so it supplies a placeholder that is never connected to: the
// imported module only builds a lazy pool. A real DATABASE_URL (e.g. from .env)
// is left alone.
process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:1/unused";
