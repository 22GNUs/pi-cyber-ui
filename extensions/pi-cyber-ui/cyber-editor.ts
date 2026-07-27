/**
 * Cyber Editor
 *
 * Cyber shell around Pi's CustomEditor. Owns the silver ❯ prompt glyph,
 * dynamic border colour, and one static session identity label. All dynamic
 * info (turn / tokens / tps / tools) lives in the working area (above editor),
 * and environment info (cwd / git / model / context / thinking) lives in the
 * footer.
 */
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { palette, rgb, RESET_FG, type RGB } from "./palette.js";
import { setUiWidth } from "./ui-metrics.js";

const GLYPH_GAP = 1;
const SESSION_LABEL_RIGHT_BORDER_WIDTH = 4;
const SESSION_LABEL_MIN_LEFT_BORDER_WIDTH = 8;
const SESSION_LABEL_MAX_WIDTH_RATIO = 1 / 3;

export interface CyberEditorOptions {
  getBorderColor?: (text: string) => ((value: string) => string) | undefined;
  getSessionName?: () => string | undefined;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function isBorderLine(line: string): boolean {
  const plain = stripAnsi(line);
  return plain.includes("─") && !/[^\s─↑↓0-9more]/i.test(plain);
}

function isPlainBorderLine(line: string): boolean {
  return /^─+$/.test(stripAnsi(line));
}

function findBorderLineIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isBorderLine(lines[i]!)) return i;
  }
  return Math.max(0, lines.length - 1);
}

function normalizeSessionName(name: string | undefined): string {
  return name?.replace(/\s+/g, " ").trim() ?? "";
}

export default class CyberEditor extends CustomEditor {
  private readonly getBorderColor: (text: string) => ((value: string) => string) | undefined;
  private readonly getSessionName: () => string | undefined;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    kb: KeybindingsManager,
    options: CyberEditorOptions = {},
  ) {
    super(tui, theme, kb);
    this.getBorderColor = options.getBorderColor ?? (() => undefined);
    this.getSessionName = options.getSessionName ?? (() => undefined);
  }

  private promptColor(): RGB {
    return palette.promptSilver;
  }

  private modeMarker(): string {
    return "❯";
  }

  private sessionLabel(width: number): string {
    const name = normalizeSessionName(this.getSessionName());
    if (!name) return "";

    const wrapperWidth = visibleWidth("⟦  ⟧");
    const maxLabelWidth = Math.floor(width * SESSION_LABEL_MAX_WIDTH_RATIO);
    const maxNameWidth = maxLabelWidth - wrapperWidth;
    if (maxNameWidth < 1) return "";

    return `⟦ ${truncateToWidth(name, maxNameWidth, "…")} ⟧`;
  }

  private renderTopBorderLabel(line: string, width: number): string {
    // Preserve the editor's top scroll indicator while scrolled.
    if (!isPlainBorderLine(line)) return line;

    const label = this.sessionLabel(width);
    if (!label) return line;

    const plain = stripAnsi(line);
    const lineWidth = Math.min(width, visibleWidth(plain));
    const labelWidth = visibleWidth(label);
    const leftBorderWidth = lineWidth - SESSION_LABEL_RIGHT_BORDER_WIDTH - labelWidth;

    if (leftBorderWidth < SESSION_LABEL_MIN_LEFT_BORDER_WIDTH) return line;

    const next =
      "─".repeat(leftBorderWidth) +
      label +
      "─".repeat(SESSION_LABEL_RIGHT_BORDER_WIDTH);

    return this.borderColor(next);
  }

  override render(width: number): string[] {
    setUiWidth(width);
    this.borderColor = this.getBorderColor(this.getText()) ?? this.borderColor;

    const marker = this.modeMarker();
    const promptColor = this.promptColor();
    const promptText = `${marker}${" ".repeat(GLYPH_GAP)}`;
    const promptWidth = visibleWidth(promptText);

    // At pathological widths, preserve the component width contract and let
    // the base editor render without prompt chrome.
    if (width <= promptWidth) {
      return super.render(width).map((line) => truncateToWidth(line, width, ""));
    }

    // Layout at the real content width first. Prefixing after a full-width
    // layout would truncate the last promptWidth columns instead of wrapping.
    const innerWidth = width - promptWidth;
    const lines = super.render(innerWidth);
    if (lines.length <= 0) return lines;

    const borderIndex = findBorderLineIndex(lines);
    const borderPrefix = this.borderColor("─".repeat(promptWidth));
    lines[0] = this.renderTopBorderLabel(borderPrefix + lines[0]!, width);
    if (borderIndex > 0) lines[borderIndex] = borderPrefix + lines[borderIndex]!;

    const glyph = `${rgb(promptColor)}${marker}${RESET_FG}${" ".repeat(GLYPH_GAP)}`;
    const continuation = " ".repeat(promptWidth);

    // Skip the top/bottom borders. Autocomplete rows receive the same
    // continuation indent so every returned line remains exactly width cells.
    for (let i = 1; i < lines.length; i++) {
      if (i === borderIndex) continue;
      lines[i] = (i === 1 ? glyph : continuation) + lines[i]!;
    }

    return lines;
  }
}
