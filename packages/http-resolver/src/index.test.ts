import { once } from "node:events";
import http from "node:http";
import https from "node:https";
import net, { type LookupFunction } from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { afterAll, describe, expect, it, vi } from "vitest";
import { fakeLookup, type Route, startMockServer } from "../../../tests/fixtures/mock-server.ts";
import { type HopResult, MAX_HTML_SIZE, requestHop } from "./index.ts";

const REDIRECTS = [301, 302, 303, 307, 308];

const redirect =
  (status: number, location = "/go/abc"): Route =>
  (_req, res) => {
    res.writeHead(status, { location }).end();
  };

const page =
  (contentType: string, body: string | Buffer, headers = {}, status = 200): Route =>
  (_req, res) => {
    res.writeHead(status, { "content-type": contentType, ...headers }).end(body);
  };

/** Writes raw bytes, for responses Node's ServerResponse refuses to produce. */
const rawResponse =
  (text: string): Route =>
  (_req, res) => {
    res.socket?.end(text);
  };

let endlessBodyClosed = Promise.resolve();

const server = await startMockServer({
  ...Object.fromEntries(REDIRECTS.map((s) => [`short.test/r${s}`, redirect(s)])),
  "short.test/ok": (_req, res) => {
    res.end("ok");
  },
  "short.test/p?q=1": (_req, res) => {
    res.end("ok");
  },
  "short.test/s200": redirect(200),
  "short.test/s201": redirect(201),
  "short.test/s300": redirect(300),
  "short.test/no-location": (_req, res) => {
    res.writeHead(302).end();
  },
  "short.test/cookies": (_req, res) => {
    res.writeHead(302, { location: "/next", "set-cookie": ["a=1; Path=/", "b=2; HttpOnly"] }).end();
  },
  "short.test/challenge": (_req, res) => {
    res.writeHead(403, { "cf-mitigated": "challenge" }).end();
  },
  "short.test/challenge-redirect": (_req, res) => {
    res.writeHead(302, { "cf-mitigated": "challenge", location: "/elsewhere" }).end();
  },
  "short.test/not-a-challenge": (_req, res) => {
    res.writeHead(403, { "cf-mitigated": "block" }).end();
  },
  "short.test/html": page("text/html; charset=utf-8", "<p>café</p>"),
  "short.test/xhtml": page("application/xhtml+xml", "<p>x</p>"),
  "short.test/latin1": page("text/html; charset=iso-8859-1", Buffer.from("<p>café</p>", "latin1")),
  "short.test/unknown-charset": page("text/html; charset=no-such-charset", "<p>café</p>"),
  "short.test/plain": page("text/plain", "<p>not html</p>"),
  "short.test/compressed": page("text/html", "\x1f\x8b not really gzip", {
    "content-encoding": "gzip",
  }),
  "short.test/error-page": page("text/html", "<p>gone</p>", {}, 404),
  "short.test/redirect-with-page": page("text/html", "<p>moved</p>", { location: "/next" }, 302),
  "short.test/refresh": (_req, res) => {
    // The UTF-8 bytes of "/café", which Node writes and reads back as latin1.
    const url = Buffer.from("/café", "utf8").toString("latin1");
    res.writeHead(200, { refresh: `0; url=${url}` }).end();
  },
  "short.test/huge-page": (_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.write("x".repeat(3 * MAX_HTML_SIZE)); // and never ends
  },
  "short.test/stalled-page": (_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.write("<p>first part"); // and never ends
  },
  // Promises 5000 bytes, sends 7 and closes the connection.
  "short.test/cut-page": rawResponse(
    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5000\r\n\r\n<p>part",
  ),
  // The UTF-8 bytes of "/café", which Node writes and reads back as latin1.
  "short.test/utf8": redirect(302, Buffer.from("/café", "utf8").toString("latin1")),
  "short.test/endless": (_req, res) => {
    endlessBodyClosed = new Promise((resolve) => res.on("close", () => resolve()));
    res.writeHead(200);
    res.write("x");
  },
  "short.test/hang": () => {
    // never answers
  },
  "short.test/upgrade": rawResponse(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
  ),
  "short.test/bare101": rawResponse("HTTP/1.1 101 Switching Protocols\r\n\r\n"),
  "short.test/two-locations": rawResponse(
    "HTTP/1.1 302 Found\r\nLocation: /a\r\nLocation: /b\r\nContent-Length: 0\r\n\r\n",
  ),
  "short.test/same-locations": rawResponse(
    "HTTP/1.1 302 Found\r\nLocation: /a\r\nLocation: /a\r\nContent-Length: 0\r\n\r\n",
  ),
  "short.test/big-header": (_req, res) => {
    res.setHeader("x-big", "a".repeat(20_000));
    res.end();
  },
  "short.test/bad-header": rawResponse(
    "HTTP/1.1 200 OK\r\nX-Bad: a\x01b\r\nContent-Length: 0\r\n\r\n",
  ),
  "127.0.0.1/ip": (_req, res) => {
    res.end("ok");
  },
});
afterAll(() => server.close());

