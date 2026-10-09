import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { resolveUrl } from "@urlresolve/core";
import { createSafeLookup, isPublicAddress } from "@urlresolve/security";
import { afterAll, describe, expect, it } from "vitest";
import { type Route, startMockServer } from "../fixtures/mock-server.ts";

// The default policy refuses all of these before a single packet is sent: names by their
// spelling, IP addresses by their range. So this part needs neither DNS nor a server.
describe("the default policy refuses private destinations without touching the network", () => {
  it.each([
    ["http://localhost/", "http://localhost/", "localhost is a local or internal host name"],
    ["http://LOCALHOST./", "http://localhost./", "localhost. is a local or internal host name"],
    ["localhost:8080", "https://localhost:8080/", "localhost is a local or internal host name"],
    [
      "http://ｌｏｃａｌｈｏｓｔ/",
      "http://localhost/",
      "localhost is a local or internal host name",
    ],
    [
      "http://app.localhost:3000/",
      "http://app.localhost:3000/",
      "app.localhost is a local or internal host name",
    ],
    ["http://intranet/", "http://intranet/", "intranet is a local or internal host name"],
    [
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "metadata.google.internal is a local or internal host name",
    ],
    [
      "http://printer.local/",
      "http://printer.local/",
      "printer.local is a local or internal host name",
    ],
    [
      "http://nas.home.arpa/",
      "http://nas.home.arpa/",
      "nas.home.arpa is a local or internal host name",
    ],
    ["http://127.0.0.1/", "http://127.0.0.1/", "127.0.0.1 is a private or reserved address"],
    ["https://127.0.0.1/", "https://127.0.0.1/", "127.0.0.1 is a private or reserved address"],
    // Other spellings of 127.0.0.1: the URL parser turns them all into the same address.
    ["http://127.1/", "http://127.0.0.1/", "127.0.0.1 is a private or reserved address"],
    ["http://2130706433/", "http://127.0.0.1/", "127.0.0.1 is a private or reserved address"],
    ["http://0x7f.0.0.1/", "http://127.0.0.1/", "127.0.0.1 is a private or reserved address"],
    ["http://017700000001/", "http://127.0.0.1/", "127.0.0.1 is a private or reserved address"],
    ["http://①②⑦.0.0.1/", "http://127.0.0.1/", "127.0.0.1 is a private or reserved address"],
    ["http://0/", "http://0.0.0.0/", "0.0.0.0 is a private or reserved address"],
    ["http://0.0.0.0:8080/", "http://0.0.0.0:8080/", "0.0.0.0 is a private or reserved address"],
    ["http://10.0.0.1/", "http://10.0.0.1/", "10.0.0.1 is a private or reserved address"],
    ["http://172.16.5.4/", "http://172.16.5.4/", "172.16.5.4 is a private or reserved address"],
    ["http://192.168.1.1/", "http://192.168.1.1/", "192.168.1.1 is a private or reserved address"],
    [
      "http://169.254.169.254/latest/meta-data/",
      "http://169.254.169.254/latest/meta-data/",
      "169.254.169.254 is a private or reserved address",
    ],
    [
      "http://100.100.100.200/",
      "http://100.100.100.200/",
      "100.100.100.200 is a private or reserved address",
    ],
    ["http://[::1]/", "http://[::1]/", "::1 is a private or reserved address"],
    ["http://[::]/", "http://[::]/", ":: is a private or reserved address"],
    [
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:7f00:1]/",
      "::ffff:7f00:1 is a private or reserved address",
    ],
    [
      "http://[fd00:ec2::254]/",
      "http://[fd00:ec2::254]/",
      "fd00:ec2::254 is a private or reserved address",
    ],
    ["http://[fe80::1]/", "http://[fe80::1]/", "fe80::1 is a private or reserved address"],
    [
      "http://[64:ff9b::7f00:1]/",
      "http://[64:ff9b::7f00:1]/",
      "64:ff9b::7f00:1 is a private or reserved address",
    ],
    [
      "http://[2002:7f00:1::]/",
      "http://[2002:7f00:1::]/",
      "2002:7f00:1:: is a private or reserved address",
    ],
  ])("%s", async (input, originalUrl, error) => {
    expect(await resolveUrl(input, { timeoutMs: 2000 })).toEqual({
      originalUrl,
      finalUrl: null,
      status: "BLOCKED",
      method: null,
      redirectCount: 0,
      chain: [originalUrl],
      httpStatus: null,
      timing: { elapsedMs: expect.any(Number) },
      security: { credentialsRemoved: false },
      tracking: null,
      error,
    });
  });

  it.each([
    "file:///etc/passwd",
    "ftp://files.example/x",
    "gopher://example.com/",
    "data:text/html,<script>alert(1)</script>",
    "javascript:alert(1)",
  ])("rejects %s as INVALID_URL", async (input) => {
    expect(await resolveUrl(input)).toMatchObject({ status: "INVALID_URL", chain: [] });
  });
});

