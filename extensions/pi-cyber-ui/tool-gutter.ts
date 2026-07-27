/**
 * Tool gutter — neon status bar + uniform slate panel for built-in tools.
 *
 * Design language (see design/DESIGN.html):
 *   - one neutral panel surface for every state (elevation by luminance);
 *     status lives entirely in the left bar
 *   - bar (static, no animation — deliberately timer-free):
 *       pending = blue · success = teal · error = red
 *   - call slot text follows the tokyonight fish shell palette: tool name /
 *     command = cyan, params = pink
 *
 * Official wrap pattern (pi docs "Overriding Built-in Tools"): register
 * same-name tools whose `execute` is the untouched built-in implementation
 * (loaded from the exact Pi package running this process), and only replace
 * the shell:
 *
 *   - `renderShell: "self"` bypasses the default background Box entirely
 *   - built-in `renderCall` / `renderResult` are reused as-is (syntax
 *     highlighting, diffs, expand/collapse all inherited)
 *   - vertical padding is normalized at the shell level: inner blank lines
 *     are trimmed and every panel gets exactly one padded line top/bottom
 *     plus one separator line between call and result, so bash/read/edit
 *     all share the same silhouette
 *
 * Same-name extension / SDK tools are never overridden. Active extension
 * tools keep their original rendering and produce one startup/reload warning
 * that the gutter was skipped; default block shells still inherit the theme's
 * tool*Bg tokens.
 */
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

import type { CyberUiConfig } from "./config.js";
import { bgRgb, paint, palette, RESET_BG, rgb, type RGB } from "./palette.js";
import { importRunningPiModule } from "./runtime-pi.js";

type AnyToolDefinition = ToolDefinition<any, any, any>;
type RenderCall = NonNullable<AnyToolDefinition["renderCall"]>;
type RenderResult = NonNullable<AnyToolDefinition["renderResult"]>;
type RenderContext = Parameters<RenderCall>[2];

type BuiltinToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
type ToolFactory = (cwd: string) => AnyToolDefinition;

const BUILTIN_TOOL_SPECS = [
  ["read", "createReadToolDefinition"],
  ["bash", "createBashToolDefinition"],
  ["edit", "createEditToolDefinition"],
  ["write", "createWriteToolDefinition"],
  ["grep", "createGrepToolDefinition"],
  ["find", "createFindToolDefinition"],
  ["ls", "createLsToolDefinition"],
] as const satisfies readonly (readonly [BuiltinToolName, string])[];

export interface ToolGutterDependencies {
  loadBuiltinDefinitions(cwd: string): Promise<ReadonlyMap<BuiltinToolName, AnyToolDefinition> | undefined>;
}

export async function loadRunningBuiltinDefinitions(
  cwd: string,
): Promise<ReadonlyMap<BuiltinToolName, AnyToolDefinition> | undefined> {
  const mod = await importRunningPiModule();
  if (!mod) return undefined;

  const definitions = new Map<BuiltinToolName, AnyToolDefinition>();
  for (const [name, exportName] of BUILTIN_TOOL_SPECS) {
    try {
      const factory = mod[exportName];
      if (typeof factory !== "function") continue;
      const definition = (factory as ToolFactory)(cwd);
      if (definition.name === name && typeof definition.execute === "function") {
        definitions.set(name, definition);
      }
    } catch {
      // A missing or incompatible factory must degrade to Pi's original tool.
    }
  }
  return definitions;
}

const DEFAULT_DEPENDENCIES: ToolGutterDependencies = {
  loadBuiltinDefinitions: loadRunningBuiltinDefinitions,
};

const BAR = "▍"; // 3/8 block — between the thin ▎ and the heavy ▌
const BAR_WIDTH = 2; // bar + space
const FULL_RESET = "\x1b[0m";
const SGR_OR_OSC = /\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g;
const PANEL_BG = bgRgb(palette.toolSurface);

