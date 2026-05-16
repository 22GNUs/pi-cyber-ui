/**
 * Working area — single source of truth for "what is the AI doing right now".
 *
 * Two visual modes, mutually exclusive:
 *
 *   running — pi's built-in working Loader is active. We feed it a single
 *     line via `setWorkingMessage`:
 *       <verb> · <prompt-elapsed> · ↑in ↓out · <tps>
 *     followed by a soft "esc to cancel" hint after 10s.
 *     Segments are ordered by priority and dropped right-to-left when the
 *     terminal is too narrow.
 *
 *   idle — Loader is hidden. A single-line widget above the editor shows the
 *     last prompt's summary, persisting until the next prompt:
 *       ✓ done · <total> · ↑in ↓out · <avg tps>
 *
 * Verb pool is cyber-themed and rotates every few seconds for ambient variety.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";

import { cyberState, type CyberHudSnapshot } from "./editor-state.js";

// ---------------------------------------------------------------------------
// Cyber palette — working-specific UI colours. Pure presentation layer; token
// accounting / tps logic remains untouched.
// ---------------------------------------------------------------------------

type RGB = readonly [number, number, number];

const C = {
  fg: [192, 202, 245] as RGB,
  fgMuted: [169, 177, 214] as RGB,
  fgDim: [86, 95, 137] as RGB,
  cyan: [125, 207, 255] as RGB,
  cyanBright: [180, 249, 248] as RGB,
  blue: [122, 162, 247] as RGB,
  green: [158, 206, 106] as RGB,
  orange: [224, 175, 104] as RGB,
  red: [247, 118, 142] as RGB,
};

const RESET_FG = "\x1b[39m";
const BOLD = "\x1b[1m";
const UNBOLD = "\x1b[22m";

function rgb(c: RGB): string {
  return `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
}

function paint(color: RGB, text: string, bold = false): string {
  const open = bold ? `${BOLD}${rgb(color)}` : rgb(color);
  const close = bold ? `${RESET_FG}${UNBOLD}` : RESET_FG;
  return `${open}${text}${close}`;
}

function mix(a: RGB, b: RGB, t: number): RGB {
  const clamped = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * clamped),
    Math.round(a[1] + (b[1] - a[1]) * clamped),
    Math.round(a[2] + (b[2] - a[2]) * clamped),
  ] as RGB;
}

const SHIMMER_PADDING = 10;
const SHIMMER_SWEEP_MS = 2_000;
const SHIMMER_BAND_HALF_WIDTH = 5;

function paintCyberSilver(text: string): string {
  const chars = [...text];
  if (chars.length === 0) return "";

  const period = chars.length + SHIMMER_PADDING * 2;
  const pos = ((Date.now() % SHIMMER_SWEEP_MS) / SHIMMER_SWEEP_MS) * period;

  return `${BOLD}${chars
    .map((ch, index) => {
      const charPos = index + SHIMMER_PADDING;
      const dist = Math.abs(charPos - pos);
      const intensity =
        dist <= SHIMMER_BAND_HALF_WIDTH
          ? 0.5 * (1 + Math.cos(Math.PI * (dist / SHIMMER_BAND_HALF_WIDTH)))
          : 0;

      const base = mix(C.fgDim, C.fgMuted, 0.28);
      const highlight = mix(C.fg, C.cyanBright, 0.12);
      return `${rgb(mix(base, highlight, intensity))}${ch}`;
    })
    .join("")}${RESET_FG}${UNBOLD}`;
}

/** v1 HUD's tps grading. Higher rate → more positive colour. */
function tpsColor(v: number): RGB {
  return v > 300 ? C.green : v > 150 ? C.cyan : v > 50 ? C.orange : C.red;
}

// ---------------------------------------------------------------------------
// Spinner — gentle 8-frame breath, used by pi's Loader to the left of message
// ---------------------------------------------------------------------------