function hop(
  url: URL | string,
  lookup: LookupFunction = fakeLookup,
  signal: AbortSignal = AbortSignal.timeout(2000),
) {
  return requestHop(typeof url === "string" ? new URL(url) : url, {
    lookup,
    signal,
  });
}

/** What requestHop returns when the server answered. */
const answered = (statusCode: number, fields: Partial<Extract<HopResult, { ok: true }>> = {}) => ({
  ok: true,
  statusCode,
  location: null,
  setCookies: [],
  challenge: false,
  refresh: null,
  html: null,
  ...fields,
});

/** A security policy that refuses every name, the way the safe lookup refuses private addresses. */
const refuse: LookupFunction = (hostname, _options, callback) => {
  callback(Object.assign(new Error(`${hostname} is not allowed`), { code: "BLOCKED" }), "");
};

/** A DNS server that never answers. */
const silent: LookupFunction = () => {
  // never calls back
};

/**
 * Pretends a preloaded tool replaced the agent's connection code: `dial` reaches 127.0.0.1 by itself
 * and the lookup (which would have answered 203.0.113.7) is never asked. Returns the hop result and
 * the number of bytes the listening side received.
 */
async function hijackedHop(
  scheme: "http" | "https",
  agent: http.Agent,
  dial: (port: number) => Promise<Duplex>,
) {
  let bytes = 0;
  const serverSideClosed = Promise.withResolvers<void>();
  const listener = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      bytes += chunk.length;
    });
    socket.on("close", () => serverSideClosed.resolve());
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const { port } = listener.address() as net.AddressInfo;
  const socket = await dial(port);
  const spy = vi.spyOn(agent, "createConnection").mockImplementation(() => socket);
  const answer: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address: "203.0.113.7", family: 4 }]);
    else callback(null, "203.0.113.7", 4);
  };
  try {
    const result = await hop(`${scheme}://short.test:${port}/`, answer);
    await serverSideClosed.promise;
    return { result, bytes };
  } finally {
    spy.mockRestore();
    listener.close();
  }
}

const HIJACK_BLOCKED = {
  result: { ok: false, status: "BLOCKED", error: "Connected to an address that was not checked" },
  bytes: 0,
};

describe("requestHop: redirects", () => {
  it.each(REDIRECTS)("returns the Location of a %i without following it", async (status) => {
    const before = server.requests.length;
    expect(await hop(server.url("short.test", `/r${status}`))).toEqual(
      answered(status, { location: "/go/abc" }),
    );
    expect(server.requests.slice(before).map((req) => req.url)).toEqual([`/r${status}`]);
  });

  it.each([200, 201, 300])("ignores a Location header on a %i", async (status) => {
    expect(await hop(server.url("short.test", `/s${status}`))).toEqual(answered(status));
  });

  it("returns null for a redirect without a Location header", async () => {
    expect(await hop(server.url("short.test", "/no-location"))).toEqual(answered(302));
  });

  it("decodes a UTF-8 Location the way browsers do", async () => {
    expect(await hop(server.url("short.test", "/utf8"))).toEqual(
      answered(302, { location: "/café" }),
    );
  });

  it("refuses a redirect that names two different targets", async () => {
    expect(await hop(server.url("short.test", "/two-locations"))).toEqual({
      ok: false,
      status: "ERROR",
      error: "Response has more than one Location header",
    });
  });

  it("accepts a repeated identical Location header", async () => {
    expect(await hop(server.url("short.test", "/same-locations"))).toEqual(
      answered(302, { location: "/a" }),
    );
  });
});

