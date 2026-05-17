/**
 * Cyber Editor — pure ❯ prompt glyph + dynamic border.
 *
 * Dynamic HUD data lives in working/footer; editor owns input chrome only.
 */
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import CyberEditor from "./cyber-editor.js";
import { cyberState as state } from "./editor-state.js";

function attach(pi: ExtensionAPI, ctx: ExtensionContext): void {
  try {
    if (!ctx.hasUI) return;
    const theme = ctx.ui.theme;
    ctx.ui.setEditorComponent((tui, th, kb) => {
      const editor = new CyberEditor(tui, th, kb, {
        getBorderColor: (text) => {
          if (text.trimStart().startsWith("!")) return theme.getBashModeBorderColor();
          try {
            return theme.getThinkingBorderColor(pi.getThinkingLevel());
          } catch {
            return theme.getThinkingBorderColor("off");
          }
        },
      });
      return editor;
    });
  } catch {
    // ctx may already be stale during reload teardown; next session attaches.
  }
}

export default function editor(pi: ExtensionAPI) {
  pi.on("session_start", async (_e, ctx) => {
    state.onSessionStart();
    attach(pi, ctx);
  });

  pi.on("session_before_switch", async () => {
    state.onSessionSwitch();
  });

  pi.on("session_shutdown", async (_e, ctx) => {
    try {
      if (!ctx.hasUI) return;
      ctx.ui.setEditorComponent(undefined);
    } catch {
      // Reload/session replacement may stale ctx during teardown. Fresh session
      // installs its own editor component on session_start.
    }
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
