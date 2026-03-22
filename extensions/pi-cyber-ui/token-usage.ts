/**
 * Token usage helpers for the cyber HUD.
 *
 * Exact mode is determined by the API/protocol, not the provider name.
 * Anthropic Messages API (and any provider using the same request protocol)
 * can expose cumulative streaming usage, so we can display exact in-flight
 * output tokens.
 */
import type { Api } from "@mariozechner/pi-ai";

export type UsageMode = "exact" | "estimated";

const EXACT_USAGE_APIS = new Set<Api | string>(["anthropic-messages"]);

export function supportsExactUsage(api?: Api | string): boolean {
  return api !== undefined && EXACT_USAGE_APIS.has(api);
}

export function getUsageMode(api?: Api | string): UsageMode {
  return supportsExactUsage(api) ? "exact" : "estimated";
}

type TokenBuckets = {
  ascii: number;
  cjk: number;
  other: number;
};

function classifyCodePoint(codePoint: number): keyof TokenBuckets {
  if (
    (codePoint >= 0x3400 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af)
  ) {
    return "cjk";
  }

  if (codePoint <= 0x7f) return "ascii";
  return "other";
}

export function estimateTokensFromText(text: string): number {
  const buckets: TokenBuckets = { ascii: 0, cjk: 0, other: 0 };

  for (const ch of text) {
    const codePoint = ch.codePointAt(0) ?? 0;
    buckets[classifyCodePoint(codePoint)] += 1;
  }

  return estimateTokensFromBuckets(buckets);
}

function estimateTokensFromBuckets(buckets: TokenBuckets): number {
  return (
    buckets.cjk +
    Math.ceil(buckets.ascii / 4) +
    Math.ceil(buckets.other / 2)
  );
}

export class StreamingTokenEstimator {
  private buckets: TokenBuckets = { ascii: 0, cjk: 0, other: 0 };

  reset(): void {
    this.buckets.ascii = 0;
    this.buckets.cjk = 0;
    this.buckets.other = 0;
  }

  add(delta: string): void {
    for (const ch of delta) {
      const codePoint = ch.codePointAt(0) ?? 0;
      this.buckets[classifyCodePoint(codePoint)] += 1;
    }
  }

  value(): number {
    return estimateTokensFromBuckets(this.buckets);
  }
}