// Here a local mock server plays a public site. The policy is the real one, with one exception:
// 127.0.0.1, where the mock server listens, counts as public. Every other loopback address
// (127.0.0.2, ::1, "localhost") is still refused.
const DNS: Record<string, string[]> = {
  "public.test": ["127.0.0.1"],
  "private.test": ["10.0.0.7"],
  "mixed.test": ["127.0.0.1", "192.168.0.5"],
  "metadata.test": ["169.254.169.254"],
  "v6.test": ["fd00::1"],
};
/** The answers rebind.test still has to give, one per lookup. The rebinding test fills it. */
let rebindAnswers: string[][] = [];

async function fakeDns(hostname: string): Promise<LookupAddress[]> {
  const addresses = hostname === "rebind.test" ? rebindAnswers.shift() : DNS[hostname];
  if (!addresses) {
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
  }
  return addresses.map((address) => ({ address, family: isIP(address) }));
}

const lookup = createSafeLookup({
  resolve: fakeDns,
  isAllowedAddress: (ip) => ip === "127.0.0.1" || isPublicAddress(ip),
});

const go =
  (location: () => string): Route =>
  (_req, res) => {
    res.writeHead(302, { location: location() }).end();
  };

const page =
  (body: () => string): Route =>
  (_req, res) => {
    res.writeHead(200, { "content-type": "text/html" }).end(body());
  };

/** Where the refused redirects point. Each test checks that only its own first hop arrived. */
const SECRET = "/secret";
const port = () => server.port;

const server = await startMockServer({
  "public.test/fine": go(() => `http://public.test:${port()}/landing`),
  "public.test/landing": (_req, res) => {
    res.end("ok");
  },
  "public.test/to-localhost": go(() => `http://localhost:${port()}${SECRET}`),
  "public.test/to-loopback": go(() => `http://127.0.0.2:${port()}${SECRET}`),
  "public.test/to-decimal": go(() => `http://2130706434:${port()}${SECRET}`),
  "public.test/to-hex": go(() => `http://0x7f000002:${port()}${SECRET}`),
  "public.test/to-ipv6": go(() => `http://[::1]:${port()}${SECRET}`),
  "public.test/to-mapped": go(() => `http://[::ffff:127.0.0.2]:${port()}${SECRET}`),
  "public.test/to-private-ip": go(() => `http://10.0.0.1:${port()}${SECRET}`),
  "public.test/to-metadata-ip": go(() => "http://169.254.169.254/latest/meta-data/"),
  "public.test/to-private-name": go(() => `http://private.test:${port()}${SECRET}`),
  "public.test/to-mixed-name": go(() => `http://mixed.test:${port()}${SECRET}`),
  "public.test/to-metadata-name": go(() => `http://metadata.test${SECRET}`),
  "public.test/to-v6-name": go(() => `http://v6.test:${port()}${SECRET}`),
  "public.test/to-internal-name": go(() => `http://intranet:${port()}${SECRET}`),
  "public.test/to-rebind": go(() => `http://rebind.test:${port()}/first`),
  "rebind.test/first": go(() => `http://rebind.test:${port()}${SECRET}`),
  // Pages that point somewhere by themselves, instead of with an HTTP redirect.
  "public.test/meta-to-localhost": page(
    () => `<meta http-equiv="refresh" content="0;url=http://localhost:${port()}${SECRET}">`,
  ),
  "public.test/noscript-to-private": page(
    () =>
      `<noscript><meta http-equiv="refresh" content="0;url=http://10.0.0.1${SECRET}"></noscript>`,
  ),
  "public.test/header-to-metadata": (_req, res) => {
    res.writeHead(200, { refresh: "0; url=http://169.254.169.254/latest/meta-data/" }).end();
  },
  "public.test/frame-to-private-name": page(
    () => `<frameset><frame src="http://private.test:${port()}${SECRET}"></frameset>`,
  ),
  "public.test/out?u=http%3A%2F%2F127.0.0.2%2Fsecret": page(
    () => '<a href="http://127.0.0.2/secret">Continue</a>',
  ),
  "public.test/script-to-localhost": page(
    () => `<script>location.replace("http://localhost:${port()}${SECRET}")</script>`,
  ),
  "public.test/script-to-private-name": page(
    () =>
      `<script>var h = "private.test"; location.href = "http://" + h + ":${port()}${SECRET}";</script>`,
  ),
  "public.test/script-go?to=http%3A%2F%2F169.254.169.254%2F": page(
    () => '<script>location.href = new URLSearchParams(location.search).get("to");</script>',
  ),
});
afterAll(() => server.close());

const start = (path: string) => `http://public.test:${port()}${path}`;

