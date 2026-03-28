/**
 * Vim Editor
 *
 * Standalone vim-style behavior layer for Pi's editor.
 * This module intentionally focuses on editing semantics only so other
 * editor shells (Cyber, minimal, future variants) can reuse it.
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
 */
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import type { KeybindingsManager } from "@mariozechner/pi-coding-agent";
import type { EditorTheme, TUI } from "@mariozechner/pi-tui";
import { matchesKey } from "@mariozechner/pi-tui";

const DOUBLE_ESCAPE_MS = 500;
const VIM_PREFIX_MS = DOUBLE_ESCAPE_MS;

type VimPrefix = "g" | "d";

export interface VimEditorOptions {
  enabled?: boolean;
}

type EditorInternals = {
  state: { lines: string[]; cursorLine: number; cursorCol: number };
  pushUndoSnapshot(): void;
  setCursorCol(col: number): void;
  killRing: { push(text: string, opts: { prepend: boolean; accumulate: boolean }): void };
  lastAction: string | null;
  historyIndex: number;
  deleteToEndOfLine(): void;
};

export default class VimEditor extends CustomEditor {
  protected mode: "normal" | "insert" = "insert";
  protected readonly vimEnabled: boolean;

  private pendingNormal?: ReturnType<typeof setTimeout>;
  private pendingNormalAt = 0;
  private pendingVimPrefix?: VimPrefix;
  private pendingVimPrefixTimer?: ReturnType<typeof setTimeout>;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    kb: KeybindingsManager,
    options: VimEditorOptions = {},
  ) {
    super(tui, theme, kb);
    this.vimEnabled = options.enabled ?? true;
  }

  protected enterInsertMode(): void {
    this.mode = "insert";
    this.tui.requestRender();
  }

  private internals(): EditorInternals {
    return this as unknown as EditorInternals;
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

  private moveToBufferLine(targetLine: number): void {
    const editor = this.internals();
    const lines = editor.state.lines;
    if (lines.length === 0) {
      editor.lastAction = null;
      this.clearPendingVimPrefix();
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

  private deleteCurrentLine(): void {
    const editor = this.internals();
    const lines = editor.state.lines;
    this.clearPendingVimPrefix();
    if (lines.length === 0) {
      editor.lastAction = null;
      return;
    }

    const currentLine = Math.max(0, Math.min(editor.state.cursorLine, lines.length - 1));
    const lineText = lines[currentLine] ?? "";
    const isOnlyLine = lines.length === 1;
    const isLastLine = currentLine === lines.length - 1;

    if (isOnlyLine && lineText.length === 0) {
      editor.lastAction = null;
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
  }

  private handleDeleteKey(data: string): boolean {
    if (matchesKey(data, "shift+d") || data === "D") {
      this.internals().deleteToEndOfLine();
      return true;
    }

    if (data === "x") {
      super.handleInput("\x1b[3~");
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
    return true;
  }

  override handleInput(data: string): void {
    if (!this.vimEnabled) {
      super.handleInput(data);
      return;
    }

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
      return;
    }

    super.handleInput(data);
  }

  destroy(): void {
    this.clearPendingNormal();
    this.clearPendingVimPrefix();
  }
}
