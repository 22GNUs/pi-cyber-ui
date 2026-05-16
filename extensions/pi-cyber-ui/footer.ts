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
};

const THINKING_HIGH_COLORS: readonly ThemeColor[] = [
  "accent",
  "success",
  "warning",
  "error",
  "muted",
];

const CONTEXT_PERCENT_COLORS: readonly { max: number; color: ThemeColor }[] = [
  { max: 55, color: "success" },
  { max: 75, color: "accent" },
  { max: 90, color: "warning" },
  { max: Number.POSITIVE_INFINITY, color: "error" },
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
const FOOTER_REFRESH_STATUS_KEY = "cyber-ui:footer-refresh";

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
  if (normalized === "high" || normalized === "xhigh") {
    return rainbow(theme, normalized);
  }
  switch (normalized) {
    case "off":
      return theme.fg("dim", normalized);
    case "minimal":
      return theme.fg("muted", normalized);
    case "low":
      return theme.fg("accent", normalized);
    case "medium":
      return theme.fg("success", normalized);
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

function fitStatusText(theme: Theme, texts: string[], availableWidth: number): string {
  if (texts.length === 0) return "";
  const sep = theme.fg("dim", SEP);
  const sepWidth = visibleWidth(sep);

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
      if (collapse > 0) result += theme.fg("dim", ` +${collapse}`);
      return result;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Path + Git rendering
// ---------------------------------------------------------------------------

function renderPath(theme: Theme, cwd: string, maxWidth: number): string {
  if (!cwd || maxWidth <= 0) return "";
  const home = homeRelative(cwd);
  const text = shortenPathToWidth(home, Math.max(8, maxWidth));
  return stylePath(text);
}

/**
 * Show the git branch icon plus the dirty-file count. Branch name itself is
 * omitted to keep the footer compact — the shell prompt already shows the
 * branch, and what changes turn-to-turn is the dirty count. Clean trees
 * render nothing.
 *
 * `~N` mirrors the `~` symbol used in `edit` tool diff stats for modified
 * lines, keeping the visual language consistent across the UI.
 */
function renderGit(
  theme: Theme,
  branch: string | null,
  dirty: number | undefined,
): string {
  if (!branch || !dirty || dirty <= 0) return "";
  const icon = theme.fg("dim", ICONS.branch);
  const count = theme.fg("warning", `~${dirty}`);
  return `${icon} ${count}`;
}

// ---------------------------------------------------------------------------
// Async git dirty count (cached)
// ---------------------------------------------------------------------------

interface DirtyCacheEntry {
  count: number;
  at: number;
  inFlight?: boolean;
}

const dirtyCache = new Map<string, DirtyCacheEntry>();

function getCachedDirty(cwd: string): number | undefined {
  return dirtyCache.get(cwd)?.count;
}

function refreshDirty(cwd: string, onUpdate?: () => void, force = false): void {
  const existing = dirtyCache.get(cwd);
  if (existing?.inFlight) return;
  if (!force && existing && Date.now() - existing.at < DIRTY_REFRESH_MS / 2) return;

  const entry: DirtyCacheEntry = {
    count: existing?.count ?? 0,
    at: existing?.at ?? 0,
    inFlight: true,
  };
  dirtyCache.set(cwd, entry);

  exec(
    "git status --porcelain",
    { cwd, timeout: DIRTY_TIMEOUT_MS, maxBuffer: 256 * 1024 },
    (err, stdout) => {
      const count = err
        ? entry.count
        : stdout.split("\n").filter((line) => line.trim().length > 0).length;
      const changed = existing?.count !== count;
      dirtyCache.set(cwd, { count, at: Date.now() });
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
  statusTexts: string[];
}

function joinNonEmpty(theme: Theme, parts: string[], sep: string): string {
  const sepStyled = theme.fg("dim", sep);
  return parts.filter((p) => p && visibleWidth(p) > 0).join(sepStyled);
}

function renderLine(width: number, theme: Theme, parts: LineParts): string {
  const sepStyled = theme.fg("dim", SEP);
  const sepWidth = visibleWidth(sepStyled);

  const pathLeft = parts.path;
  const gitLeft = parts.git;
  const left = joinNonEmpty(theme, [pathLeft, gitLeft], SEP);

  const right = joinNonEmpty(
    theme,
    [parts.modelLabel, parts.thinking, parts.context],
    SEP,
  );

  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  const minGap = 2;

  // Try fitting status between left and right
  if (parts.statusTexts.length > 0) {
    const available = width - leftWidth - rightWidth - sepWidth - minGap;
    if (available > 6) {
      const statusText = fitStatusText(theme, parts.statusTexts, available);
      if (statusText) {
        const middle = `${sepStyled}${statusText}`;
        const used = leftWidth + visibleWidth(middle) + rightWidth;
        const pad = " ".repeat(Math.max(minGap, width - used));
        return truncateToWidth(`${left}${middle}${pad}${right}`, width);
      }
    }
  }

  // Just left + right
  if (leftWidth + minGap + rightWidth <= width) {
    const pad = " ".repeat(Math.max(minGap, width - leftWidth - rightWidth));
    return truncateToWidth(`${left}${pad}${right}`, width);
  }

  // Drop git from left
  const leftSlim = pathLeft;
  const leftSlimWidth = visibleWidth(leftSlim);
  if (leftSlimWidth + minGap + rightWidth <= width) {
    const pad = " ".repeat(Math.max(minGap, width - leftSlimWidth - rightWidth));
    return truncateToWidth(`${leftSlim}${pad}${right}`, width);
  }

  // Drop thinking from right
  const rightSlim = joinNonEmpty(theme, [parts.modelLabel, parts.context], SEP);
  const rightSlimWidth = visibleWidth(rightSlim);
  if (leftSlimWidth + minGap + rightSlimWidth <= width) {
    const pad = " ".repeat(Math.max(minGap, width - leftSlimWidth - rightSlimWidth));
    return truncateToWidth(`${leftSlim}${pad}${rightSlim}`, width);
  }

  // Final fallback: model + context only
  return truncateToWidth(
    joinNonEmpty(theme, [parts.modelLabel, parts.context], SEP),
    width,
  );
}

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

interface CacheKey {
  width: number;
  cwd: string;
  branch: string | null;
  dirty: number | undefined;
  modelId: string | undefined;
  modelName: string | undefined;
  thinkingLevel: string;
  usedTokens: number | null;
  contextWindow: number;
  statusSignature: string;
  statusCount: number;
}

function cacheKeyEquals(a: CacheKey | undefined, b: CacheKey): boolean {
  if (!a) return false;
  return (
    a.width === b.width &&
    a.cwd === b.cwd &&
    a.branch === b.branch &&
    a.dirty === b.dirty &&
    a.modelId === b.modelId &&
    a.modelName === b.modelName &&
    a.thinkingLevel === b.thinkingLevel &&
    a.usedTokens === b.usedTokens &&
    a.contextWindow === b.contextWindow &&
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
  ctx.ui.setFooter(
    (_tui, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
      let cachedKey: CacheKey | undefined;
      let cachedLines: string[] | undefined;

      const invalidate = () => {
        cachedKey = undefined;
        cachedLines = undefined;
        // Footer render cache is internal to the custom component. Poking an
        // empty status key triggers pi's requestRender() without adding visible
        // content, so async git updates are reflected while idle.
        ctx.ui.setStatus(FOOTER_REFRESH_STATUS_KEY, undefined);
      };

      // Prime + watch git
      refreshDirty(ctx.cwd, invalidate);
      const dirtyTimer = setInterval(() => refreshDirty(ctx.cwd, invalidate), DIRTY_REFRESH_MS);
      if (typeof dirtyTimer.unref === "function") dirtyTimer.unref();

      const unsubBranch = footerData.onBranchChange(() => {
        // Branch changed → dirty count likely stale.
        dirtyCache.delete(ctx.cwd);
        refreshDirty(ctx.cwd, invalidate);
        invalidate();
      });

      return {
        invalidate() {
          cachedKey = undefined;
          cachedLines = undefined;
        },
        render(width: number): string[] {
          const branch = footerData.getGitBranch();
          const dirty = getCachedDirty(ctx.cwd);
          const thinkingLevel = getThinkingLevel();
          const usage: ContextUsage | undefined = ctx.getContextUsage?.();
          const usedTokens = usage?.tokens ?? null;
          const contextWindow =
            usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const statusInfo = getStatusInfo(theme, footerData);

          const key: CacheKey = {
            width,
            cwd: ctx.cwd,
            branch,
            dirty,
            modelId: ctx.model?.id,
            modelName: ctx.model?.name,
            thinkingLevel,
            usedTokens,
            contextWindow,
            statusSignature: statusInfo.signature,
            statusCount: statusInfo.texts.length,
          };

          if (cachedLines && cacheKeyEquals(cachedKey, key)) {
            return cachedLines;
          }

          // Path budget: roughly a third of the width when long, never less than 12.
          const pathBudget = Math.max(12, Math.floor(width * 0.34));
          const path = renderPath(theme, ctx.cwd, pathBudget);
          const git = renderGit(theme, branch, dirty);
          const modelLabel = theme.fg(
            "accent",
            `${ICONS.model} ${formatModelLabel(ctx.model)}`,
          );
          const thinking = thinkingText(theme, thinkingLevel);
          const context = contextText(theme, usedTokens, contextWindow);

          cachedLines = [
            renderLine(width, theme, {
              path,
              git,
              modelLabel,
              thinking,
              context,
              statusTexts: statusInfo.texts,
            }),
          ];
          cachedKey = key;
          return cachedLines;
        },
        dispose() {
          unsubBranch();
          clearInterval(dirtyTimer);
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
    if (!ctx.hasUI) return;
    attachFooter(ctx, getThinkingLevel);
  });

  // Refresh dirty count after agent_end (likely files just changed). Force so
  // commits/checkout performed by tools update immediately even inside the
  // normal debounce window.
  pi.on("agent_end", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    refreshDirty(ctx.cwd, () => ctx.ui.setStatus(FOOTER_REFRESH_STATUS_KEY, undefined), true);
  });
}