/**
 * Some built-in renderers (edit) paint their own shell Box with the theme's
 * tool-state backgrounds. Those are shell chrome, not content — rewrite them
 * to the panel surface so the row stays one continuous tone. Content
 * highlights (diff word-level backgrounds etc.) use other colors and pass
 * through untouched.
 */
const SHELL_BG_SEQUENCES = [palette.bgAlt, palette.toolErrorBg, palette.toolSurface].map((c) =>
  bgRgb(c),
);

function normalizeShellBg(line: string, panelBg: string): string {
  let result = line;
  for (const seq of SHELL_BG_SEQUENCES) {
    result = result.replaceAll(seq, panelBg);
  }
  return result;
}

function isBlankLine(line: string): boolean {
  return line.replace(SGR_OR_OSC, "").trim() === "";
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && isBlankLine(lines[start]!)) start++;
  while (end > start && isBlankLine(lines[end - 1]!)) end--;
  return lines.slice(start, end);
}

const BOLD_ON = "\x1b[1m";
const ACCENT_FG = rgb(palette.cyan);
const PARAM_FG = rgb(palette.pink);

/**
 * Built-in call renderers paint paths/args with the accent color (cyan),
 * which now equals toolTitle. Rewrite non-bold accent runs to the fish
 * param color (pink): tool names are `fg(toolTitle, bold(...))`, so
 * their accent sequence is immediately followed by bold-on — params are not.
 */
function recolorCallParams(line: string): string {
  let out = "";
  let idx = 0;
  while (true) {
    const at = line.indexOf(ACCENT_FG, idx);
    if (at === -1) {
      out += line.slice(idx);
      return out;
    }
    out += line.slice(idx, at);
    const follows = line.slice(at + ACCENT_FG.length, at + ACCENT_FG.length + BOLD_ON.length);
    out += follows === BOLD_ON ? ACCENT_FG : PARAM_FG;
    idx = at + ACCENT_FG.length;
  }
}

/** Static bar colors — no timers, no animation state. */
const BAR_PENDING: RGB = palette.blue;
const BAR_SUCCESS: RGB = palette.teal;
const BAR_ERROR: RGB = palette.red;

/** Row-scoped state shared by the call and result slots of one tool row. */
interface GutterShell {
  /** The result slot has rendered; the call slot skips its bottom padding. */
  hasResult: boolean;
  /** Current bar color, shared by both slots. */
  barColor: RGB;
}

function getShell(context: RenderContext): GutterShell {
  const state = context.state as { __gutterShell?: GutterShell };
  state.__gutterShell ??= { hasResult: false, barColor: BAR_SUCCESS };
  return state.__gutterShell;
}

/**
 * Prefixes every line of the wrapped component with a colored status bar,
 * paints the uniform panel surface across the full row width, and normalizes
 * vertical padding (call slot pads the top, result slot separator + bottom).
 */
interface GutterRenderCache {
  width: number;
  inner: Component;
  innerLines: string[];
  innerLinesRef: string[];
  barColor: RGB;
  hasResult: boolean;
  lines: string[];
}

function linesEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

function colorsEqual(a: RGB, b: RGB): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

class GutterComponent implements Component {
  inner: Component | undefined;
  private cache: GutterRenderCache | undefined;

  constructor(
    private readonly role: "call" | "result",
    private readonly shell: GutterShell,
    private readonly recolorParams: boolean,
  ) {}

