import { describe, expect, it } from "vitest";
import { encodeJsonl, JsonlDecoder } from "../src/pi-rpc/jsonl.js";

describe("JSONL framing", () => {
  it("does not split on U+2028/U+2029 inside strings", () => {
    const d = new JsonlDecoder();
    const recs = d.push(`{"t":"a b c"}\n{"t":2}\n`);
    expect(recs).toEqual([
      { ok: true, value: { t: "a b c" } },
      { ok: true, value: { t: 2 } },
    ]);
  });

  it("reassembles records and multi-byte characters split across chunks", () => {
    const d = new JsonlDecoder();
    const bytes = Buffer.from(encodeJsonl({ text: "привет 👋" }));
    const cut = bytes.indexOf(0xd0) + 1; // inside a Cyrillic character
    expect(d.push(bytes.subarray(0, cut))).toEqual([]);
    expect(d.pending).toBe(cut);
    expect(d.push(bytes.subarray(cut))).toEqual([{ ok: true, value: { text: "привет 👋" } }]);
    expect(d.pending).toBe(0);
  });

  it("strips CR, skips blank lines and reports malformed lines without throwing", () => {
    const d = new JsonlDecoder();
    const recs = d.push('{"a":1}\r\n\n{oops}\n');
    expect(recs[0]).toEqual({ ok: true, value: { a: 1 } });
    expect(recs[1]).toMatchObject({ ok: false, line: "{oops}" });
    expect(recs).toHaveLength(2);
  });
});
