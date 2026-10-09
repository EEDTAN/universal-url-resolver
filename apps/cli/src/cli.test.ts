import type { LookupFunction } from "node:net";
import { resolveUrl } from "@urlresolve/core";
import { afterAll, describe, expect, it } from "vitest";
import { fakeLookup, type Route, startMockServer } from "../../../tests/fixtures/mock-server.ts";
import { json, report, run, USAGE, visible } from "./cli.ts";

// Written as code points, so that this file holds none of them itself.
const BEL = String.fromCodePoint(0x07);
const ESC = String.fromCodePoint(0x1b);
const NEL = String.fromCodePoint(0x85);
const CSI = String.fromCodePoint(0x9b);
const RLO = String.fromCodePoint(0x202e); // right-to-left override
const TAG = String.fromCodePoint(0xe0001); // language tag, beyond U+FFFF
const hasRaw = (text: string) => [BEL, ESC, NEL, CSI, RLO, TAG].some((c) => text.includes(c));

const at = (host: string, path: string) => server.url(host, path).href;

const html =
  (body: string, status = 200): Route =>
  (_req, res) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(body);
  };

// Its query decodes to ESC, BEL and U+202E: in a value, and in the name of a tracking parameter.
const ODD = "/odd?q=%1B%5B2J%E2%80%AE&utm_%1B%5D0%3Bx%07=1";

const server = await startMockServer({
  "short.test/abc": (_req, res) => {
    res.writeHead(301, { location: "/page?id=1&utm_source=x" }).end();
  },
  "short.test/page?id=1&utm_source=x": html("<p>destination</p>"),
  "short.test/gone": html("<p>not here</p>", 404),
  "short.test/inside": (_req, res) => {
    res.writeHead(302, { location: "http://inside.test/" }).end();
  },
  "short.test/slow": () => {}, // never answers
  "short.test/fetch": html('<script>fetch("/api").then(() => { location.href = "/x"; });</script>'),
  [`short.test${ODD}`]: html("<p>odd</p>"),
});
afterAll(() => server.close());

/**
 * *.test is 127.0.0.1; inside.test is refused, as safeLookup refuses a private address.
 * evil.test is refused with a message that holds ESC, as an unknown lookup might write one.
 */
const lookup: LookupFunction = (hostname, options, callback) => {
  if (hostname === "inside.test" || hostname === "evil.test") {
    const reason = hostname === "evil.test" ? `bad${ESC}[2Jhost` : "a private or reserved address";
    const error = new Error(`${hostname} is ${reason}`);
    callback(Object.assign(error, { code: "BLOCKED" }), "");
  } else {
    fakeLookup(hostname, options, callback);
  }
};

/** Runs the command with a stand-in browser and collects what it writes. */
async function cli(...args: string[]) {
  return cliWith({}, ...args);
}

async function cliWith(deps: { signal?: AbortSignal }, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const browser = { made: 0, closed: 0 };
  // Only /fetch needs the browser; it goes on to dest.test from there.
  const makeBrowser = () => {
    browser.made += 1;
    return {
      visit: async (url: URL) => {
        if (url.pathname !== "/fetch") throw new Error("no other page here needs a browser");
        return {
          ok: true as const,
          chain: [url.href, at("dest.test", "/page")],
          statusCode: 200,
          challenge: false,
          refresh: null,
          html: "<p>destination</p>",
        };
      },
      close: async () => {
        browser.closed += 1;
      },
    };
  };
  const io = { out: (text: string) => out.push(text), err: (text: string) => err.push(text) };
  const code = await run(args, io, { lookup, makeBrowser, ...deps });
  // The time differs from run to run.
  return {
    code,
    out: out.join("\n").replace(/Time: +\d+\.\d\ds/, "Time:       0.00s"),
    err: err.join("\n"),
    browser,
  };
}

