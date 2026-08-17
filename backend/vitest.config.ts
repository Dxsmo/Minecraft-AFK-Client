import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    testTimeout: 10000,
    // All test files share one SQLite database file; running them in
    // parallel processes causes cross-file race conditions on shared
    // tables (deleteMany in one file racing with creates in another).
    fileParallelism: false,
  },
});
