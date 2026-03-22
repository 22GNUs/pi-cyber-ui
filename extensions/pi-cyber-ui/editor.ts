/**
 * Cyber Editor — cyberpunk HUD + ❯ glyph
 *
 * ❯  idle=silver breath · running=steel silver · thinking=steel pulse
 * HUD  cwd ∷ turn ∷ ↑in ↓out ∷ Nt/s
 */
import { type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";

import { attachCyberHud } from "./editor-hud.js";
import { CyberEditorState } from "./editor-state.js";
import VimEditor from "./vim-editor.js";

const state = new CyberEditorState();

function attach(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setEditorComponent((tui, th, kb) => new VimEditor(tui, th, kb, () => state.getAgentState()));
  attachCyberHud(ctx, state);
}

export default function editor(pi: ExtensionAPI) {
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
