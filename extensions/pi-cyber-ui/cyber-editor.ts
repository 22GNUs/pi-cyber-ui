/**
 * Cyber Editor
 *
 * Cyber shell around Pi's CustomEditor.
 * Owns HUD chrome and prompt glyph.
 */
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { renderHudChrome } from "./editor-hud.js";
import type { CyberHudSnapshot } from "./editor-state.js";

type RGB = [number, number, number];

const SILVER: RGB = [170, 184, 202];
const RESET = "\x1b[39m";
const GLYPH_GAP = 1;

export interface CyberEditorOptions {
  getHudSnapshot?: () => CyberHudSnapshot;
  getBorderColor?: (text: string) => ((value: string) => string) | undefined;
  cwd?: string;
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

function hasScrollIndicator(line: string): boolean {
  return stripAnsi(line).includes("more");
}

function findBorderLineIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isBorderLine(lines[i]!)) return i;
  }
  return Math.max(0, lines.length - 1);
}

function snapshotKey(snapshot: CyberHudSnapshot): string {
  return [
    snapshot.agentState,
    snapshot.promptActive ? 1 : 0,
    snapshot.promptTurns,
    snapshot.promptIn,
    snapshot.inputValue ?? "",
    snapshot.output.value ?? "",
    snapshot.output.estimated ? 1 : 0,
    snapshot.output.frozen ? 1 : 0,
    snapshot.tps.value?.toFixed(1) ?? "",
    snapshot.tps.estimated ? 1 : 0,
    snapshot.toolDepth,
    snapshot.resetNotice?.kind ?? "",
  ].join("|");
}

interface HudCache {
  cwd: string;
  width: number;
  borderKey: string;
  snapshotKey: string;
  result: { topLine: string; bottomLine: string };
}

export default class CyberEditor extends CustomEditor {
  private readonly getHudSnapshot: () => CyberHudSnapshot | undefined;
  private readonly getBorderColor: (text: string) => ((value: string) => string) | undefined;
  private readonly cwd: string;

  private hudCache?: HudCache;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    kb: KeybindingsManager,
    options: CyberEditorOptions = {},
  ) {
    super(tui, theme, kb);
    this.getHudSnapshot = options.getHudSnapshot ?? (() => undefined);
    this.getBorderColor = options.getBorderColor ?? (() => undefined);
    this.cwd = options.cwd ?? "";
  }

  private promptColor(): RGB {
    return SILVER;
  }

  private modeMarker(): string {
    return "❯";
  }

  private getHudChrome(width: number, snapshot: CyberHudSnapshot): { topLine: string; bottomLine: string } {
    const cache = this.hudCache;
    const key = snapshotKey(snapshot);
    const borderKey = this.borderColor("─");
    if (
      cache &&
      cache.cwd === this.cwd &&
      cache.width === width &&
      cache.borderKey === borderKey &&
      cache.snapshotKey === key
    ) {
      return cache.result;
    }

    const result = renderHudChrome(this.cwd, snapshot, width, this.borderColor);

    this.hudCache = {
      cwd: this.cwd,
      width,
      borderKey,
      snapshotKey: key,
      result,
    };

    return result;
  }

  override render(width: number): string[] {
    this.borderColor = this.getBorderColor(this.getText()) ?? this.borderColor;
    const lines = super.render(width);
    if (lines.length <= 0) return lines;

    const snapshot = this.getHudSnapshot();
    let contentStart = 1;

    if (snapshot && !hasScrollIndicator(lines[0]!)) {
      const chrome = this.getHudChrome(width, snapshot);
      lines[0] = chrome.topLine;
      lines.splice(1, 0, chrome.bottomLine);
      contentStart = 2;
    }

    const borderIndex = findBorderLineIndex(lines);
    const marker = this.modeMarker();
    const promptColor = this.promptColor();
    const promptStr = `${marker}${" ".repeat(GLYPH_GAP)}`;
    const glyph = `${rgb(promptColor)}${marker}${RESET}${" ".repeat(GLYPH_GAP)}`;
    const promptWidth = visibleWidth(promptStr);
    const innerWidth = Math.max(0, width - promptWidth);

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

  destroy(): void {}

  dispose(): void {
    this.destroy();
  }
}
