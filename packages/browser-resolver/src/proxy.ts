import type { LookupAddress } from "node:dns";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { type AddressInfo, connect, type LookupFunction, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { BAD_PORTS } from "@urlresolve/http-resolver";

/** Most data one visit may move through its proxy, both ways together: 64 MiB. */
export const MAX_VISIT_BYTES = 64 * 1024 * 1024;
/** Most connections one visit may have open at the same time. */
export const MAX_VISIT_CONNECTIONS = 64;

// Headers about one connection rather than the request, so a proxy does not pass them on.
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Why the proxy could not reach a host. The browser itself only says that a request failed. */
export interface ProxyProblem {
  status: "BLOCKED" | "ERROR";
  error: string;
}

export interface VisitProxy {
  /** "http://127.0.0.1:<port>", for the proxy setting of the browser context. */
  server: string;
  /** The last problem for each "host:port" (with the default port written out). */
  problems: ReadonlyMap<string, ProxyProblem>;
  /** Stops the proxy and cuts every connection through it. */
  close(): Promise<void>;
}

export interface VisitProxyOptions {
  /** DNS and the address policy, the same hook requestHop uses. */
  lookup: LookupFunction;
  /** Default MAX_VISIT_BYTES. */
  maxBytes?: number;
  /** Default MAX_VISIT_CONNECTIONS. */
  maxConnections?: number;
}

/**
 * Starts the proxy for one browser visit. The browser sends it every request: plain HTTP as a
 * full URL, and HTTPS and WebSockets through a CONNECT tunnel. For each connection the proxy asks
 * `lookup` once and connects to an address it answered, never to any other, so a DNS answer that
 * changes in between (DNS rebinding) cannot send the connection elsewhere. It never follows a
 * redirect itself: the browser does, and its next request comes back through the proxy.
 * It listens on 127.0.0.1 only, on a port the system picks.
 */
export async function startVisitProxy({
  lookup,
  maxBytes = MAX_VISIT_BYTES,
  maxConnections = MAX_VISIT_CONNECTIONS,
}: VisitProxyOptions): Promise<VisitProxy> {
  const problems = new Map<string, ProxyProblem>();
  const sockets = new Set<Duplex>();
  let bytes = 0;
  let upstreams = 0;

  /** Kept for close(); and a broken connection only ends itself, never the process. */
  const track = (socket: Duplex) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  };
  const tooMuch = () => bytes > maxBytes;
  const count = (chunk: Buffer) => {
    bytes += chunk.length;
    if (tooMuch()) for (const socket of sockets) socket.destroy();
  };

  /** A connection to host:port, at an address `lookup` approved. */
  const open = async (host: string, port: number): Promise<Socket> => {
    if (BAD_PORTS.has(port)) throw withCode(`Port ${port} is not allowed`, "BLOCKED");
    if (tooMuch()) throw withCode(`The pages sent more than ${maxBytes / 2 ** 20} MiB`, "ELIMIT");
    if (upstreams >= maxConnections) throw withCode("Too many connections at once", "ELIMIT");
    // Counted before the waits below, so that connections asked for at the same time see each
    // other, and given back when the connection closes or never comes about.
    upstreams += 1;
    try {
      // The host of a URL keeps the [ ] around an IPv6 address; lookup wants the bare address.
      const addresses = await lookupAll(lookup, host.replace(/^\[|\]$/g, ""));
      let failure: unknown;
      for (const { address, family } of addresses) {
        try {
          const socket = await connectTo(address, family, port, track);
          socket.on("close", () => {
            upstreams -= 1;
          });
          return socket;
        } catch (error) {
          failure = error; // try the next address, as a browser would
        }
      }
      throw failure;
    } catch (error) {
      upstreams -= 1;
      throw error;
    }
  };

  const record = (key: string, error: unknown) => {
    const { code = "UNKNOWN", message } = Object(error) as NodeJS.ErrnoException;
    if (code === "BLOCKED") problems.set(key, { status: "BLOCKED", error: message });
    else if (code === "ELIMIT") problems.set(key, { status: "ERROR", error: message });
    else problems.set(key, { status: "ERROR", error: `Request failed (${code})` });
  };

  const tunnel = (req: IncomingMessage, client: Duplex, head: Buffer) => {
    const target = authority(req.url as string); // always set on a request a server receives
    if (target === null) {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const key = `${target.host}:${target.port}`;
    open(target.host, target.port).then(
      (upstream) => {
        if (client.destroyed) {
          upstream.destroy();
          return;
        }
        client.on("close", () => upstream.destroy());
        upstream.on("close", () => client.destroy());
        client.on("data", count);
        upstream.on("data", count);
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        // Bytes that came with the CONNECT request go first, counted like the rest.
        count(head);
        upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      },
      (error: unknown) => {
        record(key, error);
        const blocked = (Object(error) as NodeJS.ErrnoException).code === "BLOCKED";
        client.end(`HTTP/1.1 ${blocked ? "403 Forbidden" : "502 Bad Gateway"}\r\n\r\n`);
      },
    );
  };

  const forward = (req: IncomingMessage, res: ServerResponse) => {
    // A browser sends plain HTTP to a proxy as a full http:// URL. Anything else is not for us.
    const url = URL.parse(req.url as string);
    if (url === null || url.protocol !== "http:") {
      res.writeHead(400).end();
      return;
    }
    const port = Number(url.port || 80);
    const key = `${url.hostname}:${port}`;
    open(url.hostname, port).then(
      (socket) => {
        if (req.socket.destroyed) {
          socket.destroy();
          return;
        }
        const upstream = httpRequest({
          createConnection: () => socket,
          method: req.method,
          path: `${url.pathname}${url.search}`,
          headers: passOn(req.rawHeaders),
        });
        upstream.on("response", (answer) => {
          res.writeHead(answer.statusCode as number, passOn(answer.rawHeaders));
          answer.on("data", count);
          answer.pipe(res);
        });
        upstream.on("error", () => res.destroy());
        res.on("close", () => upstream.destroy());
        req.on("data", count);
        req.pipe(upstream);
      },
      (error: unknown) => {
        record(key, error);
        // No answer at all: the browser reports a failed request, and the visit explains it
        // with the problem recorded here.
        req.socket.destroy();
      },
    );
  };

  const server = createServer();
  server.on("connection", track);
  server.on("clientError", (_error, socket: Duplex) => socket.destroy());
  // Browsers send WebSockets through CONNECT. An Upgrade on a plain request is refused.
  server.on("upgrade", (_req, socket: Duplex) => socket.destroy());
  server.on("connect", tunnel);
  server.on("request", forward);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    server: `http://127.0.0.1:${port}`,
    problems,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** "host:port" from a CONNECT request (an IPv6 host in brackets), or null when it is not one. */
function authority(text: string): { host: string; port: number } | null {
  const match = /^(\[[\da-f:.]+\]|[^:@[\]/\s]+):(\d{1,5})$/i.exec(text);
  if (match === null) return null;
  const [, host = "", digits] = match;
  const port = Number(digits);
  return port >= 1 && port <= 65_535 ? { host: host.toLowerCase(), port } : null;
}

/** Raw headers without the ones about the connection, in the same flat [name, value, ...] form. */
function passOn(raw: string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i] as string;
    if (!HOP_HEADERS.has(name.toLowerCase())) kept.push(name, raw[i + 1] as string);
  }
  return kept;
}

function lookupAll(lookup: LookupFunction, host: string): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    lookup(host, { all: true }, (error, addresses) => {
      if (error) reject(error);
      else if (Array.isArray(addresses) && addresses.length > 0) resolve(addresses);
      else reject(withCode(`No address found for ${host}`, "ENOTFOUND"));
    });
  });
}

/** A TCP connection to an IP address (so no DNS of its own), checked once it is open. */
function connectTo(
  address: string,
  family: number,
  port: number,
  track: (socket: Duplex) => void,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: address, port, family });
    track(socket);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      // The same last line of defence as in requestHop: something that replaced net.connect
      // (a preloaded tool, say) must not take the connection to another address.
      if (socket.remoteAddress === address) {
        resolve(socket);
      } else {
        socket.destroy();
        reject(withCode("Connected to an address that was not checked", "BLOCKED"));
      }
    });
  });
}

function withCode(message: string, code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}
