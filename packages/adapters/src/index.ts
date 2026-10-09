import type { ShortenerAdapter } from "@urlresolve/types";

/**
 * The adapters resolveUrl() asks unless it is given a list of its own, in this order.
 *
 * None yet: so far no service has been found whose pages the generic readers get wrong while
 * the way on can still be shown. A service that guards its links with a CAPTCHA gets no adapter
 * either, because an adapter must not get past one.
 *
 * To add one:
 * 1. Write packages/adapters/src/<service>.ts that exports a ShortenerAdapter (the rules are on
 *    that type in @urlresolve/types).
 * 2. Test it against a copy of the service's page served by tests/fixtures/mock-server.ts, never
 *    against the real site.
 * 3. Add it to this list.
 */
export const adapters: readonly ShortenerAdapter[] = [];
