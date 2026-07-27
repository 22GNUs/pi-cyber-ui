/**
 * Lightweight streaming token estimation for providers that do not expose
 * cumulative usage while a message is still arriving.
 *
 * The estimator preserves word/run boundaries across deltas instead of
 * aggregating every Latin character into one global bucket. It deliberately
 * stays dependency-free and is replaced by provider usage as soon as a
 * positive cumulative output count appears.
 */

type RunKind = "asciiWord" | "digit" | "unicodeWord";

const UNICODE_WORD = /[\p{L}\p{M}]/u;

function isCjk(cp: number): boolean {
  return (
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0xff00 && cp <= 0xffef)
  );
}

function estimateRun(kind: RunKind | undefined, length: number): number {
  if (!kind || length <= 0) return 0;
  if (kind === "digit") return Math.ceil(length / 3);
  if (kind === "asciiWord") return Math.ceil(length / 4);
  return Math.ceil(length / 2.5);
}

/** Incremental estimator that keeps the current lexical run across chunks. */
export class StreamingTokenEstimator {
  private settled = 0;
  private runKind: RunKind | undefined;
  private runLength = 0;

  reset(): void {
    this.settled = 0;
    this.runKind = undefined;
    this.runLength = 0;
  }

  add(delta: string): void {
    for (const character of delta) {
      const cp = character.codePointAt(0) ?? 0;
      let nextRun: RunKind | undefined;

      if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) {
        nextRun = "asciiWord";
      } else if (cp >= 0x30 && cp <= 0x39) {
        nextRun = "digit";
      } else if (!isCjk(cp) && cp >= 0x80 && UNICODE_WORD.test(character)) {
        nextRun = "unicodeWord";
      }

      if (nextRun) {
        if (this.runKind !== nextRun) {
          this.flushRun();
          this.runKind = nextRun;
        }
        this.runLength += 1;
        continue;
      }

      this.flushRun();
      if (/\s/u.test(character)) continue;
      if (isCjk(cp)) {
        this.settled += 1;
      } else if (cp < 0x80) {
        this.settled += 1;
      } else {
        // Emoji and symbols commonly occupy more than one token; UTF-8 byte
        // width is a cheap conservative proxy without loading encoder tables.
        this.settled += Math.max(1, Math.ceil(Buffer.byteLength(character, "utf8") / 3));
      }
    }
  }

  value(): number {
    return this.settled + estimateRun(this.runKind, this.runLength);
  }

  private flushRun(): void {
    this.settled += estimateRun(this.runKind, this.runLength);
    this.runKind = undefined;
    this.runLength = 0;
  }
}
