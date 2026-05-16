/**
 * Cyber tool renderer
 *
 * Overrides built-in pi tools (read / bash / edit / write / grep / find / ls)
 * with a Claude Code style minimal display:
 *
 *   <icon> <name> <primary-arg>      <summary>      <duration>
 *
 * - Collapsed: single-line summary (default).
 * - Running:   spinner + tool name + elapsed time.
 * - Expanded:  full output (toggled by `app.tools.expand`, ctrl+o by default).
 *
 * Color & shape align with `themes/cyber-ui-dark.json`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { homedir } from "os";

import { toolRegistry } from "./tool-registry.js";

/** Subset of pi's ToolRenderContext we rely on (type not re-exported by pi). */
interface RenderCtx {
  toolCallId: string;
  cwd: string;
  invalidate: () => void;
  isPartial: boolean;
  isError: boolean;
  expanded: boolean;
}

// ---------------------------------------------------------------------------
// Cyber palette (raw RGB, mirrors themes/cyber-ui-dark.json)
// ---------------------------------------------------------------------------

const ICON_GREEN = "\x1b[38;2;158;206;106m"; // green
const ICON_RED = "\x1b[38;2;247;118;142m"; // red
const ICON_CYAN = "\x1b[38;2;125;207;255m"; // cyan
const ICON_ORANGE = "\x1b[38;2;224;175;104m"; // orange
const RESET = "\x1b[39m";
const BOLD = "\x1b[1m";
const UNBOLD = "\x1b[22m";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 80;

function spinnerFrame(): string {
  return SPINNER_FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length]!;
}

