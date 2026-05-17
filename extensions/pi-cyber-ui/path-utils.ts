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
const PATH_MAX_DEPTH = 3;
const RESET = "\x1b[39m";
const BOLD = "\x1b[1m";
const UNBOLD = "\x1b[22m";

type RGB = readonly [number, number, number];

// Path palette is intentionally muted: only the home `~` carries a hue,
// the basename gets weight (bold + fg) instead of an extra colour. This
// removes a major source of cyan repetition in the footer.
const C = {
  hotPink: [255, 130, 184] as RGB,
  dim: [112, 124, 146] as RGB,
  // Tokyo Night fg — same as theme `text`. Used for the basename.
  fg: [192, 202, 245] as RGB,
};

function rgb(c: RGB): string {
  return `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
}

function paint(color: RGB, text: string, bold = false): string {
  const open = bold ? `${BOLD}${rgb(color)}` : rgb(color);
  const close = bold ? `${RESET}${UNBOLD}` : RESET;
  return `${open}${text}${close}`;
}

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
    prefix = paint(C.dim, "/");
    parts = raw.slice(1).split("/").filter(Boolean);
  } else {
    parts = raw.split("/").filter(Boolean);
  }

  const slash = paint(C.dim, "/");
  const styled = parts
    .map((part, index) => {
      if (part === "…") return paint(C.dim, part);
      const isLast = index === parts.length - 1;
      if (part === "~") return paint(C.hotPink, part, true);
      // Basename: bold fg, no extra hue. Lets `~` and dim separators carry
      // the only colour cues, while weight signals "current location".
      if (isLast) return paint(C.fg, part, true);
      return paint(C.dim, part);
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
