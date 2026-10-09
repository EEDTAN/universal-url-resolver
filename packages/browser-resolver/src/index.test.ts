import { createSocket } from "node:dgram";
import type { LookupFunction } from "node:net";
import { MAX_HTML_SIZE } from "@urlresolve/http-resolver";
import { type Browser, chromium } from "playwright-core";
import { afterAll, describe, expect, it, vi } from "vitest";
import { fakeLookup, type Route, startMockServer } from "../../../tests/fixtures/mock-server.ts";
import { createBrowserResolver } from "./index.ts";

const at = (host: string, path: string) => server.url(host, path).href;

const html =
  (body: string | (() => string), headers: Record<string, string> = {}, status = 200): Route =>
  (_req, res) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
    res.end(typeof body === "string" ? body : body());
  };
const script = (code: string | (() => string)) =>
  html(() => `<!doctype html><script>${typeof code === "string" ? code : code()}</script>`);

const server = await startMockServer({
  "go.test/next": html("<p>next page</p>"),
  "go.test/landing": html("<p>landing</p>"),
  "dest.test/": html("<p>destination</p>"),
  "go.test/stay": html("<p>just a page</p>"),
  "go.test/js": script('location.href = "/next"'),
  "go.test/http": (_req, res) => {
    res.writeHead(302, { location: "/next" }).end();
  },
  "go.test/api": (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ url: at("dest.test", "/") }));
  },
  "go.test/fetch": script(
    'fetch("/api").then((r) => r.json()).then((d) => location.replace(d.url))',
  ),
  "go.test/cookie": (req, res) => {
    if (req.headers.cookie?.includes("ok=1")) {
      res.writeHead(302, { location: at("dest.test", "/") }).end();
    } else {
      html('<script>document.cookie = "ok=1"; location.reload();</script>')(req, res);
    }
  },
  "go.test/timer": script('setTimeout(() => { location.href = "/next"; }, 100)'),
  "go.test/late-timer": script('setTimeout(() => { location.href = "/next"; }, 2000)'),
  "go.test/challenge": html("<p>Just a moment...</p>", { "cf-mitigated": "challenge" }, 403),
  "go.test/to-challenge": script('location.href = "/challenge"'),
  "go.test/file": (_req, res) => {
    res.writeHead(200, { "content-disposition": "attachment; filename=a.bin" }).end("data");
  },
  "go.test/download": script('location.href = "/file"'),
  "go.test/blank": script('location.href = "about:blank"'),
  "go.test/to-loopback": script(() => `location.href = "http://127.0.0.1:${server.port}/secret"`),
  "go.test/to-localhost": script(() => `location.href = "http://localhost:${server.port}/secret"`),
  "go.test/to-inside": script(() => `location.href = "${at("inside.test", "/secret")}"`),
  "go.test/to-nowhere": script('location.href = "http://nowhere.test.example/"'),
  "go.test/to-inside-https": script('location.href = "https://inside.test/secret"'),
  "go.test/to-https": script(() => `location.href = "https://go.test:${server.port}/next"`),
  "go.test/reach-inside": html(
    () => `<p>a page that tries to reach inside</p>
      <img src="http://127.0.0.1:${server.port}/secret?img">
      <iframe src="http://localhost:${server.port}/secret?frame"></iframe>
      <script>
        fetch("http://[::1]:${server.port}/secret?fetch").catch(() => {});
        fetch("${at("inside.test", "/secret?inside")}").catch(() => {});
        try { new WebSocket("ws://127.0.0.1:${server.port}/secret?ws"); } catch {}
      </script>`,
  ),
  "go.test/popup": script('window.open("/next"); location.href = "/landing";'),
  "go.test/loop-a": script('location.href = "/loop-b"'),
  "go.test/loop-b": script('location.href = "/loop-a"'),
  "go.test/never": () => {}, // never answers
  "go.test/hang": script('location.href = "/never"'),
  "go.test/empty": (_req, res) => {
    res.writeHead(204).end();
  },
  "go.test/to-empty": script('setTimeout(() => { location.href = "/empty"; }, 50)'),
  "go.test/stop": script('location.href = "/never"; setTimeout(() => window.stop(), 100)'),
  "go.test/to-hash": script('location.href = "/next#/item/42"'),
  // An app link, then the web page for browsers without the app.
  "go.test/deeplink": script(
    'location.href = "myapp://open"; setTimeout(() => { location.href = "/landing"; }, 100)',
  ),
  "go.test/needs-session": (req, res) => {
    if (req.headers.cookie?.includes("sid=42") && req.headers.cookie.includes("t=a=b")) {
      res.writeHead(302, { location: at("dest.test", "/") }).end();
    } else {
      html("<p>no session</p>")(req, res);
    }
  },
  "go.test/multi": (_req, res) => {
    res.writeHead(300, { location: "/next", "content-type": "text/html" }).end("<p>choose</p>");
  },
  "go.test/to-multi": script('location.href = "/multi"'),
  "go.test/refresh-header": html("<p>wait</p>", { refresh: "5; url=/next" }),
  "go.test/to-refresh-header": script('location.href = "/refresh-header"'),
  // Its end, with the script that moves on, comes a while after its start.
  "go.test/slow-body": (_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.write("<!doctype html><p>start</p>");
    setTimeout(() => res.end('<script>location.href = "/next"</script>'), 800);
  },
  "go.test/to-slow": script('setTimeout(() => { location.href = "/slow-body"; }, 50)'),
  "go.test/held": (req, res) => {
    held.now += 1;
    held.most = Math.max(held.most, held.now);
    setTimeout(() => {
      held.now -= 1;
      html("<p>held</p>")(req, res);
    }, 500);
  },
  "go.test/missing-image": html('<p>fine</p><img src="/missing.png">'),
  // Moves on a little after its slow image has loaded.
  "go.test/slow-image": html(
    '<img src="/slow.png"><script>onload = () => setTimeout(() => { location.href = "/next"; }, 600);</script>',
  ),
  "go.test/slow.png": (_req, res) => {
    setTimeout(() => res.end(), 700);
  },
  "go.test/huge": html(
    '<body><script>document.body.textContent = "x".repeat(2 * 1024 * 1024);</script></body>',
  ),
  "go.test/popup-pinger": script('window.open("/pinger"); location.href = "/landing";'),
  "go.test/pinger": script('setInterval(() => { fetch("/ping"); }, 50)'),
  "go.test/ping": (_req, res) => {
    res.end("pong");
  },
  "go.test/webrtc": script(
    () => `const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:${stunPort}" }] });
      pc.createDataChannel("x");
      pc.createOffer().then((offer) => pc.setLocalDescription(offer));`,
  ),
});
const held = { now: 0, most: 0 };
let stunPort = 0;

