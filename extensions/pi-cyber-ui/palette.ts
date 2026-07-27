/**
 * Shared cyber palette — single source of truth for RGB colors.
 *
 * All colors are derived from `themes/cyber-ui-dark.json` `vars`. Animations
 * that need interpolation (working spinner / letter-wave) use the RGB values
 * directly via `mix()`; static surfaces use `paint()` / `rgb()`.
 *
 * Why import the theme JSON instead of pi's Theme API? Pi's `ThemeColor` is a
 * closed union and `Theme` exposes named colors only as ANSI-wrapped strings
 * (`theme.fg(name, text)`) — it cannot surface the private silver / pink /
 * promptSilver tokens, nor raw RGB for interpolation. Importing the theme JSON
 * keeps `themes/cyber-ui-dark.json` as the single source for every color,
 * including the ones only this UI uses.
 */
import themeVars from "../../themes/cyber-ui-dark.json" with { type: "json" };

export type RGB = readonly [number, number, number];

export const RESET_FG = "\x1b[39m";
export const RESET_BG = "\x1b[49m";
export const BOLD = "\x1b[1m";
export const UNBOLD = "\x1b[22m";

function hexToRgb(hex: string): RGB {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`Invalid cyber palette color: ${hex}`);
  const h = hex.slice(1);
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ] as RGB;
}

/** ANSI truecolor fg prefix for the given RGB. */
export function rgb(c: RGB): string {
  return `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
}

/** ANSI truecolor bg prefix for the given RGB. */
export function bgRgb(c: RGB): string {
  return `\x1b[48;2;${c[0]};${c[1]};${c[2]}m`;
}

/** Wrap text in an fg color (optionally bold). Resets after. */
export function paint(color: RGB, text: string, bold = false): string {
  const open = bold ? `${BOLD}${rgb(color)}` : rgb(color);
  const close = bold ? `${RESET_FG}${UNBOLD}` : RESET_FG;
  return `${open}${text}${close}`;
}

/** Linear interpolation between two RGB colors. `t` clamped to [0, 1]. */
export function mix(a: RGB, b: RGB, t: number): RGB {
  const k = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ] as RGB;
}

const v = themeVars.vars as Record<string, string>;
const resolve = (name: string): RGB => {
  const value = v[name];
  if (!value) throw new Error(`Missing cyber palette variable: ${name}`);
  return hexToRgb(value);
};

/**
 * Named RGB constants — derived from theme `vars` (single source).
 * Kept as a namespace object so call sites read `palette.fgDim` etc.
 */
export const palette = {
  bg: resolve("bg"),
  fg: resolve("fg"),
  fgMuted: resolve("fgMuted"),
  fgDim: resolve("fgDim"),
  bgAlt: resolve("bgAlt"),
  toolSurface: resolve("toolSurface"),
  toolErrorBg: resolve("toolErrorBg"),
  userInputBg: resolve("userInputBg"),
  cyan: resolve("cyan"),
  blue: resolve("blue"),
  teal: resolve("teal"),
  tealDark: resolve("tealDark"),
  green: resolve("green"),
  orange: resolve("orange"),
  red: resolve("red"),
  silverDim: resolve("silverDim"),
  silver: resolve("silver"),
  silverHi: resolve("silverHi"),
  pink: resolve("pink"),
  promptSilver: resolve("promptSilver"),
} as const;
