/**
 * Cyber Editor
 *
 * Cyber shell around the standalone Vim editor behavior module.
 * Owns HUD chrome, animated prompt glyph, and mode styling.
 */
import type { KeybindingsManager } from "@mariozechner/pi-coding-agent";
import type { EditorTheme, TUI } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

import { renderHudChrome } from "./editor-hud.js";
import type { CyberHudSnapshot } from "./editor-state.js";
import VimEditor from "./vim-editor.js";

type RGB = [number, number, number];

const SILVER: RGB = [170, 184, 202];
const WHITE: RGB = [214, 224, 236];
const RESET = "\x1b[39m";
const GLYPH_GAP = 1;
const BREATH_MS = 3200;
const BREATH_FPS = 30;
const ANIM_MS = 60;

export interface CyberEditorOptions {
  getHudSnapshot?: () => CyberHudSnapshot;
  cwd?: string;
  vimEnabled?: boolean;
  jjEscapeTimeoutMs?: number;
}

function rgb(c: RGB): string {
  return `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
}

function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
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

interface HudCache {
  cwd: string;
  width: number;
  vimEnabled: boolean;
  vimMode: "insert" | "normal";
  snapshot: CyberHudSnapshot;
  result: { topLine: string; bottomLine: string };
}

export default class CyberEditor extends VimEditor {
  private readonly getHudSnapshot: () => CyberHudSnapshot | undefined;
  private readonly cwd: string;

  private breath?: ReturnType<typeof setInterval>;
  private anim?: ReturnType<typeof setInterval>;
  private breathT0 = Date.now();
  private frame = 0;
  private hudCache?: HudCache;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    kb: KeybindingsManager,
    options: CyberEditorOptions = {},
  ) {
    super(tui, theme, kb, {
      enabled: options.vimEnabled,
      jjEscapeTimeoutMs: options.jjEscapeTimeoutMs,
    });
    this.getHudSnapshot = options.getHudSnapshot ?? (() => undefined);
    this.cwd = options.cwd ?? "";
    this.setPaddingX(this.getPaddingX() + this.promptWidth());
    this.breathT0 = Date.now();
    this.breath = setInterval(() => this.tui.requestRender(), BREATH_FPS);
  }

  private alpha(): number {
    const t = ((Date.now() - this.breathT0) % BREATH_MS) / BREATH_MS;
    return (1 - Math.cos(2 * Math.PI * t)) / 2;
  }

  private startAnim(): void {
    if (this.anim) return;
    this.frame = 0;
    this.anim = setInterval(() => {
      this.frame += 1;
      this.tui.requestRender();
      if (this.frame > 10) this.stopAnim();
    }, ANIM_MS);
  }

  private stopAnim(): void {
    if (!this.anim) return;
    clearInterval(this.anim);
    this.anim = undefined;
  }

  private insertColor(): RGB {
    if (this.anim) return mixRgb(SILVER, WHITE, Math.max(0, 1 - this.frame / 10));
    return mixRgb(SILVER, WHITE, this.alpha());
  }

  private promptColor(): RGB {
    return this.insertColor();
  }

  private modeMarker(): string {
    return "❯";
  }

  private promptWidth(): number {
    return visibleWidth(`${this.modeMarker()}${" ".repeat(GLYPH_GAP)}`);
  }

  override setVimEnabled(enabled: boolean): void {
    super.setVimEnabled(enabled);
    this.hudCache = undefined;
  }

  override handleInput(data: string): void {
    const hadText = this.getText().length > 0;
    super.handleInput(data);
    const hasText = this.getText().length > 0;
    if (hasText && !hadText) {
      this.startAnim();
    }
  }

  private getHudChrome(width: number, snapshot: CyberHudSnapshot): { topLine: string; bottomLine: string } {
    const cache = this.hudCache;
    if (
      cache &&
      cache.cwd === this.cwd &&
      cache.width === width &&
      cache.vimEnabled === this.vimEnabled &&
      cache.vimMode === this.mode &&
      cache.snapshot === snapshot
    ) {
      return cache.result;
    }

    const result = renderHudChrome(this.cwd, snapshot, width, this.borderColor, {
      vimEnabled: this.vimEnabled,
      vimMode: this.mode,
    });

    this.hudCache = {
      cwd: this.cwd,
      width,
      vimEnabled: this.vimEnabled,
      vimMode: this.mode,
      snapshot,
      result,
    };

    return result;
  }

  override render(width: number): string[] {
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

  override destroy(): void {
    if (this.breath) clearInterval(this.breath);
    this.stopAnim();
    super.destroy();
  }
}