  render(width: number): string[] {
    if (!this.inner || width <= 0) return [];

    const innerWidth = Math.max(1, width - BAR_WIDTH);
    const innerLines = this.inner.render(innerWidth);
    const cached = this.cache;
    if (
      cached &&
      cached.width === width &&
      cached.inner === this.inner &&
      cached.hasResult === this.shell.hasResult &&
      colorsEqual(cached.barColor, this.shell.barColor) &&
      (cached.innerLinesRef === innerLines || linesEqual(cached.innerLines, innerLines))
    ) {
      return cached.lines;
    }

    const bg = PANEL_BG;
    const prefix = bg + paint(this.shell.barColor, BAR) + " ";
    const blank = prefix + " ".repeat(innerWidth) + RESET_BG;
    const content = trimBlankEdges(innerLines);
    let rows: string[];

    if (content.length === 0) {
      // Empty result still supplies the bottom padding it owns.
      rows = this.role === "result" ? [blank] : [];
    } else {
      rows = [blank]; // call: top padding · result: separator
      for (const rawLine of content) {
        const line = this.recolorParams && this.role === "call" ? recolorCallParams(rawLine) : rawLine;
        // Inner renderers may emit full SGR resets; re-arm the panel bg after
        // each so the surface stays continuous. Shell-state backgrounds painted
        // by inner Boxes (edit) are rewritten to the panel tone.
        const restored = normalizeShellBg(line, bg)
          .replaceAll(FULL_RESET, FULL_RESET + bg)
          .replaceAll(RESET_BG, bg);
        const pad = Math.max(0, innerWidth - visibleWidth(line));
        rows.push(prefix + restored + " ".repeat(pad) + RESET_BG);
      }
      if (this.role === "result" || !this.shell.hasResult) rows.push(blank); // bottom padding
    }

    const fitted = rows.map((line) =>
      visibleWidth(line) > width ? truncateToWidth(line, width, "") : line,
    );
    this.cache = {
      width,
      inner: this.inner,
      innerLines: [...innerLines],
      innerLinesRef: innerLines,
      barColor: this.shell.barColor,
      hasResult: this.shell.hasResult,
      lines: fitted,
    };
    return fitted;
  }

  invalidate(): void {
    this.cache = undefined;
    this.inner?.invalidate();
  }
}

function getTextContent(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Bash is the one built-in whose renderCall paints the whole `$ command` in
 * bold toolTitle. Restyle with the tokyonight fish syntax palette so tool
 * rows read exactly like the user's shell:
 *
 *   command → cyan · option/param → pink · quote → orange
 *   end (| ; &&) → orange · $expansion → green · comment → fgDim
 *   redirection → fg (unpainted)
 */
const SHELL_OPERATOR = /^(\|\||&&|>{1,2}&?\d*|<{1,2}|;|\||&)/;
const COMMAND_CHAINERS = new Set(["sudo", "env", "time", "nohup", "xargs", "exec", "command"]);
const WRAPPER_OPTIONS_WITH_VALUE = new Map<string, ReadonlySet<string>>([
  [
    "sudo",
    new Set([
      "-u", "--user", "-g", "--group", "-h", "--host",
      "-C", "--close-from", "-R", "--chroot", "-D", "--chdir",
    ]),
  ],
  ["env", new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"])],
  ["time", new Set(["-f", "--format", "-o", "--output"])],
  [
    "xargs",
    new Set([
      "-a", "--arg-file", "-E", "--eof", "-I", "--replace",
      "-L", "--max-lines", "-n", "--max-args", "-P", "--max-procs",
      "-s", "--max-chars",
    ]),
  ],
]);
const WORD_BREAK = " \t'\"|;&<>";
const COMMAND_SEPARATORS = new Set(["||", "&&", "|", ";", "&"]);

type ShellTheme = Parameters<RenderCall>[1];

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
}

function wrapperOptionNeedsValue(wrapper: string, option: string): boolean {
  if (option.includes("=")) return false;
  return WRAPPER_OPTIONS_WITH_VALUE.get(wrapper)?.has(option) ?? false;
}

function findHeredocMarker(line: string): string | undefined {
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote && !isEscaped(line, i)) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch !== "<" || line[i + 1] !== "<" || line[i + 2] === "<") continue;

    let j = i + 2;
    if (line[j] === "-") j++;
    while (line[j] === " " || line[j] === "\t") j++;
    const markerQuote = line[j] === "'" || line[j] === '"' ? line[j++] : undefined;
    const start = j;
    while (
      j < line.length &&
      (markerQuote ? line[j] !== markerQuote : !" \t|;&<>".includes(line[j]!))
    ) {
      j++;
    }
    const marker = line.slice(start, j);
    if (marker) return marker;
  }
  return undefined;
}