const FRAMES = ["·", "·", "•", "●", "◆", "●", "•", "·"] as const;
const FRAME_INTERVAL_MS = 120;

function applyWorkingIndicator(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWorkingIndicator({
    frames: FRAMES.map((frame, index) => {
      if (index === 3 || index === 4 || index === 5) return paint(C.cyan, frame);
      if (index === 2 || index === 6) return paint(C.fgMuted, frame);
      return paint(C.fgDim, frame);
    }),
    intervalMs: FRAME_INTERVAL_MS,
  });
}

// ---------------------------------------------------------------------------
// Verbs (Claude Code style whimsy)
// ---------------------------------------------------------------------------

const VERBS = [
  "Compiling",
  "Indexing",
  "Synthesizing",
  "Routing",
  "Distilling",
  "Calibrating",
  "Decoding",
  "Resolving",
  "Streaming",
  "Plotting",
  "Crunching",
  "Weaving",
  "Conjuring",
  "Querying",
  "Brewing",
  "Tokenizing",
  "Optimizing",
  "Cogitating",
  "Pondering",
  "Refracting",
  "Threading",
  "Buffering",
  "Hacking",
  "Probing",
] as const;

function pickVerb(prev?: string): string {
  for (let i = 0; i < 8; i++) {
    const candidate = VERBS[Math.floor(Math.random() * VERBS.length)]!;
    if (candidate !== prev) return candidate;
  }
  return VERBS[0]!;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatTokens(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return "";
  if (value < 1_000) return `${value}`;
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function formatTps(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return "";
  return value < 1 ? `${value.toFixed(1)}t/s` : `${Math.round(value)}t/s`;
}

function joinDim(parts: string[]): string {
  const sep = paint(C.fgDim, " · ");
  return parts.filter((p) => p && p.length > 0).join(sep);
}

// ---------------------------------------------------------------------------
// Lines builders
// ---------------------------------------------------------------------------

interface RunningLineArgs {
  verb: string;
  elapsedMs: number;
  snapshot: CyberHudSnapshot;
}

const ESC_HINT_AFTER_MS = 10_000;

const TURN_ICON = "󰄉";

/**
 * Build the prioritized segment list for the running working line. Each entry
 * carries an importance — when the rendered length exceeds the terminal
 * width, segments are dropped right-to-left starting at the lowest importance.
 *
 * Importance scale (higher = keep longer):
 *   100 verb + elapsed (always kept)
 *    70 tokens ↑/↓
 *    60 tps
 *    50 turn marker (≥2)
 *    20 esc hint
 */
interface Segment {
  text: string;
  importance: number;
  /** Render width of the visible text (used for fitting). */
  width: number;
}

function seg(text: string, importance: number): Segment {
  return { text, importance, width: visibleWidth(text) };
}

function collectRunningSegments(args: RunningLineArgs): Segment[] {
  const { snapshot } = args;
  const segments: Segment[] = [];

  // 100 — verb + elapsed (anchor). Internal " · " matches the inter-segment
  // separator added by fitSegments(), so the whole line reads with a
  // consistent middle-dot rhythm.
  const verb = paintCyberSilver(args.verb);
  const time = paint(C.fgMuted, formatElapsed(args.elapsedMs));
  segments.push(seg(`${verb}${paint(C.fgDim, " · ")}${time}`, 100));

  // 70 — tokens
  const inTokens = formatTokens(snapshot.inputValue ?? snapshot.promptIn);
  const outTokens = formatTokens(snapshot.output.value);
  if (inTokens || outTokens) {
    const inPart = inTokens ? paint(C.fgDim, `↑${inTokens}`) : "";
    let outColor: RGB = C.fgMuted;
    if (snapshot.output.frozen) outColor = C.fgDim;
    else if (snapshot.output.estimated) outColor = C.fgMuted;
    const outPrefix = snapshot.output.estimated ? "~" : "";
    const outPart = outTokens ? paint(outColor, `${outPrefix}↓${outTokens}`) : "";
    const both = [inPart, outPart].filter(Boolean).join(" ");
    if (both) segments.push(seg(both, 70));
  }

  // 60 — tps (graded by speed, dim while idle/thinking)
  const tpsValue = snapshot.tps.value;
  if (tpsValue !== undefined && Number.isFinite(tpsValue) && tpsValue > 0) {
    const tpsLabel = `${snapshot.tps.estimated ? "~" : ""}${formatTps(tpsValue)}`;
    const idle = snapshot.agentState === "thinking" || snapshot.agentState === "idle";
    const color: RGB = idle ? C.fgDim : tpsColor(tpsValue);
    segments.push(seg(paint(color, tpsLabel), 60));
  }

  // 50 — turn marker. Always shown while a prompt is active to match the
  // v1 HUD's behaviour (the clock glyph + count is part of the muscle memory).
  if (snapshot.promptActive) {
    const turns = Math.max(1, snapshot.promptTurns);
    segments.push(seg(paint(C.fgDim, `${TURN_ICON}${turns}`), 50));
  }

  // 20 — esc hint (after 10s)
  if (args.elapsedMs >= ESC_HINT_AFTER_MS) {
    segments.push(seg(paint(C.fgDim, "esc to cancel"), 20));
  }

  return segments;
}

/** Reasonable budget when we don't know the actual terminal width. */
const MESSAGE_BUDGET = 100;

function fitSegments(segments: Segment[], budget: number): string {
  // Visible separator is a dim middle-dot with a space on each side. The
  // ANSI escape adds bytes but not display width, so we track them
  // separately for budgeting.
  const sep = paint(C.fgDim, " · ");
  const sepWidth = visibleWidth(sep);

  const indexed = segments.map((s, i) => ({ s, i }));
  const survivors = new Set(indexed.map((x) => x.i));

  const totalWidth = () => {
    let w = 0;
    let n = 0;
    for (const { s, i } of indexed) {
      if (!survivors.has(i)) continue;
      if (n > 0) w += sepWidth;
      w += s.width;
      n += 1;
    }
    return w;
  };

  // Drop lowest-importance segments while total width exceeds budget.
  const sortedByImportance = [...indexed].sort((a, b) => a.s.importance - b.s.importance);
  for (const { i } of sortedByImportance) {
    if (totalWidth() <= budget) break;
    // Always keep the highest-importance anchor, even if it overflows alone.
    if (segments[i]!.importance >= 100) continue;
    survivors.delete(i);
  }

  return indexed
    .filter(({ i }) => survivors.has(i))
    .map(({ s }) => s.text)
    .join(sep);
}

// ---------------------------------------------------------------------------
// Idle summary widget
// ---------------------------------------------------------------------------

interface PromptSummary {
  totalElapsedMs: number;
  turns: number;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  avgTps: number | undefined;
}

let lastSummary: PromptSummary | undefined;

const WIDGET_KEY = "cyber-ui:summary";

function buildIdleSummary(summary: PromptSummary): string {
  const parts: string[] = [];

  // ✓ done · 1:23
  const check = paint(C.green, "✓", true);
  const doneLabel = paint(C.green, "done");
  const time = paint(C.fgMuted, formatElapsed(summary.totalElapsedMs));
  parts.push(`${check} ${doneLabel} ${paint(C.fgDim, "·")} ${time}`);

  // tokens
  const inTokens = formatTokens(summary.inputTokens);
  const outTokens = formatTokens(summary.outputTokens);
  if (inTokens || outTokens) {
    const inPart = inTokens ? paint(C.fgDim, `↑${inTokens}`) : "";
    const outPart = outTokens ? paint(C.fgMuted, `↓${outTokens}`) : "";
    const both = [inPart, outPart].filter(Boolean).join(" ");
    if (both) parts.push(both);
  }

  // avg tps
  if (summary.avgTps !== undefined && summary.avgTps > 0) {
    parts.push(paint(C.fgDim, formatTps(summary.avgTps)));
  }

  // turn count tail — always show, matching v1 HUD
  if (summary.turns > 0) {
    parts.push(paint(C.fgDim, `${TURN_ICON}${summary.turns}`));
  }

  return joinDim(parts);
}

function attachSummaryWidget(ctx: ExtensionContext, summary: PromptSummary): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(
    WIDGET_KEY,
    (_tui, _theme) => new Text(buildIdleSummary(summary), 0, 0),
    { placement: "aboveEditor" },
  );
}

function clearSummaryWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(WIDGET_KEY, undefined);
}