describe("every redirect goes through the same checks as the first URL", () => {
  it("lets the mock site through, so the refusals below are real", async () => {
    expect(await resolveUrl(start("/fine"), { lookup, timeoutMs: 2000 })).toMatchObject({
      status: "RESOLVED",
      finalUrl: start("/landing"),
    });
  });

  it.each([
    [
      "/to-localhost",
      `http://localhost:{port}${SECRET}`,
      "localhost is a local or internal host name",
    ],
    [
      "/to-loopback",
      `http://127.0.0.2:{port}${SECRET}`,
      "127.0.0.2 is a private or reserved address",
    ],
    [
      "/to-decimal",
      `http://127.0.0.2:{port}${SECRET}`,
      "127.0.0.2 is a private or reserved address",
    ],
    ["/to-hex", `http://127.0.0.2:{port}${SECRET}`, "127.0.0.2 is a private or reserved address"],
    ["/to-ipv6", `http://[::1]:{port}${SECRET}`, "::1 is a private or reserved address"],
    [
      "/to-mapped",
      `http://[::ffff:7f00:2]:{port}${SECRET}`,
      "::ffff:7f00:2 is a private or reserved address",
    ],
    [
      "/to-private-ip",
      `http://10.0.0.1:{port}${SECRET}`,
      "10.0.0.1 is a private or reserved address",
    ],
    [
      "/to-metadata-ip",
      "http://169.254.169.254/latest/meta-data/",
      "169.254.169.254 is a private or reserved address",
    ],
    [
      "/to-private-name",
      `http://private.test:{port}${SECRET}`,
      "private.test resolves to a private or reserved address",
    ],
    [
      "/to-mixed-name",
      `http://mixed.test:{port}${SECRET}`,
      "mixed.test resolves to a private or reserved address",
    ],
    [
      "/to-metadata-name",
      `http://metadata.test${SECRET}`,
      "metadata.test resolves to a private or reserved address",
    ],
    [
      "/to-v6-name",
      `http://v6.test:{port}${SECRET}`,
      "v6.test resolves to a private or reserved address",
    ],
    [
      "/to-internal-name",
      `http://intranet:{port}${SECRET}`,
      "intranet is a local or internal host name",
    ],
  ])("blocks the redirect %s", async (path, target, error) => {
    const before = server.requests.length;
    const result = await resolveUrl(start(path), { lookup, timeoutMs: 2000 });
    expect(result).toMatchObject({
      status: "BLOCKED",
      finalUrl: null,
      error,
      method: "http",
      httpStatus: 302,
      chain: [start(path), target.replace("{port}", String(port()))],
    });
    expect(server.requests.slice(before).map((req) => req.url)).toEqual([path]);
  });

  it("catches a name whose DNS answer changes between two requests (DNS rebinding)", async () => {
    rebindAnswers = [["127.0.0.1"], ["10.0.0.1"]];
    const before = server.requests.length;
    const result = await resolveUrl(start("/to-rebind"), { lookup, timeoutMs: 2000 });
    expect(result).toMatchObject({
      status: "BLOCKED",
      error: "rebind.test resolves to a private or reserved address",
      chain: [
        start("/to-rebind"),
        `http://rebind.test:${port()}/first`,
        `http://rebind.test:${port()}${SECRET}`,
      ],
    });
    expect(server.requests.slice(before).map((req) => req.url)).toEqual(["/to-rebind", "/first"]);
  });

  it("never names the private address a host resolved to", async () => {
    const result = await resolveUrl(start("/to-private-name"), { lookup, timeoutMs: 2000 });
    expect(JSON.stringify(result)).not.toContain("10.0.0.7");
  });
});

describe("every URL found in a page goes through the same checks", () => {
  it.each([
    [
      "/meta-to-localhost",
      `http://localhost:{port}${SECRET}`,
      "localhost is a local or internal host name",
      "meta-refresh",
    ],
    [
      "/noscript-to-private",
      `http://10.0.0.1${SECRET}`,
      "10.0.0.1 is a private or reserved address",
      "meta-refresh",
    ],
    [
      "/header-to-metadata",
      "http://169.254.169.254/latest/meta-data/",
      "169.254.169.254 is a private or reserved address",
      "meta-refresh",
    ],
    [
      "/frame-to-private-name",
      `http://private.test:{port}${SECRET}`,
      "private.test resolves to a private or reserved address",
      "html",
    ],
    [
      "/out?u=http%3A%2F%2F127.0.0.2%2Fsecret",
      "http://127.0.0.2/secret",
      "127.0.0.2 is a private or reserved address",
      "html",
    ],
    [
      "/script-to-localhost",
      `http://localhost:{port}${SECRET}`,
      "localhost is a local or internal host name",
      "javascript",
    ],
    [
      "/script-to-private-name",
      `http://private.test:{port}${SECRET}`,
      "private.test resolves to a private or reserved address",
      "javascript",
    ],
    [
      "/script-go?to=http%3A%2F%2F169.254.169.254%2F",
      "http://169.254.169.254/",
      "169.254.169.254 is a private or reserved address",
      "javascript",
    ],
  ])("blocks the target of %s", async (path, target, error, method) => {
    const before = server.requests.length;
    const result = await resolveUrl(start(path), { lookup, timeoutMs: 2000 });
    expect(result).toMatchObject({
      status: "BLOCKED",
      error,
      method,
      chain: [start(path), target.replace("{port}", String(port()))],
    });
    expect(server.requests.slice(before).map((req) => req.url)).toEqual([path]);
  });
});
