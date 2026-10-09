import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction, type Socket } from "node:net";
import { isHttpUrl } from "@urlresolve/url-parser";

/** Statuses a browser follows by itself (Fetch standard). 201, 300, 304 and 305 are not followed. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Ports browsers refuse to connect to (mail, FTP, SSH, IRC, SIP...): fetch.spec.whatwg.org/#port-blocking */
const BAD_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

const USER_AGENT = "urlresolve (+https://github.com/EEDTAN/universal-url-resolver)";

export interface HopOptions {
  /**
   * DNS for this request, and the security hook: the request is never sent to an address this
   * function did not return. IP-literal hosts are passed through it too. Refuse by calling back
   * with an Error whose `code` is "BLOCKED": its message becomes the result's error. A successful
   * answer with no address counts as ENOTFOUND. Addresses are compared as text with the socket's
   * peer address, so return them the way Node prints them (dns.lookup and dns.Resolver already do).
   * There is no default on purpose: the caller decides the policy. @urlresolve/core passes
   * safeLookup from @urlresolve/security, which only answers with public addresses.
   */
  lookup: LookupFunction;
  /** Stops the request. A "TimeoutError" reason (from AbortSignal.timeout) gives TIMEOUT. */
  signal: AbortSignal;
  /** Value of the Cookie header, from the caller's cookie jar. Nothing is sent when it is empty. */
  cookie?: string;
}

export type HopResult =
  | {
      ok: true;
      statusCode: number;
      location: string | null;
      setCookies: string[];
      challenge: boolean;
    }
  | { ok: false; status: "BLOCKED" | "TIMEOUT" | "ERROR"; error: string };

/**
 * One GET request. It never follows redirects and never reads the body.
 * `location` is the raw Location header, set only for 301/302/303/307/308.
 * Turn it into a URL with resolveLocation() from @urlresolve/url-parser.
 * `setCookies` holds the raw Set-Cookie headers, for the caller's cookie jar.
 * `challenge` means the page wants a person to prove they are human (see below).
 */
export async function requestHop(
  url: URL,
  { lookup, signal, cookie }: HopOptions,
): Promise<HopResult> {
  if (!isHttpUrl(url)) {
    return blocked(`Refusing to request a "${url.protocol}" URL`);
  }
  if (url.username !== "" || url.password !== "") {
    return blocked("Refusing to send a username or password");
  }
  // url.port is "" for the default port, and Number("") is 0, which is on the list.
  if (url.port !== "" && BAD_PORTS.has(Number(url.port))) {
    return blocked(`Port ${url.port} is not allowed`);
  }

  // Every address the lookup handed out. The socket must be connected to one of them.
  const approved = new Set<string>();
  const checkedLookup: LookupFunction = (hostname, options, callback) => {
    lookup(hostname, options, (error, address, family) => {
      if (error) {
        callback(error, address, family);
        return;
      }
      const entries = Array.isArray(address) ? address : [{ address }];
      // An answer without any address crashes Node itself, so treat it as "not found".
      if (!entries.some((entry) => entry.address)) {
        callback(withCode(`No address found for ${hostname}`, "ENOTFOUND"), "");
        return;
      }
      for (const entry of entries) approved.add(entry.address);
      callback(null, address, family);
    });
  };

  try {
    // Node skips `lookup` for IP-literal hosts, so those are passed through it here.
    // url.hostname keeps the [ ] around an IPv6 address, and isIP("[::1]") is 0.
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) !== 0) await approveIpLiteral(host, checkedLookup, signal);

    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      const options = {
        // A fresh socket for this hop. The global agent may send requests to a proxy taken
        // from environment variables, and then `lookup` is never asked.
        agent: false,
        lookup: checkedLookup,
        signal,
        // No accept-encoding: the body is never read.
        headers: { "user-agent": USER_AGENT, accept: "*/*", ...(cookie ? { cookie } : {}) },
        // Set explicitly so that Node command-line flags and environment variables cannot loosen them.
        maxHeaderSize: 16 * 1024,
        insecureHTTPParser: false,
        rejectUnauthorized: true,
      };
      const req =
        url.protocol === "https:"
          ? httpsRequest(url, options, resolve)
          : httpRequest(url, options, resolve);
      req.on("socket", (socket: Socket) => {
        // Last line of defence, in case something replaced the agent or the connection code
        // (for example a preloaded monitoring tool): never send anything to an address `lookup`
        // did not hand out. This event fires before the request is written.
        const check = () => {
          if (!approved.has(socket.remoteAddress ?? "")) {
            socket.destroy(withCode("Connected to an address that was not checked", "BLOCKED"));
          }
        };
        // A socket from a pool or a tunnel is already connected and never emits "connect".
        // prepend, not once: tls.connect starts its handshake (which names the host) from its own,
        // earlier "connect" listener, so this check has to run first.
        if (socket.connecting) socket.prependOnceListener("connect", check);
        else check();
      });
      req.on("error", reject);
      // A "101 Switching Protocols" upgrade ends the request with neither "response" nor "error".
      // After a normal response this reject does nothing, because the promise is already settled.
      req.on("close", () => reject(withCode("Connection closed without a response", "ECONNRESET")));
      req.end();
    });
    res.destroy(); // the status and headers are all that is needed

    const statusCode = res.statusCode ?? 0;
    const setCookies = res.headers["set-cookie"] ?? [];
    // Cloudflare's documented marker for its "verify you are human" page. Only a person can pass
    // it, and this project never tries to get around one.
    const challenge = res.headers["cf-mitigated"] === "challenge";
    if (!REDIRECT_STATUSES.has(statusCode)) {
      return { ok: true, statusCode, location: null, setCookies, challenge };
    }
    // res.headers keeps only the first Location; headersDistinct keeps every copy.
    const locations = res.headersDistinct.location ?? [];
    // Browsers refuse a redirect that names two different targets.
    if (new Set(locations).size > 1) {
      return { ok: false, status: "ERROR", error: "Response has more than one Location header" };
    }
    const raw = locations[0];
    // Node reads header bytes as latin1, browsers read Location as UTF-8.
    const location = raw === undefined ? null : Buffer.from(raw, "latin1").toString("utf8");
    return { ok: true, statusCode, location, setCookies, challenge };
  } catch (thrown) {
    // Object() makes a thrown null or string safe to read.
    const error = Object(thrown) as NodeJS.ErrnoException;
    const code = error.code ?? "UNKNOWN";
    // Checked before the signal: a refusal that lands as the timer fires is still a refusal.
    if (code === "BLOCKED") return blocked(error.message);
    if (signal.aborted) {
      return signal.reason?.name === "TimeoutError"
        ? { ok: false, status: "TIMEOUT", error: "Request timed out" }
        : { ok: false, status: "ERROR", error: "Request was cancelled" };
    }
    // ETIMEDOUT: the operating system gave up on the TCP connection.
    if (code === "ETIMEDOUT")
      return { ok: false, status: "TIMEOUT", error: "Connection timed out" };
    // ETIMEOUT (no D): a DNS query through dns.Resolver (c-ares) timed out.
    if (code === "ETIMEOUT") return { ok: false, status: "TIMEOUT", error: "DNS lookup timed out" };
    return { ok: false, status: "ERROR", error: `Request failed (${code})` };
  }
}

/** Asks `lookup` about an IP-literal host. Abortable, so a lookup that never answers cannot hang the hop. */
function approveIpLiteral(ip: string, lookup: LookupFunction, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    lookup(ip, { all: true }, (error) => {
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    });
  });
}

function blocked(error: string): HopResult {
  return { ok: false, status: "BLOCKED", error };
}

function withCode(message: string, code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}