// ---------------------------------------------------------------------------
// Prompt timer state
// ---------------------------------------------------------------------------

interface PromptState {
  startedAt: number;
  verb: string;
  verbChangedAt: number;
}

const VERB_ROTATE_MS = 20_000;
const MESSAGE_REFRESH_MS = 80;

let prompt: PromptState | undefined;

function updateWorkingMessage(ctx: ExtensionContext): void {
  if (!ctx.hasUI || !prompt) return;
  const now = Date.now();
  const elapsed = now - prompt.startedAt;

  if (now - prompt.verbChangedAt >= VERB_ROTATE_MS) {
    prompt.verb = pickVerb(prompt.verb);
    prompt.verbChangedAt = now;
  }

  const snapshot = cyberState.snapshot();
  const args: RunningLineArgs = {
    verb: prompt.verb,
    elapsedMs: elapsed,
    snapshot,
  };

  const segments = collectRunningSegments(args);
  const message = fitSegments(segments, MESSAGE_BUDGET);
  ctx.ui.setWorkingMessage(message);
}

function startPromptTimer(ctx: ExtensionContext): void {
  prompt = {
    startedAt: Date.now(),
    verb: pickVerb(),
    verbChangedAt: Date.now(),
  };
  clearSummaryWidget(ctx);
  updateWorkingMessage(ctx);
}

