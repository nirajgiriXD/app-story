import { defineConfig } from "vitest/config";

// Tests run from the repository root (see scripts/vitest.mjs), so paths such as
// products/example resolve the same way they do for the CLI.
export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["tests/unit/**/*.test.ts"], environment: "node" } },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          testTimeout: 600_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "e2e",
          include: ["tests/e2e/**/*.test.ts"],
          environment: "node",
          testTimeout: 1_200_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
