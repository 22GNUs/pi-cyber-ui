import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

import type { CyberEditorState, CyberHudSnapshot, ResetNotice } from "./editor-state.js";

const SEP = " ∷ ";
const TURN_ICON = "󰄉";
const PATH_MAX_DEPTH = 3;
const TILDE_PINK: readonly [number, number, number] = [255, 130, 184];
const RESET = "\x1b[39m";
const BOLD = "\x1b[1m";
const UNBOLD = "\x1b[22m";

type RGB = readonly [number, number, number];

function rgb(c: RGB): string {
  return `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
}

function hotPink(text: string): string {
  return `${BOLD}${rgb(TILDE_PINK)}${text}${UNBOLD}${RESET}`;
}

function fmt(n: number): string {
  if (n < 1_000) return `${n}`;
  if (n < 10_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function tpsColor(v: number): "success" | "accent" | "warning" | "error" {
  return v > 300 ? "success" : v > 150 ? "accent" : v > 50 ? "warning" : "error";
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

function stylePath(theme: Theme, raw: string): string {
  if (raw.length === 0) return "";

  let prefix = "";
  let parts: string[];
  if (raw.startsWith("~/")) {
    parts = ["~", ...raw.slice(2).split("/").filter(Boolean)];
  } else if (raw === "~") {
    parts = ["~"];
  } else if (raw.startsWith("/")) {
    prefix = theme.fg("dim", "/");
    parts = raw.slice(1).split("/").filter(Boolean);
  } else {
    parts = raw.split("/").filter(Boolean);
  }

  const styled = parts.map((part, index) => {
    if (part === "…") return theme.fg("dim", part);
    const isLast = index === parts.length - 1;
    if (part === "~") return hotPink(part);
    if (isLast) return theme.fg("accent", part);
    return theme.fg("dim", part);
  }).join(theme.fg("dim", "/"));

  return `${prefix}${styled}`;
}

function renderResetNotice(theme: Theme, notice: ResetNotice): string {
  const label = notice.kind === "compact" ? "cmp" : "tree";
  return theme.fg("warning", label);
}

function renderHudLine(
  theme: Theme,
  cwd: string,
  snapshot: CyberHudSnapshot,
  width: number,
): string {
  const home = process.env.HOME ?? "";
  const rawPath = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  const s = theme.fg("dim", SEP);

  const dOut = snapshot.output.value;
  const dOutEst = snapshot.output.estimated;
  const dTps = snapshot.tps.value;
  const dTpsEst = snapshot.tps.estimated;

  const turn = snapshot.promptActive
    ? theme.fg("dim", `${TURN_ICON}${Math.max(1, snapshot.promptTurns)}`)
    : "";

  const inTk = snapshot.inputValue;
  let inS: string;
  if (inTk !== undefined) {
    inS = theme.fg("muted", `↑${fmt(inTk)}`);
  } else if (snapshot.promptActive && snapshot.promptIn > 0) {
    inS = theme.fg("dim", `↑${fmt(snapshot.promptIn)}+…`);
  } else if (snapshot.promptActive) {
    inS = theme.fg("dim", "↑…");
  } else {
    inS = "";
  }

  let outS = "";
  if (dOut !== undefined) {
    const lbl = `${dOutEst ? "~" : ""}↓${fmt(dOut)}`;
    outS = snapshot.output.frozen
      ? theme.fg("dim", lbl)
      : dOutEst
        ? theme.fg("muted", lbl)
        : theme.fg("accent", lbl);
  }

  let tpsS = "";
  if (dTps !== undefined && Number.isFinite(dTps) && dTps > 0) {
    const lbl = `${dTpsEst ? "~" : ""}${dTps.toFixed(0)}t/s`;
    tpsS = snapshot.agentState === "thinking" || snapshot.agentState === "idle"
      ? theme.fg("dim", lbl)
      : theme.fg(tpsColor(dTps), lbl);
  }

  const stats = [turn, [inS, outS].filter(Boolean).join(" "), tpsS].filter(Boolean);
  const statsText = stats.join(s);

  if (!snapshot.promptActive && stats.length === 0) {
    const pathLine = truncateToWidth(
      stylePath(theme, shortenPath(rawPath, Math.max(8, width - 2))),
      width,
    );
    if (snapshot.resetNotice) {
      const notice = renderResetNotice(theme, snapshot.resetNotice);
      return truncateToWidth(`${pathLine}${s}${notice}`, width);
    }
    return pathLine;
  }

  const reserved = statsText ? visibleWidth(statsText) + visibleWidth(s) : 0;
  const pathBudget = Math.max(10, width - reserved - 1);
  const path = stylePath(theme, shortenPath(rawPath, Math.max(6, pathBudget - 2)));
  const line = statsText ? `${path}${s}${statsText}` : path;
  return truncateToWidth(line, width);
}

export function attachCyberHud(ctx: ExtensionContext, state: CyberEditorState): void {
  ctx.ui.setWidget(
    "cyber-hud",
    (_tui, theme) => ({
      invalidate(): void {},
      render(w: number): string[] {
        return [renderHudLine(theme, ctx.cwd ?? "", state.snapshot(), w)];
      },
    }),
    { placement: "aboveEditor" },
  );
}
