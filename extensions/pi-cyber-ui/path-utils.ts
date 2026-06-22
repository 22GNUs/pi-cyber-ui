/**
 * Path display helpers shared by footer (cwd display) and previously the
 * editor HUD. Two separate concerns:
 *
 *   shortenPathToWidth(raw, maxWidth) — smart truncation that progressively
 *     folds, initials, and tail-clips to fit a hard column budget.
 *
 *   stylePath(raw) — paint a path with cyber colours: home tilde pink, dim
 *     separators, bold fg on the basename (no extra hue, weight signals
 *     "current location"). Returns ANSI text.
 */
import { palette, paint } from "./palette.js";

const PATH_MAX_DEPTH = 3;

// Path palette is intentionally muted: only the home `~` carries a hue
// (hotPink), the basename gets weight (bold + fg) instead of an extra colour.
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
  if (full.length <= maxWidth) return full;

  if (depthFolded.length > 2) {
    const initialed = depthFolded.map((part, index) => {
      if (part === "…") return part;
      if (index === 0 || index >= depthFolded.length - 2) return part;
      return part[0] ?? part;
    });
    const candidate = join(initialed);
    if (candidate.length <= maxWidth) return candidate;
  }

  if (depthFolded.length >= 2) {
    const tail2 = join([depthFolded[0]!, "…", ...depthFolded.slice(-2)]);
    if (tail2.length <= maxWidth) return tail2;

    const tail1 = join([depthFolded[0]!, "…", depthFolded[depthFolded.length - 1]!]);
    if (tail1.length <= maxWidth) return tail1;
  }

  if (maxWidth === 1) return "…";
  return `…${full.slice(-(maxWidth - 1))}`;
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
      if (part === "~") return paint(palette.hotPink, part, true);
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
  const home = process.env.HOME ?? "";
  if (home && (cwd === home || cwd.startsWith(`${home}/`))) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}
