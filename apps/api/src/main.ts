import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createBrowserResolver } from "@urlresolve/browser-resolver";
import { buildServer, settingsFromEnv } from "./server.ts";

const settings = settingsFromEnv(process.env);
const browser = settings.browser ? createBrowserResolver() : undefined;
// The web page, once `pnpm build` has built it.
const page = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const webRoot = existsSync(`${page}index.html`) ? page : undefined;
const app = await buildServer({ ...settings.options, browser, webRoot, logger: true });
app.addHook("onClose", async () => {
  await browser?.close();
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close();
    // Answers on their way still go out (a link takes at most 10 s); then every connection that
    // is left, an idle keep-alive one say, is cut so that the process can end.
    setTimeout(() => app.server.closeAllConnections(), 15_000).unref();
  });
}
await app.listen({ host: settings.host, port: settings.port });
