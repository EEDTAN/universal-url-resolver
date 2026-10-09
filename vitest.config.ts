import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      // Playwright sends localhost and 127.0.0.1 through a context's proxy on its own. Without
      // that, the tests show that the browser resolver's own setting does it.
      PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK: "1",
    },
    coverage: {
      // Test files are always left out of coverage.
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 85,
        // Where untrusted input enters (URLs, pages, scripts), the network policy, and the browser's
        // only way out to the network: every branch needs a test.
        "packages/url-parser/src/**": { 100: true },
        "packages/html-resolver/src/**": { 100: true },
        "packages/js-resolver/src/**": { 100: true },
        "packages/security/src/**": { 100: true },
        "packages/tracking/src/**": { 100: true },
        "packages/adapters/src/**": { 100: true },
        "packages/browser-resolver/src/proxy.ts": { 100: true },
        "apps/api/src/server.ts": { 100: true },
        "apps/web/src/view.ts": { 100: true },
      },
    },
  },
});
