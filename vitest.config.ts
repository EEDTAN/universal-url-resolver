import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      // Test files are always left out of coverage.
      include: ["packages/*/src/**/*.ts"],
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 85,
        // Where untrusted input enters (URLs, pages, scripts), and the network policy: every branch
        // needs a test.
        "packages/url-parser/src/**": { 100: true },
        "packages/html-resolver/src/**": { 100: true },
        "packages/js-resolver/src/**": { 100: true },
        "packages/security/src/**": { 100: true },
      },
    },
  },
});
