/**
 * Cyber Vim Editor
 *
 * Implemented vim capabilities:
 * - insert / normal modes
 * - Esc switches to normal mode; double-Esc still reaches the app handler
 * - h/j/k/l cursor movement
 * - w / b word motion
 * - 0 / $ line start/end
 * - x delete character under cursor
 * - i / a enter insert mode (`a` moves right first)
 * - o / O open a new line below / above and enter insert mode
 * - gg jump to first line
 * - G / Shift+G jump to last line
 * - dd delete current line
 * - D delete to end of line
 * - bottom-right mode indicator in the editor border
 */
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import type { EditorTheme, TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { KeybindingsManager } from "@mariozechner/pi-coding-agent";

type RGB = [number, number, number];
const TILDE_PINK: RGB = [255, 130, 184];
const SILVER: RGB = [170, 184, 202];
const STEEL: RGB = [92, 104, 124];
const RUNNING_SILVER: RGB = [126, 142, 164];
const THINKING_LOW: RGB = [108, 118, 142];
const THINKING_HIGH: RGB = [148, 160, 184];
const WHITE: RGB = [214, 224, 236];
const RESET = "\x1b[39m";
const BOLD = "\x1b[1m";
const UNBOLD = "\x1b[22m";

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

function hotPink(text: string): string {
  return `${BOLD}${rgb(TILDE_PINK)}${text}${UNBOLD}${RESET}`;
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

// ── constants ─────────────────────────────────────────────────
type AgentState = "idle" | "running" | "thinking";
const GLYPH_W = 2;
const BREATH_MS = 3200;
const BREATH_FPS = 50;
const ANIM_MS = 60;
const DOUBLE_ESCAPE_MS = 500;
const VIM_PREFIX_MS = DOUBLE_ESCAPE_MS;
type VimPrefix = "g" | "d";
type EditorInternals = {
  state: { lines: string[]; cursorLine: number; cursorCol: number };
  pushUndoSnapshot(): void;
  setCursorCol(col: number): void;
  killRing: { push(text: string, opts: { prepend: boolean; accumulate: boolean }): void };
  lastAction: string | null;
  historyIndex: number;
  deleteToEndOfLine(): void;
};

// ── editor component ──────────────────────────────────────────
export default class VimEditor extends CustomEditor {
  // ── state ─────────────────────────────────────────────────
  private mode: "normal" | "insert" = "insert";
  private pendingNormal?: ReturnType<typeof setTimeout>;
  private pendingNormalAt = 0;
  private pendingVimPrefix?: VimPrefix;
  private pendingVimPrefixTimer?: ReturnType<typeof setTimeout>;
  private breath?: ReturnType<typeof setInterval>;
  private anim?: ReturnType<typeof setInterval>;
  private breathT0 = Date.now();
  private frame = 0;
  private typed = false;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    kb: KeybindingsManager,
    private readonly getAgentState: () => AgentState = () => "idle",
  ) {
    super(tui, theme, kb);
    this.setPaddingX(this.getPaddingX() + GLYPH_W);
    this.breathT0 = Date.now();
    this.breath = setInterval(() => this.tui.requestRender(), BREATH_FPS);
  }

  private internals(): EditorInternals {
    return this as unknown as EditorInternals;
  }

  private alpha(): number {
    const t = ((Date.now() - this.breathT0) % BREATH_MS) / BREATH_MS;
    return (1 - Math.cos(2 * Math.PI * t)) / 2;
  }

  private clearPendingNormal(): void {
    if (this.pendingNormal) {
      clearTimeout(this.pendingNormal);
      this.pendingNormal = undefined;
    }
    this.pendingNormalAt = 0;
  }

  private clearPendingVimPrefix(): void {
    if (this.pendingVimPrefixTimer) {
      clearTimeout(this.pendingVimPrefixTimer);
      this.pendingVimPrefixTimer = undefined;
    }
    this.pendingVimPrefix = undefined;
  }

  private scheduleNormalMode(): void {
    this.clearPendingNormal();
    this.pendingNormalAt = Date.now();
    this.pendingNormal = setTimeout(() => {
      if (!this.pendingNormalAt) return;
      this.mode = "normal";
      this.clearPendingNormal();
      this.tui.requestRender();
    }, DOUBLE_ESCAPE_MS);
  }

  private scheduleVimPrefix(prefix: VimPrefix): void {
    this.clearPendingVimPrefix();
    this.pendingVimPrefix = prefix;
    this.pendingVimPrefixTimer = setTimeout(() => {
      this.clearPendingVimPrefix();
    }, VIM_PREFIX_MS);
  }

  private syncTypedState(): void {
    this.typed = this.getText().length > 0;
  }

  private enterInsertMode(): void {
    this.mode = "insert";
    this.tui.requestRender();
  }

  private resolvePendingChord(data: string): boolean {
    if (this.pendingVimPrefix === undefined) return false;

    const pending = this.pendingVimPrefix;
    this.clearPendingVimPrefix();
    if (pending === "g" && data === "g") {
      this.moveToBufferLine(0);
      return true;
    }
    if (pending === "d" && data === "d") {
      this.deleteCurrentLine();
      return true;
    }
    return false;
  }

  // ── motion ────────────────────────────────────────────────
  private moveToBufferLine(targetLine: number): void {
    const editor = this.internals();
    const lines = editor.state.lines;
    if (lines.length === 0) {
      editor.lastAction = null;
      this.clearPendingVimPrefix();
      this.syncTypedState();
      return;
    }

    const currentCol = editor.state.cursorCol;
    const clampedLine = Math.max(0, Math.min(lines.length - 1, targetLine));
    editor.state.cursorLine = clampedLine;
    const lineLength = lines[clampedLine]?.length ?? 0;
    editor.setCursorCol(Math.min(currentCol, lineLength));
    editor.lastAction = null;
    this.clearPendingVimPrefix();
  }

  private handleMotionKey(data: string): boolean {
    switch (data) {
      case "h":
        super.handleInput("\x1b[D");
        return true;
      case "j":
        super.handleInput("\x1b[B");
        return true;
      case "k":
        super.handleInput("\x1b[A");
        return true;
      case "l":
        super.handleInput("\x1b[C");
        return true;
      case "w":
        super.handleInput("\x1bf");
        return true;
      case "b":
        super.handleInput("\x1bb");
        return true;
      case "0":
        super.handleInput("\x01");
        return true;
      case "$":
        super.handleInput("\x05");
        return true;
    }

    if (matchesKey(data, "shift+g") || data === "G") {
      this.moveToBufferLine(this.internals().state.lines.length - 1);
      return true;
    }

    return false;
  }

  // ── delete ────────────────────────────────────────────────
  private deleteCurrentLine(): void {
    const editor = this.internals();
    const lines = editor.state.lines;
    this.clearPendingVimPrefix();
    if (lines.length === 0) {
      editor.lastAction = null;
      this.syncTypedState();
      return;
    }

    const currentLine = Math.max(0, Math.min(editor.state.cursorLine, lines.length - 1));
    const lineText = lines[currentLine] ?? "";
    const isOnlyLine = lines.length === 1;
    const isLastLine = currentLine === lines.length - 1;

    if (isOnlyLine && lineText.length === 0) {
      editor.lastAction = null;
      this.syncTypedState();
      return;
    }

    let deletedText: string;
    if (isOnlyLine) {
      deletedText = lineText;
    } else if (isLastLine) {
      deletedText = lineText.length > 0 ? lineText : "\n";
    } else {
      deletedText = `${lineText}\n`;
    }

    editor.pushUndoSnapshot();
    editor.killRing.push(deletedText, {
      prepend: false,
      accumulate: editor.lastAction === "kill",
    });
    editor.lastAction = "kill";
    editor.historyIndex = -1;

    if (isOnlyLine) {
      lines[0] = "";
      editor.state.cursorLine = 0;
    } else {
      lines.splice(currentLine, 1);
      editor.state.cursorLine = isLastLine ? Math.max(0, currentLine - 1) : currentLine;
    }
    editor.setCursorCol(0);

    if (this.onChange) {
      this.onChange(this.getText());
    }
    this.syncTypedState();
  }

  private handleDeleteKey(data: string): boolean {
    if (matchesKey(data, "shift+d") || data === "D") {
      this.internals().deleteToEndOfLine();
      this.syncTypedState();
      return true;
    }

    if (data === "x") {
      super.handleInput("\x1b[3~");
      this.syncTypedState();
      return true;
    }

    return false;
  }

  private openLine(direction: -1 | 1): void {
    const editor = this.internals();
    const currentLine = Math.max(0, Math.min(editor.state.cursorLine, editor.state.lines.length - 1));
    const insertAt = direction < 0 ? currentLine : currentLine + 1;

    editor.pushUndoSnapshot();
    editor.historyIndex = -1;
    editor.lastAction = null;
    editor.state.lines.splice(insertAt, 0, "");
    editor.state.cursorLine = insertAt;
    editor.setCursorCol(0);
    this.clearPendingVimPrefix();
    this.enterInsertMode();
    this.syncTypedState();
    if (this.onChange) {
      this.onChange(this.getText());
    }
  }

  private handleStateKey(data: string): boolean {
    switch (data) {
      case "i":
        this.enterInsertMode();
        return true;
      case "a":
        this.enterInsertMode();
        super.handleInput("\x1b[C");
        return true;
      case "o":
        this.openLine(1);
        return true;
      case "O":
        this.openLine(-1);
        return true;
      case "g":
        // Keep chord handling centralized so future chord starters are easy to add.
        this.scheduleVimPrefix("g");
        return true;
      case "d":
        this.scheduleVimPrefix("d");
        return true;
    }

    return false;
  }

  private handleNormalModeInput(data: string): boolean {
    if (this.resolvePendingChord(data)) return true;
    if (this.handleStateKey(data)) return true;
    if (this.handleMotionKey(data)) return true;
    if (this.handleDeleteKey(data)) return true;

    if (data.length === 1 && data.charCodeAt(0) >= 32) return false;
    super.handleInput(data);
    this.syncTypedState();
    return true;
  }

  override handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.clearPendingVimPrefix();
      if (this.mode === "insert") {
        const hasText = this.getText().trim().length > 0;
        if (hasText) {
          this.clearPendingNormal();
          this.mode = "normal";
          this.tui.requestRender();
          return;
        }

        const now = Date.now();
        const isDoubleEscape =
          this.pendingNormalAt > 0 && now - this.pendingNormalAt <= DOUBLE_ESCAPE_MS;

        if (isDoubleEscape) {
          this.clearPendingNormal();
          super.handleInput(data);
          super.handleInput(data);
          return;
        }

        this.scheduleNormalMode();
        return;
      }

      super.handleInput(data);
      return;
    }

    if (this.pendingNormalAt > 0) {
      this.clearPendingNormal();
    }

    if (this.mode === "normal") {
      const handled = this.handleNormalModeInput(data);
      if (handled) return;

      if (data.length === 1 && data.charCodeAt(0) >= 32) return;
      super.handleInput(data);
      this.syncTypedState();
      return;
    }

    super.handleInput(data);
    const t = this.getText().length > 0;
    if (t && !this.typed) this.startAnim();
    this.typed = t;
  }

  // ── render ────────────────────────────────────────────────
  private startAnim(): void {
    if (this.anim) return;
    this.frame = 0;
    this.anim = setInterval(() => {
      this.frame++;
      this.tui.requestRender();
      if (this.frame > 10) this.stopAnim();
    }, ANIM_MS);
  }

  private stopAnim(): void {
    if (this.anim) {
      clearInterval(this.anim);
      this.anim = undefined;
    }
  }

  private color(): RGB {
    const agentState = this.getAgentState();
    if (agentState === "running") return RUNNING_SILVER;
    if (agentState === "thinking") return mixRgb(THINKING_LOW, THINKING_HIGH, this.alpha());
    if (this.anim) return mixRgb(SILVER, WHITE, Math.max(0, 1 - this.frame / 10));
    return mixRgb(STEEL, SILVER, this.alpha());
  }

  private modeLabel(): string {
    const label = this.mode === "normal" ? "󰘳 NORMAL" : "󰘳 INSERT";
    return this.mode === "normal"
      ? `${BOLD}${rgb(TILDE_PINK)}${label}${UNBOLD}${RESET}`
      : `${BOLD}${rgb(SILVER)}${label}${UNBOLD}${RESET}`;
  }

  private buildBottomBorderLine(line: string, w: number): string {
    if (w <= 0) return "";

    const label = ` ${this.modeLabel()} `;
    const labelWidth = visibleWidth(label);
    if (labelWidth >= w) {
      return truncateToWidth(label, w, "");
    }

    const borderColor = this.borderColor;
    const prefixWidth = Math.max(0, w - labelWidth - 1);
    const prefix = truncateToWidth(line, prefixWidth, "");
    const suffixWidth = Math.max(1, w - visibleWidth(prefix) - labelWidth);
    return `${prefix}${label}${borderColor("─".repeat(suffixWidth))}`;
  }

  override render(w: number): string[] {
    const lines = super.render(w);
    if (lines.length <= 0) return lines;

    const g = `${rgb(this.color())}❯${RESET} `;
    for (let i = 1; i < lines.length - 1; i++) {
      lines[i] = i === 1
        ? g + truncateToWidth(lines[i]!, w - GLYPH_W, "")
        : "  " + truncateToWidth(lines[i]!, w - GLYPH_W, "");
    }

    const borderIndex = findBorderLineIndex(lines);
    lines[borderIndex] = this.buildBottomBorderLine(lines[borderIndex]!, w);
    return lines;
  }

  destroy(): void {
    if (this.breath) clearInterval(this.breath);
    this.clearPendingNormal();
    this.clearPendingVimPrefix();
    this.stopAnim();
  }
}
