import type { LookupAddress, LookupAllOptions } from "node:dns";
import { lookup as systemLookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction, SocketAddress } from "node:net";

// IPv4 ranges that are not on the public internet (IANA special-purpose address registry),
// plus multicast and the reserved block.
const PRIVATE_IPV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this network": connecting to 0.0.0.0 reaches the local machine
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  // Not in the IANA list: Azure's platform endpoint (WireServer, DNS, health probes). It is
  // public address space, but on an Azure machine it only reaches that machine's own host.
  ["168.63.129.16", 32],
  ["169.254.0.0", 16], // link-local, including cloud metadata at 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // retired 6to4 relays
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and the 255.255.255.255 broadcast
] as const) {
  PRIVATE_IPV4.addSubnet(network, prefix, "ipv4");
}

// IPv6 works the other way round: only global unicast (2000::/3) is public, minus the special
// blocks inside it. Loopback (::1), unspecified (::), IPv4-mapped (::ffff:0:0/96), NAT64
// (64:ff9b::/96), unique local (fc00::/7), link-local (fe80::/10) and multicast (ff00::/8) are
// all outside 2000::/3, and so are the old IPv4-compatible addresses (::/96).
const GLOBAL_IPV6 = new BlockList();
GLOBAL_IPV6.addSubnet("2000::", 3, "ipv6");
const SPECIAL_IPV6 = new BlockList();
for (const [network, prefix] of [
  ["2001::", 23], // IETF protocol assignments, including Teredo (2001::/32)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4, which wraps an IPv4 address: 2002:7f00:1:: is 127.0.0.1
  ["3fff::", 20], // documentation
] as const) {
  SPECIAL_IPV6.addSubnet(network, prefix, "ipv6");
}

// Names that only mean something inside a private network. They are refused before any lookup,
// so the question never leaves this computer. The address check after DNS is the real protection;
// this list also covers names the operating system answers without DNS (hosts file, mDNS, NetBIOS).
const INTERNAL_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "home.arpa",
  "localdomain",
  "lan",
  "home",
  "corp",
  "intranet",
];

/** True for an address on the public internet; false for private, loopback, reserved and invalid ones. */
export function isPublicAddress(ip: string): boolean {
  // A zone ("fe80::1%eth0") ties an address to one network card, so it is never public.
  if (ip.includes("%")) return false;
  switch (isIP(ip)) {
    case 4:
      return !PRIVATE_IPV4.check(ip, "ipv4");
    case 6:
      return GLOBAL_IPV6.check(ip, "ipv6") && !SPECIAL_IPV6.check(ip, "ipv6");
    default:
      return false;
  }
}

/**
 * Why a host name is refused before DNS, or null when it may be looked up. For names only:
 * IP addresses go through isPublicAddress. A name without a dot ("intranet") is internal too.
 */
export function checkHostname(hostname: string): string | null {
  // Trailing dots are dropped with a loop: the regex /\.+$/ takes quadratic time on "a.....b".
  let end = hostname.length;
  while (hostname[end - 1] === ".") end -= 1;
  const name = hostname.slice(0, end).toLowerCase();
  const internal =
    !name.includes(".") ||
    INTERNAL_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
  return internal ? `${hostname} is a local or internal host name` : null;
}

export interface SafeLookupOptions {
  /** The DNS step. Default: the operating system's resolver, the same one browsers use. */
  resolve?: (hostname: string, options: LookupAllOptions) => Promise<LookupAddress[]>;
  /** Which addresses may be connected to. Default: isPublicAddress. */
  isAllowedAddress?: (ip: string) => boolean;
}

/**
 * A `lookup` for node:http and @urlresolve/http-resolver that only answers with allowed addresses.
 * A refusal is an error with code "BLOCKED". Every call checks again, so a name whose DNS answer
 * changes between two requests (DNS rebinding) is caught on the request that would go astray.
 * It never throws: every outcome reaches the callback.
 */
export function createSafeLookup({
  resolve = systemLookup,
  isAllowedAddress = isPublicAddress,
}: SafeLookupOptions = {}): LookupFunction {
  // Both returns use `as const`, which types the result as a list with at least one entry,
  // so `addresses[0]` below is known to exist.
  async function addressesFor(hostname: string, options: LookupAllOptions) {
    if (isIP(hostname) !== 0) {
      if (!isAllowedAddress(hostname))
        throw blocked(`${hostname} is a private or reserved address`);
      return [canonical(hostname)] as const;
    }
    const refusal = checkHostname(hostname);
    if (refusal) throw blocked(refusal);
    const [first, ...rest] = await resolve(hostname, options);
    if (!first) throw withCode(`No address found for ${hostname}`, "ENOTFOUND");
    // One private address in the answer is enough: the name points into a private network.
    // The message leaves the address out, so it never shows where an internal name points
    // (the BLOCKED status itself still shows that such a name exists).
    if (![first, ...rest].every((entry) => isAllowedAddress(entry.address))) {
      throw blocked(`${hostname} resolves to a private or reserved address`);
    }
    return [canonical(first.address), ...rest.map((entry) => canonical(entry.address))] as const;
  }

  return (hostname, options, callback) => {
    // Node always passes a number, but the type also allows "IPv4" and "IPv6".
    const family = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family;
    addressesFor(hostname, { all: true, family: family ?? 0 }).then(
      (addresses) => {
        if (options.all) callback(null, [...addresses]);
        else callback(null, addresses[0].address, addresses[0].family);
      },
      (error: NodeJS.ErrnoException) => callback(error, ""),
    );
  };
}

/** The lookup @urlresolve/core uses by default: public addresses only. */
export const safeLookup = createSafeLookup();

/**
 * The address the way Node prints a socket's peer ("2606:4700::1111", not "2606:4700:0:0::1111").
 * http-resolver compares the two as text.
 */
function canonical(address: string): LookupAddress {
  const family = isIP(address);
  const { address: text } = new SocketAddress({ address, family: family === 6 ? "ipv6" : "ipv4" });
  return { address: text, family };
}

function blocked(message: string): NodeJS.ErrnoException {
  return withCode(message, "BLOCKED");
}

function withCode(message: string, code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}
