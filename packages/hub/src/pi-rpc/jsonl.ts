/**
 * Strict JSONL framing for Pi RPC (docs/research/pi-rpc.md):
 * records are split ONLY on LF (0x0A); an optional preceding CR is stripped.
 * node:readline is not used because it also splits on U+2028/U+2029, which are
 * valid inside JSON strings. Splitting on bytes keeps multi-byte UTF-8 characters
 * that straddle chunk boundaries intact.
 */
export type JsonlRecord = { ok: true; value: unknown } | { ok: false; error: string; line: string };

const LF = 0x0a;
const CR = 0x0d;

export class JsonlDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  /** Feed a chunk; returns every complete record it closed. */
  push(chunk: Buffer | string): JsonlRecord[] {
    const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
    const out: JsonlRecord[] = [];
    let start = 0;
    for (let i = this.buffer.indexOf(LF, start); i !== -1; i = this.buffer.indexOf(LF, start)) {
      let end = i;
      if (end > start && this.buffer[end - 1] === CR) end -= 1;
      const line = this.buffer.subarray(start, end).toString("utf8");
      start = i + 1;
      if (line.trim() === "") continue;
      try {
        out.push({ ok: true, value: JSON.parse(line) as unknown });
      } catch (e) {
        out.push({ ok: false, error: (e as Error).message, line });
      }
    }
    this.buffer = this.buffer.subarray(start);
    return out;
  }

  /** Bytes received after the last LF (an unterminated record). */
  get pending(): number {
    return this.buffer.length;
  }
}

export function encodeJsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
