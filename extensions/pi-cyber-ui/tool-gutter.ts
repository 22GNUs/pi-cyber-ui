/**
 * Tool gutter — status bar + uniform slate panel for built-in tools.
 *
 * Signal restraint (Grok / sci-fi HUD school): only two status hues exist —
 * cyan while running (breathing pulse) and red on failure. Success carries no
 * color; its bar falls back to the structural fgDim line. The panel surface
 * is one neutral tone for every state (elevation by luminance, not hue).
 *
 * Official wrap pattern (see pi docs "Overriding Built-in Tools"): register
 * same-name tools whose `execute` is the untouched built-in implementation
 * (obtained at runtime via `create*ToolDefinition`, so behavior follows pi
 * updates automatically), and only replace the shell:
 *
 *   - `renderShell: "self"` bypasses the default background Box entirely
 *   - built-in `renderCall` / `renderResult` are reused as-is (syntax
 *     highlighting, diffs, expand/collapse all inherited)
 *   - every rendered line gets a colored bar + the panel background:
 *       pending  cyan (breathing pulse when `gutterAnimation` is on)
 *       success  tealDark (cyber teal; a one-shot phase-continuous
 *                cyan→tealDark cooling fade plays when a live tool settles)
 *       error    red
 *   - vertical padding is normalized at the shell level: inner blank lines
 *     are trimmed and every panel gets exactly one padded line top/bottom
 *     plus one separator line between call and result, so bash/read/edit
 *     all share the same silhouette
 *
 * Third-party extension tools cannot be wrapped (their full definitions are
 * not reachable through the extension API); they keep pi's default block
 * shell, styled by the theme's tool*Bg tokens (same panel tone, faint blue
 * tint while pending, faint red on error).
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
import { bgRgb, mix, paint, palette, RESET_BG, type RGB } from "./palette.js";

type AnyToolDefinition = ToolDefinition<any, any, any>;
type RenderCall = NonNullable<AnyToolDefinition["renderCall"]>;
type RenderResult = NonNullable<AnyToolDefinition["renderResult"]>;
type RenderContext = Parameters<RenderCall>[2];

const BAR = "▍"; // 3/8 block — between the thin ▎ and the heavy ▌
const BAR_WIDTH = 2; // bar + space
const PULSE_PERIOD_MS = 2400;
const PULSE_TICK_MS = 120;
const POWER_DOWN_MS = 900;
const POWER_DOWN_TICK_MS = 50;
/** Breathing valley for the pending pulse (cyan sunk toward the panel). */
const PULSE_DIM: RGB = mix(palette.cyan, palette.toolSurface, 0.65);
const FULL_RESET = "\x1b[0m";
const SGR_OR_OSC = /\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g;

/**
 * Some built-in renderers (edit) paint their own shell Box with the theme's
 * tool-state backgrounds. Those are shell chrome, not content — rewrite them
 * to the panel surface so the row stays one continuous tone. Content
 * highlights (diff word-level backgrounds etc.) use other colors and pass
 * through untouched.
 */
const SHELL_BG_SEQUENCES = [palette.bgAlt, palette.toolErrorBg]
  .map((c) => bgRgb(c))
  .filter((seq) => seq !== bgRgb(palette.toolSurface));

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

/** Row-scoped state shared by the call and result slots of one tool row. */
interface GutterShell {
  /** The row was observed live (streaming); enables the power-down fade. */
  sawPartial: boolean;
  /** Timestamp when the live row settled; anchors the fade. */
  settledAt: number | undefined;
  /** Pulse color at the settle instant — the fade starts here, phase-continuous. */
  settleFrom: RGB | undefined;
  /** Last color rendered while live; captured as the fade origin. */
  lastLiveColor: RGB | undefined;
  /** The result slot has rendered; the call slot skips its bottom padding. */
  hasResult: boolean;
}

function getShell(context: RenderContext): GutterShell {
  const state = context.state as { __gutterShell?: GutterShell };
  state.__gutterShell ??= {
    sawPartial: false,
    settledAt: undefined,
    settleFrom: undefined,
    lastLiveColor: undefined,
    hasResult: false,
  };
  return state.__gutterShell;
}