function paint(color: string, text: string, bold = false): string {
  const open = bold ? `${BOLD}${color}` : color;
  const close = bold ? `${RESET}${UNBOLD}` : RESET;
  return `${open}${text}${close}`;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function shortenPath(rawPath: string, cwd: string): string {
  if (!rawPath) return "";
  const home = homedir();

  // Try cwd-relative first.
  if (cwd) {
    if (rawPath === cwd) return ".";
    const cwdSlash = cwd.endsWith("/") ? cwd : `${cwd}/`;
    if (rawPath.startsWith(cwdSlash)) {
      return rawPath.slice(cwdSlash.length) || ".";
    }
  }

  if (home && (rawPath === home || rawPath.startsWith(`${home}/`))) {
    return `~${rawPath.slice(home.length)}`;
  }

  return rawPath;
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function asText(content: { type: string; text?: string }[]): string {
  for (const c of content) {
    if (c.type === "text" && typeof c.text === "string") return c.text;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Status icon — running / success / error
// ---------------------------------------------------------------------------

interface StatusOptions {
  isPartial: boolean;
  isError: boolean;
  toolCallId: string;
}

function statusIcon({ isPartial, isError, toolCallId }: StatusOptions): string {
  if (isPartial || toolRegistry.isRunning(toolCallId)) {
    return paint(ICON_CYAN, spinnerFrame(), true);
  }
  if (isError) return paint(ICON_RED, "✗", true);
  return paint(ICON_GREEN, "✓", true);
}

// ---------------------------------------------------------------------------
// Header — built once per render; identical visual across all tools.
// ---------------------------------------------------------------------------

interface HeaderOptions {
  theme: any;
  toolName: string;
  primary: string;
  /** Optional grayed suffix shown after the primary arg (e.g. ":1-120"). */
  primarySuffix?: string;
  /** Optional muted hint (e.g. " in src/") shown after primary. */
  hint?: string;
}

function renderHeader({
  theme,
  toolName,
  primary,
  primarySuffix = "",
  hint,
}: HeaderOptions): string {
  const namePart = theme.fg("toolTitle", theme.bold(toolName));
  const primaryPart = primary ? ` ${theme.fg("accent", primary)}` : "";
  const suffixPart = primarySuffix ? theme.fg("dim", primarySuffix) : "";
  const hintPart = hint ? theme.fg("muted", ` ${hint}`) : "";
  return `${namePart}${primaryPart}${suffixPart}${hintPart}`;
}

interface SummaryParts {
  /** Inline summary like "120 lines · 3.8KB" or "4 matches". Optional. */
  summary?: string;
  /** Pass true to suppress automatic duration suffix. */
  hideDuration?: boolean;
}

function renderSummaryLine(
  ctx: RenderCtx,
  theme: any,
  parts: SummaryParts,
): string {
  toolRegistry.setInvalidate(ctx.toolCallId, ctx.invalidate);

  const dur = formatDuration(toolRegistry.getDuration(ctx.toolCallId));
  const running = ctx.isPartial || toolRegistry.isRunning(ctx.toolCallId);

  const icon = statusIcon({
    isPartial: ctx.isPartial,
    isError: ctx.isError,
    toolCallId: ctx.toolCallId,
  });

  const segments: string[] = [icon];

  if (running) {
    segments.push(theme.fg("muted", "running"));
    if (dur) segments.push(theme.fg("dim", dur));
    return `  ${segments.join(" ")}`;
  }

  if (parts.summary) {
    segments.push(theme.fg("muted", parts.summary));
  }
  if (!parts.hideDuration && dur) {
    segments.push(theme.fg("dim", dur));
  }

  // For empty (e.g. write success), keep just the icon.
  return `  ${segments.join("  ")}`;
}

function emptyText(): Text {
  return new Text("", 0, 0);
}

// ---------------------------------------------------------------------------
// Tool definition cache
// ---------------------------------------------------------------------------

interface BuiltInDefs {
  read: ReturnType<typeof createReadToolDefinition>;
  bash: ReturnType<typeof createBashToolDefinition>;
  edit: ReturnType<typeof createEditToolDefinition>;
  write: ReturnType<typeof createWriteToolDefinition>;
  grep: ReturnType<typeof createGrepToolDefinition>;
  find: ReturnType<typeof createFindToolDefinition>;
  ls: ReturnType<typeof createLsToolDefinition>;
}

const cache = new Map<string, BuiltInDefs>();

function builtInDefs(cwd: string): BuiltInDefs {
  let defs = cache.get(cwd);
  if (!defs) {
    defs = {
      read: createReadToolDefinition(cwd),
      bash: createBashToolDefinition(cwd),
      edit: createEditToolDefinition(cwd),
      write: createWriteToolDefinition(cwd),
      grep: createGrepToolDefinition(cwd),
      find: createFindToolDefinition(cwd),
      ls: createLsToolDefinition(cwd),
    };
    cache.set(cwd, defs);
  }
  return defs;
}

function defaultDefsForRegistration(): BuiltInDefs {
  return builtInDefs(process.cwd());
}

// ---------------------------------------------------------------------------
// Per-tool summary helpers
// ---------------------------------------------------------------------------

function readSummary(result: any): string {
  const text = asText(result.content);
  if (!text) return "";
  const lines = text.split("\n").length;
  const bytes = Buffer.byteLength(text, "utf8");
  return `${lines} lines · ${formatSize(bytes)}`;
}

function bashSummary(result: any): string {
  const text = asText(result.content);
  const lines = text ? text.split("\n").length : 0;
  // Built-in bash details may include exitCode in details? Currently no. Try regex.
  const exitMatch = /exit code:\s*(\d+)/i.exec(text);
  const exit = exitMatch ? `exit ${exitMatch[1]}` : "";
  return [exit, lines > 0 ? `${lines} lines` : ""].filter(Boolean).join(" · ");
}

/**
 * Parse a unified diff and split changes into three buckets:
 *   added    — pure additions (no immediately preceding removal block)
 *   modified — paired removal+addition lines (line replaced)
 *   removed  — pure removals (no immediately following addition block)
 *
 * The split mirrors VSCode source control: when N `-` lines are followed
 * directly by M `+` lines, min(N,M) of them are counted as modifications,
 * the rest as pure adds/removes. This gives a more meaningful summary than
 * raw `+/-` counts which always inflate edits.
 */
function parseEditDiff(diff: string): { added: number; modified: number; removed: number } {
  const lines = diff
    .split("\n")
    .filter((l, index) => {
      // Unified diff file headers are the first two lines for this single-file
      // edit. Later lines that happen to start with +++/--- are real content.
      if (index === 0 && l.startsWith("--- ")) return false;
      if (index === 1 && l.startsWith("+++ ")) return false;
      return !l.startsWith("@@");
    });

  let added = 0;
  let modified = 0;
  let removed = 0;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.startsWith("-") && !line.startsWith("+")) {
      i += 1;
      continue;
    }

    let removes = 0;
    while (i < lines.length && lines[i]!.startsWith("-")) {
      removes += 1;
      i += 1;
    }

    let adds = 0;
    while (i < lines.length && lines[i]!.startsWith("+")) {
      adds += 1;
      i += 1;
    }

    if (removes === 0) {
      added += adds;
    } else if (adds === 0) {
      removed += removes;
    } else {
      const m = Math.min(removes, adds);
      modified += m;
      added += adds - m;
      removed += removes - m;
    }
  }

  return { added, modified, removed };
}

function renderEditStats(theme: any, details: any): string {
  if (!details || typeof details.diff !== "string") return "";
  const { added, modified, removed } = parseEditDiff(details.diff);
  if (added === 0 && modified === 0 && removed === 0) return "";

  const parts: string[] = [];
  if (added > 0) parts.push(theme.bold(theme.fg("toolDiffAdded", `+${added}`)));
  if (modified > 0) parts.push(theme.bold(theme.fg("warning", `~${modified}`)));
  if (removed > 0) parts.push(theme.bold(theme.fg("toolDiffRemoved", `−${removed}`)));
  return parts.join(" ");
}

function lineCountSummary(result: any, label: string): string {
  const text = asText(result.content).trim();
  if (!text) return "";
  if (/^No matches found$/i.test(text)) return `0 ${label}`;
  if (/^No files found/i.test(text)) return `0 ${label}`;
  const count = text.split("\n").filter(Boolean).length;
  if (count === 0) return "";
  return `${count} ${label}`;
}

// ---------------------------------------------------------------------------
// Expanded body renderer (shared)
// ---------------------------------------------------------------------------

function expandedBody(result: any, theme: any, opts?: { color?: string }): string {
  const text = asText(result.content);
  if (!text) return "";
  const color = opts?.color ?? "toolOutput";
  return text
    .replace(/\n+$/, "")
    .split("\n")
    .map((line) => theme.fg(color, line))
    .join("\n");
}

function expandedDiff(details: any, theme: any): string {
  if (!details || typeof details.diff !== "string") return "";
  return details.diff
    .replace(/\n+$/, "")
    .split("\n")
    .map((line: string, index: number) => {
      if (index === 0 && line.startsWith("--- ")) return theme.fg("dim", line);
      if (index === 1 && line.startsWith("+++ ")) return theme.fg("dim", line);
      if (line.startsWith("@@")) return theme.fg("dim", line);
      if (line.startsWith("+")) return theme.fg("toolDiffAdded", line);
      if (line.startsWith("-")) return theme.fg("toolDiffRemoved", line);
      return theme.fg("toolDiffContext", line);
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export default function toolRender(pi: ExtensionAPI) {
  const initial = defaultDefsForRegistration();

  // -------------------------------------------------------------------------
  // read
  // -------------------------------------------------------------------------
  pi.registerTool({
    ...initial.read,
    name: "read",
    label: "read",
    description: initial.read.description,
    parameters: initial.read.parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return builtInDefs(ctx.cwd).read.execute(toolCallId, params, signal, onUpdate, ctx);
    },

    renderCall(args, theme, ctx) {
      const path = shortenPath(args.path ?? "", ctx.cwd);
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      let suffix = "";
      if (offset !== undefined || limit !== undefined) {
        const start = offset ?? 1;
        const end = limit !== undefined ? `-${start + limit - 1}` : "";
        suffix = `:${start}${end}`;
      }
      return new Text(
        renderHeader({
          theme,
          toolName: "read",
          primary: path || "...",
          primarySuffix: suffix,
        }),
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme, ctx) {
      const summary = readSummary(result);
      const head = renderSummaryLine(ctx, theme, { summary });
      if (!expanded) return new Text(head, 0, 0);
      const body = expandedBody(result, theme);
      return new Text(body ? `${head}\n${body}` : head, 0, 0);
    },
  });

  // -------------------------------------------------------------------------
  // bash
  // -------------------------------------------------------------------------
  pi.registerTool({
    ...initial.bash,
    name: "bash",
    label: "bash",
    description: initial.bash.description,
    parameters: initial.bash.parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return builtInDefs(ctx.cwd).bash.execute(toolCallId, params, signal, onUpdate, ctx);
    },

    renderCall(args, theme, _ctx) {
      const command = (args.command as string | undefined) ?? "...";
      const timeout = args.timeout as number | undefined;
      const display =
        command.length > 100 ? `${command.slice(0, 97)}…` : command;
      const hint = timeout ? `(timeout ${timeout}s)` : undefined;
      const namePart = theme.fg("toolTitle", theme.bold("$"));
      const cmdPart = theme.fg("accent", display);
      const hintPart = hint ? theme.fg("muted", ` ${hint}`) : "";
      return new Text(`${namePart} ${cmdPart}${hintPart}`, 0, 0);
    },

    renderResult(result, { expanded }, theme, ctx) {
      const summary = bashSummary(result);
      const head = renderSummaryLine(ctx, theme, { summary });
      if (!expanded) return new Text(head, 0, 0);
      const body = expandedBody(result, theme, {
        color: ctx.isError ? "error" : "toolOutput",
      });
      return new Text(body ? `${head}\n${body}` : head, 0, 0);
    },
  });

  // -------------------------------------------------------------------------
  // edit
  // -------------------------------------------------------------------------
  pi.registerTool({
    ...initial.edit,
    name: "edit",
    label: "edit",
    description: initial.edit.description,
    parameters: initial.edit.parameters,
    prepareArguments: initial.edit.prepareArguments,
    // Force the default boxed shell. The built-in edit definition uses
    // `renderShell: "self"` for its rich preview component; without this
    // override pi merges that field back in and the row loses its background
    // tint, breaking visual parity with the other tools.
    renderShell: "default",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return builtInDefs(ctx.cwd).edit.execute(toolCallId, params, signal, onUpdate, ctx);
    },

    renderCall(args, theme, ctx) {
      const path = shortenPath(args.path ?? "", ctx.cwd);
      const editsCount = Array.isArray(args.edits) ? args.edits.length : 0;
      const hint = editsCount > 1 ? `(${editsCount} edits)` : undefined;
      return new Text(
        renderHeader({
          theme,
          toolName: "edit",
          primary: path || "...",
          hint,
        }),
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme, ctx) {
      const summary = renderEditStats(theme, result.details);
      const head = renderSummaryLine(ctx, theme, { summary });
      if (!expanded) return new Text(head, 0, 0);

      const body = ctx.isError
        ? expandedBody(result, theme, { color: "error" })
        : expandedDiff(result.details, theme) || expandedBody(result, theme);
      return new Text(body ? `${head}\n${body}` : head, 0, 0);
    },
  });

  // -------------------------------------------------------------------------
  // write
  // -------------------------------------------------------------------------
  pi.registerTool({
    ...initial.write,
    name: "write",
    label: "write",
    description: initial.write.description,
    parameters: initial.write.parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return builtInDefs(ctx.cwd).write.execute(toolCallId, params, signal, onUpdate, ctx);
    },

    renderCall(args, theme, ctx) {
      const path = shortenPath(args.path ?? "", ctx.cwd);
      const content = args.content as string | undefined;
      const lines = content ? content.split("\n").length : 0;
      const hint = lines > 0 ? `+${lines} lines` : undefined;
      return new Text(
        renderHeader({
          theme,
          toolName: "write",
          primary: path || "...",
          hint,
        }),
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme, ctx) {
      // Successful write produces no useful output; keep summary empty.
      const head = renderSummaryLine(ctx, theme, {});
      if (!expanded) return new Text(head, 0, 0);
      if (ctx.isError) {
        const body = expandedBody(result, theme, { color: "error" });
        return new Text(body ? `${head}\n${body}` : head, 0, 0);
      }
      return new Text(head, 0, 0);
    },
  });

  // -------------------------------------------------------------------------
  // grep
  // -------------------------------------------------------------------------
  pi.registerTool({
    ...initial.grep,
    name: "grep",
    label: "grep",
    description: initial.grep.description,
    parameters: initial.grep.parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return builtInDefs(ctx.cwd).grep.execute(toolCallId, params, signal, onUpdate, ctx);
    },

    renderCall(args, theme, ctx) {
      const pattern = (args.pattern as string | undefined) ?? "";
      const path = shortenPath((args.path as string | undefined) ?? "", ctx.cwd);
      const glob = args.glob as string | undefined;
      const hintParts: string[] = [];
      if (path) hintParts.push(`in ${path}`);
      if (glob) hintParts.push(`(${glob})`);
      return new Text(
        renderHeader({
          theme,
          toolName: "grep",
          primary: `/${pattern}/`,
          hint: hintParts.join(" "),
        }),
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme, ctx) {
      const summary = lineCountSummary(result, "matches");
      const head = renderSummaryLine(ctx, theme, { summary });
      if (!expanded) return new Text(head, 0, 0);
      const body = expandedBody(result, theme);
      return new Text(body ? `${head}\n${body}` : head, 0, 0);
    },
  });

  // -------------------------------------------------------------------------
  // find
  // -------------------------------------------------------------------------
  pi.registerTool({
    ...initial.find,
    name: "find",
    label: "find",
    description: initial.find.description,
    parameters: initial.find.parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return builtInDefs(ctx.cwd).find.execute(toolCallId, params, signal, onUpdate, ctx);
    },

    renderCall(args, theme, ctx) {
      const pattern = (args.pattern as string | undefined) ?? "";
      const path = shortenPath((args.path as string | undefined) ?? "", ctx.cwd);
      const hint = path ? `in ${path}` : undefined;
      return new Text(
        renderHeader({
          theme,
          toolName: "find",
          primary: pattern,
          hint,
        }),
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme, ctx) {
      const summary = lineCountSummary(result, "files");
      const head = renderSummaryLine(ctx, theme, { summary });
      if (!expanded) return new Text(head, 0, 0);
      const body = expandedBody(result, theme);
      return new Text(body ? `${head}\n${body}` : head, 0, 0);
    },
  });

  // -------------------------------------------------------------------------
  // ls
  // -------------------------------------------------------------------------
  pi.registerTool({
    ...initial.ls,
    name: "ls",
    label: "ls",
    description: initial.ls.description,
    parameters: initial.ls.parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return builtInDefs(ctx.cwd).ls.execute(toolCallId, params, signal, onUpdate, ctx);
    },

    renderCall(args, theme, ctx) {
      const path = shortenPath((args.path as string | undefined) ?? ".", ctx.cwd);
      return new Text(
        renderHeader({
          theme,
          toolName: "ls",
          primary: path || ".",
        }),
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme, ctx) {
      const summary = lineCountSummary(result, "entries");
      const head = renderSummaryLine(ctx, theme, { summary });
      if (!expanded) return new Text(head, 0, 0);
      const body = expandedBody(result, theme);
      return new Text(body ? `${head}\n${body}` : head, 0, 0);
    },
  });

  // Suppress unused warning for icons we keep for future use.
  void ICON_ORANGE;
}