/** *.test is 127.0.0.1, and nothing else may be reached: as safeLookup treats a private address. */
const testLookup: LookupFunction = (hostname, options, callback) => {
  if (hostname.endsWith(".test") && hostname !== "inside.test") {
    fakeLookup(hostname, options, callback);
  } else {
    const error = new Error(`${hostname} is a private or reserved address`);
    callback(Object.assign(error, { code: "BLOCKED" }), "");
  }
};

const browser = createBrowserResolver({ lookup: testLookup, settleMs: 300 });
afterAll(async () => {
  await browser.close();
  await server.close();
});

function visit(
  path: string,
  { timeoutMs = 8000, maxNavigations = 20, signal = undefined as AbortSignal | undefined } = {},
) {
  const deadline = AbortSignal.timeout(timeoutMs);
  return browser.visit(new URL(at("go.test", path)), {
    signal: signal ? AbortSignal.any([deadline, signal]) : deadline,
    maxNavigations,
  });
}

const secretRequests = () => server.requests.filter((req) => req.url?.startsWith("/secret"));

describe("createBrowserResolver: following a page", { timeout: 20_000 }, () => {
  it("stays on a page that does not move, and returns what it shows", async () => {
    const result = await visit("/stay");
    expect(result).toMatchObject({
      ok: true,
      chain: [at("go.test", "/stay")],
      statusCode: 200,
      challenge: false,
    });
    expect(result.ok && result.html).toContain("just a page");
  });

  it.each([
    ["/js", "a script", [at("go.test", "/js"), at("go.test", "/next")]],
    ["/http", "an HTTP redirect", [at("go.test", "/http"), at("go.test", "/next")]],
    [
      "/fetch",
      "a destination fetched by a script",
      [at("go.test", "/fetch"), at("dest.test", "/")],
    ],
    [
      "/cookie",
      "a cookie set by a script, then a reload",
      [at("go.test", "/cookie"), at("go.test", "/cookie"), at("dest.test", "/")],
    ],
    ["/timer", "a timer", [at("go.test", "/timer"), at("go.test", "/next")]],
    [
      "/popup",
      "a page that opens a popup, which is closed",
      [at("go.test", "/popup"), at("go.test", "/landing")],
    ],
  ])("follows %s (%s)", async (path, _what, chain) => {
    expect(await visit(path)).toMatchObject({ ok: true, chain, statusCode: 200 });
  });

  it("takes a page that stays put for settleMs as arrived, even if a later timer would move it", async () => {
    expect(await visit("/late-timer")).toMatchObject({
      ok: true,
      chain: [at("go.test", "/late-timer")],
    });
  });

  it("ends at a file the page sends the browser to", async () => {
    expect(await visit("/download")).toEqual({
      ok: true,
      chain: [at("go.test", "/download"), at("go.test", "/file")],
      statusCode: 200,
      challenge: false,
      refresh: null,
      html: null,
    });
  });

  it("stays on the page when a navigation answers 204 No Content", async () => {
    expect(await visit("/to-empty")).toMatchObject({
      ok: true,
      chain: [at("go.test", "/to-empty")],
      statusCode: 200,
    });
  });

  it("stays on the page when the page stops its own navigation", async () => {
    expect(await visit("/stop")).toMatchObject({ ok: true, chain: [at("go.test", "/stop")] });
  });

  it("records a navigation to about:blank, which has no request", async () => {
    expect(await visit("/blank")).toMatchObject({
      ok: true,
      chain: [at("go.test", "/blank"), "about:blank"],
    });
  });

  it("stops at a human verification page", async () => {
    expect(await visit("/to-challenge")).toEqual({
      ok: true,
      chain: [at("go.test", "/to-challenge"), at("go.test", "/challenge")],
      statusCode: 403,
      challenge: true,
      refresh: null,
      html: null,
    });
  });

  it("stops after maxNavigations", async () => {
    const result = await visit("/loop-a", { maxNavigations: 3 });
    expect(result).toMatchObject({ ok: false, status: "ERROR", error: "More than 3 navigations" });
    expect(result.chain.slice(0, 4)).toEqual([
      at("go.test", "/loop-a"),
      at("go.test", "/loop-b"),
      at("go.test", "/loop-a"),
      at("go.test", "/loop-b"),
    ]);
  });
});

