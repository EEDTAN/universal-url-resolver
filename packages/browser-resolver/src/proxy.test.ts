import { once } from "node:events";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import net, { type LookupFunction } from "node:net";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { fakeLookup, startMockServer } from "../../../tests/fixtures/mock-server.ts";
import { startVisitProxy, type VisitProxy } from "./proxy.ts";

const server = await startMockServer({
  "a.test/page?x=1": (req, res) => {
    res.writeHead(200, {
      "content-type": "text/plain",
      "x-seen-proxy-auth": String(!!req.headers["proxy-authorization"]),
    });
    res.end("hello");
  },
  "a.test/redirect": (_req, res) => {
    res.writeHead(302, { location: "http://b.test/next" }).end();
  },
  "a.test/cookies": (_req, res) => {
    res
      .writeHead(200, [
        ["set-cookie", "a=1"],
        ["set-cookie", "b=2"],
      ])
      .end();
  },
  "a.test/form": (req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => res.end(`got ${req.method} ${body}`));
  },
  "a.test/big": (_req, res) => {
    res.end(Buffer.alloc(3 * 2 ** 20)); // 3 MiB
  },
  "a.test/sink": (req, res) => {
    req.resume();
    req.on("end", () => res.end("ok"));
  },
  "a.test/slow": () => {}, // never answers
  "a.test/reset": (req) => {
    req.socket.destroy(); // hangs up without an answer
  },
});
afterAll(() => server.close());

const proxies: VisitProxy[] = [];
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
  vi.restoreAllMocks();
});

const lookups: string[] = [];
/** fakeLookup, but every name listed is refused the way safeLookup refuses one. */
function refusing(...names: string[]): LookupFunction {
  return (hostname, options, callback) => {
    lookups.push(hostname);
    if (names.includes(hostname)) {
      const error = new Error(`${hostname} resolves to a private or reserved address`);
      callback(Object.assign(error, { code: "BLOCKED" }), "");
    } else {
      fakeLookup(hostname, options, callback);
    }
  };
}

async function proxy(options: Partial<Parameters<typeof startVisitProxy>[0]> = {}) {
  lookups.length = 0;
  const started = await startVisitProxy({ lookup: refusing(), ...options });
  proxies.push(started);
  return { ...started, port: Number(new URL(started.server).port) };
}

/** A plain HTTP request to the proxy, written the way a browser writes one (a full URL). */
function viaProxy(
  port: number,
  target: string,
  {
    method = "GET",
    headers = {},
    body,
  }: { method?: string; headers?: Record<string, string>; body?: string } = {},
) {
  return new Promise<
    | { status: number; headers: http.IncomingHttpHeaders; rawHeaders: string[]; body: string }
    | { error: string }
  >((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: target,
        headers: { host: new URL(target).host, ...headers },
        agent: false,
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            rawHeaders: res.rawHeaders,
            body: text,
          }),
        );
        res.on("error", (error) => resolve({ error: error.message }));
      },
    );
    req.on("error", (error: NodeJS.ErrnoException) =>
      resolve({ error: error.code ?? error.message }),
    );
    req.end(body);
  });
}

/** A CONNECT tunnel through the proxy; resolves with the proxy's status and the open socket. */
function tunnel(port: number, authority: string) {
  return new Promise<{ status: number; socket: net.Socket }>((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method: "CONNECT",
      path: authority,
      agent: false,
    });
    req.on("connect", (res, socket) => resolve({ status: res.statusCode ?? 0, socket }));
    req.on("response", (res) =>
      resolve({ status: res.statusCode ?? 0, socket: res.socket as net.Socket }),
    );
    req.on("error", reject);
    req.end();
  });
}

/** A plain TCP server on 127.0.0.1 that hands each connection to `onConnection`. */
async function rawServer(onConnection: (socket: net.Socket) => void) {
  const raw = net.createServer((socket) => {
    socket.on("error", () => {});
    onConnection(socket);
  });
  await new Promise<void>((resolve) => raw.listen(0, "127.0.0.1", resolve));
  return {
    port: (raw.address() as net.AddressInfo).port,
    close: () => new Promise<void>((resolve) => raw.close(() => resolve())),
  };
}