function endPromptTimer(ctx: ExtensionContext): void {
  if (!prompt) return;
  const totalElapsedMs = Date.now() - prompt.startedAt;
  const snapshot = cyberState.snapshot();
  const inputTokens = snapshot.inputValue ?? snapshot.promptIn;
  const outputTokens = snapshot.output.value;
  const avgTps = snapshot.tps.value;

  lastSummary = {
    totalElapsedMs,
    turns: snapshot.promptTurns,
    inputTokens: inputTokens && inputTokens > 0 ? inputTokens : undefined,
    outputTokens,
    avgTps,
  };

  prompt = undefined;
  if (ctx.hasUI) ctx.ui.setWorkingMessage();
  attachSummaryWidget(ctx, lastSummary);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export default function working(pi: ExtensionAPI) {
  let messageTimer: NodeJS.Timeout | undefined;

  const stopMessageTimer = () => {
    if (messageTimer) {
      clearInterval(messageTimer);
      messageTimer = undefined;
    }
  };

  pi.on("session_start", (event, ctx) => {
    applyWorkingIndicator(ctx);
    // Resurface the previous summary only on extension reload; new/resumed/forked
    // sessions should not inherit another session's completed-turn banner.
    if (event.reason === "reload" && lastSummary) {
      attachSummaryWidget(ctx, lastSummary);
    } else {
      lastSummary = undefined;
      clearSummaryWidget(ctx);
    }
  });

  pi.on("agent_start", (_event, ctx) => {
    startPromptTimer(ctx);
    stopMessageTimer();
    messageTimer = setInterval(() => updateWorkingMessage(ctx), MESSAGE_REFRESH_MS);
    if (typeof messageTimer.unref === "function") messageTimer.unref();
  });

  pi.on("agent_end", (_event, ctx) => {
    stopMessageTimer();
    endPromptTimer(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setWorkingIndicator();
      ctx.ui.setWorkingMessage();
      clearSummaryWidget(ctx);
    }
    stopMessageTimer();
    prompt = undefined;
  });
}
