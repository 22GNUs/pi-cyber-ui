/**
 * Cyber Editor — cyberpunk HUD + ❯ glyph
 *
 * ❯  idle=silver breath · running=steel silver · thinking=steel pulse
 * HUD  cwd ∷ turn ∷ ↑in ↓out ∷ Nt/s
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";

import CyberEditor from "./cyber-editor.js";
import { CyberEditorState } from "./editor-state.js";

const state = new CyberEditorState();
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "pi-cyber-ui.json");
let vimModeEnabled = loadVimModeSetting();
let activeUiContext: ExtensionContext | undefined;

function loadVimModeSetting(): boolean {
  try {
    const raw = readFileSync(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw) as { vimModeEnabled?: boolean };
    return parsed.vimModeEnabled ?? true;
  } catch {
    return true;
  }
}

function saveVimModeSetting(enabled: boolean): void {
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify({ vimModeEnabled: enabled }, null, 2) + "\n", "utf8");
}

function attach(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  activeUiContext = ctx;
  ctx.ui.setEditorComponent((tui, th, kb) => new CyberEditor(tui, th, kb, {
    getHudSnapshot: () => state.snapshot(),
    cwd: ctx.cwd ?? "",
    vimEnabled: vimModeEnabled,
  }));
}

function applyVimMode(enabled: boolean, ctx?: ExtensionContext): void {
  vimModeEnabled = enabled;
  saveVimModeSetting(enabled);
  const target = ctx ?? activeUiContext;
  if (target?.hasUI) {
    attach(target);
    target.ui.notify(`Cyber UI: Vim mode ${enabled ? "enabled" : "disabled"}.`, "info");
  }
}

export default function editor(pi: ExtensionAPI) {
  pi.registerCommand("cyber-vim", {
    description: "Toggle Cyber UI Vim mode (on/off/status)",
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      if (!value || value === "toggle") {
        applyVimMode(!vimModeEnabled, ctx);
        return;
      }

      if (value === "on" || value === "enable" || value === "enabled") {
        applyVimMode(true, ctx);
        return;
      }

      if (value === "off" || value === "disable" || value === "disabled") {
        applyVimMode(false, ctx);
        return;
      }

      if (value === "status") {
        ctx.ui.notify(`Cyber UI: Vim mode is ${vimModeEnabled ? "enabled" : "disabled"}.`, "info");
        return;
      }

      ctx.ui.notify("Usage: /cyber-vim [on|off|toggle|status]", "error");
    },
  });

  pi.on("session_start", async (_e, ctx) => {
    state.onSessionStart();
    attach(ctx);
  });

  pi.on("session_switch", async (_e, ctx) => {
    state.onSessionSwitch();
    attach(ctx);
  });

  pi.on("session_compact", async () => {
    state.onSessionCompact();
  });

  pi.on("session_tree", async () => {
    state.onSessionTree();
  });

  pi.on("agent_start", async () => {
    state.onAgentStart();
  });

  pi.on("turn_start", async () => {
    state.onTurnStart();
  });

  pi.on("agent_end", async () => {
    state.onAgentEnd();
  });

  pi.on("tool_call", async () => {
    state.onToolCall();
  });

  pi.on("tool_result", async () => {
    state.onToolResult();
  });

  pi.on("message_start", async (event) => {
    if (event.message.role !== "assistant") return;
    state.onAssistantStart(event.message);
  });

  pi.on("message_update", async (event) => {
    const e = event.assistantMessageEvent;

    if (e.type === "text_delta" || e.type === "thinking_delta" || e.type === "toolcall_delta") {
      state.onAssistantDelta(e.delta, e.partial);
      return;
    }

    if (
      e.type === "start" ||
      e.type === "text_start" ||
      e.type === "text_end" ||
      e.type === "thinking_start" ||
      e.type === "thinking_end" ||
      e.type === "toolcall_start" ||
      e.type === "toolcall_end"
    ) {
      state.onAssistantPartial(e.partial);
      return;
    }

    if (e.type === "done") {
      state.onAssistantDone(e.message);
      return;
    }

    if (e.type === "error") {
      state.onAssistantError(e.error);
    }
  });

  pi.on("turn_end", async (event) => {
    if (event.message.role !== "assistant") return;
    state.onAssistantTurnEnd(event.message);
  });
}
