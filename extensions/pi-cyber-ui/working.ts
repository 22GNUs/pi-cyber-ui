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
  green: [158, 206, 106] as RGB,
  orange: [224, 175, 104] as RGB,
  red: [247, 118, 142] as RGB,
  // Silver palette — working line uses cool silver tones for a restrained,
  // refined "server breathing-light" feel. No cyan/pink in the working line
  // proper; cyan is reserved for the tps gradient and footer accents.
  silverDim: [111, 119, 148] as RGB,
  silverHi: [230, 236, 250] as RGB,
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

/**
 * Letter-wave verb. Each character glows up in turn, with a fixed
 * per-character delay, like a slow ripple of light passing through the word.
 * Replaces the cyan-teal sweep which felt too "neon".
 *
 * Design:
 *   base   = fgMuted    (resting tone)
 *   peak   = silverHi   (single-char highlight)
 *   period = 1800ms      (4:3 against the 2400ms spinner)
 *   delay  = 120ms / char
 *   peak phase = 32% of period (slightly past quarter, gives a forward feel)
 *   peak FWHM  = 50% of period (raised cosine window)
 */
const LETTER_WAVE_PERIOD_MS = 1_800;
const LETTER_WAVE_DELAY_MS = 120;
const LETTER_WAVE_PEAK = 0.32;
const LETTER_WAVE_HALF = 0.25;

function paintLetterWave(text: string): string {
  const chars = [...text];
  if (chars.length === 0) return "";

  const now = Date.now();
  // Low-key: no bold, gentler contrast (fgMuted → silverHi instead of
  // silverDim → white). Peak window narrowed so most chars rest quietly.
  return `${chars
    .map((ch, i) => {
      const charTime = now - i * LETTER_WAVE_DELAY_MS;
      const phi =
        (((charTime % LETTER_WAVE_PERIOD_MS) + LETTER_WAVE_PERIOD_MS) %
          LETTER_WAVE_PERIOD_MS) /
        LETTER_WAVE_PERIOD_MS;
      const d = Math.abs(phi - LETTER_WAVE_PEAK);
      const wrapped = Math.min(d, 1 - d);
      const intensity =
        wrapped > LETTER_WAVE_HALF
          ? 0
          : 0.5 * (1 + Math.cos((Math.PI * wrapped) / LETTER_WAVE_HALF));
      const color = mix(C.fgMuted, C.silverHi, intensity);
      return `${rgb(color)}${ch}`;
    })
    .join("")}${RESET_FG}`;
}

/** v1 HUD's tps grading. Higher rate → more positive colour. */
function tpsColor(v: number): RGB {
  return v > 300 ? C.green : v > 150 ? C.cyan : v > 50 ? C.orange : C.red;
}

// ---------------------------------------------------------------------------
// Spinner — "Pulsar" silver breathing dot. The glyph never changes shape
// (always ●) and never toggles bold; only its colour breathes. This is
// what the previous pink heartbeat lacked — jumping between ·→◉ and
// flipping bold on every crest read as "flashy" rather than refined.
//
// Eight discrete frames sample an ease-in-out curve fgDim → silverDim →
// silver → silverHi (peak hold 2 frames) → silver → silverDim → fgDim,
// 300ms each = 2400ms cycle. Verb letter-wave runs at 1800ms (4:3 against
// this) so layers do not crest together.
// ---------------------------------------------------------------------------

// 32 frames @ 75ms = 2400ms cycle. High frame count makes the breathing
// read as continuous light rather than terminal steps. Higher peak contrast
// (fgDim → silverHi) makes the breathing visible while staying non-bold.
const FRAME_INTERVAL_MS = 75;

interface PulseFrame {
  glyph: string;
  color: RGB;
}

const PULSE_FRAMES: readonly PulseFrame[] = (() => {
  const N = 32;
  const frames: PulseFrame[] = [];
  for (let i = 0; i < N; i++) {
    const phase = i / N;
    // Cosine breathing: 0 at start/end, 1 at midpoint.
    const intensity = 0.5 * (1 - Math.cos(Math.PI * 2 * phase));
    frames.push({ glyph: "●", color: mix(C.fgDim, C.silverHi, intensity) });
  }
  return frames;
})();

const PULSE_FRAME_TEXTS = PULSE_FRAMES.map((f) => paint(f.color, f.glyph));

function applyWorkingIndicator(ctx: ExtensionContext): boolean {
  return safeUi(ctx, () => {
    ctx.ui.setWorkingIndicator({
      frames: PULSE_FRAME_TEXTS,
      intervalMs: FRAME_INTERVAL_MS,
    });
  });
}

// ---------------------------------------------------------------------------
// Verbs (Claude Code style whimsy)
// ---------------------------------------------------------------------------

const VERBS = [
  // English
  "Reasoning",
  "Analyzing",
  "Resolving",
  "Inferring",
  "Rendering",
  "Iterating",
  "Threading",
  "Distilling",
  // Español
  "Razonando",
  "Pensando.",
  "Tejiendo.",
  "Afinando.",
  // Français
  "Analysant",
  "Composant",
  "Éclairant",
  "Tissant..",
  // Italiano / Deutsch / Latin-ish
  "Pensando.",
  "Ragionare",
  "Denkend..",
  "Cogitans.",
] as const;

const WORKING_LABEL_SUFFIX = "...";
const WORKING_LABEL_WIDTH = Math.max(
  ...VERBS.map((v) => visibleWidth(`${v}${WORKING_LABEL_SUFFIX}`)),
);

