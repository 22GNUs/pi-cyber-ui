/**
 * Working area — single source of truth for "what is the AI doing right now".
 *
 * Two visual modes, mutually exclusive:
 *
 *   running — pi's built-in working Loader is active. We feed it a single
 *     line via `setWorkingMessage`:
 *       <verb> · <prompt-elapsed> · <tool spinner+name+dur> · ↑in ↓out · <tps>
 *     followed by a soft "esc to cancel" hint after 10s.
 *     Segments are ordered by priority and dropped right-to-left when the
 *     terminal is too narrow.
 *
 *   idle — Loader is hidden. A single-line widget above the editor shows the
 *     last prompt's summary, persisting until the next prompt:
 *       ✓ done · <total> · ✓N ✗M · ↑in ↓out · <avg tps>
 *
 * Verb pool is cyber-themed and rotates every few seconds for ambient variety.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";

import { cyberState, type CyberHudSnapshot } from "./editor-state.js";
import { toolRegistry, type ToolTally } from "./tool-registry.js";

// ---------------------------------------------------------------------------
// Cyber palette — raw RGB, kept identical to the v1 HUD so colours don't shift.
// ---------------------------------------------------------------------------

type RGB = readonly [number, number, number];

const C = {
  hotPink: [255, 130, 184] as RGB,
  dim: [112, 124, 146] as RGB,
  muted: [162, 176, 196] as RGB,
  accent: [137, 219, 255] as RGB,
  success: [122, 217, 166] as RGB,
  warning: [255, 202, 112] as RGB,
  error: [255, 136, 136] as RGB,
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

/** v1 HUD's tps grading. Higher rate → more positive colour. */
function tpsColor(v: number): RGB {
  return v > 300 ? C.success : v > 150 ? C.accent : v > 50 ? C.warning : C.error;
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
      if (index === 3 || index === 4 || index === 5) return paint(C.accent, frame);
      if (index === 2 || index === 6) return paint(C.muted, frame);
      return paint(C.dim, frame);
    }),
    intervalMs: FRAME_INTERVAL_MS,
  });
}

// ---------------------------------------------------------------------------
// Inline spinner for tool name (rendered inside line 2)
// ---------------------------------------------------------------------------

const TOOL_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const TOOL_SPINNER_INTERVAL_MS = 80;

function toolSpinnerFrame(): string {
  return TOOL_SPINNER[Math.floor(Date.now() / TOOL_SPINNER_INTERVAL_MS) % TOOL_SPINNER.length]!;
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
  const sep = paint(C.dim, " · ");
  return parts.filter((p) => p && p.length > 0).join(sep);
}

// ---------------------------------------------------------------------------
// Lines builders
// ---------------------------------------------------------------------------

interface RunningLineArgs {
  verb: string;
  elapsedMs: number;
  snapshot: CyberHudSnapshot;
  tally: ToolTally;
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
 *    80 current tool spinner+name+dur
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
  const { snapshot, tally } = args;
  const segments: Segment[] = [];

  // 100 — verb + elapsed (anchor)
  const verb = paint(C.accent, args.verb, true);
  const time = paint(C.muted, formatElapsed(args.elapsedMs));
  segments.push(seg(`${verb} ${paint(C.dim, "·")} ${time}`, 100));

  // 80 — current tool spinner+name+dur (only while a tool is actively
  // running; between-tool tallies are intentionally omitted so the loading
  // line stays focused on "what's happening *now*" rather than running
  // totals — those live in the idle summary instead).
  if (tally.running > 0 && tally.currentName) {
    const spin = paint(C.accent, toolSpinnerFrame());
    const name = paint(C.accent, tally.currentName);
    const dur =
      tally.currentElapsedMs !== undefined ? formatElapsed(tally.currentElapsedMs) : "";
    const tail = dur ? ` ${paint(C.dim, dur)}` : "";
    segments.push(seg(`${spin} ${name}${tail}`, 80));
  }

  // 70 — tokens
  const inTokens = formatTokens(snapshot.inputValue ?? snapshot.promptIn);
  const outTokens = formatTokens(snapshot.output.value);
  if (inTokens || outTokens) {
    const inPart = inTokens ? paint(C.muted, `↑${inTokens}`) : "";
    let outColor: RGB = C.accent;
    if (snapshot.output.frozen) outColor = C.dim;
    else if (snapshot.output.estimated) outColor = C.muted;
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
    const color: RGB = idle ? C.dim : tpsColor(tpsValue);
    segments.push(seg(paint(color, tpsLabel), 60));
  }

  // 50 — turn marker. Always shown while a prompt is active to match the
  // v1 HUD's behaviour (the clock glyph + count is part of the muscle memory).
  if (snapshot.promptActive) {
    const turns = Math.max(1, snapshot.promptTurns);
    segments.push(seg(paint(C.dim, `${TURN_ICON}${turns}`), 50));
  }