describe("urlresolve", () => {
  it("prints where a link goes, and ends with 0", async () => {
    const { code, out, err } = await cli(at("short.test", "/abc"));
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toBe(
      [
        `Original:   ${at("short.test", "/abc")}`,
        `Final:      ${at("short.test", "/page?id=1&utm_source=x")}`,
        "Status:     RESOLVED",
        "Method:     http",
        "Redirects:  1",
        "Time:       0.00s",
        "Tracking:   1 tracking parameter (utm_source)",
        "",
        "Redirect chain:",
        `  1. ${at("short.test", "/abc")}`,
        `  2. ${at("short.test", "/page?id=1&utm_source=x")}`,
      ].join("\n"),
    );
  });

  it("prints the reason when a link does not resolve, and ends with 1", async () => {
    const { code, out } = await cli(at("short.test", "/gone"));
    expect(code).toBe(1);
    expect(out).toContain("Status:     UNRESOLVED\nReason:     The server answered with HTTP 404");
  });

  it("prints the whole result as JSON with --json, and nothing else", async () => {
    const { code, out, err } = await cli(at("short.test", "/abc"), "--json");
    expect(code).toBe(0);
    expect(err).toBe("");
    const direct = await resolveUrl(at("short.test", "/abc"), { lookup });
    expect({ ...JSON.parse(out), timing: null }).toEqual({ ...direct, timing: null });
  });

  it("adds the clean URL with --clean", async () => {
    const { out } = await cli(at("short.test", "/abc"), "--clean");
    expect(out).toContain(`Clean:      ${at("short.test", "/page?id=1")}`);
  });

  it("adds what the security checks found with --security", async () => {
    expect((await cli(at("short.test", "/abc"), "--security")).out).toContain(
      [
        "Security:",
        "  HTTPS:              no",
        "  Public destination: yes, every address on the way passed the check",
        "  User info removed:  no",
      ].join("\n"),
    );
    const blocked = await cli(at("short.test", "/inside"), "--security");
    expect(blocked.code).toBe(1);
    expect(blocked.out).toContain(
      "Security:\n  Blocked:            inside.test is a private or reserved address",
    );
  });

  it("prints every detail, and every step on stderr, with -v", async () => {
    const { out, err } = await cli(at("short.test", "/abc"), "-v");
    expect(out).toContain(`Clean:      ${at("short.test", "/page?id=1")}`);
    expect(out).toContain("  Domain changed:     no");
    expect(out).toContain(`  Port:               ${new URL(at("short.test", "/")).port}`);
    expect(out).toContain(
      "Query parameters:\n  id=1          functional\n  utm_source=x  tracking",
    );
    expect(out).toContain("Security:");
    expect(err.split("\n")).toEqual([
      `[URL] ${at("short.test", "/abc")}`,
      `[HTTP] 301 ${at("short.test", "/abc")}`,
      `[REDIRECT] to ${at("short.test", "/page?id=1&utm_source=x")}`,
      `[HTTP] 200 ${at("short.test", "/page?id=1&utm_source=x")}`,
      "[TRACKING] 1 tracking parameter: utm_source",
      `[FINAL] RESOLVED ${at("short.test", "/page?id=1&utm_source=x")}`,
    ]);
  });

  it("keeps stdout pure JSON when --json and --verbose come together", async () => {
    const { out, err } = await cli(at("short.test", "/abc"), "--json", "--verbose");
    expect(() => JSON.parse(out)).not.toThrow();
    expect(err).toContain("[FINAL] RESOLVED");
  });

  it("takes --timeout in seconds", async () => {
    const { code, out } = await cli(at("short.test", "/slow"), "--timeout", "0.2");
    expect(code).toBe(1);
    expect(out).toContain("Status:     TIMEOUT");
    // The longest timer Node allows, 2147483.647 seconds, is still fine.
    expect((await cli(at("short.test", "/abc"), "--timeout", "2147483.647")).code).toBe(0);
  });

  it("takes --max-redirects", async () => {
    const { out } = await cli(at("short.test", "/abc"), "--max-redirects", "0");
    expect(out).toContain("Reason:     More than 0 redirects");
  });

  it("hands a page that needs it to the browser, unless --no-browser", async () => {
    const withBrowser = await cli(at("short.test", "/fetch"));
    expect(withBrowser.out).toContain(`Final:      ${at("dest.test", "/page")}`);
    expect(withBrowser.out).toContain("Method:     browser");
    expect(withBrowser.browser).toEqual({ made: 1, closed: 1 });
    const without = await cli(at("short.test", "/fetch"), "--no-browser");
    expect(without.out).toContain(`Final:      ${at("short.test", "/fetch")}`);
    expect(without.browser).toEqual({ made: 0, closed: 0 });
  });

  it("closes the browser when it was not needed", async () => {
    expect((await cli(at("short.test", "/abc"))).browser).toEqual({ made: 1, closed: 1 });
  });

  it("prints nothing and ends with 130 when it is stopped", async () => {
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 100);
    const { code, out, browser } = await cliWith(
      { signal: stop.signal },
      at("short.test", "/slow"),
    );
    expect(code).toBe(130);
    expect(out).toBe("");
    expect(browser.closed).toBe(1);
  });

  it("shows characters a terminal would act on as escapes, in the report and the log", async () => {
    const { out, err } = await cli(at("short.test", ODD), "--verbose");
    expect(out).toMatch(/q=\\u\{1b\}\[2J\\u\{202e\} +functional/);
    expect(out).toContain("Tracking:   1 tracking parameter (utm_\\u{1b}]0;x\\u{7})");
    expect(err).toContain("[TRACKING] 1 tracking parameter: utm_%1B%5D0%3Bx%07");
    expect(hasRaw(out) || hasRaw(err)).toBe(false);
  });

  it("escapes an error message from the lookup, in the report and the log", async () => {
    const { out, err } = await cli(at("evil.test", "/"), "--verbose");
    expect(out).toContain("Reason:     evil.test is bad\\u{1b}[2Jhost");
    expect(err).toContain("[FINAL] BLOCKED: evil.test is bad\\u{1b}[2Jhost");
    expect(hasRaw(out) || hasRaw(err)).toBe(false);
  });

  it.each([["--help"], ["-h"]])("prints help with %s", async (flag) => {
    expect(await cli(flag)).toMatchObject({ code: 0, out: USAGE });
  });

  it.each([
    [[], "Give exactly one link (got 0)."],
    [["a.test", "b.test"], "Give exactly one link (got 2)."],
    [["a.test", "--", "--json"], "Everything after -- counts as a link, options too."],
    [["a.test", "--fast"], "Unknown option '--fast'"],
    [["a.test", "--timeout", "abc"], "--timeout takes a number of seconds above 0"],
    [["a.test", "--timeout", "0"], "--timeout takes a number of seconds above 0"],
    [["a.test", "--timeout", "1e3"], "--timeout takes a number of seconds above 0"],
    [["a.test", "--timeout", "2147483.648"], "--timeout takes a number of seconds above 0"],
    [["a.test", "--timeout=-1"], "--timeout takes a number of seconds above 0"],
    // parseArgs takes "-1" after a space for an option of its own, and says so.
    [["a.test", "--timeout", "-1"], "argument is ambiguous"],
    [["a.test", "--max-redirects", "1.5"], "--max-redirects takes a whole number, 0 or more."],
    [["a.test", "--max-redirects", ""], "--max-redirects takes a whole number, 0 or more."],
    [["a.test", "--max-redirects", "0x10"], "--max-redirects takes a whole number, 0 or more."],
    [["a.test", "--max-redirects=-1"], "--max-redirects takes a whole number, 0 or more."],
  ])("ends with 2 and explains a mistake: %j", async (args, message) => {
    const { code, out, err, browser } = await cli(...args);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain(message);
    expect(err).toContain("Usage: urlresolve <url> [options]");
    expect(browser.made).toBe(0);
  });

  it("escapes an option it does not know before it repeats it", async () => {
    const { err } = await cli("a.test", `--x${ESC}[2J`);
    expect(err).toContain("Unknown option '--x\\u{1b}[2J'");
    expect(hasRaw(err)).toBe(false);
  });
});

