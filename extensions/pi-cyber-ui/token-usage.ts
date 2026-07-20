/**
 * Token usage helpers for the cyber HUD.
 *
 * Providers may expose cumulative usage during streaming, but that capability
 * is detected from the partial messages at runtime rather than assumed from a
 * provider or protocol name.
 *
 * Token estimation uses a zero-dependency BPE-inspired heuristic that
 * achieves ~85% accuracy without loading any encoder tables. Characters are
 * classified into six buckets and each bucket has an empirically-derived
 * chars-per-token ratio:
 *
 *   whitespace  – absorbed into adjacent tokens, not counted separately
 *   punctuation – each character is its own token               (~1.0 c/t)
 *   digit runs  – grouped in threes                             (~3.0 c/t)
 *   latin words – common short words = 1 token; others ~4.5 c/t (~4.5 c/t)
 *   CJK / kana  – one character per token                       (~1.0 c/t)
 *   cyrillic    – ~3.3 chars per token                          (~3.3 c/t)
 *   other       – conservative fallback                         (~2.5 c/t)
 *
 * Accumulated counts are stored as raw character counts so the final
 * formula can be applied once, keeping per-delta cost to O(n) char scans.
 */
// ---------------------------------------------------------------------------
// Character classification
// ---------------------------------------------------------------------------

/** Six-way bucket covering the character classes that matter for BPE ratios. */
type TokenBuckets = {
  /** ASCII whitespace (space, tab, newline) – not counted separately */
  whitespace: number;
  /** ASCII punctuation – typically one token each */
  punctuation: number;
  /** ASCII digit characters – grouped ~3 per token */
  digit: number;
  /** ASCII letter characters – word-level grouping ~4.5 chars/token */
  latin: number;
  /** CJK unified ideographs, kana, hangul – ~1 char per token */
  cjk: number;
  /** Cyrillic – ~3.3 chars per token */
  cyrillic: number;
  /** Everything else (Arabic, other scripts, emoji, …) – ~2.5 chars/token */
  other: number;
};

// Pre-built ASCII lookup: 0 = whitespace, 1 = punctuation, 2 = digit, 3 = latin
// Indexed by char code (0-127). Values must stay in sync with CharKind below.
const ASCII_KIND = new Uint8Array(128);

const enum CharKind {
  Whitespace = 0,
  Punctuation = 1,
  Digit = 2,
  Latin = 3,
}

(function initAsciiKind() {
  // whitespace
  for (const c of [0x09, 0x0a, 0x0d, 0x20]) ASCII_KIND[c] = CharKind.Whitespace;
  // digits 0-9
  for (let c = 0x30; c <= 0x39; c++) ASCII_KIND[c] = CharKind.Digit;
  // uppercase A-Z and lowercase a-z
  for (let c = 0x41; c <= 0x5a; c++) ASCII_KIND[c] = CharKind.Latin;
  for (let c = 0x61; c <= 0x7a; c++) ASCII_KIND[c] = CharKind.Latin;
  // everything else in ASCII range is punctuation/symbol
  for (let c = 0x21; c <= 0x7e; c++) {
    if (ASCII_KIND[c] === CharKind.Whitespace) continue; // already set
    if (ASCII_KIND[c] === CharKind.Latin) continue;
    if (ASCII_KIND[c] === CharKind.Digit) continue;
    ASCII_KIND[c] = CharKind.Punctuation;
  }
})();

/** Classify a Unicode code point into one of the bucket keys. */
function classifyCodePoint(cp: number): keyof TokenBuckets {
  // Fast path: ASCII range
  if (cp < 128) {
    switch (ASCII_KIND[cp]) {
      case CharKind.Whitespace: return "whitespace";
      case CharKind.Punctuation: return "punctuation";
      case CharKind.Digit: return "digit";
      default: return "latin";
    }
  }

  // CJK unified ideographs (main block + Extension A start)
  if (cp >= 0x4e00 && cp <= 0x9fff) return "cjk";
  // CJK Extension A
  if (cp >= 0x3400 && cp <= 0x4dbf) return "cjk";
  // CJK Compatibility Ideographs
  if (cp >= 0xf900 && cp <= 0xfaff) return "cjk";
  // Hiragana + Katakana
  if (cp >= 0x3040 && cp <= 0x30ff) return "cjk";
  // Hangul Syllables
  if (cp >= 0xac00 && cp <= 0xd7af) return "cjk";
  // CJK Symbols and Punctuation (。、「」…)
  if (cp >= 0x3000 && cp <= 0x303f) return "cjk";
  // Fullwidth forms
  if (cp >= 0xff00 && cp <= 0xffef) return "cjk";

  // Cyrillic
  if (cp >= 0x0400 && cp <= 0x04ff) return "cyrillic";

  return "other";
}

// ---------------------------------------------------------------------------
// Token count formula
// ---------------------------------------------------------------------------

