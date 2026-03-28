import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

import type { CyberHudSnapshot, ResetNotice } from "./editor-state.js";

const SEP = " ∷ ";
const TURN_ICON = "󰄉";
const PATH_MAX_DEPTH = 3;
const RESET = "\x1b[39m";
const BOLD = "\x1b[1m";
const UNBOLD = "\x1b[22m";

type RGB = readonly [number, number, number];
type BorderColorFn = (text: string) => string;

const C = {
  hotPink: [255, 130, 184] as RGB,
  dim: [112, 124, 146] as RGB,
  muted: [162, 176, 196] as RGB,
  accent: [137, 219, 255] as RGB,
  success: [122, 217, 166] as RGB,
  warning: [255, 202, 112] as RGB,
  error: [255, 136, 136] as RGB,
} as const;

function rgb(c: RGB): string {
  return `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
}

function paint(color: RGB, text: string, bold = false): string {
  const weight = bold ? BOLD : "";
  const unweight = bold ? UNBOLD : "";
  return `${weight}${rgb(color)}${text}${unweight}${RESET}`;
}

function fill(borderColor: BorderColorFn, width: number): string {
  return width > 0 ? borderColor("─".repeat(width)) : "";
}

function fmt(n: number): string {
  if (n < 1_000) return `${n}`;
  if (n < 10_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function tpsColor(v: number): RGB {
  return v > 300 ? C.success : v > 150 ? C.accent : v > 50 ? C.warning : C.error;
}

function shortenPath(raw: string, maxWidth: number): string {
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

function stylePath(raw: string): string {
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
  const styled = parts.map((part, index) => {
    if (part === "…") return paint(C.dim, part);
    const isLast = index === parts.length - 1;
    if (part === "~") return paint(C.hotPink, part, true);
    if (isLast) return paint(C.accent, part);
    return paint(C.dim, part);
  }).join(slash);

  return `${prefix}${styled}`;
}

function renderResetNotice(notice: ResetNotice): string {
  const label = notice.kind === "compact" ? "cmp" : "tree";
  return paint(C.warning, label);
}

function joinParts(parts: string[]): string {
  const filtered = parts.filter(Boolean);
  if (filtered.length === 0) return "";
  return filtered.join(paint(C.dim, SEP));
}

function composeBorderLine(
  width: number,
  borderColor: BorderColorFn,
  leftCandidates: string[],
  rightCandidates: string[],
): string {
  const lefts = leftCandidates.length > 0 ? leftCandidates : [""];
  const rights = rightCandidates.length > 0 ? rightCandidates : [""];

  for (const right of rights) {
    for (const left of lefts) {
      const leftWidth = visibleWidth(left);
      const rightWidth = visibleWidth(right);
      if (leftWidth + rightWidth > width) continue;

      const gap = width - leftWidth - rightWidth;
      if (!left && !right) return fill(borderColor, width);
      if (!left) return `${fill(borderColor, gap)}${right}`;
      if (!right) return `${left}${fill(borderColor, gap)}`;
      return `${left}${fill(borderColor, gap)}${right}`;
    }
  }

  const right = rights.find(Boolean) ?? "";
  if (right) return truncateToWidth(right, width, "");

  const left = lefts.find(Boolean) ?? "";
  if (left) return truncateToWidth(left, width, "");

  return fill(borderColor, width);
}

function renderTurn(snapshot: CyberHudSnapshot): string {
  if (!snapshot.promptActive) return "";
  return paint(C.dim, `${TURN_ICON}${Math.max(1, snapshot.promptTurns)}`);
}

function renderInput(snapshot: CyberHudSnapshot): string {
  const inTk = snapshot.inputValue;
  if (inTk !== undefined) return paint(C.muted, `↑${fmt(inTk)}`);
  if (snapshot.promptActive && snapshot.promptIn > 0) {
    return paint(C.dim, `↑${fmt(snapshot.promptIn)}+…`);
  }
  if (snapshot.promptActive) return paint(C.dim, "↑…");
  return "";
}

function renderOutput(snapshot: CyberHudSnapshot): string {
  const value = snapshot.output.value;
  if (value === undefined) return "";

  const label = `${snapshot.output.estimated ? "~" : ""}↓${fmt(value)}`;
  if (snapshot.output.frozen) return paint(C.dim, label);
  if (snapshot.output.estimated) return paint(C.muted, label);
  return paint(C.accent, label);
}

function renderTps(snapshot: CyberHudSnapshot): string {
  const value = snapshot.tps.value;
  if (value === undefined || !Number.isFinite(value) || value <= 0) return "";

  const label = `${snapshot.tps.estimated ? "~" : ""}${value.toFixed(0)}t/s`;
  if (snapshot.agentState === "thinking" || snapshot.agentState === "idle") {
    return paint(C.dim, label);
  }
  return paint(tpsColor(value), label);
}

function statsCandidates(snapshot: CyberHudSnapshot): string[] {
  const turn = renderTurn(snapshot);
  const reset = snapshot.resetNotice ? renderResetNotice(snapshot.resetNotice) : "";
  const input = renderInput(snapshot);
  const output = renderOutput(snapshot);
  const tps = renderTps(snapshot);
  const io = [input, output].filter(Boolean).join(" ");

  return [
    joinParts([turn, io, tps, reset]),
    joinParts([turn, io, tps]),
    joinParts([turn, io, reset]),
    joinParts([turn, io]),
    joinParts([io, tps, reset]),
    joinParts([io, tps]),
    joinParts([io, reset]),
    io,
    joinParts([turn, input, output, tps]),
    joinParts([input, output, tps]),
    joinParts([output, tps, reset]),
    joinParts([output, tps]),
    joinParts([input, output]),
    output,
    input,
    joinParts([turn, reset]),
    reset,
    turn,
    "",
  ];
}

function pathCandidates(cwd: string, width: number): string[] {
  const home = process.env.HOME ?? "";
  const rawPath = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  const basename = rawPath === "/"
    ? "/"
    : rawPath.split("/").filter(Boolean).at(-1) ?? rawPath;

  return [
    stylePath(shortenPath(rawPath, Math.max(10, width))),
    stylePath(shortenPath(rawPath, Math.max(10, Math.floor(width * 0.66)))),
    stylePath(shortenPath(rawPath, Math.max(8, Math.floor(width * 0.5)))),
    stylePath(shortenPath(rawPath, 12)),
    stylePath(shortenPath(basename, Math.max(4, Math.floor(width * 0.4)))),
    "",
  ];
}

function topLeftCandidates(
  cwd: string,
  snapshot: CyberHudSnapshot,
  width: number,
): string[] {
  const paths = pathCandidates(cwd, width);
  const stats = statsCandidates(snapshot);
  const candidates: string[] = [];

  for (const path of paths) {
    for (const stat of stats) {
      const combined = joinParts([path, stat]);
      if (combined && !candidates.includes(combined)) candidates.push(combined);
    }
  }

  for (const stat of stats) {
    if (stat && !candidates.includes(stat)) candidates.push(stat);
  }

  for (const path of paths) {
    if (path && !candidates.includes(path)) candidates.push(path);
  }

  candidates.push("");
  return candidates;
}

export function renderHudTopBorder(
  cwd: string,
  snapshot: CyberHudSnapshot,
  width: number,
  borderColor: BorderColorFn,
): string {
  if (width <= 0) return "";
  return composeBorderLine(
    width,
    borderColor,
    topLeftCandidates(cwd, snapshot, width),
    [""],
  );
}