/**
 * Prefixes every line of the wrapped component with a colored status bar,
 * paints the uniform panel surface across the full row width, and normalizes
 * vertical padding (call slot pads the top, result slot separator + bottom).
 */
class GutterComponent implements Component {
  inner: Component | undefined;
  private color: RGB = palette.cyan;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly role: "call" | "result",
    private readonly shell: GutterShell,
  ) {}

  setBar(color: RGB): void {
    this.color = color;
  }

  /** Re-render soon while the pending pulse or power-down fade is active. */
  scheduleTick(invalidate: () => void, delayMs: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      invalidate();
    }, delayMs);
    this.timer.unref?.();
  }

  render(width: number): string[] {
    if (!this.inner) return [];
    const bg = bgRgb(palette.toolSurface);
    const prefix = bg + paint(this.color, BAR) + " ";
    const innerWidth = Math.max(8, width - BAR_WIDTH);
    const blank = prefix + " ".repeat(innerWidth) + RESET_BG;
    const content = trimBlankEdges(this.inner.render(innerWidth));
    if (content.length === 0) {
      // Empty result still supplies the bottom padding it owns.
      return this.role === "result" ? [blank] : [];
    }
    const rows: string[] = [blank]; // call: top padding · result: separator
    for (const line of content) {
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
    this.inner?.invalidate();
  }
}

function getTextContent(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function renderIntoGutter(
  role: "call" | "result",
  context: RenderContext,
  buildInner: (innerContext: RenderContext) => Component,
  isPartial: boolean,
  animate: boolean,
): Component {
  const shell = getShell(context);
  if (role === "result") shell.hasResult = true;
  const outer =
    context.lastComponent instanceof GutterComponent
      ? context.lastComponent
      : new GutterComponent(role, shell);
  // Built-in renderers cache via context.lastComponent; hand them their own
  // inner component instead of our wrapper.
  outer.inner = buildInner({ ...context, lastComponent: outer.inner });

  const now = Date.now();
  if (isPartial && !context.isError) {
    shell.sawPartial = true;
    shell.settledAt = undefined;
  }
  if (context.isError) {
    outer.setBar(palette.red);
  } else if (isPartial) {
    let color: RGB;
    if (animate) {
      const phase = (now % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
      const k = (1 - Math.cos(phase * 2 * Math.PI)) / 2; // 0 → 1 → 0
      color = mix(palette.cyan, PULSE_DIM, k);
      outer.scheduleTick(context.invalidate, PULSE_TICK_MS);
    } else {
      color = palette.cyan;
    }
    shell.lastLiveColor = color;
    outer.setBar(color);
  } else if (shell.sawPartial && animate) {
    // Power-down: the live row settles and the bar cools to tealDark,
    // starting from the pulse's current color (phase-continuous, no jump)
    // with an ease-out decay — like a capacitor discharging.
    if (shell.settledAt === undefined) {
      shell.settledAt = now;
      shell.settleFrom = shell.lastLiveColor ?? palette.cyan;
    }
    const t = (now - shell.settledAt) / POWER_DOWN_MS;
    if (t >= 1) {
      outer.setBar(palette.tealDark);
    } else {
      const eased = 1 - (1 - t) ** 2; // ease-out: fast start, gentle landing
      outer.setBar(mix(shell.settleFrom ?? palette.cyan, palette.tealDark, eased));
      outer.scheduleTick(context.invalidate, POWER_DOWN_TICK_MS);
    }
  } else {
    outer.setBar(palette.tealDark);
  }
  return outer;
}

function wrapDefinition(def: AnyToolDefinition, animate: boolean): AnyToolDefinition {
  const innerCall: RenderCall = (args, theme, context) =>
    def.renderCall
      ? def.renderCall(args, theme, context)
      : new Text(theme.fg("toolTitle", theme.bold(def.name)), 0, 0);
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
      );
    },
    renderResult(result, options, theme, context) {
      return renderIntoGutter(
        "result",
        context,
        (inner) => innerResult(result, options, theme, inner),
        options.isPartial ?? false,
        animate,
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
      pi.registerTool(wrapDefinition(definition, config.gutterAnimation));
    }
  });
}
