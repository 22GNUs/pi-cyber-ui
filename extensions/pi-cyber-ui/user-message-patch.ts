/**
 * Prompt-style user message rendering — the one deliberate hack in this
 * package.
 *
 * Pi renders user messages with a core component (`UserMessageComponent`,
 * a background Box) that has no extension hook. To get a "❯ prompt" panel
 * that matches the tool gutter language, we patch
 * `UserMessageComponent.prototype.rebuild` at runtime:
 *
 *   ▎ ❯ user input in silver     (userInputBg panel, promptSilver bar)
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
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Markdown, visibleWidth, type Component } from "@earendil-works/pi-tui";

import { bgRgb, paint, palette, RESET_BG } from "./palette.js";

const USER_MESSAGE_MODULE = join("dist", "modes", "interactive", "components", "user-message.js");
const BAR = "▍"; // 3/8 block — matches the tool gutter
const GUTTER_WIDTH = 4; // "▎ ❯ "
const FULL_RESET = "\x1b[0m";

/**
 * First line gets the prompt glyph; continuation lines stay aligned. The
 * whole panel is painted with the userInputBg surface plus one padded line
 * top and bottom, mirroring the tool gutter silhouette.
 */
class PromptGutter implements Component {
  constructor(private inner: Component) {}

  render(width: number): string[] {
    const bg = bgRgb(palette.userInputBg);
    const bar = bg + paint(palette.promptSilver, BAR);
    const glyph = paint(palette.promptSilver, "❯");
    const innerWidth = Math.max(8, width - GUTTER_WIDTH);
    const blank = bar + " ".repeat(width - 1) + RESET_BG;
    const lines = this.inner.render(innerWidth);
    const body = lines.map((line, i) => {
      const restored = line.replaceAll(FULL_RESET, FULL_RESET + bg).replaceAll(RESET_BG, bg);
      const pad = Math.max(0, innerWidth - visibleWidth(line));
      const head = i === 0 ? `${bar} ${glyph} ` : `${bar}   `;
      return head + restored + " ".repeat(pad) + RESET_BG;
    });
    return [blank, ...body, blank];
  }

  invalidate(): void {
    this.inner.invalidate();
  }
}

/** Walk up from the running entry script to pi's package root. */
function findPiRoot(): string | undefined {
  const entry = process.argv[1];
  if (!entry || !existsSync(entry)) return undefined;
  try {
    let dir = dirname(realpathSync(entry));
    while (true) {
      if (existsSync(join(dir, USER_MESSAGE_MODULE)) && existsSync(join(dir, "package.json"))) {
        return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  } catch {
    return undefined;
  }
}

/**
 * Apply the patch. Returns true when active; false means pi's structure did
 * not match expectations and the theme block style stays in effect.
 */
export async function applyUserMessagePatch(): Promise<boolean> {
  try {
    const root = findPiRoot();
    if (!root) return false;

    const modulePath = join(root, USER_MESSAGE_MODULE);
    // Node caches ES modules per resolved URL, so this import returns the
    // exact module instance pi is already using.
    const mod = (await import(pathToFileURL(modulePath).href)) as {
      UserMessageComponent?: new (...args: unknown[]) => unknown;
    };
    const UserMessageComponent = mod.UserMessageComponent;
    if (typeof UserMessageComponent !== "function") return false;

    const proto = UserMessageComponent.prototype as {
      rebuild?: (this: Record<string, unknown>) => void;
      clear?: unknown;
      addChild?: unknown;
    };
    const original = proto.rebuild;
    if (
      typeof original !== "function" ||
      typeof proto.clear !== "function" ||
      typeof proto.addChild !== "function"
    ) {
      return false;
    }

    proto.rebuild = function (this: Record<string, unknown>) {
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
        // Structure drifted at runtime: restore pi's implementation for good.
        proto.rebuild = original;
        original.call(this);
      }
    };
    return true;
  } catch {
    return false;
  }
}