describe("requestHop: the request itself", () => {
  it("stops after the headers when the body is not HTML, even if it never ends", async () => {
    expect(await hop(server.url("short.test", "/endless"))).toEqual(answered(200));
    await endlessBodyClosed; // resolves only once the server sees the connection close
  });

  it("sends a plain GET with only the expected headers and no fragment", async () => {
    await hop(server.url("short.test", "/p?q=1#frag"));
    const req = server.requests.at(-1);
    expect(req?.method).toBe("GET");
    expect(req?.url).toBe("/p?q=1");
    expect(Object.keys(req?.headers ?? {}).sort()).toEqual([
      "accept",
      "accept-encoding",
      "connection",
      "host",
      "user-agent",
    ]);
    expect(req?.headers["accept-encoding"]).toBe("identity");
    expect(req?.headers["user-agent"]).toMatch(/^urlresolve /);
    expect(req?.headers.connection).toBe("close");
  });

  it("returns every Set-Cookie header", async () => {
    expect(await hop(server.url("short.test", "/cookies"))).toEqual(
      answered(302, { location: "/next", setCookies: ["a=1; Path=/", "b=2; HttpOnly"] }),
    );
  });

  it.each([
    ["/challenge", 403, null, true],
    ["/challenge-redirect", 302, "/elsewhere", true],
    ["/not-a-challenge", 403, null, false],
  ])("reports a Cloudflare challenge on %s", async (path, status, location, challenge) => {
    expect(await hop(server.url("short.test", path))).toEqual(
      answered(status, { location, challenge }),
    );
  });

  it("sends the Cookie header it is given", async () => {
    const signal = AbortSignal.timeout(2000);
    const url = server.url("short.test", "/ok");
    expect(await requestHop(url, { lookup: fakeLookup, signal, cookie: "a=1; b=2" })).toEqual(
      answered(200),
    );
    expect(server.requests.at(-1)?.headers.cookie).toBe("a=1; b=2");
  });

  it("works when Node asks the lookup for a single address (Happy Eyeballs off)", async () => {
    const lookup = vi.fn(fakeLookup);
    net.setDefaultAutoSelectFamily(false);
    try {
      expect(await hop(server.url("short.test", "/ok"), lookup)).toEqual(answered(200));
    } finally {
      net.setDefaultAutoSelectFamily(true);
    }
    expect(lookup.mock.calls[0]?.[1]).not.toHaveProperty("all", true);
  });
});

describe("requestHop: reading the page", () => {
  it.each([
    ["/html", "<p>café</p>"],
    ["/xhtml", "<p>x</p>"],
    ["/latin1", "<p>café</p>"],
    ["/unknown-charset", "<p>café</p>"], // falls back to UTF-8
  ])("reads the HTML of %s", async (path, html) => {
    expect(await hop(server.url("short.test", path))).toEqual(answered(200, { html }));
  });

  it("reads the HTML of an error page too", async () => {
    expect(await hop(server.url("short.test", "/error-page"))).toEqual(
      answered(404, { html: "<p>gone</p>" }),
    );
  });

  it.each(["/plain", "/compressed"])("does not read %s, which is not plain HTML", async (path) => {
    expect(await hop(server.url("short.test", path))).toEqual(answered(200));
  });

  it("does not read the page of a redirect", async () => {
    expect(await hop(server.url("short.test", "/redirect-with-page"))).toEqual(
      answered(302, { location: "/next" }),
    );
  });

  it("returns the Refresh header, decoded like a Location", async () => {
    expect(await hop(server.url("short.test", "/refresh"))).toEqual(
      answered(200, { refresh: "0; url=/café" }),
    );
  });

  it("stops reading a page at MAX_HTML_SIZE", async () => {
    const result = await hop(server.url("short.test", "/huge-page"));
    expect(result.ok && result.html?.length).toBe(MAX_HTML_SIZE);
  });

  it("times out on a page that never finishes", async () => {
    const signal = AbortSignal.timeout(200);
    expect(await hop(server.url("short.test", "/stalled-page"), fakeLookup, signal)).toEqual({
      ok: false,
      status: "TIMEOUT",
      error: "Request timed out",
    });
  });

  it("keeps the part of a page that arrived before the connection closed", async () => {
    expect(await hop(server.url("short.test", "/cut-page"))).toEqual(
      answered(200, { html: "<p>part" }),
    );
  });
});

