/**
 * Tool gutter — neon status bar + uniform slate panel for built-in tools.
 *
 * Design language (see design/DESIGN.html · v2 "信号克制"):
 *   - one neutral panel surface for every state (elevation by luminance);
 *     status lives entirely in the left bar
 *   - bar: pending = cyan neon breathing · success = teal (settle blink:
 *     flash to cyanBright, ease down) · error = red
 *   - call slot text follows the tokyonight fish shell palette: tool name /
 *     command = cyan, params = pink
 *
 * Official wrap pattern (pi docs "Overriding Built-in Tools"): register
 * same-name tools whose `execute` is the untouched built-in implementation
 * (obtained at runtime via `create*ToolDefinition`, so behavior follows pi
 * updates automatically), and only replace the shell:
 *
 *   - `renderShell: "self"` bypasses the default background Box entirely
 *   - built-in `renderCall` / `renderResult` are reused as-is (syntax
 *     highlighting, diffs, expand/collapse all inherited)
 *   - vertical padding is normalized at the shell level: inner blank lines
 *     are trimmed and every panel gets exactly one padded line top/bottom
 *     plus one separator line between call and result, so bash/read/edit
 *     all share the same silhouette
 *
 * Third-party extension tools cannot be wrapped (their full definitions are
 * not reachable through the extension API); they keep pi's default block
 * shell, styled by the theme's tool*Bg tokens on the same panel tone.
 */
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth, type Component } from "@earendil-works/pi-tui";

import type { CyberUiConfig } from "./config.js";
import { bgRgb, mix, paint, palette, RESET_BG, rgb, type RGB } from "./palette.js";

type AnyToolDefinition = ToolDefinition<any, any, any>;
type RenderCall = NonNullable<AnyToolDefinition["renderCall"]>;
type RenderResult = NonNullable<AnyToolDefinition["renderResult"]>;
type RenderContext = Parameters<RenderCall>[2];

const BAR = "▍"; // 3/8 block — between the thin ▎ and the heavy ▌
const BAR_WIDTH = 2; // bar + space
const PULSE_PERIOD_MS = 2400;
const SETTLE_FLASH_MS = 140;
const POWER_DOWN_MS = 900; // flash rise + ease-down total
const FRAME_MS = 16; // 60fps sampling; renders are gated on actual color change
/** Breathing valley — shallow sink so the pending bar keeps its neon glow. */
const PULSE_DIM: RGB = mix(palette.cyan, palette.toolSurface, 0.45);
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

/** Bar animation state — a pure function of time (see animColor). */
type BarAnim =
  | { kind: "static"; color: RGB }
  | { kind: "pulse" }
  | { kind: "fade"; settledAt: number; from: RGB };

