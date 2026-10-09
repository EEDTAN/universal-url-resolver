import type { ResolveResult } from "@urlresolve/types";
import { describe, expect, it } from "vitest";
import { apiProblem, view, visible } from "./view.ts";

// Written as code points, so that this file holds none of them itself.
const ESC = String.fromCodePoint(0x1b);
const RLO = String.fromCodePoint(0x202e); // right-to-left override

const resolved: ResolveResult = {
  originalUrl: "https://short.example/abc",
  finalUrl: "https://example.com/page?id=1&utm_source=x",
  status: "RESOLVED",
  method: "browser",
  redirectCount: 3,
  chain: [
    "https://short.example/abc",
    "https://intermediate.example/x",
    "http://tracker.example:8080/r",
    "https://example.com/page?id=1&utm_source=x",
  ],
  httpStatus: 200,
  timing: { elapsedMs: 1820 },
  security: { credentialsRemoved: false },
  tracking: {
    cleanUrl: "https://example.com/page?id=1",
    parameters: [
      { name: "id", value: "1", kind: "functional" },
      { name: "utm_source", value: "x", kind: "tracking" },
    ],
  },
  error: null,
};

const failed = (status: "UNRESOLVED" | "BLOCKED", error: string): ResolveResult => ({
  originalUrl: "https://short.example/abc",
  finalUrl: null,
  status,
  method: "http",
  redirectCount: 0,
  chain: ["https://short.example/abc"],
  httpStatus: 403,
  timing: { elapsedMs: 160 },
  security: { credentialsRemoved: false },
  tracking: null,
  error,
});

describe("view", () => {
  it("shows a resolved link the way the spec draws it", () => {
    expect(view(resolved)).toEqual({
      resolved: true,
      headline: "https://example.com/page?id=1&utm_source=x",
      reason: null,
      chain: [
        { position: 1, host: "short.example", href: "https://short.example/abc" },
        { position: 2, host: "intermediate.example", href: "https://intermediate.example/x" },
        { position: 3, host: "tracker.example:8080", href: "http://tracker.example:8080/r" },
        {
          position: 4,
          host: "example.com",
          href: "https://example.com/page?id=1&utm_source=x",
        },
      ],
      security: [
        { ok: true, text: "HTTPS" },
        { ok: true, text: "Public destination" },
      ],
      tracking: { names: ["utm_source"], cleanUrl: "https://example.com/page?id=1" },
      technical: ["3 redirects", "1.82 seconds", "Browser fallback", "HTTP 200"],
    });
  });

  it("says why a link did not resolve", () => {
    expect(view(failed("UNRESOLVED", "Human verification required"))).toMatchObject({
      resolved: false,
      headline: "UNRESOLVED",
      reason: "Human verification required",
      security: [],
      tracking: { names: [], cleanUrl: null },
      technical: ["0 redirects", "0.16 seconds", "HTTP redirects", "HTTP 403"],
    });
  });

  it("says why a link was blocked", () => {
    expect(view(failed("BLOCKED", "127.0.0.1 is a private address")).security).toEqual([
      { ok: false, text: "Blocked: 127.0.0.1 is a private address" },
    ]);
  });

  it("warns about a user name or password taken out of the link", () => {
    const result = { ...resolved, security: { credentialsRemoved: true } };
    expect(view(result).security).toContainEqual({
      ok: false,
      text: "A user name or password was taken out of the link",
    });
  });

  it("says when the final URL is not HTTPS, and gives no clean URL without tracking", () => {
    const plain: ResolveResult = {
      ...resolved,
      finalUrl: "http://example.com/",
      redirectCount: 1,
      tracking: { cleanUrl: "http://example.com/", parameters: [] },
    };
    const shown = view(plain);
    expect(shown.security[0]).toEqual({ ok: false, text: "Not HTTPS" });
    expect(shown.tracking).toEqual({ names: [], cleanUrl: null });
    expect(shown.technical[0]).toBe("1 redirect");
  });

  it("names each method, and says when no answer came at all", () => {
    for (const [method, name] of [
      ["http", "HTTP redirects"],
      ["html", "Read from the page"],
      ["meta-refresh", "Meta refresh"],
      ["javascript", "JavaScript, read without running it"],
      ["adapter", "Service adapter"],
    ] as const) {
      expect(view({ ...resolved, method }).technical[2]).toBe(name);
    }
    const none = view({ ...failed("UNRESOLVED", "x"), method: null, httpStatus: null });
    expect(none.technical).toEqual(["0 redirects", "0.16 seconds", "No answer from the link"]);
  });

  it("shows tracking names a terminal or a page could misread as escapes", () => {
    const odd: ResolveResult = {
      ...resolved,
      tracking: {
        cleanUrl: resolved.tracking.cleanUrl,
        parameters: [{ name: `utm_${ESC}x${RLO}`, value: "1", kind: "tracking" }],
      },
    };
    expect(view(odd).tracking.names).toEqual(["utm_\\u{1b}x\\u{202e}"]);
  });
});

describe("apiProblem", () => {
  it.each([
    [400, "That is not a link the server can take."],
    [413, "That is not a link the server can take."],
    [429, "Too many links at once: wait a minute, then try again."],
    [503, "The server is busy right now: try again in a moment."],
    [500, "The server answered with HTTP 500."],
  ])("explains HTTP %i", (status, message) => {
    expect(apiProblem(status)).toBe(message);
  });
});

describe("visible", () => {
  it("leaves ordinary text alone", () => {
    expect(visible("utm_source")).toBe("utm_source");
  });
});
