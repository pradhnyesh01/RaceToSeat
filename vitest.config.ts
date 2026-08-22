import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // All test files share one Postgres database (no per-file schema
    // isolation yet), and each file's beforeEach TRUNCATEs the shared
    // tables — running files in parallel lets one file's reset race
    // another file's in-flight writes. Revisit if per-file DB isolation is
    // added later.
    fileParallelism: false,
  },
});
