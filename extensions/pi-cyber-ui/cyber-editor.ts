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

type RGB = [number, number, number];

const SILVER: RGB = [170, 184, 202];
const RESET = "\x1b[39m";
const GLYPH_GAP = 1;
const SESSION_LABEL_RIGHT_BORDER_WIDTH = 4;
const SESSION_LABEL_MIN_LEFT_BORDER_WIDTH = 8;
const SESSION_LABEL_MAX_WIDTH_RATIO = 1 / 3;

export interface CyberEditorOptions {
  getBorderColor?: (text: string) => ((value: string) => string) | undefined;
  getSessionName?: () => string | undefined;
}

function rgb(c: RGB): string {
  return `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function isBorderLine(line: string): boolean {
  const plain = stripAnsi(line);
  return plain.includes("─") && !/[^\s─↑↓0-9more]/i.test(plain);
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
    return SILVER;
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
    if (!isBorderLine(line)) return line;

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
    this.borderColor = this.getBorderColor(this.getText()) ?? this.borderColor;
    const lines = super.render(width);
    if (lines.length <= 0) return lines;

    lines[0] = this.renderTopBorderLabel(lines[0]!, width);

    const borderIndex = findBorderLineIndex(lines);
    const marker = this.modeMarker();
    const promptColor = this.promptColor();
    const promptStr = `${marker}${" ".repeat(GLYPH_GAP)}`;
    const glyph = `${rgb(promptColor)}${marker}${RESET}${" ".repeat(GLYPH_GAP)}`;
    const promptWidth = visibleWidth(promptStr);
    const innerWidth = Math.max(0, width - promptWidth);

    // Skip leading top border line (kept by CustomEditor) before applying ❯.
    const contentStart = 1;

    for (let i = contentStart; i < lines.length; i++) {
      if (i === borderIndex) continue;
      if (i === contentStart) {
        lines[i] = glyph + truncateToWidth(lines[i]!, innerWidth, "");
      } else {
        lines[i] = "  " + truncateToWidth(lines[i]!, innerWidth, "");
      }
    }

    return lines;
  }
}
