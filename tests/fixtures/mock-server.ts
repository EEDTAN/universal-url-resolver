import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type AddressInfo, isIP, type LookupFunction } from "node:net";

export type Route = (req: IncomingMessage, res: ServerResponse) => void;

/** One local HTTP server that plays many sites. Routes are keyed "host/path?query", e.g. "short.test/abc". */
export async function startMockServer(routes: Record<string, Route>) {
  const requests: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    requests.push(req);
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    const route = routes[`${host}${req.url}`];
    if (route) route(req, res);
    else res.writeHead(404).end();
  });
  // 127.0.0.1 only: no Windows firewall prompt, and nothing outside this computer can reach it.
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    /** Every request the server received, in order. */
    requests,
    url: (host: string, path = "/") => new URL(`http://${host}:${port}${path}`),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Fake DNS: *.test -> 127.0.0.1, IP literals -> themselves, anything else -> ENOTFOUND. Never real DNS. */
export const fakeLookup: LookupFunction = (hostname, options, callback) => {
  const address = hostname.endsWith(".test") ? "127.0.0.1" : hostname;
  const family = isIP(address);
  if (family === 0) {
    const error = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
    callback(Object.assign(error, { code: "ENOTFOUND" }), "");
  } else if (options.all) {
    callback(null, [{ address, family }]);
  } else {
    callback(null, address, family);
  }
};