  // 20 — esc hint (after 10s)
  if (args.elapsedMs >= ESC_HINT_AFTER_MS) {
    segments.push(seg(paint(C.dim, "esc to cancel"), 20));
  }

  return segments;
}

/** Reasonable budget when we don't know the actual terminal width. */
const MESSAGE_BUDGET = 100;

function fitSegments(segments: Segment[], budget: number): string {
  const sep = "  "; // soft separator between segments
  const sepWidth = sep.length;

  // Drop lowest-importance segments while total width exceeds budget.
  // Segments are kept in original order; we discard from the back of the
  // sorted-by-importance ascending list.
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

  const sortedByImportance = [...indexed].sort((a, b) => a.s.importance - b.s.importance);
  for (const { i } of sortedByImportance) {
    if (totalWidth() <= budget) break;
    // Always keep the highest-importance anchor (first segment), even if
    // it overflows on its own.
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
  toolOk: number;
  toolErr: number;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  avgTps: number | undefined;
}

let lastSummary: PromptSummary | undefined;

const WIDGET_KEY = "cyber-ui:summary";

function buildIdleSummary(summary: PromptSummary): string {
  const parts: string[] = [];

  // ✓ done · 1:23
  const check = paint(C.success, "✓", true);
  const doneLabel = paint(C.success, "done");
  const time = paint(C.muted, formatElapsed(summary.totalElapsedMs));
  parts.push(`${check} ${doneLabel} ${paint(C.dim, "·")} ${time}`);

  // ✓m ✗k
  if (summary.toolOk > 0 || summary.toolErr > 0) {
    const okStr = summary.toolOk > 0 ? paint(C.success, `✓${summary.toolOk}`) : "";
    const errStr = summary.toolErr > 0 ? paint(C.error, `✗${summary.toolErr}`) : "";
    const t = [okStr, errStr].filter(Boolean).join(" ");
    if (t) parts.push(t);
  }

  // tokens
  const inTokens = formatTokens(summary.inputTokens);
  const outTokens = formatTokens(summary.outputTokens);
  if (inTokens || outTokens) {
    const inPart = inTokens ? paint(C.muted, `↑${inTokens}`) : "";
    const outPart = outTokens ? paint(C.muted, `↓${outTokens}`) : "";
    const both = [inPart, outPart].filter(Boolean).join(" ");
    if (both) parts.push(both);
  }

  // avg tps
  if (summary.avgTps !== undefined && summary.avgTps > 0) {
    parts.push(paint(C.dim, formatTps(summary.avgTps)));
  }

  // turn count tail — always show, matching v1 HUD
  if (summary.turns > 0) {
    parts.push(paint(C.dim, `${TURN_ICON}${summary.turns}`));
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

const VERB_ROTATE_MS = 6000;
const MESSAGE_REFRESH_MS = 250;

let prompt: PromptState | undefined;

function updateWorkingMessage(ctx: ExtensionContext): void {
  if (!ctx.hasUI || !prompt) return;
  const now = Date.now();
  const elapsed = now - prompt.startedAt;

  if (now - prompt.verbChangedAt >= VERB_ROTATE_MS) {
    prompt.verb = pickVerb(prompt.verb);
    prompt.verbChangedAt = now;
  }

  const theme = ctx.ui.theme;
  const snapshot = cyberState.snapshot();
  const tally = toolRegistry.getTally();

  const args: RunningLineArgs = {
    verb: prompt.verb,
    elapsedMs: elapsed,
    snapshot,
    tally,
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
  const tally = toolRegistry.getTally();

  const inputTokens = snapshot.inputValue ?? snapshot.promptIn;
  const outputTokens = snapshot.output.value;
  const avgTps = snapshot.tps.value;

  lastSummary = {
    totalElapsedMs,
    turns: snapshot.promptTurns,
    toolOk: tally.ok,
    toolErr: tally.err,
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
  let toolUnsub: (() => void) | undefined;

  const stopMessageTimer = () => {
    if (messageTimer) {
      clearInterval(messageTimer);
      messageTimer = undefined;
    }
  };

  pi.on("session_start", (_event, ctx) => {
    applyWorkingIndicator(ctx);
    // Resurface last summary if we have one (e.g. after reload).
    if (lastSummary) attachSummaryWidget(ctx, lastSummary);

    // Refresh working message whenever a tool starts/ends so the spinner +
    // tool slot stays current even when no events fire on the prompt side.
    toolUnsub?.();
    toolUnsub = toolRegistry.subscribe(() => {
      if (prompt) updateWorkingMessage(ctx);
    });
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
    toolUnsub?.();
    toolUnsub = undefined;
    stopMessageTimer();
    prompt = undefined;
  });
}
