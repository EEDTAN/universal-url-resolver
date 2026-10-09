import type { LookupFunction } from "node:net";
import { type ResolveOptions, resolveUrl } from "@urlresolve/core";
import { afterAll, describe, expect, it } from "vitest";
import { fakeLookup, type Route, startMockServer } from "../fixtures/mock-server.ts";

type Adapter = NonNullable<ResolveOptions["adapters"]>[number];
type Context = Parameters<Adapter["next"]>[0];

const at = (host: string, path: string) => server.url(host, path).href;

const html =
  (body: string | (() => string), status = 200, headers: Record<string, string> = {}): Route =>
  (_req, res) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
    res.end(typeof body === "string" ? body : body());
  };

const server = await startMockServer({
  "svc.test/plain": html("<p>a page of the service</p>"),
  "svc.test/next": html("<p>the next page</p>"),
  "svc.test/moved": (_req, res) => {
    res.writeHead(302, { location: "/plain" }).end();
  },
  "svc.test/refresh": html('<meta http-equiv="refresh" content="0; url=/plain">'),
  "svc.test/js": html('<script>location.href = "/plain";</script>'),
  "svc.test/captcha": html('<form><div class="g-recaptcha" data-sitekey="x"></div></form>'),
  "svc.test/challenge": html("<p>Just a moment...</p>", 403, { "cf-mitigated": "challenge" }),
  "svc.test/gone": html("<p>not here</p>", 404),
  "svc.test/leaving?u=https://dest.example/": html(
    "<p>You are leaving for https://dest.example/</p>",
  ),
  "svc.test/unknown": html("<script>location.href = document.title;</script>"),
  "svc.test/data": html(() => `<div id="go" data-go="${at("dest.test", "/landing")}"></div>`),
  "svc.test/text": (_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" }).end("just text");
  },
  "dest.test/landing": html("<p>destination</p>"),
});
afterAll(() => server.close());

/** *.test is 127.0.0.1; inside.test is refused, as safeLookup refuses a private address. */
const policy: LookupFunction = (hostname, options, callback) => {
  if (hostname === "inside.test") {
    const error = new Error(`${hostname} is a private or reserved address`);
    callback(Object.assign(error, { code: "BLOCKED" }), "");
  } else {
    fakeLookup(hostname, options, callback);
  }
};

/** An adapter for svc.test that records every page it is shown and answers with `answer`. */
function serviceAdapter(answer: (context: Context) => string | null) {
  const seen: { url: string; html: string | null }[] = [];
  const adapter: Adapter = {
    name: "svc",
    matches: (url) => url.hostname === "svc.test",
    next(context) {
      seen.push({ url: context.url.href, html: context.html });
      return answer(context);
    },
  };
  return { adapter, seen };
}

function resolve(path: string, adapters: readonly Adapter[], options: ResolveOptions = {}) {
  return resolveUrl(at("svc.test", path), { lookup: policy, adapters, ...options });
}