describe("createBrowserResolver: security", { timeout: 20_000 }, () => {
  it.each([
    ["/to-loopback", "127.0.0.1", `http://127.0.0.1:${server.port}/secret`],
    ["/to-localhost", "localhost", `http://localhost:${server.port}/secret`],
    ["/to-inside", "inside.test", at("inside.test", "/secret")],
  ])("refuses a navigation to %s (%s)", async (path, host, target) => {
    const before = secretRequests().length;
    expect(await visit(path)).toEqual({
      ok: false,
      status: "BLOCKED",
      error: `${host} is a private or reserved address`,
      chain: [at("go.test", path), target],
    });
    expect(secretRequests().length).toBe(before);
  });

  it("reaches nothing inside from a page's images, frames, fetches or WebSockets", async () => {
    const before = secretRequests().length;
    expect(await visit("/reach-inside")).toMatchObject({
      ok: true,
      chain: [at("go.test", "/reach-inside")],
    });
    expect(secretRequests().length).toBe(before);
  });

  it("refuses a name outside the policy", async () => {
    expect(await visit("/to-nowhere")).toMatchObject({
      ok: false,
      status: "BLOCKED",
      error: "nowhere.test.example is a private or reserved address",
    });
  });

  it("refuses an https:// navigation inside, on the default port", async () => {
    expect(await visit("/to-inside-https")).toEqual({
      ok: false,
      status: "BLOCKED",
      error: "inside.test is a private or reserved address",
      chain: [at("go.test", "/to-inside-https"), "https://inside.test/secret"],
    });
  });

  it("refuses a page that is inside itself", async () => {
    const before = secretRequests().length;
    const target = `http://127.0.0.1:${server.port}/secret`;
    expect(
      await browser.visit(new URL(target), {
        signal: AbortSignal.timeout(8000),
        maxNavigations: 5,
      }),
    ).toEqual({
      ok: false,
      status: "BLOCKED",
      error: "127.0.0.1 is a private or reserved address",
      chain: [target],
    });
    expect(secretRequests().length).toBe(before);
  });

  it("explains a navigation that fails after the proxy let it through", async () => {
    // TLS to the mock server, which only speaks plain HTTP.
    const result = await visit("/to-https");
    expect(result).toMatchObject({ ok: false, status: "ERROR" });
    expect(!result.ok && result.error).toMatch(/^Request failed \(net::ERR_[A-Z_]+\)$/);
  });

  it("starts every visit with no cookies", async () => {
    // The first visit set the cookie; a second one must not see it.
    await visit("/cookie");
    const second = await browser.visit(new URL(at("go.test", "/cookie")), {
      signal: AbortSignal.timeout(8000),
      maxNavigations: 1,
    });
    expect(second.chain.slice(0, 2)).toEqual([at("go.test", "/cookie"), at("go.test", "/cookie")]);
  });
});

