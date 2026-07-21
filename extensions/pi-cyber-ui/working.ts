/**
 * Working area — single source of truth for "what is the AI doing right now".
 *
 * Two visual modes, mutually exclusive:
 *
 *   running — pi's built-in working Loader is active. We feed it a single
 *     line via `setWorkingMessage`:
 *       <verb> · <prompt-elapsed> · ↑in ↓out · <tps>
 *     followed by a soft "esc to cancel" hint fading in after 10s.
 *     Segments are ordered by priority and dropped right-to-left when the
 *     terminal is too narrow. Numeric segments are display-smoothed
 *     (odometer / glow / freeze-fade / fixed-width slots — see below).
 *
 *   idle — Loader is hidden. A single-line widget above the editor shows the
 *     last prompt's summary, fading in over 600ms and persisting until the
 *     next prompt:
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
import { formatCompactNumber } from "./format.js";
import { palette as C, paint, mix, rgb, RESET_FG, type RGB } from "./palette.js";

// Cyber palette (RGB + paint/mix helpers) — see palette.ts; colors sourced
// from theme vars, single source of truth.

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

/**
 * Quantize animation intensities to a coarse grid. Visually identical (16
 * steps across a subtle color ramp), but consecutive frames collapse to
 * byte-identical strings far more often — combined with the render memo
 * this removes most redundant terminal writes and the ±1 RGB shimmer that
 * float rounding produced.
 */