function padWorkingLabel(verb: string): string {
  const label = `${verb}${WORKING_LABEL_SUFFIX}`;
  const pad = Math.max(0, WORKING_LABEL_WIDTH - visibleWidth(label));
  return `${label}${" ".repeat(pad)}`;
}

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

function formatWorkingElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
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

  // 100 — fixed-width working label. Metrics after it are grouped in
  // parentheses by fitSegments(), keeping the vibe stable and low-key.
  const label = paintLetterWave(padWorkingLabel(args.verb));
  const time = paint(C.fgMuted, formatWorkingElapsed(args.elapsedMs));
  segments.push(seg(label, 100));
  segments.push(seg(time, 95));

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
  const labelWidth = segments[0]?.width ?? 0;
  const bracketWidth = visibleWidth(" ()");

  const totalWidth = () => {
    let tailWidth = 0;
    let tailCount = 0;
    for (const { s, i } of indexed) {
      if (!survivors.has(i) || i === 0) continue;
      if (tailCount > 0) tailWidth += sepWidth;
      tailWidth += s.width;
      tailCount += 1;
    }
    return labelWidth + (tailCount > 0 ? bracketWidth + tailWidth : 0);
  };

  // Drop lowest-importance segments while total width exceeds budget.
  const sortedByImportance = [...indexed].sort((a, b) => a.s.importance - b.s.importance);
  for (const { i } of sortedByImportance) {
    if (totalWidth() <= budget) break;
    // Always keep the highest-importance segment, even if it overflows alone.
    if (segments[i]!.importance >= 100) continue;
    survivors.delete(i);
  }

  const label = segments[0]?.text ?? "";
  const tail = indexed
    .filter(({ i }) => survivors.has(i) && i !== 0)
    .map(({ s }) => s.text)
    .join(sep);

  if (!tail) return label;
  return `${label} ${paint(C.fgDim, "(")}${tail}${paint(C.fgDim, ")")}`;
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
  // Only the check stays green; "done" drops to muted fg so the line reads
  // as one positive event rather than a doubled-up green block.
  const check = paint(C.green, "✓", true);
  const doneLabel = paint(C.fgMuted, "done");
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

function hasUsableUi(ctx: ExtensionContext): boolean {
  try {
    return ctx.hasUI;
  } catch {
    return false;
  }
}

function safeUi(ctx: ExtensionContext, fn: () => void): boolean {
  try {
    if (!ctx.hasUI) return true;
    fn();
    return true;
  } catch {
    // Session reload/replacement can stale captured ctx before timers or
    // deferred UI work settle. Fresh session will attach fresh UI state.
    return false;
  }
}

function attachSummaryWidget(ctx: ExtensionContext, summary: PromptSummary): boolean {
  return safeUi(ctx, () => {
    ctx.ui.setWidget(
      WIDGET_KEY,
      (_tui, _theme) => new Text(buildIdleSummary(summary), 0, 0),
      { placement: "aboveEditor" },
    );
  });
}

function clearSummaryWidget(ctx: ExtensionContext): boolean {
  return safeUi(ctx, () => ctx.ui.setWidget(WIDGET_KEY, undefined));
}

// ---------------------------------------------------------------------------
// Prompt timer state
// ---------------------------------------------------------------------------

interface PromptState {
  startedAt: number;
  verb: string;
  verbChangedAt: number;
}

const VERB_ROTATE_MS = 8_000;
// ~60fps so the letter-wave breathes very smoothly without visible stepping.
const MESSAGE_REFRESH_MS = 16;

let prompt: PromptState | undefined;

function updateWorkingMessage(ctx: ExtensionContext): boolean {
  if (!prompt) return true;
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
  return safeUi(ctx, () => ctx.ui.setWorkingMessage(message));
}

function startPromptTimer(ctx: ExtensionContext): void {
  const now = Date.now();
  prompt = {
    startedAt: now,
    verb: pickVerb(),
    verbChangedAt: now,
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
  safeUi(ctx, () => ctx.ui.setWorkingMessage());
  attachSummaryWidget(ctx, lastSummary);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export default function working(pi: ExtensionAPI) {
  let messageTimer: NodeJS.Timeout | undefined;
  let sessionToken = 0;

  const stopMessageTimer = (timer = messageTimer) => {
    if (!timer) return;
    clearInterval(timer);
    if (timer === messageTimer) messageTimer = undefined;
  };

  const invalidateSession = () => {
    sessionToken += 1;
    stopMessageTimer();
    prompt = undefined;
  };

  pi.on("session_start", (event, ctx) => {
    invalidateSession();
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
    if (!hasUsableUi(ctx)) return;
    startPromptTimer(ctx);
    stopMessageTimer();
    const token = sessionToken;
    const timer = setInterval(() => {
      if (token !== sessionToken || !updateWorkingMessage(ctx)) stopMessageTimer(timer);
    }, MESSAGE_REFRESH_MS);
    messageTimer = timer;
    if (typeof timer.unref === "function") timer.unref();
  });

  pi.on("agent_end", (_event, ctx) => {
    stopMessageTimer();
    endPromptTimer(ctx);
  });

  pi.on("session_before_switch", () => {
    invalidateSession();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    safeUi(ctx, () => {
      ctx.ui.setWorkingIndicator();
      ctx.ui.setWorkingMessage();
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    });
    invalidateSession();
  });
}