describe("adapters", () => {
  it("go on from a page the readers take for the destination", async () => {
    const { adapter, seen } = serviceAdapter(() => at("dest.test", "/landing"));
    expect(await resolve("/plain", [adapter])).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("dest.test", "/landing"),
      method: "adapter",
      chain: [at("svc.test", "/plain"), at("dest.test", "/landing")],
    });
    expect(seen).toEqual([{ url: at("svc.test", "/plain"), html: "<p>a page of the service</p>" }]);
  });

  it.each([
    ["/leaving?u=https://dest.example/", "a page that asks for a click"],
    ["/unknown", "a script that leaves for a place unknown"],
  ])("go on from %s (%s)", async (path) => {
    const { adapter } = serviceAdapter(() => at("dest.test", "/landing"));
    expect(await resolve(path, [adapter])).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("dest.test", "/landing"),
    });
  });

  it("can read the way on from the page", async () => {
    const { adapter } = serviceAdapter(
      ({ html }) => /data-go="([^"]+)"/.exec(html ?? "")?.[1] ?? null,
    );
    expect(await resolve("/data", [adapter])).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("dest.test", "/landing"),
    });
  });

  it("are shown no HTML for an answer that is not HTML", async () => {
    const { adapter, seen } = serviceAdapter(() => null);
    await resolve("/text", [adapter]);
    expect(seen).toEqual([{ url: at("svc.test", "/text"), html: null }]);
  });

  it("are not asked while the readers can follow the page", async () => {
    const { adapter, seen } = serviceAdapter(() => null);
    for (const path of ["/moved", "/refresh", "/js"]) {
      expect(await resolve(path, [adapter])).toMatchObject({
        status: "RESOLVED",
        finalUrl: at("svc.test", "/plain"),
      });
    }
    // Only about the page each of them leads to.
    expect(seen.map(({ url }) => url)).toEqual(Array(3).fill(at("svc.test", "/plain")));
  });

  it.each([
    ["/captcha", "a CAPTCHA", "Human verification required"],
    ["/challenge", "a Cloudflare challenge", "Human verification required"],
    ["/gone", "an error page", "The server answered with HTTP 404"],
  ])("are never asked about %s (%s)", async (path, _what, error) => {
    const { adapter, seen } = serviceAdapter(() => at("dest.test", "/landing"));
    expect(await resolve(path, [adapter])).toMatchObject({ status: "UNRESOLVED", error });
    expect(seen).toEqual([]);
  });

  it("resolve a relative answer against the page", async () => {
    const { adapter } = serviceAdapter(({ url }) => (url.pathname === "/plain" ? "next" : null));
    expect(await resolve("/plain", [adapter])).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("svc.test", "/next"),
    });
  });

  it.each([
    ["the page itself", (context: Context) => context.url.href, "REDIRECT_LOOP"],
    ["a private address", () => "http://inside.test/secret", "BLOCKED"],
    ["a javascript: URL", () => "javascript:alert(1)", "BLOCKED"],
  ])("have their answer checked like any redirect: %s", async (_what, answer, status) => {
    const { adapter } = serviceAdapter(answer);
    expect(await resolve("/plain", [adapter])).toMatchObject({ status });
  });

  it("have a password taken out of their answer", async () => {
    const { adapter } = serviceAdapter(() =>
      at("dest.test", "/landing").replace("//", "//user:s3cret@"),
    );
    const result = await resolve("/plain", [adapter]);
    expect(result).toMatchObject({ status: "RESOLVED", security: { credentialsRemoved: true } });
    expect(JSON.stringify(result)).not.toContain("s3cret");
  });

  it("count against maxRedirects", async () => {
    const { adapter } = serviceAdapter(() => at("dest.test", "/landing"));
    expect(await resolve("/plain", [adapter], { maxRedirects: 0 })).toMatchObject({
      status: "UNRESOLVED",
      error: "More than 0 redirects",
    });
  });

  it("cannot move the resolution by changing the URL they are shown", async () => {
    const { adapter } = serviceAdapter((context) => {
      context.url.hostname = "inside.test";
      return null;
    });
    expect(await resolve("/plain", [adapter])).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("svc.test", "/plain"),
    });
  });

  it("are asked one at a time: only the first that knows the page", async () => {
    const first = serviceAdapter(() => null);
    const second = serviceAdapter(() => at("dest.test", "/landing"));
    expect(await resolve("/plain", [first.adapter, second.adapter])).toMatchObject({
      finalUrl: at("svc.test", "/plain"),
    });
    expect(second.seen).toEqual([]);
  });

  it("pass over an adapter that does not know the page, or whose matches() throws", async () => {
    const other: Adapter = { name: "other", matches: () => false, next: () => "/next" };
    const failing: Adapter = {
      name: "failing",
      matches: () => {
        throw new Error("bug");
      },
      next: () => "/next",
    };
    const { adapter } = serviceAdapter(() => at("dest.test", "/landing"));
    expect(await resolve("/plain", [other, failing, adapter])).toMatchObject({
      finalUrl: at("dest.test", "/landing"),
    });
  });

  it("stop at a first adapter whose next() throws, as at one that answers null", async () => {
    const failing: Adapter = {
      name: "failing",
      matches: (url) => url.hostname === "svc.test",
      next: () => {
        throw new Error("bug");
      },
    };
    const { adapter, seen } = serviceAdapter(() => at("dest.test", "/landing"));
    expect(await resolve("/plain", [failing, adapter])).toMatchObject({
      finalUrl: at("svc.test", "/plain"),
    });
    expect(seen).toEqual([]);
  });

  it("each get a URL of their own, so one cannot steer the others", async () => {
    const meddling: Adapter = {
      name: "meddling",
      matches(url) {
        url.hostname = "inside.test";
        return false;
      },
      next: () => null,
    };
    const { adapter } = serviceAdapter(() => at("dest.test", "/landing"));
    expect(await resolve("/plain", [meddling, adapter])).toMatchObject({
      finalUrl: at("dest.test", "/landing"),
    });
  });

  it("do not pass the page's #fragment on, as a link on the page would not", async () => {
    const { adapter } = serviceAdapter(() => at("dest.test", "/landing"));
    expect(await resolve("/plain#part-2", [adapter])).toMatchObject({
      finalUrl: at("dest.test", "/landing"),
    });
  });

  const broken: [string, Adapter][] = [
    [
      "matches() throws",
      {
        name: "a",
        matches: () => {
          throw new Error("bug");
        },
        next: () => "/next",
      },
    ],
    [
      "next() throws",
      {
        name: "b",
        matches: () => true,
        next: () => {
          throw new Error("bug");
        },
      },
    ],
    ["next() answers an empty string", { name: "c", matches: () => true, next: () => "" }],
    [
      "next() answers no string",
      { name: "d", matches: () => true, next: () => 42 as unknown as string },
    ],
  ];
  it.each(broken)("change nothing when %s", async (_what, adapter) => {
    expect(await resolve("/plain", [adapter])).toMatchObject({
      status: "RESOLVED",
      finalUrl: at("svc.test", "/plain"),
      method: "http",
    });
  });
});
