/**
 * Cyber Editor
 *
 * Cyber shell around Pi's CustomEditor. Owns only the silver ❯ prompt glyph
 * and the dynamic border colour. All dynamic info (turn / tokens / tps /
 * tools) now lives in the working area (above editor), and static
 * environment info (cwd / git / model / context / thinking) lives in the
 * footer. The editor itself is kept visually pure.
 */
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type RGB = [number, number, number];

const SILVER: RGB = [170, 184, 202];
const RESET = "\x1b[39m";
const GLYPH_GAP = 1;

export interface CyberEditorOptions {
  getBorderColor?: (text: string) => ((value: string) => string) | undefined;
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

export default class CyberEditor extends CustomEditor {
  private readonly getBorderColor: (text: string) => ((value: string) => string) | undefined;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    kb: KeybindingsManager,
    options: CyberEditorOptions = {},
  ) {
    super(tui, theme, kb);
    this.getBorderColor = options.getBorderColor ?? (() => undefined);
  }

  private promptColor(): RGB {
    return SILVER;
  }

  private modeMarker(): string {
    return "❯";
  }

  override render(width: number): string[] {
    this.borderColor = this.getBorderColor(this.getText()) ?? this.borderColor;
    const lines = super.render(width);
    if (lines.length <= 0) return lines;

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