/** Sends an HTTP request over an open tunnel and returns the raw answer. */
async function throughTunnel(socket: net.Socket, host: string, path: string) {
  socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  let text = "";
  socket.on("data", (chunk) => {
    text += chunk;
  });
  await once(socket, "end");
  return text;
}

describe("startVisitProxy: plain HTTP", () => {
  it("forwards a request to the address the lookup gave, path and query included", async () => {
    const { port } = await proxy();
    const answer = await viaProxy(port, server.url("a.test", "/page?x=1").href);
    expect(answer).toMatchObject({ status: 200, body: "hello" });
    expect(lookups).toEqual(["a.test"]);
  });

  it("passes a redirect back to the browser instead of following it", async () => {
    const { port } = await proxy();
    const answer = await viaProxy(port, server.url("a.test", "/redirect").href);
    expect(answer).toMatchObject({ status: 302, headers: { location: "http://b.test/next" } });
    expect(server.requests.some((req) => req.headers.host?.startsWith("b.test"))).toBe(false);
  });

  it("keeps repeated headers such as Set-Cookie", async () => {
    const { port } = await proxy();
    const answer = await viaProxy(port, server.url("a.test", "/cookies").href);
    expect(answer).toMatchObject({ headers: { "set-cookie": ["a=1", "b=2"] } });
  });

  it("sends a request body on and keeps the method", async () => {
    const { port } = await proxy();
    const answer = await viaProxy(port, server.url("a.test", "/form").href, {
      method: "POST",
      body: "k=v",
    });
    expect(answer).toMatchObject({ status: 200, body: "got POST k=v" });
  });

  it("does not pass the proxy's own headers on", async () => {
    const { port } = await proxy();
    const answer = await viaProxy(port, server.url("a.test", "/page?x=1").href, {
      headers: { "proxy-authorization": "Basic czNjcjN0", "proxy-connection": "keep-alive" },
    });
    expect(answer).toMatchObject({ headers: { "x-seen-proxy-auth": "false" } });
  });

  it("refuses a host the lookup refuses, sends nothing and records why", async () => {
    const { port, problems } = await proxy({ lookup: refusing("inside.test") });
    const before = server.requests.length;
    expect(await viaProxy(port, server.url("inside.test", "/page?x=1").href)).toEqual({
      error: "ECONNRESET",
    });
    expect(server.requests.length).toBe(before);
    expect(problems.get(`inside.test:${server.port}`)).toEqual({
      status: "BLOCKED",
      error: "inside.test resolves to a private or reserved address",
    });
  });

  it("records other lookup failures as errors", async () => {
    const { port, problems } = await proxy();
    expect(await viaProxy(port, "http://nowhere.example/")).toEqual({ error: "ECONNRESET" });
    expect(problems.get("nowhere.example:80")).toEqual({
      status: "ERROR",
      error: "Request failed (ENOTFOUND)",
    });
  });

  it("refuses a port browsers refuse, without a lookup", async () => {
    const { port, problems } = await proxy();
    await viaProxy(port, "http://a.test:25/");
    expect(problems.get("a.test:25")).toEqual({
      status: "BLOCKED",
      error: "Port 25 is not allowed",
    });
    expect(lookups).toEqual([]);
  });

  it.each([
    ["/page", "a path without a host"],
    ["https://a.test/page", "an https:// URL, which comes through CONNECT instead"],
  ])("answers 400 to %s (%s)", async (target) => {
    const { port } = await proxy();
    const answer = await new Promise<number>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, path: target, agent: false }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.end();
    });
    expect(answer).toBe(400);
  });

  it("refuses an Upgrade on a plain request", async () => {
    const { port } = await proxy();
    const answer = await viaProxy(port, server.url("a.test", "/page?x=1").href, {
      headers: { connection: "upgrade", upgrade: "websocket" },
    });
    expect(answer).toEqual({ error: "ECONNRESET" });
  });

  it("hangs up on the browser when the server hangs up", async () => {
    const { port } = await proxy();
    expect(await viaProxy(port, server.url("a.test", "/reset").href)).toEqual({
      error: "ECONNRESET",
    });
  });

  it("closes a connection that does not speak HTTP", async () => {
    const { port } = await proxy();
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.on("error", () => {});
    socket.write("not http at all\r\n\r\n");
    await new Promise((resolve) => socket.on("close", resolve));
    expect(socket.destroyed).toBe(true);
  });

  it("answers an empty lookup result as ENOTFOUND", async () => {
    const empty: LookupFunction = (_hostname, _options, callback) => callback(null, []);
    const { port, problems } = await proxy({ lookup: empty });
    await viaProxy(port, server.url("a.test", "/page?x=1").href);
    expect(problems.get(`a.test:${server.port}`)).toEqual({
      status: "ERROR",
      error: "Request failed (ENOTFOUND)",
    });
  });
});

