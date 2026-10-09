import { describe, expect, it } from "vitest";
import { analyzeTracking } from "./index.ts";

const clean = (href: string) => analyzeTracking(new URL(href)).cleanUrl;
const kinds = (href: string) =>
  analyzeTracking(new URL(href)).parameters.map(({ name, kind }) => `${name}:${kind}`);

describe("analyzeTracking", () => {
  it("tells tracking parameters from functional ones (the spec's example)", () => {
    expect(analyzeTracking(new URL("https://example.com/page?id=123&utm_source=test"))).toEqual({
      cleanUrl: "https://example.com/page?id=123",
      parameters: [
        { name: "id", value: "123", kind: "functional" },
        { name: "utm_source", value: "test", kind: "tracking" },
      ],
    });
  });

  it.each([
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "utm_id",
    "utm_source_platform",
    "gclid",
    "gclsrc",
    "gad_source",
    "dclid",
    "gbraid",
    "wbraid",
    "srsltid",
    "_ga",
    "_gl",
    "fbclid",
    "igshid",
    "igsh",
    "msclkid",
    "twclid",
    "ttclid",
    "li_fat_id",
    "epik",
    "yclid",
    "mc_cid",
    "mc_eid",
    "_hsenc",
    "_hsmi",
    "vero_id",
    "vero_conv",
    "oly_anon_id",
    "oly_enc_id",
    // Names are matched without regard to case.
    "UTM_Source",
    "FBCLID",
  ])("takes out %s", (name) => {
    expect(kinds(`https://a.test/p?${name}=x`)).toEqual([`${name}:tracking`]);
    expect(clean(`https://a.test/p?${name}=x`)).toBe("https://a.test/p");
  });

  it.each(["id", "q", "query", "search", "page", "lang", "v", "ID"])(
    "keeps %s, which chooses what the page shows",
    (name) => {
      expect(kinds(`https://a.test/p?${name}=1`)).toEqual([`${name}:functional`]);
      expect(clean(`https://a.test/p?${name}=1`)).toBe(`https://a.test/p?${name}=1`);
    },
  );

  it.each([
    ["ref", "a name that some sites need and others use for tracking"],
    ["s", "X's share code, but a search on many other sites"],
    ["si", "a share code on YouTube and Spotify, anything elsewhere"],
    ["mkt_tok", "Marketo's unsubscribe and web-view pages read it to know who clicked"],
    ["utmsource", "a name that only looks like a utm_ tag"],
    ["my_fbclid", "a name that only contains a tracking name"],
    ["gclid_x", "a name that only starts with one"],
    ["token", "a parameter the page may need"],
  ])("keeps %s as unknown (%s)", (name) => {
    expect(kinds(`https://a.test/p?${name}=1`)).toEqual([`${name}:unknown`]);
    expect(clean(`https://a.test/p?${name}=1`)).toBe(`https://a.test/p?${name}=1`);
  });

  it("keeps the order and spelling of the other parameters, and the #fragment", () => {
    expect(clean("https://a.test/p?b=%2F&utm_medium=email&a=x%20y&c=1,2&d=a+b#top")).toBe(
      "https://a.test/p?b=%2F&a=x%20y&c=1,2&d=a+b#top",
    );
  });

  it("drops the ? when only tracking parameters were there", () => {
    expect(clean("https://a.test/p?utm_source=x&gclid=y#top")).toBe("https://a.test/p#top");
  });

  it("takes out, and lists, every copy of a tracking parameter", () => {
    expect(clean("https://a.test/p?utm_source=a&id=1&utm_source=b")).toBe("https://a.test/p?id=1");
    expect(kinds("https://a.test/p?utm_source=a&id=1&utm_source=b")).toEqual([
      "utm_source:tracking",
      "id:functional",
      "utm_source:tracking",
    ]);
  });

  it("keeps a ? at the start of the first piece it keeps", () => {
    expect(clean("https://a.test/p??utm_source=x&utm_medium=y")).toBe(
      "https://a.test/p??utm_source=x",
    );
    expect(clean("https://a.test/p?utm_source=x&?id=1")).toBe("https://a.test/p??id=1");
  });

  it("reads a ; as part of a value, as URLSearchParams does", () => {
    expect(analyzeTracking(new URL("https://a.test/p?id=1;utm_source=x"))).toEqual({
      cleanUrl: "https://a.test/p?id=1;utm_source=x",
      parameters: [{ name: "id", value: "1;utm_source=x", kind: "functional" }],
    });
  });

  it("never throws on a stray %, which stays as it is", () => {
    expect(analyzeTracking(new URL("https://a.test/p?q=50%+off&utm_source=x"))).toEqual({
      cleanUrl: "https://a.test/p?q=50%+off",
      parameters: [
        { name: "q", value: "50% off", kind: "functional" },
        { name: "utm_source", value: "x", kind: "tracking" },
      ],
    });
  });

  it("leaves a URL without tracking parameters exactly as it was", () => {
    for (const href of [
      "https://a.test/p",
      "https://a.test/p?",
      "https://a.test/p?a=1&&b=2&",
      "https://a.test/p#utm_source=x",
    ]) {
      expect(analyzeTracking(new URL(href)).cleanUrl).toBe(href);
    }
    expect(analyzeTracking(new URL("https://a.test/p?")).parameters).toEqual([]);
  });

  it("drops empty pieces once it takes something out", () => {
    expect(clean("https://a.test/p?a=1&&utm_source=x&")).toBe("https://a.test/p?a=1");
  });

  it("decodes names and values the way a server reads them", () => {
    expect(
      analyzeTracking(new URL("https://a.test/p?utm%5Fsource=a%20b&q=c+d&next=/x?y=z")),
    ).toEqual({
      cleanUrl: "https://a.test/p?q=c+d&next=/x?y=z",
      parameters: [
        { name: "utm_source", value: "a b", kind: "tracking" },
        { name: "q", value: "c d", kind: "functional" },
        { name: "next", value: "/x?y=z", kind: "unknown" },
      ],
    });
  });

  it("reports a parameter without a value", () => {
    expect(analyzeTracking(new URL("https://a.test/p?utm_source&id"))).toEqual({
      cleanUrl: "https://a.test/p?id",
      parameters: [
        { name: "utm_source", value: "", kind: "tracking" },
        { name: "id", value: "", kind: "functional" },
      ],
    });
  });

  it("does not read ?utm_source inside a query as utm_source", () => {
    expect(kinds("https://a.test/p?a=1&?utm_source=x")).toEqual([
      "a:unknown",
      "?utm_source:unknown",
    ]);
    expect(clean("https://a.test/p?a=1&?utm_source=x")).toBe("https://a.test/p?a=1&?utm_source=x");
  });
});