describe("createBrowserResolver: time and turns", { timeout: 20_000 }, () => {
  it("gives up when the deadline passes", async () => {
    expect(await visit("/hang", { timeoutMs: 1500 })).toEqual({
      ok: false,
      status: "TIMEOUT",
      error: "Browser navigation timed out",
      chain: [at("go.test", "/hang"), at("go.test", "/never")],
    });
  });

  it("says so when the caller cancels", async () => {
    const cancel = new AbortController();
    const result = visit("/hang", { signal: cancel.signal });
    setTimeout(() => cancel.abort(), 300);
    expect(await result).toMatchObject({
      ok: false,
      status: "ERROR",
      error: "Request was cancelled",
    });
  });

  it("answers at once for a signal that has already aborted", async () => {
    expect(await visit("/stay", { signal: AbortSignal.abort() })).toMatchObject({
      ok: false,
      error: "Request was cancelled",
    });
  });

  it("lets visits wait for a free page, and leave the line when cancelled", async () => {
    const single = createBrowserResolver({ lookup: testLookup, settleMs: 300, maxPages: 1 });
    try {
      const signal = () => AbortSignal.timeout(8000);
      const first = single.visit(new URL(at("go.test", "/stay")), {
        signal: signal(),
        maxNavigations: 5,
      });
      const cancel = new AbortController();
      const leaving = single.visit(new URL(at("go.test", "/stay")), {
        signal: cancel.signal,
        maxNavigations: 5,
      });
      const third = single.visit(new URL(at("go.test", "/js")), {
        signal: signal(),
        maxNavigations: 5,
      });
      cancel.abort();
      expect(await leaving).toMatchObject({ ok: false, error: "Request was cancelled" });
      expect(await first).toMatchObject({ ok: true });
      expect(await third).toMatchObject({
        ok: true,
        chain: [at("go.test", "/js"), at("go.test", "/next")],
      });
    } finally {
      await single.close();
    }
  });

  it("starts the browser again after close()", async () => {
    await browser.close();
    expect(await visit("/stay")).toMatchObject({ ok: true });
  });

  it("explains a browser that cannot start", async () => {
    const broken = createBrowserResolver({ executablePath: "D:/no/such/chrome.exe" });
    const result = await broken.visit(new URL(at("go.test", "/stay")), {
      signal: AbortSignal.timeout(8000),
      maxNavigations: 5,
    });
    expect(result).toMatchObject({
      ok: false,
      status: "ERROR",
      error: "Chromium is not installed (in this repository: pnpm install-browser)",
    });
    await broken.close();
  });

  it("passes on any other launch error", async () => {
    // A file that exists but is no browser.
    const broken = createBrowserResolver({ executablePath: process.execPath });
    const result = await broken.visit(new URL(at("go.test", "/stay")), {
      signal: AbortSignal.timeout(8000),
      maxNavigations: 5,
    });
    expect(result).toMatchObject({ ok: false, status: "ERROR" });
    expect(!result.ok && result.error).toMatch(/^The browser failed \(/);
    await broken.close();
  });
});

describe("createBrowserResolver: what a visit reports", { timeout: 20_000 }, () => {
  it("keeps the #fragment of the page it ends on", async () => {
    expect(await visit("/to-hash")).toMatchObject({
      chain: [at("go.test", "/to-hash"), at("go.test", "/next#/item/42")],
    });
  });

  it("leaves out a link to an app that the browser could not open", async () => {
    expect(await visit("/deeplink")).toMatchObject({
      ok: true,
      chain: [at("go.test", "/deeplink"), at("go.test", "/landing")],
    });
  });

  it("starts with the cookies it is given", async () => {
    const result = await browser.visit(new URL(at("go.test", "/needs-session")), {
      signal: AbortSignal.timeout(8000),
      maxNavigations: 5,
      cookie: "sid=42; t=a=b",
    });
    expect(result).toMatchObject({
      ok: true,
      chain: [at("go.test", "/needs-session"), at("dest.test", "/")],
    });
  });

  it("stays on a 300 answer, which browsers do not follow", async () => {
    expect(await visit("/to-multi")).toMatchObject({
      ok: true,
      chain: [at("go.test", "/to-multi"), at("go.test", "/multi")],
      statusCode: 300,
    });
  });

  it("passes on the Refresh header of the page it ends on", async () => {
    expect(await visit("/to-refresh-header")).toMatchObject({
      ok: true,
      chain: [at("go.test", "/to-refresh-header"), at("go.test", "/refresh-header")],
      refresh: "5; url=/next",
    });
  });

  it("waits for the whole page before it counts as arrived", async () => {
    expect(await visit("/to-slow")).toMatchObject({
      ok: true,
      chain: [at("go.test", "/to-slow"), at("go.test", "/slow-body"), at("go.test", "/next")],
    });
  });

  it("takes the status of the page, not of a missing image on it", async () => {
    expect(await visit("/missing-image")).toMatchObject({ ok: true, statusCode: 200 });
  });

  it("allows exactly maxNavigations navigations", async () => {
    expect(await visit("/js", { maxNavigations: 1 })).toMatchObject({ ok: true });
  });

  it("waits again after the page's load event, which comes after its images", async () => {
    // The image comes 700 ms in and the page moves 600 ms after that: only a wait that starts
    // again at the load event is still going then.
    const patient = createBrowserResolver({ lookup: testLookup, settleMs: 1000 });
    try {
      const result = await patient.visit(new URL(at("go.test", "/slow-image")), {
        signal: AbortSignal.timeout(8000),
        maxNavigations: 5,
      });
      expect(result).toMatchObject({
        ok: true,
        chain: [at("go.test", "/slow-image"), at("go.test", "/next")],
      });
    } finally {
      await patient.close();
    }
  });

  it("returns at most MAX_HTML_SIZE characters of the page", async () => {
    const result = await visit("/huge");
    expect(result.ok && result.html?.length).toBe(MAX_HTML_SIZE);
  });
});

describe("createBrowserResolver: isolation", { timeout: 20_000 }, () => {
  it("starts Chromium sandboxed, and every page with its own proxy and nothing else", async () => {
    const launch = vi.spyOn(chromium, "launch");
    const own = createBrowserResolver({ lookup: testLookup, settleMs: 300 });
    try {
      await own.visit(new URL(at("go.test", "/stay")), {
        signal: AbortSignal.timeout(8000),
        maxNavigations: 5,
      });
      expect(launch).toHaveBeenCalledTimes(1);
      const options = launch.mock.calls[0]?.[0];
      expect(options).toMatchObject({
        chromiumSandbox: true,
        proxy: { server: "http://per-context" },
      });
      expect(options?.args).toEqual([
        "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      ]);
      const instance = (await launch.mock.results[0]?.value) as Browser;
      const newContext = vi.spyOn(instance, "newContext");
      await own.visit(new URL(at("go.test", "/stay")), {
        signal: AbortSignal.timeout(8000),
        maxNavigations: 5,
      });
      expect(newContext.mock.calls[0]?.[0]).toMatchObject({
        proxy: { bypass: "<-loopback>" },
        serviceWorkers: "block",
        acceptDownloads: false,
      });
    } finally {
      launch.mockRestore();
      await own.close();
    }
  });

  it("sends no WebRTC traffic over UDP, which would go around the proxy", async () => {
    const stun = createSocket("udp4");
    let packets = 0;
    stun.on("message", () => {
      packets += 1;
    });
    await new Promise<void>((resolve) => stun.bind(0, "127.0.0.1", resolve));
    stunPort = stun.address().port;
    try {
      expect(await visit("/webrtc")).toMatchObject({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(packets).toBe(0);
    } finally {
      stun.close();
    }
  });

  it("closes a popup before it can do anything", async () => {
    const pings = () => server.requests.filter((req) => req.url === "/ping").length;
    const before = pings();
    expect(await visit("/popup-pinger")).toMatchObject({
      chain: [at("go.test", "/popup-pinger"), at("go.test", "/landing")],
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pings()).toBe(before);
  });
});

describe("createBrowserResolver: the browser's life", { timeout: 30_000 }, () => {
  it("opens at most maxPages pages at once", async () => {
    const single = createBrowserResolver({ lookup: testLookup, settleMs: 100, maxPages: 1 });
    held.most = 0;
    try {
      const options = () => ({ signal: AbortSignal.timeout(10_000), maxNavigations: 5 });
      const url = new URL(at("go.test", "/held"));
      const results = await Promise.all([1, 2, 3].map(() => single.visit(url, options())));
      expect(results.map((result) => result.ok)).toEqual([true, true, true]);
      expect(held.most).toBe(1);
    } finally {
      await single.close();
    }
  });

  it("ends a visit at once when the browser closes under it", async () => {
    const own = createBrowserResolver({ lookup: testLookup, settleMs: 300 });
    try {
      const options = () => ({ signal: AbortSignal.timeout(8000), maxNavigations: 5 });
      await own.visit(new URL(at("go.test", "/stay")), options()); // Chromium is running now
      const started = performance.now();
      const result = own.visit(new URL(at("go.test", "/hang")), options());
      setTimeout(() => own.close(), 300);
      expect(await result).toMatchObject({
        ok: false,
        status: "ERROR",
        error: "The browser closed during the visit",
      });
      expect(performance.now() - started).toBeLessThan(4000);
    } finally {
      await own.close();
    }
  });

  it("starts Chromium again after it failed to start, or went away", async () => {
    const launch = vi.spyOn(chromium, "launch");
    launch.mockRejectedValueOnce(new Error("boom"));
    const own = createBrowserResolver({ lookup: testLookup, settleMs: 300 });
    try {
      const options = () => ({ signal: AbortSignal.timeout(8000), maxNavigations: 5 });
      const url = new URL(at("go.test", "/stay"));
      expect(await own.visit(url, options())).toMatchObject({
        ok: false,
        error: "The browser failed (boom)",
      });
      expect(await own.visit(url, options())).toMatchObject({ ok: true });
      const instance = (await launch.mock.results[1]?.value) as Browser;
      await instance.close(); // as if it had crashed
      expect(await own.visit(url, options())).toMatchObject({ ok: true });
      expect(launch).toHaveBeenCalledTimes(3);
    } finally {
      launch.mockRestore();
      await own.close();
    }
  });

  it("leaves no page behind when visits are cancelled while they start", async () => {
    const launch = vi.spyOn(chromium, "launch");
    const own = createBrowserResolver({ lookup: testLookup, settleMs: 300, maxPages: 50 });
    try {
      const url = new URL(at("go.test", "/stay"));
      await own.visit(url, { signal: AbortSignal.timeout(8000), maxNavigations: 5 });
      const visits = Array.from({ length: 20 }, (_, i) =>
        own.visit(url, { signal: AbortSignal.timeout(i * 2 + 1), maxNavigations: 5 }),
      );
      await Promise.all(visits);
      const instance = (await launch.mock.results[0]?.value) as Browser;
      await vi.waitFor(() => expect(instance.contexts()).toHaveLength(0));
    } finally {
      launch.mockRestore();
      await own.close();
    }
  });

  it("closes the visit's proxy when the visit ends", async () => {
    const servers = () =>
      process.getActiveResourcesInfo().filter((name) => name === "TCPServerWrap").length;
    const before = servers();
    expect(await visit("/stay")).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(servers()).toBe(before));
  });

  it("gives the turn of a visit that stopped waiting for it to the next one", async () => {
    const single = createBrowserResolver({ lookup: testLookup, settleMs: 100, maxPages: 1 });
    const url = new URL(at("go.test", "/held"));
    const options = (ms: number) => ({ signal: AbortSignal.timeout(ms), maxNavigations: 5 });
    try {
      const first = single.visit(url, options(10_000));
      expect(await single.visit(url, options(100))).toMatchObject({ ok: false, status: "TIMEOUT" });
      expect(await first).toMatchObject({ ok: true });
      expect(await single.visit(url, options(5000))).toMatchObject({ ok: true });
    } finally {
      await single.close();
    }
  });
});