function highlightShellLine(line: string, startAsCommand: boolean): string {
  let out = "";
  let i = 0;
  let expectCommand = startAsCommand;
  let wrapper: string | undefined;
  let wrapperOptionValue = false;
  const n = line.length;
  while (i < n) {
    const ch = line[i]!;
    if (ch === " " || ch === "\t") {
      out += ch;
      i++;
      continue;
    }
    if (ch === "#") {
      out += paint(palette.fgDim, line.slice(i));
      break;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n && (line[j] !== ch || isEscaped(line, j))) j++;
      const end = Math.min(n, j + 1);
      out += paint(palette.orange, line.slice(i, end));
      i = end;
      expectCommand = false;
      continue;
    }
    const op = SHELL_OPERATOR.exec(line.slice(i));
    if (op) {
      // fish: command separators use the "end" color; redirections stay fg.
      out += COMMAND_SEPARATORS.has(op[0]) ? paint(palette.orange, op[0]) : op[0];
      i += op[0].length;
      if (COMMAND_SEPARATORS.has(op[0])) {
        expectCommand = true;
        wrapper = undefined;
        wrapperOptionValue = false;
      }
      continue;
    }
    let j = i;
    while (j < n && !WORD_BREAK.includes(line[j]!)) j++;
    const word = line.slice(i, j);
    if (word.startsWith("$")) {
      out += paint(palette.green, word);
      expectCommand = false;
      wrapper = undefined;
    } else if (expectCommand && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      out += paint(palette.pink, word); // env assignment; still expecting the command
    } else if (expectCommand && wrapperOptionValue) {
      out += paint(palette.pink, word);
      wrapperOptionValue = false;
    } else if (expectCommand && wrapper && word.startsWith("-")) {
      out += paint(palette.pink, word);
      wrapperOptionValue = wrapperOptionNeedsValue(wrapper, word);
    } else if (expectCommand) {
      out += paint(palette.cyan, word);
      if (COMMAND_CHAINERS.has(word)) {
        wrapper = word;
      } else {
        expectCommand = false;
        wrapper = undefined;
      }
    } else {
      out += paint(palette.pink, word); // options and params share the fish param color
    }
    i = j;
  }
  return out;
}

export function highlightShellCommand(command: string): string {
  const lines = command.split("\n");
  const out: string[] = [];
  let heredocMarker: string | undefined;
  for (const line of lines) {
    if (heredocMarker) {
      out.push(paint(palette.orange, line));
      if (line.trim() === heredocMarker) heredocMarker = undefined;
      continue;
    }
    out.push(highlightShellLine(line, true));
    heredocMarker = findHeredocMarker(line);
  }
  return out.join("\n");
}

function formatCyberBashCall(args: unknown, theme: ShellTheme): string {
  const record = (args ?? {}) as { command?: unknown; timeout?: unknown };
  const command = typeof record.command === "string" && record.command ? record.command : undefined;
  const timeoutSuffix =
    typeof record.timeout === "number" ? theme.fg("muted", ` (timeout ${record.timeout}s)`) : "";
  const commandDisplay = command ? highlightShellCommand(command) : theme.fg("toolOutput", "...");
  return theme.fg("accent", theme.bold("$")) + " " + commandDisplay + timeoutSuffix;
}

