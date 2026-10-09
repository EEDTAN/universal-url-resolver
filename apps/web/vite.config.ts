import { defineConfig } from "vite";

export default defineConfig({
  // While `pnpm web` runs, the page's calls to /api go to the API server (`pnpm api`).
  server: { proxy: { "/api": "http://127.0.0.1:3000" } },
  // React's JSX without a plugin: Vite's own transform writes the calls.
  oxc: { jsx: { runtime: "automatic" } },
});