describe("report", () => {
  type Result = Parameters<typeof report>[0];
  const resolved = (finalUrl: string, credentialsRemoved = false): Result => ({
    originalUrl: "https://short.example/abc",
    finalUrl,
    status: "RESOLVED",
    method: "http",
    redirectCount: 1,
    chain: ["https://short.example/abc", finalUrl],
    httpStatus: 200,
    timing: { elapsedMs: 1840 },
    security: { credentialsRemoved },
    tracking: { cleanUrl: finalUrl, parameters: [] },
    error: null,
  });

  it("shows every part of the final URL with --verbose", () => {
    expect(report(resolved("http://example.com:8080/a/b?x=1#top"), { verbose: true })).toBe(
      [
        "Original:   https://short.example/abc",
        "Final:      http://example.com:8080/a/b?x=1#top",
        "Clean:      http://example.com:8080/a/b?x=1#top",
        "Status:     RESOLVED",
        "Method:     http",
        "Redirects:  1",
        "Time:       1.84s",
        "",
        "Redirect chain:",
        "  1. https://short.example/abc",
        "  2. http://example.com:8080/a/b?x=1#top",
        "",
        "Final URL:",
        "  Original domain:    short.example",
        "  Final domain:       example.com",
        "  Domain changed:     yes",
        "  Protocol:           http",
        "  Port:               8080",
        "  Path:               /a/b",
        "  Query:              ?x=1",
        "  Fragment:           #top",
        "  HTTP status:        200",
        "",
        "Security:",
        "  HTTPS:              no",
        "  Public destination: yes, every address on the way passed the check",
        "  User info removed:  no",
      ].join("\n"),
    );
  });

  it("names the default port, and says when there is no query or fragment", () => {
    const text = report(resolved("https://example.com/", true), { verbose: true });
    for (const line of [
      "  Port:               443 (default)",
      "  Query:              (none)",
      "  Fragment:           (none)",
      "  HTTPS:              yes",
      "  User info removed:  yes",
    ]) {
      expect(text.split("\n")).toContain(line);
    }
    expect(text).not.toContain("Query parameters:");
    expect(report(resolved("http://example.com/"), { verbose: true })).toContain(
      "  Port:               80 (default)",
    );
  });

  it("counts the tracking parameters", () => {
    const result = resolved("https://example.com/?utm_source=a&fbclid=b");
    if (result.tracking) {
      result.tracking.parameters = [
        { name: "utm_source", value: "a", kind: "tracking" },
        { name: "fbclid", value: "b", kind: "tracking" },
      ];
    }
    expect(report(result)).toContain("Tracking:   2 tracking parameters (utm_source, fbclid)");
  });

  it("keeps the list of query parameters narrow when one is very long", () => {
    const result = resolved("https://example.com/?a=1");
    if (result.tracking) {
      result.tracking.parameters = [
        { name: "a", value: "1", kind: "unknown" },
        { name: "b", value: "x".repeat(5000), kind: "unknown" },
      ];
    }
    const line = report(result, { verbose: true })
      .split("\n")
      .find((l) => l.startsWith("  a=1"));
    expect(line).toBe(`  ${"a=1".padEnd(40)}  unknown`);
  });

  it("checks nothing for a link it could not read", () => {
    const text = report(
      {
        originalUrl: "javascript:alert(1)",
        finalUrl: null,
        status: "INVALID_URL",
        method: null,
        redirectCount: 0,
        chain: [],
        httpStatus: null,
        timing: { elapsedMs: 0 },
        security: { credentialsRemoved: false },
        tracking: null,
        error: 'Only http and https links can be resolved (got "javascript:")',
      },
      { security: true },
    );
    expect(text).toContain("Method:     none");
    expect(text).not.toContain("Redirect chain:");
    expect(text).not.toContain("Security:");
  });
});

describe("visible and json", () => {
  it("escape control and invisible formatting characters", () => {
    expect(visible(`a${ESC}[31mb${RLO}c${NEL}d${TAG}`)).toBe(
      "a\\u{1b}[31mb\\u{202e}c\\u{85}d\\u{e0001}",
    );
  });

  it("keep the JSON valid, characters beyond U+FFFF included", () => {
    const value = `${ESC}[2J${RLO}${NEL}${CSI}${TAG}`;
    const text = json({ error: value } as unknown as Parameters<typeof json>[0]);
    expect(hasRaw(text)).toBe(false);
    expect(JSON.parse(text).error).toBe(value);
  });

  it("keep the JSON that --json prints valid", async () => {
    const out: string[] = [];
    const io = { out: (text: string) => out.push(text), err: () => {} };
    await run([at("short.test", ODD), "--json", "--no-browser"], io, { lookup });
    const text = out.join("");
    expect(hasRaw(text)).toBe(false);
    expect(JSON.parse(text).tracking.parameters[0].value).toBe(`${ESC}[2J${RLO}`);
  });
});
