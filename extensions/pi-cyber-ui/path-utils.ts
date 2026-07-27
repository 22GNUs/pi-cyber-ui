/**
 * Path display helpers for the footer. Two separate concerns:
 *
 *   shortenPathToWidth(raw, maxWidth) — smart truncation that folds and
 *     tail-clips to fit a hard terminal-column budget.
 *
 *   stylePath(raw) — paint a path with cyber colours: home tilde pink, dim
 *     separators, bold fg on the basename (no extra hue, weight signals
 *     "current location"). Returns ANSI text.
 */
import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";

import { palette, paint } from "./palette.js";

const PATH_MAX_DEPTH = 3;

// Path palette is intentionally muted: only the home `~` carries a hue
// (pink · tokyonight moon magenta), the basename gets weight (bold + fg)
// instead of an extra colour.
// Separators use silverDim — shared with the working spinner.

export function shortenPathToWidth(raw: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";

  let prefix = "";
  let parts: string[];
  if (raw === "~") return raw;
  if (raw.startsWith("~/")) {
    parts = ["~", ...raw.slice(2).split("/").filter(Boolean)];
  } else if (raw.startsWith("/")) {
    prefix = "/";
    parts = raw.slice(1).split("/").filter(Boolean);
  } else {
    parts = raw.split("/").filter(Boolean);
  }

  const join = (segments: string[]): string => {
    if (segments.length === 0) return prefix || raw;
    const body = segments.join("/");
    return prefix ? prefix + body : body;
  };

  const foldByDepth = (segments: string[]): string[] => {
    const hasRootMarker = segments[0] === "~";
    const offset = hasRootMarker ? 1 : 0;
    const logicalDepth = Math.max(0, segments.length - offset);
    if (logicalDepth <= PATH_MAX_DEPTH) return segments;
    return [segments[0]!, "…", ...segments.slice(-2)];
  };

  const depthFolded = foldByDepth(parts);
  const full = join(depthFolded);
  const fits = (text: string) => visibleWidth(text) <= maxWidth;
  if (fits(full)) return full;

  if (depthFolded.length >= 2) {
    const tail2 = join([depthFolded[0]!, "…", ...depthFolded.slice(-2)]);
    if (fits(tail2)) return tail2;

    const tail1 = join([depthFolded[0]!, "…", depthFolded[depthFolded.length - 1]!]);
    if (fits(tail1)) return tail1;
  }

  if (maxWidth === 1) return "…";
  const tailBudget = maxWidth - 1;
  let tail = "";
  for (const character of [...full].reverse()) {
    const candidate = character + tail;
    if (visibleWidth(candidate) > tailBudget) break;
    tail = candidate;
  }
  return `…${tail}`;
}

export function stylePath(raw: string): string {
  if (raw.length === 0) return "";

  let prefix = "";
  let parts: string[];
  if (raw.startsWith("~/")) {
    parts = ["~", ...raw.slice(2).split("/").filter(Boolean)];
  } else if (raw === "~") {
    parts = ["~"];
  } else if (raw.startsWith("/")) {
    prefix = paint(palette.silverDim, "/");
    parts = raw.slice(1).split("/").filter(Boolean);
  } else {
    parts = raw.split("/").filter(Boolean);
  }

  const slash = paint(palette.silverDim, "/");
  const styled = parts
    .map((part, index) => {
      if (part === "…") return paint(palette.silverDim, part);
      const isLast = index === parts.length - 1;
      if (part === "~") return paint(palette.pink, part, true);
      // Basename: bold fg, no extra hue. Lets `~` and silverDim separators
      // carry the only colour cues, while weight signals "current location".
      if (isLast) return paint(palette.fg, part, true);
      return paint(palette.silverDim, part);
    })
    .join(slash);

  return `${prefix}${styled}`;
}

/** Return the home-relative form of cwd: `/Users/me/x` → `~/x`. */
export function homeRelative(cwd: string): string {
  const home = homedir();
  if (!home) return cwd;

  const relativePath = relative(home, cwd);
  if (relativePath === "") return "~";
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return cwd;
  }
  return `~/${relativePath.split(sep).join("/")}`;
}
