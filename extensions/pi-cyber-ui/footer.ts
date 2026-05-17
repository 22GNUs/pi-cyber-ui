import { exec } from "node:child_process";

import type {
  ContextUsage,
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { homeRelative, shortenPathToWidth, stylePath } from "./path-utils.js";

const ICONS = {
  model: "🐱",
  // Nerd Font: nf-fa-code-branch (U+F126). Encoded via \u escape so it
  // survives source-edit round-trips that may strip non-ASCII glyphs.
  branch: "\uf126",
  // Nerd Font: nf-fa-bolt (U+F0E7). Cache hit “spark” glyph.
  cache: "\uf0e7",
};

// Cache hit-rate gradient. Higher = better. Unified 5-tier palette across
// TPS / context / cache: green=exceptional · teal=good · cyan=ok ·
// orange=warn · red=bad. cache is direction-inverse of context.
const CACHE_PERCENT_COLORS: readonly { min: number; color: ThemeColor }[] = [
  { min: 95, color: "toolDiffAdded" }, // green
  { min: 85, color: "mdCode" },        // teal
  { min: 60, color: "accent" },        // cyan
  { min: 30, color: "warning" },       // orange
  { min: 0, color: "error" },          // red
];

function colorForCachePercent(percent: number): ThemeColor {
  for (const step of CACHE_PERCENT_COLORS) {
    if (percent >= step.min) return step.color;
  }
  return "error";
}

// Latest cache hit-rate, updated on every assistant message_end. Single
// module-level slot is enough — pi shows one active session in the TUI at a
// time, and the footer factory reads on each render(). Reset on context
// reset events (session_start / session_compact / session_tree / model_select)
// so a fresh context never inherits a stale value.
let latestCacheHit: number | null = null;
// Successful assistant turns observed since the last context reset. Used to
// suppress the cold-start "0%" that always shows on the first turn after a
// reset (no prior prefix has been cached server-side yet).
let assistantTurnsSinceReset = 0;
const footerRenderListeners = new Set<() => void>();

function notifyFooterRenderListeners(): void {
  for (const fn of footerRenderListeners) {
    try {
      fn();
    } catch {
      // listeners are best-effort poke-renders; ignore stale ctx errors.
    }
  }
}

function setLatestCacheHit(value: number | null): void {
  if (latestCacheHit === value) return;
  latestCacheHit = value;
  notifyFooterRenderListeners();
}

function resetCacheTracking(): void {
  assistantTurnsSinceReset = 0;
  setLatestCacheHit(null);
}

function usageToken(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return value;
}

function recordAssistantUsage(usage: unknown): void {
  if (!usage || typeof usage !== "object") {
    setLatestCacheHit(null);
    return;
  }
  const u = usage as Record<string, unknown>;
  const input = usageToken(u.input);
  const cacheRead = usageToken(u.cacheRead);
  const cacheWrite = usageToken(u.cacheWrite);
  const denom = input + cacheRead + cacheWrite;
  if (denom <= 0) {
    setLatestCacheHit(null);
    return;
  }
  // Server actually processed the prompt → prefix is now cached. Count this
  // turn even if cacheRead is 0 so the next turn passes the cold-start gate.
  assistantTurnsSinceReset += 1;
  // Cold-start gate: first assistant turn after a context reset has no prior
  // prefix to read from, so cacheRead==0 is structurally guaranteed and a 0%
  // readout is just noise. Hide it. If the provider reports a non-zero hit
  // (e.g. --continue with a still-warm Anthropic prompt cache), show it.
  if (assistantTurnsSinceReset < 2 && cacheRead <= 0) {
    setLatestCacheHit(null);
    return;
  }
  setLatestCacheHit((cacheRead / denom) * 100);
}

function renderCache(theme: Theme, percent: number | null): string {
  if (percent === null || !Number.isFinite(percent)) return "";
  const clamped = Math.max(0, Math.min(100, percent));
  const color = colorForCachePercent(clamped);
  const icon = theme.fg("dim", ICONS.cache);
  const num = theme.fg(color, `${Math.round(clamped)}`);
  const sign = theme.fg("dim", "%");
  return `${icon} ${num}${sign}`;
}

// True spectrum, no hue duplicates. The previous palette repeated `accent`
// and `success` (both cyan in this theme) and ended on `muted`, so "high"
// looked half cyan, half gray. Now each slot is a distinct hue: cyan →
// teal → purple → orange → red — a clean cool-to-warm sweep that reads
// as escalating intensity rather than a random colour mix.
const THINKING_HIGH_COLORS: readonly ThemeColor[] = [
  "accent",         // cyan
  "mdCode",         // teal
  "syntaxKeyword",  // purple
  "warning",        // orange
  "error",          // red
];

// Context-window heat. Unified 5-tier palette across TPS / context / cache:
// green=exceptional · teal=good · cyan=ok · orange=warn · red=bad. Context
// is lower=better, so green sits at the very low end.
const CONTEXT_PERCENT_COLORS: readonly { max: number; color: ThemeColor }[] = [
  { max: 30, color: "toolDiffAdded" }, // green
  { max: 55, color: "mdCode" },        // teal
  { max: 75, color: "accent" },        // cyan
  { max: 90, color: "warning" },       // orange
  { max: Number.POSITIVE_INFINITY, color: "error" }, // red
];

const KNOWN_THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

const SEP = " ∷ ";
const DIRTY_REFRESH_MS = 10_000;
const DIRTY_TIMEOUT_MS = 800;

// ---------------------------------------------------------------------------
// Tiny helpers reused from v1 footer
// ---------------------------------------------------------------------------

function rainbow(theme: Theme, text: string): string {
  let out = "";
  let i = 0;
  for (const ch of text) {
    if (ch.trim().length === 0 || ch === ":") {
      out += ch;
      continue;
    }
    const color = THINKING_HIGH_COLORS[i % THINKING_HIGH_COLORS.length] ?? "accent";
    out += theme.fg(color, ch);
    i += 1;
  }
  return out;
}

function formatTokens(value: number): string {
  if (value < 1_000) return `${value}`;
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000_000)}M`;
}

function normalizeThinkingLevel(level: string): string {
  return KNOWN_THINKING_LEVELS.has(level) ? level : "off";
}

function formatModelLabel(model: { name?: string; id: string } | undefined): string {
  if (!model) return "no-model";
  const name = model.name?.trim();
  if (name && name.length > 0) return name.replace(/^Claude\s+/i, "");
  const slash = model.id.lastIndexOf("/");
  return slash >= 0 ? model.id.slice(slash + 1) : model.id;
}

function thinkingText(theme: Theme, level: string): string {
  const normalized = normalizeThinkingLevel(level);
  // xhigh distinguishes itself from high via bold weight on the same
  // rainbow palette — keeps the spectrum consistent while still showing
  // "one notch above high".
  if (normalized === "xhigh") return theme.bold(rainbow(theme, normalized));
  if (normalized === "high") return rainbow(theme, normalized);
  switch (normalized) {
    case "off":
      return theme.fg("thinkingOff", normalized);
    case "minimal":
      return theme.fg("thinkingMinimal", normalized);
    case "low":
      return theme.fg("thinkingLow", normalized);
    case "medium":
      return theme.fg("thinkingMedium", normalized);
    default:
      return theme.fg("muted", normalized);
  }
}

function colorForContextPercent(percent: number): ThemeColor {
  for (const step of CONTEXT_PERCENT_COLORS) {
    if (percent <= step.max) return step.color;
  }
  return "error";
}

function formatContextPercent(percent: number): string {
  if (!Number.isFinite(percent)) return "0.00";
  const abs = Math.abs(percent);
  if (abs < 10) return percent.toFixed(2);
  if (abs < 100) return percent.toFixed(1);
  return percent.toFixed(0);
}

function progressBar(theme: Theme, percent: number, width = 12): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const color = colorForContextPercent(clamped);
  const totalUnits = width * 8;
  const filledUnits = Math.round((clamped / 100) * totalUnits);
  const fullBlocks = Math.floor(filledUnits / 8);
  const partialIndex = filledUnits % 8;
  const partials = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
  const partial = partials[partialIndex] ?? "";
  const occupiedCells = fullBlocks + (partial ? 1 : 0);
  const emptyCells = Math.max(0, width - occupiedCells);

  const left = theme.fg("dim", "[");
  const full = fullBlocks > 0 ? theme.fg(color, "█".repeat(fullBlocks)) : "";
  const part = partial ? theme.fg(color, partial) : "";
  const empty = emptyCells > 0 ? theme.fg("dim", "░".repeat(emptyCells)) : "";
  const right = theme.fg("dim", "]");
  return `${left}${full}${part}${empty}${right}`;
}

function compactBar(theme: Theme, width = 12): string {
  const label = "SYNC";
  const pad = Math.max(0, width - label.length);
  const leftPad = Math.floor(pad / 2);
  const rightPad = Math.ceil(pad / 2);
  const left = theme.fg("dim", "░".repeat(leftPad));
  const center = theme.fg("accent", label);
  const right = theme.fg("dim", "░".repeat(rightPad));
  return `${theme.fg("dim", "[")}${left}${center}${right}${theme.fg("dim", "]")}`;
}

function contextText(theme: Theme, usedTokens: number | null, contextWindow: number): string {
  if (usedTokens === null) {
    if (contextWindow <= 0) return theme.fg("dim", "?");
    const bar = compactBar(theme);
    const size = theme.fg("dim", formatTokens(contextWindow));
    return `${bar} ${size}`;
  }

  if (contextWindow <= 0) return theme.fg("dim", formatTokens(usedTokens));

  const percent = (usedTokens / contextWindow) * 100;
  const percentColor = colorForContextPercent(percent);
  const bar = progressBar(theme, percent);
  const usage = theme.fg(
    "dim",
    `${formatTokens(usedTokens)}/${formatTokens(contextWindow)}`,
  );
  const percentNumber = theme.fg(percentColor, formatContextPercent(percent));
  const percentSign = theme.fg("dim", "%");
  return `${bar} ${percentNumber}${percentSign} ${usage}`;
}

function getStatusInfo(
  theme: Theme,
  footerData: ReadonlyFooterDataProvider,
): { texts: string[]; signature: string } {
  const entries = Array.from(footerData.getExtensionStatuses().entries())
    .filter(([, value]) => value.trim().length > 0)
    .sort(([a], [b]) => a.localeCompare(b));

  const signature = entries
    .map(([key, value]) => `${key}\u0000${value}`)
    .join("\u0001");

  return {
    texts: entries.map(([, value]) => theme.fg("muted", value)),
    signature,
  };
}

function collapsedStatusText(theme: Theme, count: number): string {
  return theme.fg("dim", `+${count}`);
}

function fitStatusText(theme: Theme, texts: string[], availableWidth: number): string {
  if (texts.length === 0 || availableWidth <= 0) return "";
  const sep = theme.fg("dim", SEP);
  const sepWidth = visibleWidth(sep);
  const collapseAll = collapsedStatusText(theme, texts.length);

  if (visibleWidth(collapseAll) > availableWidth) return "";

  let result = "";
  let shown = 0;

  for (let i = 0; i < texts.length; i++) {
    const candidate = texts[i]!;
    const remaining = texts.length - i - 1;
    const suffix = remaining > 0 ? theme.fg("dim", ` +${remaining}`) : "";
    const suffixWidth = remaining > 0 ? visibleWidth(suffix) : 0;
    const needed = (shown > 0 ? sepWidth : 0) + visibleWidth(candidate) + suffixWidth;

    if (visibleWidth(result) + needed <= availableWidth) {
      result += (shown > 0 ? sep : "") + candidate;
      shown += 1;
    } else {
      const collapse = texts.length - shown;
      if (collapse <= 0) return result;
      if (shown === 0) return collapsedStatusText(theme, collapse);
      return `${result}${theme.fg("dim", ` +${collapse}`)}`;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Path + Git rendering
// ---------------------------------------------------------------------------

function renderPath(cwd: string, maxWidth: number): string {
  if (!cwd || maxWidth <= 0) return "";
  const home = homeRelative(cwd);
  const text = shortenPathToWidth(home, Math.max(8, maxWidth));
  return stylePath(text);
}

/**
 * Show the git branch icon plus compact dirty counts. Branch name itself is
 * omitted to keep the footer compact — the shell prompt already shows the
 * branch, and what changes turn-to-turn are added/modified/deleted counts.
 * Clean trees render nothing.
 *
 * Symbols mirror `edit` tool diff stats where possible: `+N`, `~N`, `−N`.
 */
interface GitStatusCounts {
  added: number;
  modified: number;
  deleted: number;
}

function totalGitChanges(counts: GitStatusCounts | undefined): number {
  if (!counts) return 0;
  return counts.added + counts.modified + counts.deleted;
}

function parseGitStatus(stdout: string): GitStatusCounts {
  const counts: GitStatusCounts = { added: 0, modified: 0, deleted: 0 };

  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";

    if (x === "?" && y === "?") {
      counts.added += 1;
    } else if (x === "A" || y === "A") {
      counts.added += 1;
    } else if (x === "D" || y === "D") {
      counts.deleted += 1;
    } else {
      counts.modified += 1;
    }
  }

  return counts;
}

function renderGit(
  theme: Theme,
  branch: string | null,
  counts: GitStatusCounts | undefined,
): string {
  if (!branch || totalGitChanges(counts) <= 0) return "";
  const icon = theme.fg("dim", ICONS.branch);
  const parts: string[] = [];
  if (counts && counts.added > 0) parts.push(theme.fg("toolDiffAdded", `+${counts.added}`));
  if (counts && counts.modified > 0) parts.push(theme.fg("warning", `~${counts.modified}`));
  if (counts && counts.deleted > 0) parts.push(theme.fg("error", `−${counts.deleted}`));
  return `${icon} ${parts.join(" ")}`;
}

// ---------------------------------------------------------------------------
// Async git dirty count (cached)
// ---------------------------------------------------------------------------

interface DirtyCacheEntry {
  counts: GitStatusCounts;
  at: number;
  inFlight?: boolean;
}

const EMPTY_GIT_STATUS_COUNTS: GitStatusCounts = { added: 0, modified: 0, deleted: 0 };

const dirtyCache = new Map<string, DirtyCacheEntry>();

function getCachedDirty(cwd: string): GitStatusCounts | undefined {
  return dirtyCache.get(cwd)?.counts;
}

function gitStatusCountsEqual(
  a: GitStatusCounts | undefined,
  b: GitStatusCounts | undefined,
): boolean {
  if (!a || !b) return a === b;
  return a.added === b.added && a.modified === b.modified && a.deleted === b.deleted;
}

function refreshDirty(cwd: string, onUpdate?: () => void, force = false): void {
  const existing = dirtyCache.get(cwd);
  if (existing?.inFlight) return;
  if (!force && existing && Date.now() - existing.at < DIRTY_REFRESH_MS / 2) return;

  const entry: DirtyCacheEntry = {
    counts: existing?.counts ?? EMPTY_GIT_STATUS_COUNTS,
    at: existing?.at ?? 0,
    inFlight: true,
  };
  dirtyCache.set(cwd, entry);

  exec(
    "git status --porcelain",
    { cwd, timeout: DIRTY_TIMEOUT_MS, maxBuffer: 256 * 1024 },
    (err, stdout) => {
      const counts = err ? entry.counts : parseGitStatus(stdout);
      const changed = !gitStatusCountsEqual(existing?.counts, counts);
      dirtyCache.set(cwd, { counts, at: Date.now() });
      if (changed || force) onUpdate?.();
    },
  );
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

interface LineParts {
  path: string;
  git: string;
  modelLabel: string;
  thinking: string;
  context: string;
  cache: string;
  statusTexts: string[];
}

function joinNonEmpty(theme: Theme, parts: string[], sep: string): string {
  const sepStyled = theme.fg("dim", sep);
  return parts.filter((p) => p && visibleWidth(p) > 0).join(sepStyled);
}

function renderLine(width: number, theme: Theme, parts: LineParts): string {
  const sepStyled = theme.fg("dim", SEP);
  const sepWidth = visibleWidth(sepStyled);
  const minGap = 2;

  const countIfVisible = (text: string): number => (visibleWidth(text) > 0 ? 1 : 0);

  const compose = (leftParts: string[], rightParts: string[]): string | undefined => {
    const left = joinNonEmpty(theme, leftParts, SEP);
    const right = joinNonEmpty(theme, rightParts, SEP);
    const leftWidth = visibleWidth(left);
    const rightWidth = visibleWidth(right);

    if (leftWidth + minGap + rightWidth > width) return undefined;

    const pad = " ".repeat(Math.max(minGap, width - leftWidth - rightWidth));
    return truncateToWidth(`${left}${pad}${right}`, width);
  };

  const tryLayout = (
    leftParts: string[],
    rightParts: string[],
    hiddenFixed: number,
  ): string | undefined => {
    // If fixed footer parts were dropped, prefer one combined "+N" marker.
    // This avoids showing detailed extension statuses while hiding core fields.
    if (hiddenFixed > 0) {
      const hiddenTotal = hiddenFixed + parts.statusTexts.length;
      return compose(leftParts, [...rightParts, collapsedStatusText(theme, hiddenTotal)]);
    }

    if (parts.statusTexts.length > 0) {
      const left = joinNonEmpty(theme, leftParts, SEP);
      const right = joinNonEmpty(theme, rightParts, SEP);
      const leftWidth = visibleWidth(left);
      const rightWidth = visibleWidth(right);
      const available = width - leftWidth - rightWidth - sepWidth - minGap;
      const statusText = fitStatusText(theme, parts.statusTexts, available);
      if (statusText) return compose(leftParts, [...rightParts, statusText]);
      return undefined;
    }

    return compose(leftParts, rightParts);
  };

  const cacheHidden = countIfVisible(parts.cache);
  const contextHidden = countIfVisible(parts.context);
  const thinkingHidden = countIfVisible(parts.thinking);
  const gitHidden = countIfVisible(parts.git);
  const pathHidden = countIfVisible(parts.path);

  // Fold priority (drop first → keep last):
  // cache → context → thinking → git → path → modelLabel.
  return (
    tryLayout(
      [parts.modelLabel, parts.thinking, parts.context, parts.cache],
      [parts.path, parts.git],
      0,
    ) ??
    tryLayout(
      [parts.modelLabel, parts.thinking, parts.context],
      [parts.path, parts.git],
      cacheHidden,
    ) ??
    tryLayout(
      [parts.modelLabel, parts.thinking],
      [parts.path, parts.git],
      cacheHidden + contextHidden,
    ) ??
    tryLayout(
      [parts.modelLabel, parts.thinking],
      [parts.path],
      cacheHidden + contextHidden + gitHidden,
    ) ??
    tryLayout(
      [parts.modelLabel],
      [parts.path],
      cacheHidden + contextHidden + thinkingHidden + gitHidden,
    ) ??
    tryLayout(
      [parts.modelLabel],
      [],
      cacheHidden + contextHidden + thinkingHidden + gitHidden + pathHidden,
    ) ??
    truncateToWidth(parts.modelLabel, width)
  );
}

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

interface CacheKey {
  width: number;
  cwd: string;
  branch: string | null;
  dirty: GitStatusCounts | undefined;
  modelId: string | undefined;
  modelName: string | undefined;
  thinkingLevel: string;
  usedTokens: number | null;
  contextWindow: number;
  cacheHit: number | null;
  statusSignature: string;
  statusCount: number;
}

function cacheKeyEquals(a: CacheKey | undefined, b: CacheKey): boolean {
  if (!a) return false;
  return (
    a.width === b.width &&
    a.cwd === b.cwd &&
    a.branch === b.branch &&
    gitStatusCountsEqual(a.dirty, b.dirty) &&
    a.modelId === b.modelId &&
    a.modelName === b.modelName &&
    a.thinkingLevel === b.thinkingLevel &&
    a.usedTokens === b.usedTokens &&
    a.contextWindow === b.contextWindow &&
    a.cacheHit === b.cacheHit &&
    a.statusSignature === b.statusSignature &&
    a.statusCount === b.statusCount
  );
}

// ---------------------------------------------------------------------------
// Footer factory
// ---------------------------------------------------------------------------

function attachFooter(
  ctx: ExtensionContext,
  getThinkingLevel: () => string,
): void {
  const cwd = ctx.cwd;
  ctx.ui.setFooter(
    (tui, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
      let cachedKey: CacheKey | undefined;
      let cachedLines: string[] | undefined;
      let disposed = false;

      const pokeRender = () => {
        if (disposed) return;
        try {
          // Footer render cache is internal to this custom component. Async
          // updates must explicitly ask the TUI to redraw while pi is idle.
          tui.requestRender();
        } catch {
          // Session reload/replacement can stale captured ctx before async git
          // callbacks settle. Ignore: next session attaches a fresh footer.
          disposed = true;
        }
      };

      const invalidate = () => {
        if (disposed) return;
        cachedKey = undefined;
        cachedLines = undefined;
        pokeRender();
      };

      // Prime + watch git. Capture cwd while ctx is active; timer callbacks
      // must not read guarded ctx getters after reload/session replacement.
      refreshDirty(cwd, invalidate);
      const dirtyTimer = setInterval(() => refreshDirty(cwd, invalidate), DIRTY_REFRESH_MS);
      if (typeof dirtyTimer.unref === "function") dirtyTimer.unref();

      // Cache/git updates flow through module-level listeners → this component.
      footerRenderListeners.add(invalidate);

      const unsubBranch = footerData.onBranchChange(() => {
        if (disposed) return;
        // Branch changed → dirty count likely stale.
        dirtyCache.delete(cwd);
        refreshDirty(cwd, invalidate);
        invalidate();
      });

      return {
        invalidate() {
          cachedKey = undefined;
          cachedLines = undefined;
        },
        render(width: number): string[] {
          let model: ExtensionContext["model"];
          let usage: ContextUsage | undefined;
          let thinkingLevel = "off";
          try {
            model = ctx.model;
            usage = ctx.getContextUsage?.();
            thinkingLevel = getThinkingLevel();
          } catch {
            // Component can render once after ctx went stale during reload.
            // Return last stable line and mark disposed so async callbacks stop.
            disposed = true;
            return cachedLines ?? [""];
          }

          const branch = footerData.getGitBranch();
          const dirty = getCachedDirty(cwd);
          const usedTokens = usage?.tokens ?? null;
          const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 0;
          const cacheHit = latestCacheHit;
          const statusInfo = getStatusInfo(theme, footerData);

          const key: CacheKey = {
            width,
            cwd,
            branch,
            dirty,
            modelId: model?.id,
            modelName: model?.name,
            thinkingLevel,
            usedTokens,
            contextWindow,
            cacheHit,
            statusSignature: statusInfo.signature,
            statusCount: statusInfo.texts.length,
          };

          if (cachedLines && cacheKeyEquals(cachedKey, key)) {
            return cachedLines;
          }

          // Path budget: roughly a third of the width when long, never less than 12.
          const pathBudget = Math.max(12, Math.floor(width * 0.34));
          const path = renderPath(cwd, pathBudget);
          const git = renderGit(theme, branch, dirty);
          const modelLabel = theme.fg(
            "accent",
            `${ICONS.model} ${formatModelLabel(model)}`,
          );
          const thinking = thinkingText(theme, thinkingLevel);
          const context = contextText(theme, usedTokens, contextWindow);
          const cache = renderCache(theme, cacheHit);

          cachedLines = [
            renderLine(width, theme, {
              path,
              git,
              modelLabel,
              thinking,
              context,
              cache,
              statusTexts: statusInfo.texts,
            }),
          ];
          cachedKey = key;
          return cachedLines;
        },
        dispose() {
          disposed = true;
          unsubBranch();
          clearInterval(dirtyTimer);
          footerRenderListeners.delete(invalidate);
        },
      };
    },
  );
}

export default function footer(pi: ExtensionAPI) {
  const getThinkingLevel = () => {
    if (typeof pi.getThinkingLevel === "function") return pi.getThinkingLevel();
    return "off";
  };

  pi.on("session_start", async (_event, ctx) => {
    // Fresh session must not inherit prior cache hit-rate or turn count.
    resetCacheTracking();
    try {
      if (!ctx.hasUI) return;
      attachFooter(ctx, getThinkingLevel);
    } catch {
      // ctx may already be stale during reload teardown; next session attaches.
    }
  });

  // Context-reset events that invalidate the cache prefix. session_before_switch
  // is intentionally not hooked: it can be cancelled, and the post-switch
  // session_start handler above resets unconditionally.
  pi.on("session_compact", async () => resetCacheTracking());
  pi.on("session_tree", async () => resetCacheTracking());
  pi.on("model_select", async () => resetCacheTracking());

  pi.on("message_end", async (event) => {
    try {
      if (event.message.role !== "assistant") return;
      recordAssistantUsage((event.message as { usage?: unknown }).usage);
    } catch {
      // Defensive: usage shape varies across providers.
    }
  });

  // Refresh dirty count after agent_end (likely files just changed). Force so
  // commits/checkout performed by tools update immediately even inside the
  // normal debounce window.
  pi.on("agent_end", async (_event, ctx) => {
    try {
      if (!ctx.hasUI) return;
      const cwd = ctx.cwd;
      refreshDirty(cwd, notifyFooterRenderListeners, true);
    } catch {
      // Ignore stale ctx during reload/session replacement.
    }
  });
}
