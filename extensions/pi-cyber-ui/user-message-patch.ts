/**
 * Prompt-style user message rendering — the one deliberate hack in this
 * package.
 *
 * Pi renders user messages with a core component (`UserMessageComponent`,
 * a background Box) that has no extension hook. To get a "❯ prompt" panel
 * that matches the tool gutter language, we patch
 * `UserMessageComponent.prototype.rebuild` at runtime:
 *
 *   ▎ ❯ user input               (userInputBg panel, pink bar, promptSilver glyph)
 *   ▎   continuation lines aligned
 *
 * Safety model (must degrade, never break):
 *   - The running pi's module is located from `process.argv[1]` (realpath,
 *     walk up to the package root) so we patch the exact instance pi uses,
 *     not a second copy from our own node_modules.
 *   - Structure is verified before patching; any mismatch → no patch, the
 *     theme's userMessageBg/Text block style (U2) applies instead.
 *   - The patched rebuild is wrapped in try/catch; on any error it restores
 *     the original implementation and re-runs it.
 *   - Only rendering is touched. Message content, session data, and LLM
 *     context are never modified.
 */
import { join } from "node:path";
import { Markdown, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

import { bgRgb, paint, palette, RESET_BG } from "./palette.js";
import { importRunningPiModule } from "./runtime-pi.js";

const USER_MESSAGE_MODULE = join("dist", "modes", "interactive", "components", "user-message.js");
const BAR = "▍"; // 3/8 block — matches the tool gutter
const GUTTER_WIDTH = 4; // "▎ ❯ "
const FULL_RESET = "\x1b[0m";
const PATCH_STATE = Symbol.for("pi-cyber-ui:user-message-patch");

type Rebuild = (this: Record<string, unknown>) => void;
interface UserMessagePatchState {
  original: Rebuild;
  patched: Rebuild;
}

type PatchablePrototype = {
  rebuild?: Rebuild;
  clear?: unknown;
  addChild?: unknown;
  [PATCH_STATE]?: UserMessagePatchState;
};

/**
 * First line gets the prompt glyph; continuation lines stay aligned. The
 * whole panel is painted with the userInputBg surface plus one padded line
 * top and bottom, mirroring the tool gutter silhouette.
 */
class PromptGutter implements Component {
  private cache:
    | { width: number; innerLines: string[]; innerLinesRef: string[]; lines: string[] }
    | undefined;

  constructor(private inner: Component) {}

  render(width: number): string[] {
    if (width <= 0) return [];

    const innerWidth = Math.max(1, width - GUTTER_WIDTH);
    const innerLines = this.inner.render(innerWidth);
    const cached = this.cache;
    if (
      cached &&
      cached.width === width &&
      (cached.innerLinesRef === innerLines ||
        (cached.innerLines.length === innerLines.length &&
          cached.innerLines.every((line, index) => line === innerLines[index])))
    ) {
      return cached.lines;
    }

    const bg = bgRgb(palette.userInputBg);
    const bar = bg + paint(palette.pink, BAR);
    const glyph = paint(palette.promptSilver, "❯");
    const blank = bar + " ".repeat(Math.max(0, width - 1)) + RESET_BG;
    const body = innerLines.map((line, i) => {
      const restored = line.replaceAll(FULL_RESET, FULL_RESET + bg).replaceAll(RESET_BG, bg);
      const pad = Math.max(0, innerWidth - visibleWidth(line));
      const head = i === 0 ? `${bar} ${glyph} ` : `${bar}   `;
      return head + restored + " ".repeat(pad) + RESET_BG;
    });
    const lines = [blank, ...body, blank].map((line) =>
      visibleWidth(line) > width ? truncateToWidth(line, width, "") : line,
    );
    this.cache = { width, innerLines: [...innerLines], innerLinesRef: innerLines, lines };
    return lines;
  }

  invalidate(): void {
    this.cache = undefined;
    this.inner.invalidate();
  }
}

/**
 * Apply the patch. Returns true when active; false means pi's structure did
 * not match expectations and the theme block style stays in effect.
 */
export async function applyUserMessagePatch(): Promise<boolean> {
  try {
    // Node caches ES modules per resolved URL, so this import returns the
    // exact module instance pi is already using.
    const mod = (await importRunningPiModule(USER_MESSAGE_MODULE)) as {
      UserMessageComponent?: new (...args: unknown[]) => unknown;
    } | undefined;
    if (!mod) return false;
    const UserMessageComponent = mod.UserMessageComponent;
    if (typeof UserMessageComponent !== "function") return false;

    const proto = UserMessageComponent.prototype as PatchablePrototype;
    const active = proto[PATCH_STATE];
    if (active && proto.rebuild === active.patched) return true;

    const original = proto.rebuild;
    if (
      typeof original !== "function" ||
      typeof proto.clear !== "function" ||
      typeof proto.addChild !== "function"
    ) {
      return false;
    }

    const patched: Rebuild = function (this: Record<string, unknown>) {
      try {
        if (typeof this.text !== "string" || !this.markdownTheme) throw new Error("unexpected shape");
        (this.clear as () => void).call(this);
        // Tolerate pi-tui version skew: older Markdown constructors take 5
        // args and simply ignore the trailing options argument.
        const MarkdownCtor = Markdown as unknown as new (
          text: string,
          paddingX: number,
          paddingY: number,
          theme: unknown,
          defaultTextStyle?: unknown,
          options?: unknown,
        ) => Component;
        const markdown = new MarkdownCtor(
          this.text,
          0,
          0,
          this.markdownTheme,
          { color: (content: string) => paint(palette.silver, content) },
          { preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
        );
        (this.addChild as (child: Component) => void).call(this, new PromptGutter(markdown));
      } catch {
        // Structure drifted at runtime: restore Pi's implementation for good.
        if (proto.rebuild === patched) proto.rebuild = original;
        delete proto[PATCH_STATE];
        original.call(this);
      }
    };

    proto[PATCH_STATE] = { original, patched };
    proto.rebuild = patched;
    return true;
  } catch {
    return false;
  }
}

/** Restore Pi's original renderer when this extension instance shuts down. */
export async function removeUserMessagePatch(): Promise<void> {
  try {
    const mod = (await importRunningPiModule(USER_MESSAGE_MODULE)) as {
      UserMessageComponent?: new (...args: unknown[]) => unknown;
    } | undefined;
    const UserMessageComponent = mod?.UserMessageComponent;
    if (typeof UserMessageComponent !== "function") return;

    const proto = UserMessageComponent.prototype as PatchablePrototype;
    const state = proto[PATCH_STATE];
    if (!state) return;
    if (proto.rebuild === state.patched) proto.rebuild = state.original;
    delete proto[PATCH_STATE];
  } catch {
    // Teardown is best-effort; the process or old runtime may already be gone.
  }
}