describe("startVisitProxy: CONNECT tunnels", () => {
  it("opens a tunnel to the address the lookup gave", async () => {
    const { port } = await proxy();
    const { status, socket } = await tunnel(port, `a.test:${server.port}`);
    expect(status).toBe(200);
    expect(await throughTunnel(socket, "a.test", "/page?x=1")).toMatch(
      /^HTTP\/1\.1 200 OK[\s\S]*hello/,
    );
  });

  it("refuses a host the lookup refuses with 403 and records why", async () => {
    const { port, problems } = await proxy({ lookup: refusing("inside.test") });
    const { status } = await tunnel(port, `inside.test:${server.port}`);
    expect(status).toBe(403);
    expect(problems.get(`inside.test:${server.port}`)?.status).toBe("BLOCKED");
  });

  it("answers 502 when the host cannot be reached", async () => {
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const closedPort = (closed.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const { port, problems } = await proxy();
    const { status } = await tunnel(port, `a.test:${closedPort}`);
    expect(status).toBe(502);
    expect(problems.get(`a.test:${closedPort}`)).toEqual({
      status: "ERROR",
      error: "Request failed (ECONNREFUSED)",
    });
  });

  it("tries the next address when the first one does not answer", async () => {
    // 127.0.0.2 is loopback too, but the mock server only listens on 127.0.0.1.
    const twoAddresses: LookupFunction = (_hostname, _options, callback) =>
      callback(null, [
        { address: "127.0.0.2", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]);
    const { port } = await proxy({ lookup: twoAddresses });
    const { status, socket } = await tunnel(port, `a.test:${server.port}`);
    expect(status).toBe(200);
    expect(await throughTunnel(socket, "a.test", "/page?x=1")).toContain("hello");
  });

  it.each(["a.test", "a.test:0", "a.test:70000", "a.test:443/path", "[::1", "user@a.test:443"])(
    "answers 400 to the authority %j",
    async (authority) => {
      const { port } = await proxy();
      expect((await tunnel(port, authority)).status).toBe(400);
    },
  );

  it("passes an IPv6 address to the lookup without its brackets", async () => {
    const { port, problems } = await proxy({ lookup: refusing("::1") });
    expect((await tunnel(port, "[::1]:443")).status).toBe(403);
    expect(lookups).toEqual(["::1"]);
    expect(problems.has("[::1]:443")).toBe(true);
  });

  it("asks the lookup again for every connection, so a changed answer is caught", async () => {
    let calls = 0;
    // The rebinding trick: a harmless answer first, a private address later.
    const rebinding: LookupFunction = (hostname, options, callback) => {
      calls += 1;
      if (calls === 1) fakeLookup(hostname, options, callback);
      else
        callback(
          Object.assign(new Error("rebind.test resolves to a private or reserved address"), {
            code: "BLOCKED",
          }),
          "",
        );
    };
    const { port } = await proxy({ lookup: rebinding });
    expect((await tunnel(port, `rebind.test:${server.port}`)).status).toBe(200);
    expect((await tunnel(port, `rebind.test:${server.port}`)).status).toBe(403);
    expect(calls).toBe(2);
  });

  it("never connects to an address the lookup did not give", async () => {
    // Something that replaced net.connect sends the connection to 127.0.0.1 instead of 127.0.0.3.
    const realConnect = net.connect;
    vi.spyOn(net, "connect").mockImplementation(((options: net.NetConnectOpts) =>
      realConnect({
        ...(options as net.TcpNetConnectOpts),
        host: "127.0.0.1",
      })) as typeof net.connect);
    syncBuiltinESMExports();
    const elsewhere: LookupFunction = (_hostname, _options, callback) =>
      callback(null, [{ address: "127.0.0.3", family: 4 }]);
    const { port, problems } = await proxy({ lookup: elsewhere });
    try {
      expect((await tunnel(port, `a.test:${server.port}`)).status).toBe(403);
      expect(problems.get(`a.test:${server.port}`)).toEqual({
        status: "BLOCKED",
        error: "Connected to an address that was not checked",
      });
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    }
  });
});

describe("startVisitProxy: limits", () => {
  it("cuts the transfer at maxBytes and refuses what comes after", async () => {
    const { port, problems } = await proxy({ maxBytes: 2 ** 20 });
    const answer = await viaProxy(port, server.url("a.test", "/big").href);
    expect("error" in answer || answer.body.length < 3 * 2 ** 20).toBe(true);
    await viaProxy(port, server.url("a.test", "/page?x=1").href);
    expect(problems.get(`a.test:${server.port}`)).toEqual({
      status: "ERROR",
      error: "The pages sent more than 1 MiB",
    });
  });

  it("refuses more connections at once than maxConnections", async () => {
    const { port, problems } = await proxy({ maxConnections: 1 });
    const first = await tunnel(port, `a.test:${server.port}`);
    expect(first.status).toBe(200);
    expect((await tunnel(port, `b.test:${server.port}`)).status).toBe(502);
    expect(problems.get(`b.test:${server.port}`)).toEqual({
      status: "ERROR",
      error: "Too many connections at once",
    });
    first.socket.destroy();
  });

  it("cuts every open connection on close()", async () => {
    const started = await proxy();
    const { socket } = await tunnel(started.port, `a.test:${server.port}`);
    socket.on("error", () => {}); // the cut can arrive as ECONNRESET
    socket.write(`GET /slow HTTP/1.1\r\nHost: a.test\r\n\r\n`);
    const closed = new Promise((resolve) => socket.on("close", resolve));
    await started.close();
    await closed;
    expect(socket.destroyed).toBe(true);
  });

  it("drops a connection whose browser side left while the lookup was running", async () => {
    // The first lookup waits until the test answers it; the ones after it answer at once.
    let first: (() => void) | undefined;
    const slowLookup: LookupFunction = (hostname, options, callback) => {
      if (first === undefined) first = () => fakeLookup(hostname, options, callback);
      else fakeLookup(hostname, options, callback);
    };
    const { port } = await proxy({ lookup: slowLookup, maxConnections: 1 });
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: server.url("a.test", "/page?x=1").href,
      agent: false,
    });
    req.on("error", () => {});
    req.end();
    await vi.waitFor(() => expect(first).toBeDefined());
    req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50)); // for the proxy to see it go
    first?.();
    // The connection opened for it is closed again, so its one place comes free for the next.
    await vi.waitFor(async () => {
      expect(await viaProxy(port, server.url("a.test", "/page?x=1").href)).toMatchObject({
        status: 200,
      });
    });
  });

  it("counts connections that are still being opened", async () => {
    const { port } = await proxy({ maxConnections: 2 });
    const tunnels = await Promise.all(
      ["a", "b", "c", "d"].map((name) => tunnel(port, `${name}.test:${server.port}`)),
    );
    expect(tunnels.map(({ status }) => status).sort()).toEqual([200, 200, 502, 502]);
    for (const { socket } of tunnels) socket.destroy();
  });

  it("frees a connection's place once it closes", async () => {
    const { port } = await proxy({ maxConnections: 1 });
    const first = await tunnel(port, `a.test:${server.port}`);
    first.socket.destroy();
    await vi.waitFor(async () => {
      const again = await tunnel(port, `a.test:${server.port}`);
      again.socket.destroy();
      expect(again.status).toBe(200);
    });
  });

  it("frees the place of a connection that was refused", async () => {
    const { port } = await proxy({ maxConnections: 1, lookup: refusing("inside.test") });
    expect((await tunnel(port, `inside.test:${server.port}`)).status).toBe(403);
    const next = await tunnel(port, `a.test:${server.port}`);
    next.socket.destroy();
    expect(next.status).toBe(200);
  });

  it("counts what comes down a tunnel against maxBytes", async () => {
    const source = await rawServer((socket) => socket.write(Buffer.alloc(3 * 2 ** 20)));
    const { port, problems } = await proxy({ maxBytes: 2 ** 20 });
    const { socket } = await tunnel(port, `a.test:${source.port}`);
    let received = 0;
    socket.on("data", (chunk: Buffer) => {
      received += chunk.length;
    });
    socket.on("error", () => {});
    await new Promise((resolve) => socket.on("close", resolve));
    expect(received).toBeLessThan(3 * 2 ** 20);
    expect((await tunnel(port, `a.test:${source.port}`)).status).toBe(502);
    expect(problems.get(`a.test:${source.port}`)?.error).toBe("The pages sent more than 1 MiB");
    await source.close();
  });

  it("counts what goes up a tunnel against maxBytes", async () => {
    let received = 0;
    const sink = await rawServer((socket) =>
      socket.on("data", (chunk: Buffer) => {
        received += chunk.length;
      }),
    );
    const { port } = await proxy({ maxBytes: 2 ** 20 });
    const { socket } = await tunnel(port, `a.test:${sink.port}`);
    socket.on("error", () => {});
    socket.end(Buffer.alloc(3 * 2 ** 20));
    await new Promise((resolve) => socket.on("close", resolve));
    expect(received).toBeLessThan(3 * 2 ** 20);
    await sink.close();
  });

  it("passes on, and counts, what came in the same packet as the CONNECT request", async () => {
    // The request for the tunnel carries 2000 bytes of header; the answer is far smaller.
    const send = async (options: { maxBytes?: number } = {}) => {
      const { port } = await proxy(options);
      const socket = net.connect(port, "127.0.0.1");
      socket.on("error", () => {});
      const target = `a.test:${server.port}`;
      // One write: the request for the tunnel arrives together with the CONNECT.
      socket.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n` +
          `GET /page?x=1 HTTP/1.1\r\nHost: a.test\r\nX-Pad: ${"x".repeat(2000)}\r\n` +
          "Connection: close\r\n\r\n",
      );
      let text = "";
      socket.on("data", (chunk) => {
        text += chunk;
      });
      await new Promise((resolve) => socket.on("close", resolve));
      return text;
    };
    expect(await send()).toMatch(/200 Connection Established[\s\S]*hello/);
    expect(await send({ maxBytes: 1000 })).not.toContain("hello");
  });

  it("counts a request body against maxBytes", async () => {
    const { port, problems } = await proxy({ maxBytes: 2 ** 20 });
    const sent = await viaProxy(port, server.url("a.test", "/sink").href, {
      method: "POST",
      body: "x".repeat(3 * 2 ** 20),
    });
    expect(sent).not.toMatchObject({ status: 200 });
    await viaProxy(port, server.url("a.test", "/page?x=1").href);
    expect(problems.get(`a.test:${server.port}`)?.error).toBe("The pages sent more than 1 MiB");
  });

  it("keeps a connection that the far side resets to itself", async () => {
    const resetting = await rawServer((socket) =>
      socket.on("data", () => socket.resetAndDestroy()),
    );
    const { port } = await proxy();
    const { socket } = await tunnel(port, `a.test:${resetting.port}`);
    socket.on("error", () => {});
    socket.write("hello");
    await new Promise((resolve) => socket.on("close", resolve));
    // The proxy is still there for the next connection.
    expect(await viaProxy(port, server.url("a.test", "/page?x=1").href)).toMatchObject({
      status: 200,
    });
    await resetting.close();
  });

  it("drops a tunnel whose browser side left while the lookup was running", async () => {
    let answer: (() => void) | undefined;
    const slowLookup: LookupFunction = (hostname, options, callback) => {
      answer = () => fakeLookup(hostname, options, callback);
    };
    const { port } = await proxy({ lookup: slowLookup });
    const connections = net.createServer();
    let accepted = 0;
    connections.on("connection", (socket) => {
      accepted += 1;
      socket.on("close", () => {
        accepted -= 1;
      });
    });
    await new Promise<void>((resolve) => connections.listen(0, "127.0.0.1", resolve));
    const target = (connections.address() as net.AddressInfo).port;
    const req = http.request({
      host: "127.0.0.1",
      port,
      method: "CONNECT",
      path: `a.test:${target}`,
      agent: false,
    });
    req.on("error", () => {});
    req.end();
    await vi.waitFor(() => expect(answer).toBeDefined());
    // A reset, so the proxy's side of the connection is gone at once, not just half closed.
    req.socket?.resetAndDestroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    answer?.();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(accepted).toBe(0);
    await new Promise<void>((resolve) => connections.close(() => resolve()));
  });
});