const COLOR_STEPS = 16;
function quant(v: number): number {
  return Math.round(v * COLOR_STEPS) / COLOR_STEPS;
}

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
          : quant(0.5 * (1 + Math.cos((Math.PI * wrapped) / LETTER_WAVE_HALF)));
      const color = mix(C.fgMuted, C.silverHi, intensity);
      return `${rgb(color)}${ch}`;
    })
    .join("")}${RESET_FG}`;
}

/** TPS grading. Higher rate → more positive colour; algorithm unchanged. */
function tpsColor(v: number): RGB {
  // Unified 5-tier palette: green=exceptional · teal=good · cyan=ok ·
  // orange=warn · red=bad. TPS skips the cyan "ok" band so the jump from
  // good to exceptional still reads as a clear breakthrough.
  if (v >= 100) return C.green;
  if (v >= 60) return C.teal;
  if (v >= 30) return C.orange;
  return C.red;
}

// ---------------------------------------------------------------------------
// Spinner — duotone alternating heartbeat. The glyph never changes shape
// (always ●) and never toggles bold; only its colour breathes. One breath
// peaks pink, the next peaks cyan — the cyber duotone on a single char.
// Trough stays fgDim (neutral when dark, hue only near the peak), so the
// dot reads as one calm heartbeat, not a colour strobe.
//
// History: an earlier pink heartbeat was dropped because it jumped ·→◉ and
// flipped bold at every crest — the failure was shape/bold flicker, not the
// hue. Fixed glyph + pure colour breathing avoids that failure mode.
// ---------------------------------------------------------------------------

// 64 frames @ 75ms = 4800ms full cycle (two 2400ms breaths: pink then cyan).
// High frame count keeps the breathing continuous rather than steppy. Verb
// letter-wave runs at 1800ms (3:4 against each breath) so layers do not
// crest together.
const FRAME_INTERVAL_MS = 75;

interface PulseFrame {
  glyph: string;
  color: RGB;
}

const PULSE_FRAMES: readonly PulseFrame[] = (() => {
  const N = 64;
  const frames: PulseFrame[] = [];
  for (let i = 0; i < N; i++) {
    const phase = i / N;
    // Two breaths per cycle; breath 0 peaks pink, breath 1 peaks cyan.
    const local = (phase * 2) % 1;
    const peak = phase < 0.5 ? C.pink : C.cyan;
    // Cosine breathing: 0 at start/end of each breath, 1 at its midpoint.
    const intensity = 0.5 * (1 - Math.cos(Math.PI * 2 * local));
    frames.push({ glyph: "●", color: mix(C.fgDim, peak, intensity) });
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
  // 3 significant figures improve visible movement across common scales:
  //   9_100     -> 9.10k   (10-token granularity)
  //   47_342    -> 47.3k   (100-token granularity)
  //   128_000   -> 128k    (1k-token granularity)
  //   1_050_000 -> 1.05M   (10k-token granularity)
  // Trailing zeros are kept on purpose: "9.10k" advertises a 10-token
  // last-digit step.
  return formatCompactNumber(value, { significantFigures: 3 });
}

function formatTps(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return "";
  return value < 1 ? `${value.toFixed(1)}t/s` : `${Math.round(value)}t/s`;
}

// ---------------------------------------------------------------------------
// Display smoothing — odometer / glow / freeze-fade / fixed-width slots.
//
// Pure display layer: cyberState stays the source of truth; this only shapes
// how its snapshot reaches the eye at the 16ms refresh cadence.
//
//   odometer  — shown output eases toward the true value (τ 80ms ≈ 95% in
//               250ms), so token counts roll instead of jumping.
//   glow      — a soft sheen keyed to data arrival with a generous hold:
//               any target increase re-arms a 600ms window, so the sheen
//               target stays solidly on through a stream (deltas arrive
//               far more often than that) and transitions exactly twice —
//               once up at stream start, once down at stream end. No
//               mid-stream target flapping, which read as pumping around
//               mid-brightness. Stays silver on purpose: the working line
//               keeps its monochrome-motion signature.
//   tps EMA   — display tps low-passes raw tps (τ 500ms) so the value and
//               its grade colour stop jittering.
//   freeze    — entering/leaving tool state fades values to fgDim (τ 90ms
//               ≈ 250ms settle) instead of snapping.
//   slots     — numeric segments never shrink below their max width this
//               prompt, so 999→1.00k cannot make the line wobble.
// ---------------------------------------------------------------------------

const ODOMETER_TAU_MS = 80;
const TPS_EMA_TAU_MS = 500;
const FREEZE_TAU_MS = 90;
// Glow envelope: any data arrival re-arms a generous hold window; the
// brightness target only drops after a real stream pause, so rise/fall
// transitions happen at stream boundaries, never mid-stream. Peak is
// capped below full silverHi so the sheen never reads as a highlight.
const GLOW_HOLD_MS = 600;
const GLOW_ATTACK_TAU_MS = 120;
const GLOW_RELEASE_TAU_MS = 350;
const GLOW_PEAK = 0.7;
// Event-loop stalls (tool output flooding the TUI) can starve the 16ms
// timer; an unclamped dt would make every time-based smoother jump through
// its curve in a single frame. Clamp dt so recovery is still eased.
const MAX_FRAME_DT_MS = 64;
const HINT_FADE_MS = 600;
const SUMMARY_FADE_MS = 600;

/** Time-based exponential approach — the single smoothing primitive. */
function ease(current: number, target: number, dt: number, tau: number): number {
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

interface DisplaySmoothing {
  lastAt?: number;
  /** Odometer-smoothed output tokens. */
  out?: number;
  /** Last rendered output token text. */
  outText: string;
  /** Last seen true output value (data-arrival detector). */
  lastTarget?: number;
  /** Glow hold deadline — re-armed on every data arrival. */
  glowHold: number;
  /** Smoothed glow brightness 0..1. */
  glowB: number;
  /** EMA-smoothed tps. */
  tps?: number;
  /** 0 = live colours, 1 = fully frozen (tool running). */
  freezeK: number;
  tokWidth: number;
  tpsWidth: number;
}

function newSmoothing(): DisplaySmoothing {
  return { outText: "", glowHold: 0, glowB: 0, freezeK: 0, tokWidth: 0, tpsWidth: 0 };
}

let smooth: DisplaySmoothing = newSmoothing();

function updateSmoothing(snapshot: CyberHudSnapshot, now: number): void {
  const rawDt = smooth.lastAt === undefined ? 0 : Math.max(0, now - smooth.lastAt);
  smooth.lastAt = now;
  const dt = Math.min(rawDt, MAX_FRAME_DT_MS);

  // Odometer — ease toward the true output count; snap on resets.
  const target = snapshot.output.value;
  if (target === undefined) {
    smooth.out = undefined;
    smooth.outText = "";
    smooth.lastTarget = undefined;
  } else {
    if (smooth.out === undefined) smooth.out = 0;
    if (target < smooth.out) {
      smooth.out = target;
    } else {
      smooth.out = ease(smooth.out, target, dt, ODOMETER_TAU_MS);
      if (target - smooth.out < 0.5) smooth.out = target;
    }
    smooth.outText = formatTokens(Math.round(smooth.out));
    // Data arrival — re-arm the glow hold window.
    if (smooth.lastTarget === undefined || target > smooth.lastTarget) {
      smooth.glowHold = now + GLOW_HOLD_MS;
    }
    smooth.lastTarget = target;
  }

  // Glow envelope — hysteresis via the hold window keeps the target stable
  // through a stream; asymmetric attack/release keeps the brightness curve
  // continuous at the two genuine transitions.
  const glowTarget = now < smooth.glowHold && !snapshot.output.frozen ? 1 : 0;
  const glowTau = glowTarget > smooth.glowB ? GLOW_ATTACK_TAU_MS : GLOW_RELEASE_TAU_MS;
  smooth.glowB = ease(smooth.glowB, glowTarget, dt, glowTau);
  if (glowTarget === 0 && smooth.glowB < 0.01) smooth.glowB = 0;

  // TPS — time-based EMA.
  const rawTps = snapshot.tps.value;
  if (rawTps === undefined || !Number.isFinite(rawTps)) {
    smooth.tps = undefined;
  } else if (smooth.tps === undefined) {
    smooth.tps = rawTps;
  } else {
    smooth.tps = ease(smooth.tps, rawTps, dt, TPS_EMA_TAU_MS);
  }

  // Freeze fade — ease toward frozen/live.
  const targetK = snapshot.output.frozen ? 1 : 0;
  smooth.freezeK = ease(smooth.freezeK, targetK, dt, FREEZE_TAU_MS);
  if (Math.abs(targetK - smooth.freezeK) < 0.01) smooth.freezeK = targetK;
}

// ---------------------------------------------------------------------------
// Lines builders
// ---------------------------------------------------------------------------

interface RunningLineArgs {
  verb: string;
  elapsedMs: number;
  now: number;
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

  // 70 — tokens. Output rolls via the odometer, carries the glow sheen
  // while streaming, fades to dim while a tool runs, and sits in a
  // non-shrinking slot.
  const inTokens = formatTokens(snapshot.inputValue ?? snapshot.promptIn);
  const outTokens = smooth.outText;
  if (inTokens || outTokens) {
    const inPart = inTokens ? paint(C.fgDim, `↑${inTokens}`) : "";
    let outPart = "";
    if (outTokens) {
      const freezeK = quant(smooth.freezeK);
      const base = mix(C.fgMuted, C.fgDim, freezeK);
      const color = mix(
        base,
        C.silverHi,
        quant(smooth.glowB) * GLOW_PEAK * (1 - freezeK),
      );
      const outPrefix = snapshot.output.estimated ? "~" : "";
      outPart = paint(color, `${outPrefix}↓${outTokens}`);
    }
    let both = [inPart, outPart].filter(Boolean).join(" ");
    if (both) {
      const w = visibleWidth(both);
      smooth.tokWidth = Math.max(smooth.tokWidth, w);
      if (w < smooth.tokWidth) both += " ".repeat(smooth.tokWidth - w);
      segments.push(seg(both, 70));
    }
  }

  // 60 — tps (EMA-smoothed, graded by speed, fades to dim during tools/idle)
  const tpsValue = smooth.tps;
  if (tpsValue !== undefined && Number.isFinite(tpsValue) && tpsValue > 0) {
    const tpsLabel = `${snapshot.tps.estimated ? "~" : ""}${formatTps(tpsValue)}`;
    const dimK = quant(snapshot.agentState === "idle" ? 1 : smooth.freezeK);
    const color = mix(tpsColor(tpsValue), C.fgDim, dimK);
    const w = visibleWidth(tpsLabel);
    smooth.tpsWidth = Math.max(smooth.tpsWidth, w);
    const padded =
      paint(color, tpsLabel) + " ".repeat(smooth.tpsWidth - w);
    segments.push(seg(padded, 60));
  }

  // 50 — turn marker. Always shown while a prompt is active to match the
  // v1 HUD's behaviour (the clock glyph + count is part of the muscle memory).
  if (snapshot.promptActive) {
    const turns = Math.max(1, snapshot.promptTurns);
    segments.push(seg(paint(C.fgDim, `${TURN_ICON}${turns}`), 50));
  }

  // 20 — esc hint (fades in over 600ms after 10s instead of popping)
  if (args.elapsedMs >= ESC_HINT_AFTER_MS) {
    const k = quant(Math.min(1, (args.elapsedMs - ESC_HINT_AFTER_MS) / HINT_FADE_MS));
    segments.push(seg(paint(mix(C.bg, C.fgDim, k), "esc to cancel"), 20));
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

function buildIdleSummary(summary: PromptSummary, alpha = 1): string {
  // Fade-in support: every colour is mixed up from the theme background so
  // the whole line rises together instead of popping.
  const col = (c: RGB): RGB => mix(C.bg, c, alpha);
  const sep = paint(col(C.fgDim), " · ");
  const parts: string[] = [];

  // ✓ done · 1:23
  // Only the check stays green; "done" drops to muted fg so the line reads
  // as one positive event rather than a doubled-up green block.
  const check = paint(col(C.green), "✓", true);
  const doneLabel = paint(col(C.fgMuted), "done");
  const time = paint(col(C.fgMuted), formatElapsed(summary.totalElapsedMs));
  parts.push(`${check} ${doneLabel} ${paint(col(C.fgDim), "·")} ${time}`);

  // tokens
  const inTokens = formatTokens(summary.inputTokens);
  const outTokens = formatTokens(summary.outputTokens);
  if (inTokens || outTokens) {
    const inPart = inTokens ? paint(col(C.fgDim), `↑${inTokens}`) : "";
    const outPart = outTokens ? paint(col(C.fgMuted), `↓${outTokens}`) : "";
    const both = [inPart, outPart].filter(Boolean).join(" ");
    if (both) parts.push(both);
  }

  // avg tps
  if (summary.avgTps !== undefined && summary.avgTps > 0) {
    parts.push(paint(col(C.fgDim), formatTps(summary.avgTps)));
  }

  // turn count tail — always show, matching v1 HUD
  if (summary.turns > 0) {
    parts.push(paint(col(C.fgDim), `${TURN_ICON}${summary.turns}`));
  }

  return parts.filter((p) => p && p.length > 0).join(sep);
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

function attachSummaryWidget(
  ctx: ExtensionContext,
  summary: PromptSummary,
  alpha = 1,
): boolean {
  return safeUi(ctx, () => {
    ctx.ui.setWidget(
      WIDGET_KEY,
      (_tui, _theme) => new Text(buildIdleSummary(summary, alpha), 0, 0),
      { placement: "aboveEditor" },
    );
  });
}

let summaryFadeTimer: NodeJS.Timeout | undefined;

function stopSummaryFade(): void {
  if (!summaryFadeTimer) return;
  clearInterval(summaryFadeTimer);
  summaryFadeTimer = undefined;
}

/** Attach the summary widget and fade it in over SUMMARY_FADE_MS. */
function fadeInSummaryWidget(ctx: ExtensionContext, summary: PromptSummary): void {
  stopSummaryFade();
  const startedAt = Date.now();
  if (!attachSummaryWidget(ctx, summary, 0)) return;
  const timer = setInterval(() => {
    const k = Math.min(1, (Date.now() - startedAt) / SUMMARY_FADE_MS);
    const ok = attachSummaryWidget(ctx, summary, k);
    if (!ok || k >= 1) {
      clearInterval(timer);
      if (summaryFadeTimer === timer) summaryFadeTimer = undefined;
    }
  }, 33);
  summaryFadeTimer = timer;
  if (typeof timer.unref === "function") timer.unref();
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
// ~60fps sampling for animation phase accuracy. Terminal writes are NOT
// 60/s: the 16-step intensity quantization collapses most neighbouring
// ticks into byte-identical strings and the render memo below skips them,
// so write volume is governed by actual visual change, not tick rate.
const MESSAGE_REFRESH_MS = 16;

let prompt: PromptState | undefined;
/** Last string sent to setWorkingMessage — skip identical rewrites. */
let lastMessage: string | undefined;

function updateWorkingMessage(ctx: ExtensionContext): boolean {
  if (!prompt) return true;
  const now = Date.now();
  const elapsed = now - prompt.startedAt;

  if (now - prompt.verbChangedAt >= VERB_ROTATE_MS) {
    prompt.verb = pickVerb(prompt.verb);
    prompt.verbChangedAt = now;
  }

  const snapshot = cyberState.snapshot();
  updateSmoothing(snapshot, now);
  const args: RunningLineArgs = {
    verb: prompt.verb,
    elapsedMs: elapsed,
    now,
    snapshot,
  };

  const segments = collectRunningSegments(args);
  const message = fitSegments(segments, MESSAGE_BUDGET);
  if (message === lastMessage) return true;
  const ok = safeUi(ctx, () => ctx.ui.setWorkingMessage(message));
  if (ok) lastMessage = message;
  return ok;
}

function startPromptTimer(ctx: ExtensionContext): void {
  const now = Date.now();
  prompt = {
    startedAt: now,
    verb: pickVerb(),
    verbChangedAt: now,
  };
  smooth = newSmoothing();
  lastMessage = undefined;
  stopSummaryFade();
  clearSummaryWidget(ctx);
  updateWorkingMessage(ctx);
}

function endPromptTimer(ctx: ExtensionContext): void {
  if (!prompt) return;
  const totalElapsedMs = Date.now() - prompt.startedAt;
  const snapshot = cyberState.snapshot();
  const inputTokens = snapshot.inputValue;
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
  lastMessage = undefined;
  safeUi(ctx, () => ctx.ui.setWorkingMessage());
  fadeInSummaryWidget(ctx, lastSummary);
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
    stopSummaryFade();
    prompt = undefined;
    lastMessage = undefined;
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
