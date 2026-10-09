import type { LookupAddress, LookupAllOptions, LookupOptions } from "node:dns";
import type { LookupFunction } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  checkHostname,
  createSafeLookup,
  isPublicAddress,
  type SafeLookupOptions,
  safeLookup,
} from "./index.ts";

describe("isPublicAddress", () => {
  it.each([
    // the edges of every IPv4 range
    ["0.0.0.0", false],
    ["0.255.255.255", false],
    ["1.0.0.0", true],
    ["9.255.255.255", true],
    ["10.0.0.0", false],
    ["10.255.255.255", false],
    ["11.0.0.0", true],
    ["100.63.255.255", true],
    ["100.64.0.0", false],
    ["100.127.255.255", false],
    ["100.128.0.0", true],
    ["126.255.255.255", true],
    ["127.0.0.1", false],
    ["127.255.255.255", false],
    ["128.0.0.0", true],
    ["168.63.129.15", true],
    ["168.63.129.16", false],
    ["168.63.129.17", true],
    ["169.253.255.255", true],
    ["169.254.169.254", false],
    ["169.255.0.0", true],
    ["172.15.255.255", true],
    ["172.16.0.0", false],
    ["172.31.255.255", false],
    ["172.32.0.0", true],
    ["192.0.0.192", false],
    ["192.0.2.1", false],
    ["192.88.99.1", false],
    ["192.167.255.255", true],
    ["192.168.0.1", false],
    ["192.169.0.0", true],
    ["198.17.255.255", true],
    ["198.18.0.0", false],
    ["198.19.255.255", false],
    ["198.20.0.0", true],
    ["198.51.100.1", false],
    ["203.0.113.1", false],
    ["223.255.255.255", true],
    ["224.0.0.1", false],
    ["239.255.255.255", false],
    ["240.0.0.1", false],
    ["255.255.255.255", false],
    ["8.8.8.8", true],
    ["93.184.215.14", true],
  ])("IPv4 %s -> %s", (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected);
  });

  it.each([
    ["::1", false],
    ["::", false],
    ["::ffff:127.0.0.1", false],
    ["::ffff:7f00:1", false],
    // IPv4-mapped is refused even for a public IPv4: plain IPv4 is the normal way to reach it.
    ["::ffff:8.8.8.8", false],
    ["::127.0.0.1", false],
    ["64:ff9b::7f00:1", false],
    ["64:ff9b:1::1", false],
    ["100::1", false],
    ["fc00::1", false],
    ["fd00:ec2::254", false],
    ["fe80::1", false],
    ["fec0::1", false],
    ["ff02::1", false],
    ["1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false],
    ["2000::1", true],
    ["2001::1", false],
    ["2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff", false],
    ["2001:200::1", true],
    ["2001:db8::1", false],
    ["2001:db9::1", true],
    ["2002:7f00:1::", false],
    ["2003::1", true],
    ["2001:4860:4860::8888", true],
    ["2606:4700:4700::1111", true],
    ["3ffe:ffff::1", true],
    ["3fff::1", false],
    ["4000::1", false],
    ["5f00::1", false],
    ["2001:4860:4860::8888%eth0", false],
  ])("IPv6 %s -> %s", (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected);
  });

  it.each(["", "localhost", "1.2.3", "01.2.3.4", "999.0.0.1", "[::1]", "example.com"])(
    "refuses %j, which is not an IP address",
    (text) => {
      expect(isPublicAddress(text)).toBe(false);
    },
  );
});