function renderIntoGutter(
  role: "call" | "result",
  context: RenderContext,
  buildInner: (innerContext: RenderContext) => Component,
  isPartial: boolean,
  recolorParams: boolean,
): Component {
  const shell = getShell(context);
  if (role === "result") shell.hasResult = true;
  const outer =
    context.lastComponent instanceof GutterComponent
      ? context.lastComponent
      : new GutterComponent(role, shell, recolorParams);
  // Built-in renderers cache via context.lastComponent; hand them their own
  // inner component instead of our wrapper.
  outer.inner = buildInner({ ...context, lastComponent: outer.inner });

  shell.barColor = context.isError ? BAR_ERROR : isPartial ? BAR_PENDING : BAR_SUCCESS;
  return outer;
}

function wrapDefinition(def: AnyToolDefinition): AnyToolDefinition {
  const innerCall: RenderCall = (args, theme, context) => {
    const component = def.renderCall
      ? def.renderCall(args, theme, context)
      : new Text(theme.fg("toolTitle", theme.bold(def.name)), 0, 0);
    if (def.name === "bash") {
      // Built-in renderCall already updated its timing state; only the text
      // styling is replaced. Duck-typed: Text instances may come from pi's
      // own pi-tui copy.
      const text = component as { setText?: (content: string) => void };
      text.setText?.(formatCyberBashCall(args, theme));
    }
    return component;
  };
  const innerResult: RenderResult = (result, options, theme, context) =>
    def.renderResult
      ? def.renderResult(result, options, theme, context)
      : new Text(theme.fg("toolOutput", getTextContent(result)), 0, 0);

  return {
    ...def,
    renderShell: "self",
    renderCall(args, theme, context) {
      return renderIntoGutter(
        "call",
        context,
        (inner) => innerCall(args, theme, inner),
        context.isPartial,
        def.name !== "bash", // bash styles itself via the fish tokenizer
      );
    },
    renderResult(result, options, theme, context) {
      return renderIntoGutter(
        "result",
        context,
        (inner) => innerResult(result, options, theme, inner),
        options.isPartial ?? false,
        false,
      );
    },
  };
}

function summarizeToolNames(names: readonly string[], limit = 2): string {
  const shown = names.slice(0, limit);
  const remaining = names.length - shown.length;
  return remaining > 0 ? `${shown.join(", ")} +${remaining}` : shown.join(", ");
}

function getActiveExtensionToolNames(
  pi: ExtensionAPI,
  sourceByName: ReadonlyMap<string, string>,
): string[] {
  return pi.getActiveTools().filter((name) => {
    const source = sourceByName.get(name);
    return source !== undefined && source !== "builtin";
  });
}

export default function toolGutter(
  pi: ExtensionAPI,
  config: CyberUiConfig,
  dependencies: ToolGutterDependencies = DEFAULT_DEPENDENCIES,
): void {
  if (config.toolHighlight !== "gutter") return;

  let registered = false;
  pi.on("session_start", async (event, ctx) => {
    const mode = (ctx as { mode?: string }).mode;
    if (registered || !ctx.hasUI || (mode !== undefined && mode !== "tui")) return;
    registered = true;

    const sourceByName = new Map(
      pi.getAllTools().map((tool) => [tool.name, tool.sourceInfo.source] as const),
    );
    const skippedExtensionTools = getActiveExtensionToolNames(pi, sourceByName);
    const definitions = await dependencies.loadBuiltinDefinitions(ctx.cwd);

    if (definitions) {
      for (const [name] of BUILTIN_TOOL_SPECS) {
        // A same-name extension/SDK tool owns its behavior and rendering. Only
        // replace tools that are still Pi's untouched built-ins.
        if (sourceByName.get(name) !== "builtin") continue;
        const definition = definitions.get(name);
        if (definition) pi.registerTool(wrapDefinition(definition));
      }
    }

    if (
      skippedExtensionTools.length > 0 &&
      (event.reason === "startup" || event.reason === "reload")
    ) {
      ctx.ui.notify(
        `pi-cyber-ui gutter wrap skipped for extension tools: ${summarizeToolNames(skippedExtensionTools)} · using themed block fallback`,
        "warning",
      );
    }
  });
}
