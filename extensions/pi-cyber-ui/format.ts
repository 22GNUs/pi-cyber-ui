// Shared formatting helpers for the cyber UI.

const COMPACT_UNITS = [
  { suffix: "k", scale: 1_000 },
  { suffix: "M", scale: 1_000_000 },
  { suffix: "B", scale: 1_000_000_000 },
] as const;

/**
 * Compact human number: 9_100 -> "9.10k", 128_000 -> "128k", 1_050_000 ->
 * "1.05M". Values below 1000 are returned as-is; trailing zeros are kept so
 * the last digit advertises its granularity.
 */
export function formatCompactNumber(
  value: number | undefined,
  significantFigures = 3,
): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return "";
  if (value < 1_000) return `${value}`;

  for (let i = 0; i < COMPACT_UNITS.length; i++) {
    const unit = COMPACT_UNITS[i]!;
    const scaled = value / unit.scale;
    const intDigits = Math.floor(Math.log10(scaled)) + 1;
    const decimals = Math.max(0, significantFigures - intDigits);
    const rounded = Number(scaled.toFixed(decimals));
    const isLastUnit = i === COMPACT_UNITS.length - 1;

    // Unit thresholds use the rounded display value so 999_500 becomes 1.00M,
    // never the awkward carry value "1000k".
    if (rounded < 1_000 || isLastUnit) {
      return `${rounded.toFixed(decimals)}${unit.suffix}`;
    }
  }

  return `${value}`;
}