describe("requestHop: security", () => {
  it("connects only through the lookup it was given", async () => {
    const lookup = vi.fn(fakeLookup);
    expect(await hop(server.url("short.test", "/ok"), lookup)).toEqual(answered(200));
    // .test names never resolve in real DNS, so this request can only have used the fake answer.
    expect(lookup).toHaveBeenCalledWith("short.test", expect.anything(), expect.any(Function));
  });

  it.each(["127.0.0.1", "0x7f.1"])("passes the IP literal %s through the lookup", async (host) => {
    const lookup = vi.fn(fakeLookup);
    expect(await hop(`http://${host}:${server.port}/ip`, lookup)).toEqual(answered(200));
    expect(lookup).toHaveBeenCalledWith("127.0.0.1", expect.anything(), expect.any(Function));
  });

  it("refuses an IPv6 literal when the lookup says no", async () => {
    const lookup = vi.fn(refuse);
    const before = server.requests.length;
    expect(await hop(`http://[::1]:${server.port}/ip`, lookup)).toEqual({
      ok: false,
      status: "BLOCKED",
      error: "::1 is not allowed",
    });
    expect(lookup).toHaveBeenCalledWith("::1", expect.anything(), expect.any(Function));
    expect(server.requests.length).toBe(before);
  });

  it("returns the lookup's refusal for a hostname, and sends nothing", async () => {
    const before = server.requests.length;
    expect(await hop(server.url("short.test", "/ok"), refuse)).toEqual({
      ok: false,
      status: "BLOCKED",
      error: "short.test is not allowed",
    });
    expect(server.requests.length).toBe(before);
  });

  it("refuses a URL with a username or password before any network activity", async () => {
    const lookup = vi.fn(fakeLookup);
    const url = server.url("short.test", "/ok");
    url.username = "u";
    url.password = "secret";
    const before = server.requests.length;
    expect(await hop(url, lookup)).toEqual({
      ok: false,
      status: "BLOCKED",
      error: "Refusing to send a username or password",
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(server.requests.length).toBe(before);
  });

  it("refuses a non-http URL", async () => {
    const lookup = vi.fn(fakeLookup);
    expect(await hop("ftp://short.test/x", lookup)).toEqual({
      ok: false,
      status: "BLOCKED",
      error: 'Refusing to request a "ftp:" URL',
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(["25", "0"])("refuses port %s, which browsers block too", async (port) => {
    const lookup = vi.fn(fakeLookup);
    expect(await hop(`http://short.test:${port}/`, lookup)).toEqual({
      ok: false,
      status: "BLOCKED",
      error: `Port ${port} is not allowed`,
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("lets the default port through to the lookup", async () => {
    expect(await hop("http://short.test/", refuse)).toEqual({
      ok: false,
      status: "BLOCKED",
      error: "short.test is not allowed",
    });
  });

  it("cuts an http connection to an address the lookup never handed out", async () => {
    const dial = async (port: number) => net.createConnection({ host: "127.0.0.1", port });
    expect(await hijackedHop("http", http.Agent.prototype, dial)).toEqual(HIJACK_BLOCKED);
  });

  // Real TLS: with `once` instead of `prependOnceListener`, the ClientHello (1.5 KB) would get out.
  it("cuts an https connection before the TLS handshake starts", async () => {
    const dial = async (port: number) =>
      tls.connect({ host: "127.0.0.1", port, servername: "short.test" });
    expect(await hijackedHop("https", https.Agent.prototype, dial)).toEqual(HIJACK_BLOCKED);
  });

  // A pooled or tunnelled socket is already connected, so it never emits "connect".
  it("cuts a socket that arrives already connected", async () => {
    const dial = async (port: number) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      await once(socket, "connect");
      return socket;
    };
    expect(await hijackedHop("http", http.Agent.prototype, dial)).toEqual(HIJACK_BLOCKED);
  });
});

describe("requestHop: timeouts and failures", () => {
  it("times out when the server never answers", async () => {
    const signal = AbortSignal.timeout(100);
    expect(await hop(server.url("short.test", "/hang"), fakeLookup, signal)).toEqual({
      ok: false,
      status: "TIMEOUT",
      error: "Request timed out",
    });
  });

  it.each(["short.test", "127.0.0.1"])(
    "times out when the lookup never answers for %s",
    async (host) => {
      const signal = AbortSignal.timeout(100);
      expect(await hop(`http://${host}:${server.port}/ok`, silent, signal)).toEqual({
        ok: false,
        status: "TIMEOUT",
        error: "Request timed out",
      });
    },
  );

  it.each(["short.test", "127.0.0.1"])("reports a cancelled request for %s", async (host) => {
    const controller = new AbortController();
    controller.abort();
    expect(await hop(`http://${host}:${server.port}/ok`, fakeLookup, controller.signal)).toEqual({
      ok: false,
      status: "ERROR",
      error: "Request was cancelled",
    });
  });

  it.each([
    // The shape c-ares (dns.Resolver) uses for a DNS timeout: ETIMEOUT, without the D.
    ["queryA ETIMEOUT short.test", "ETIMEOUT", "DNS lookup timed out"],
    // The operating system giving up on a TCP connection.
    ["connect ETIMEDOUT 203.0.113.7:80", "ETIMEDOUT", "Connection timed out"],
  ])("maps %s to TIMEOUT", async (message, code, error) => {
    const lookup: LookupFunction = (_hostname, _options, callback) => {
      callback(Object.assign(new Error(message), { code }), "");
    };
    expect(await hop(server.url("short.test", "/ok"), lookup)).toEqual({
      ok: false,
      status: "TIMEOUT",
      error,
    });
  });

  // Real DNS answers asynchronously; an empty answer used to crash Node inside node:net.
  it.each([true, false])(
    "treats an answer without addresses as not found (Happy Eyeballs on: %s)",
    async (happyEyeballs) => {
      const empty: LookupFunction = (_hostname, options, callback) => {
        setImmediate(() => callback(null, options.all ? [] : ""));
      };
      net.setDefaultAutoSelectFamily(happyEyeballs);
      try {
        expect(await hop(server.url("short.test", "/ok"), empty)).toEqual({
          ok: false,
          status: "ERROR",
          error: "Request failed (ENOTFOUND)",
        });
      } finally {
        net.setDefaultAutoSelectFamily(true);
      }
    },
  );

  it("reports a name that does not resolve", async () => {
    expect(await hop("http://nowhere.example/")).toEqual({
      ok: false,
      status: "ERROR",
      error: "Request failed (ENOTFOUND)",
    });
  });

  it("reports an error without a code as UNKNOWN", async () => {
    const lookup: LookupFunction = (_hostname, _options, callback) => {
      callback(new Error("broken lookup"), "");
    };
    expect(await hop(server.url("short.test", "/ok"), lookup)).toEqual({
      ok: false,
      status: "ERROR",
      error: "Request failed (UNKNOWN)",
    });
  });

  it("reports a closed port", async () => {
    const gone = await startMockServer({});
    await gone.close();
    expect(await hop(`http://short.test:${gone.port}/`)).toEqual({
      ok: false,
      status: "ERROR",
      error: "Request failed (ECONNREFUSED)",
    });
  });

  it("reports TLS spoken to a plain-HTTP port as an error", async () => {
    const lookup = vi.fn(fakeLookup);
    const result = await hop(`https://short.test:${server.port}/ok`, lookup);
    expect(result).toMatchObject({ ok: false, status: "ERROR" });
    expect(!result.ok && result.error).toMatch(/^Request failed \(\w+\)$/);
    expect(lookup).toHaveBeenCalledWith("short.test", expect.anything(), expect.any(Function));
  });

  it("does not hang on a 101 upgrade", async () => {
    const started = performance.now();
    expect(await hop(server.url("short.test", "/upgrade"))).toEqual({
      ok: false,
      status: "ERROR",
      error: "Request failed (ECONNRESET)",
    });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("returns a bare 101 without upgrade headers as a normal status", async () => {
    expect(await hop(server.url("short.test", "/bare101"))).toEqual(answered(101));
  });

  it("rejects oversized response headers", async () => {
    expect(await hop(server.url("short.test", "/big-header"))).toEqual({
      ok: false,
      status: "ERROR",
      error: "Request failed (HPE_HEADER_OVERFLOW)",
    });
  });

  it("rejects malformed response headers", async () => {
    expect(await hop(server.url("short.test", "/bad-header"))).toEqual({
      ok: false,
      status: "ERROR",
      error: "Request failed (HPE_INVALID_HEADER_TOKEN)",
    });
  });
});