function animColor(anim: BarAnim, now: number): RGB {
  switch (anim.kind) {
    case "static":
      return anim.color;
    case "pulse": {
      const phase = (now % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
      const k = (1 - Math.cos(phase * 2 * Math.PI)) / 2; // 0 → 1 → 0
      return mix(palette.cyan, PULSE_DIM, k);
    }
    case "fade": {
      // Settle blink: rise to cyanBright (unmissable "done" flash), then
      // ease down to the neon teal rest color. Phase-continuous: `from` is
      // the pulse color at the settle instant.
      const elapsed = now - anim.settledAt;
      if (elapsed >= POWER_DOWN_MS) return palette.teal;
      if (elapsed < SETTLE_FLASH_MS) {
        return mix(anim.from, palette.cyanBright, elapsed / SETTLE_FLASH_MS);
      }
      const t = (elapsed - SETTLE_FLASH_MS) / (POWER_DOWN_MS - SETTLE_FLASH_MS);
      return mix(palette.cyanBright, palette.teal, 1 - (1 - t) ** 2); // ease-out
    }
  }
}

function animDone(anim: BarAnim, now: number): boolean {
  if (anim.kind === "static") return true;
  if (anim.kind === "fade") return now - anim.settledAt >= POWER_DOWN_MS;
  return false;
}

/** Row-scoped state shared by the call and result slots of one tool row. */
interface GutterShell {
  /** The row was observed live (streaming); enables the settle blink. */
  sawPartial: boolean;
  /** The result slot has rendered; the call slot skips its bottom padding. */
  hasResult: boolean;
  /** Current bar animation, shared by both slots. */
  anim: BarAnim;
  /** Row animation loop (one per row, 60fps, color-change gated). */
  loop: ReturnType<typeof setTimeout> | undefined;
  lastLoopColor: RGB | undefined;
  /**
   * True while an animation frame invalidates the row. Animation frames only
   * change the bar color, so inner render caches are preserved (pi-tui
   * components cache render output and rebuild on invalidate).
   */
  animFrame: boolean;
}

function getShell(context: RenderContext): GutterShell {
  const state = context.state as { __gutterShell?: GutterShell };
  state.__gutterShell ??= {
    sawPartial: false,
    hasResult: false,
    anim: { kind: "static", color: palette.teal },
    loop: undefined,
    lastLoopColor: undefined,
    animFrame: false,
  };
  return state.__gutterShell;
}

/**
 * One 60fps sampling loop per tool row. Each frame computes the bar color
 * from wall-clock time and only triggers a row re-render when the quantized
 * color actually changed — near the cosine peaks this naturally idles.
 */
function ensureAnimLoop(shell: GutterShell, invalidate: () => void): void {
  if (shell.loop) return;
  if (animDone(shell.anim, Date.now())) return;
  const tick = () => {
    shell.loop = undefined;
    const now = Date.now();
    const color = animColor(shell.anim, now);
    const last = shell.lastLoopColor;
    if (!last || last[0] !== color[0] || last[1] !== color[1] || last[2] !== color[2]) {
      shell.lastLoopColor = color;
      // Animation frames only recolor the bar prefix — keep inner caches.
      shell.animFrame = true;
      try {
        invalidate();
      } finally {
        shell.animFrame = false;
      }
    }
    if (!shell.loop && !animDone(shell.anim, now)) {
      shell.loop = setTimeout(tick, FRAME_MS);
      shell.loop.unref?.();
    }
  };
  shell.loop = setTimeout(tick, FRAME_MS);
  shell.loop.unref?.();
}

/**
 * Prefixes every line of the wrapped component with a colored status bar,
 * paints the uniform panel surface across the full row width, and normalizes
 * vertical padding (call slot pads the top, result slot separator + bottom).
 */
class GutterComponent implements Component {
  inner: Component | undefined;

  constructor(
    private readonly role: "call" | "result",
    private readonly shell: GutterShell,
    private readonly recolorParams: boolean,
  ) {}

  render(width: number): string[] {
    if (!this.inner) return [];
    const barColor = animColor(this.shell.anim, Date.now());
    const bg = PANEL_BG;
    const prefix = bg + paint(barColor, BAR) + " ";
    const innerWidth = Math.max(8, width - BAR_WIDTH);
    const blank = prefix + " ".repeat(innerWidth) + RESET_BG;
    const content = trimBlankEdges(this.inner.render(innerWidth));
    if (content.length === 0) {
      // Empty result still supplies the bottom padding it owns.
      return this.role === "result" ? [blank] : [];
    }
    const rows: string[] = [blank]; // call: top padding · result: separator
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
    return rows;
  }

  invalidate(): void {
    // Skip cache-busting for animation frames; only the bar color changed.
    if (!this.shell.animFrame) this.inner?.invalidate();
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
const WORD_BREAK = " \t'\"|;&<>#";
const COMMAND_SEPARATORS = new Set(["||", "&&", "|", ";", "&"]);

type ShellTheme = Parameters<RenderCall>[1];

function highlightShellLine(line: string, startAsCommand: boolean): string {
  let out = "";
  let i = 0;
  let expectCommand = startAsCommand;
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
      while (j < n && (line[j] !== ch || line[j - 1] === "\\")) j++;
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
      if (COMMAND_SEPARATORS.has(op[0])) expectCommand = true;
      continue;
    }
    let j = i;
    while (j < n && !WORD_BREAK.includes(line[j]!)) j++;
    const word = line.slice(i, j);
    if (word.startsWith("$")) {
      out += paint(palette.green, word);
      expectCommand = false;
    } else if (expectCommand && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      out += paint(palette.pink, word); // env assignment; still expecting the command
    } else if (expectCommand) {
      out += paint(palette.cyan, word);
      if (!COMMAND_CHAINERS.has(word)) expectCommand = false;
    } else {
      out += paint(palette.pink, word); // options and params share the fish param color
    }
    i = j;
  }
  return out;
}

function highlightShellCommand(command: string): string {
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
    const heredoc = /<<-?\s*['"]?(\w+)['"]?/.exec(line);
    if (heredoc) heredocMarker = heredoc[1];
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
  animate: boolean,
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

  const now = Date.now();
  if (isPartial && !context.isError) shell.sawPartial = true;
  if (context.isError) {
    shell.anim = { kind: "static", color: palette.red };
  } else if (isPartial) {
    shell.anim = animate ? { kind: "pulse" } : { kind: "static", color: palette.cyan };
  } else if (shell.sawPartial && animate) {
    if (shell.anim.kind !== "fade") {
      // Settle instant: start the blink from the pulse's current color.
      shell.anim = { kind: "fade", settledAt: now, from: animColor(shell.anim, now) };
    }
  } else {
    shell.anim = { kind: "static", color: palette.teal };
  }
  if (animate) ensureAnimLoop(shell, context.invalidate);
  return outer;
}

function wrapDefinition(def: AnyToolDefinition, config: CyberUiConfig): AnyToolDefinition {
  const animate = config.gutterAnimation;
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
        animate,
        def.name !== "bash", // bash styles itself via the fish tokenizer
      );
    },
    renderResult(result, options, theme, context) {
      return renderIntoGutter(
        "result",
        context,
        (inner) => innerResult(result, options, theme, inner),
        options.isPartial ?? false,
        animate,
        false,
      );
    },
  };
}

export default function toolGutter(pi: ExtensionAPI, config: CyberUiConfig): void {
  if (config.toolHighlight !== "gutter") return;

  let registered = false;
  pi.on("session_start", (_event, ctx) => {
    if (registered) return;
    registered = true;
    const definitions: AnyToolDefinition[] = [
      createReadToolDefinition(ctx.cwd),
      createBashToolDefinition(ctx.cwd),
      createEditToolDefinition(ctx.cwd),
      createWriteToolDefinition(ctx.cwd),
      createGrepToolDefinition(ctx.cwd),
      createFindToolDefinition(ctx.cwd),
      createLsToolDefinition(ctx.cwd),
    ];
    for (const definition of definitions) {
      pi.registerTool(wrapDefinition(definition, config));
    }
  });
}