describe("checkHostname", () => {
  it.each([
    "localhost",
    "LOCALHOST",
    "localhost.",
    "localhost..",
    "app.localhost",
    "intranet",
    "router",
    "printer.local",
    "metadata.google.internal",
    "nas.home.arpa",
    "home.arpa",
    "db.localdomain",
    "pc.lan",
    "server.home",
    "mail.corp",
    "wiki.intranet",
    "",
  ])("refuses %j", (hostname) => {
    expect(checkHostname(hostname)).toBe(`${hostname} is a local or internal host name`);
  });

  it.each([
    "bit.ly",
    "example.com",
    "example.com.",
    "localhost.example.com",
    "local.example.com",
    "internal.example.com",
    "mylocal.com",
    "notlocal.example",
    "homes.example",
    // A suffix only counts as a whole label: these end in "lan" and "home.arpa" as plain text.
    "pc.milan",
    "myhome.arpa",
  ])("allows %j", (hostname) => {
    expect(checkHostname(hostname)).toBeNull();
  });

  // The URL parser accepts hosts like this one. 20 calls take well under a millisecond now and
  // took over a second with the old /\.+$/ regex.
  it("handles a host with thousands of dots quickly", () => {
    const hostname = `a${".".repeat(8000)}b`;
    const started = performance.now();
    for (let i = 0; i < 20; i += 1) checkHostname(hostname);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

type Answer = { error: { code: unknown; message: string } } | { address: unknown; family: unknown };

/** Calls a LookupFunction and returns what reached its callback. */
function ask(
  lookup: LookupFunction,
  hostname: string,
  options: LookupOptions = { all: true },
): Promise<Answer> {
  return new Promise((resolve) => {
    lookup(hostname, options, (error, address, family) => {
      if (error) resolve({ error: { code: error.code, message: error.message } });
      else resolve({ address, family });
    });
  });
}

/** Fake DNS: the answers for each name; a name that is missing does not exist. */
function fakeDns(answers: Record<string, string[]>) {
  return vi.fn<NonNullable<SafeLookupOptions["resolve"]>>(
    async (hostname: string, options: LookupAllOptions): Promise<LookupAddress[]> => {
      const addresses = answers[hostname];
      if (!addresses) {
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
      }
      return addresses
        .map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))
        .filter((entry) => !options.family || entry.family === options.family);
    },
  );
}

const blockedError = (message: string) => ({ error: { code: "BLOCKED", message } });

describe("createSafeLookup", () => {
  it("answers with every address of a public name", async () => {
    const resolve = fakeDns({ "bit.ly": ["67.199.248.10", "2606:4700::6810:84e5"] });
    expect(await ask(createSafeLookup({ resolve }), "bit.ly")).toEqual({
      address: [
        { address: "67.199.248.10", family: 4 },
        { address: "2606:4700::6810:84e5", family: 6 },
      ],
      family: undefined,
    });
  });

  it("answers with one address when Node asks for one", async () => {
    const resolve = fakeDns({ "bit.ly": ["67.199.248.10", "2606:4700::6810:84e5"] });
    expect(await ask(createSafeLookup({ resolve }), "bit.ly", { family: 0 })).toEqual({
      address: "67.199.248.10",
      family: 4,
    });
  });

  it.each([
    [4, 4],
    [6, 6],
    ["IPv4", 4],
    ["IPv6", 6],
    [undefined, 0],
  ] as const)("passes family %j to DNS as %j", async (family, expected) => {
    const resolve = fakeDns({ "bit.ly": ["67.199.248.10", "2606:4700::6810:84e5"] });
    await ask(createSafeLookup({ resolve }), "bit.ly", { all: true, family });
    expect(resolve).toHaveBeenCalledWith("bit.ly", { all: true, family: expected });
  });

  it("writes addresses the way Node prints a socket's peer", async () => {
    const resolve = fakeDns({ "bit.ly": ["2606:4700:0:0:0:0:0:1111", "2001:DB9::1"] });
    expect(await ask(createSafeLookup({ resolve }), "bit.ly")).toMatchObject({
      address: [
        { address: "2606:4700::1111", family: 6 },
        { address: "2001:db9::1", family: 6 },
      ],
    });
  });

  it.each([["10.0.0.7"], ["127.0.0.1"], ["169.254.169.254"], ["fd00::1"], ["::ffff:127.0.0.1"]])(
    "refuses a name that resolves to %s, without naming the address",
    async (ip) => {
      const resolve = fakeDns({ "evil.example": [ip] });
      const answer = await ask(createSafeLookup({ resolve }), "evil.example");
      expect(answer).toEqual(
        blockedError("evil.example resolves to a private or reserved address"),
      );
      expect(JSON.stringify(answer)).not.toContain(ip);
    },
  );

  it("refuses a name when only one of its addresses is private", async () => {
    const resolve = fakeDns({ "mixed.example": ["93.184.215.14", "192.168.1.10"] });
    expect(await ask(createSafeLookup({ resolve }), "mixed.example")).toEqual(
      blockedError("mixed.example resolves to a private or reserved address"),
    );
  });

  it("checks every call again, so a DNS answer that changes is caught (DNS rebinding)", async () => {
    const answers = [["93.184.215.14"], ["127.0.0.1"]];
    const resolve = vi.fn(async () =>
      (answers.shift() ?? []).map((address) => ({ address, family: 4 })),
    );
    const lookup = createSafeLookup({ resolve });
    expect(await ask(lookup, "rebind.example")).toEqual({
      address: [{ address: "93.184.215.14", family: 4 }],
      family: undefined,
    });
    expect(await ask(lookup, "rebind.example")).toEqual(
      blockedError("rebind.example resolves to a private or reserved address"),
    );
  });

  it.each([
    ["localhost", "localhost is a local or internal host name"],
    ["intranet", "intranet is a local or internal host name"],
    ["metadata.google.internal", "metadata.google.internal is a local or internal host name"],
    ["127.0.0.1", "127.0.0.1 is a private or reserved address"],
    ["::1", "::1 is a private or reserved address"],
    ["169.254.169.254", "169.254.169.254 is a private or reserved address"],
  ])("refuses %s without asking DNS", async (hostname, message) => {
    const resolve = fakeDns({});
    expect(await ask(createSafeLookup({ resolve }), hostname)).toEqual(blockedError(message));
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    ["93.184.215.14", { address: "93.184.215.14", family: 4 }],
    ["2606:4700:4700::1111", { address: "2606:4700:4700::1111", family: 6 }],
  ])("answers with a public IP address itself, without asking DNS", async (ip, entry) => {
    const resolve = fakeDns({});
    expect(await ask(createSafeLookup({ resolve }), ip)).toEqual({
      address: [entry],
      family: undefined,
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("treats an empty answer as a name that does not exist", async () => {
    const resolve = fakeDns({ "empty.example": [] });
    expect(await ask(createSafeLookup({ resolve }), "empty.example")).toEqual({
      error: { code: "ENOTFOUND", message: "No address found for empty.example" },
    });
  });

  it("passes a DNS error on unchanged", async () => {
    expect(await ask(createSafeLookup({ resolve: fakeDns({}) }), "nowhere.example")).toEqual({
      error: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND nowhere.example" },
    });
  });

  it("reports a resolver that throws instead of rejecting", async () => {
    const resolve = () => {
      throw Object.assign(new Error("broken resolver"), { code: "EBROKEN" });
    };
    expect(await ask(createSafeLookup({ resolve }), "bit.ly")).toEqual({
      error: { code: "EBROKEN", message: "broken resolver" },
    });
  });

  it("uses the address policy it is given", async () => {
    const resolve = fakeDns({ "mock.example": ["127.0.0.1"] });
    const isAllowedAddress = (ip: string) => ip === "127.0.0.1";
    expect(await ask(createSafeLookup({ resolve, isAllowedAddress }), "mock.example")).toEqual({
      address: [{ address: "127.0.0.1", family: 4 }],
      family: undefined,
    });
  });

  it("is what safeLookup uses by default (refusals need no network)", async () => {
    expect(await ask(safeLookup, "localhost")).toEqual(
      blockedError("localhost is a local or internal host name"),
    );
    expect(await ask(safeLookup, "10.1.2.3")).toEqual(
      blockedError("10.1.2.3 is a private or reserved address"),
    );
  });
});