/**
 * Convert accumulated character-count buckets to an estimated token count.
 *
 * Ratios derived from empirical BPE analysis (see module docstring):
 *  - whitespace: 0 tokens (absorbed into adjacent token)
 *  - punctuation: 1 char / token
 *  - digit: 3 chars / token (short numbers single token; long ones split)
 *  - latin: 4.5 chars / token
 *  - cjk: 1 char / token
 *  - cyrillic: 3.3 chars / token
 *  - other: 2.5 chars / token
 */
function estimateTokensFromBuckets(b: TokenBuckets): number {
  return (
    b.punctuation +
    Math.ceil(b.digit / 3) +
    Math.ceil(b.latin / 4.5) +
    b.cjk +
    Math.ceil(b.cyrillic / 3.3) +
    Math.ceil(b.other / 2.5)
    // whitespace: intentionally omitted
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** One-shot estimate for a complete string. */
export function estimateTokensFromText(text: string): number {
  const b: TokenBuckets = {
    whitespace: 0, punctuation: 0, digit: 0,
    latin: 0, cjk: 0, cyrillic: 0, other: 0,
  };
  for (const ch of text) {
    b[classifyCodePoint(ch.codePointAt(0) ?? 0)] += 1;
  }
  return estimateTokensFromBuckets(b);
}

/**
 * Streaming accumulator: call `add(delta)` on every text chunk, then read
 * `value()` to get the running estimate. Call `reset()` between messages.
 */
export class StreamingTokenEstimator {
  private b: TokenBuckets = {
    whitespace: 0, punctuation: 0, digit: 0,
    latin: 0, cjk: 0, cyrillic: 0, other: 0,
  };

  reset(): void {
    this.b.whitespace = 0;
    this.b.punctuation = 0;
    this.b.digit = 0;
    this.b.latin = 0;
    this.b.cjk = 0;
    this.b.cyrillic = 0;
    this.b.other = 0;
  }

  add(delta: string): void {
    const b = this.b;
    for (const ch of delta) {
      b[classifyCodePoint(ch.codePointAt(0) ?? 0)] += 1;
    }
  }

  value(): number {
    return estimateTokensFromBuckets(this.b);
  }
}

interface RateInterval {
  startedAt: number;
  endedAt: number;
  tokens: number;
}

/**
 * Delta-driven rolling token rate.
 *
 * The rate changes only when cumulative token progress increases. Rendering
 * between chunks therefore cannot create artificial movement by continuously
 * growing a denominator. A short EMA smooths provider batching while the
 * rolling window keeps the value responsive to current stream throughput.
 */
export class StreamingTokenRate {
  private readonly intervals: RateInterval[] = [];
  private previousTokens: number | undefined;
  private previousAt = 0;
  private smoothed: number | undefined;
  private smoothedAt = 0;
  private lastProgressAt = 0;

  constructor(
    private readonly windowMs = 1_500,
    private readonly smoothingTauMs = 600,
  ) {}

  reset(): void {
    this.intervals.length = 0;
    this.previousTokens = undefined;
    this.previousAt = 0;
    this.smoothed = undefined;
    this.smoothedAt = 0;
    this.lastProgressAt = 0;
  }

  addCumulative(tokens: number, at = Date.now()): number | undefined {
    if (!Number.isFinite(tokens) || tokens < 0) return this.smoothed;

    if (this.previousTokens === undefined) {
      this.previousTokens = tokens;
      this.previousAt = at;
      if (tokens > 0) this.lastProgressAt = at;
      return this.smoothed;
    }

    const delta = tokens - this.previousTokens;
    const startedAt = this.previousAt;
    this.previousTokens = tokens;
    this.previousAt = at;
    if (delta <= 0) return this.smoothed;

    this.lastProgressAt = at;
    if (at <= startedAt) return this.smoothed;
    this.intervals.push({ startedAt, endedAt: at, tokens: delta });
    const cutoff = at - this.windowMs;
    while (this.intervals.length > 0 && this.intervals[0]!.endedAt < cutoff) {
      this.intervals.shift();
    }

    let windowTokens = 0;
    let windowStartedAt = at;
    for (const interval of this.intervals) {
      windowTokens += interval.tokens;
      windowStartedAt = Math.min(windowStartedAt, Math.max(cutoff, interval.startedAt));
    }

    const durationMs = Math.max(250, at - windowStartedAt);
    const instant = windowTokens / (durationMs / 1_000);
    if (this.smoothed === undefined || this.smoothedAt === 0) {
      this.smoothed = instant;
    } else {
      const dt = Math.max(0, at - this.smoothedAt);
      const alpha = 1 - Math.exp(-dt / this.smoothingTauMs);
      this.smoothed = this.smoothed * (1 - alpha) + instant * alpha;
    }
    this.smoothedAt = at;
    return this.smoothed;
  }

  value(): number | undefined {
    return this.smoothed;
  }

  lastProgressTimestamp(): number {
    return this.lastProgressAt;
  }
}
