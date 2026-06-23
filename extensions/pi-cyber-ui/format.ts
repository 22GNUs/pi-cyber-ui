// Shared formatting helpers for the cyber UI.

interface CompactNumberUnit {
  suffix: string;
  scale: number;
}

export interface FormatCompactNumberOptions {
  /** Values below this threshold are returned without a suffix. */
  minValue?: number;
  /** Significant figures to keep once a suffix is used. */
  significantFigures?: number;
  /** Ordered from smallest suffix scale to largest. */
  units?: readonly CompactNumberUnit[];
}

const DEFAULT_COMPACT_UNITS = [
  { suffix: "k", scale: 1_000 },
  { suffix: "M", scale: 1_000_000 },
  { suffix: "B", scale: 1_000_000_000 },
] as const;

export function formatCompactNumber(
  value: number | undefined,
  options: FormatCompactNumberOptions = {},
): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return "";

  const minValue = options.minValue ?? 1_000;
  if (value < minValue) return `${value}`;

  const significantFigures = options.significantFigures ?? 3;
  const units = options.units ?? DEFAULT_COMPACT_UNITS;

  for (let i = 0; i < units.length; i++) {
    const unit = units[i]!;
    const scaled = value / unit.scale;
    const intDigits = Math.floor(Math.log10(scaled)) + 1;
    const decimals = Math.max(0, significantFigures - intDigits);
    const rounded = Number(scaled.toFixed(decimals));
    const isLastUnit = i === units.length - 1;

    // Unit thresholds use the rounded display value so 999_500 becomes 1.00M,
    // never the awkward carry value "1000k".
    if (rounded < 1_000 || isLastUnit) {
      return `${rounded.toFixed(decimals)}${unit.suffix}`;
    }
  }

  return `${value}`;
}
