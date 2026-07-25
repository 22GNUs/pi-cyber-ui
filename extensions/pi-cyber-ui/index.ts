import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadConfig } from "./config.js";
import editor from "./editor.js";
import footer from "./footer.js";
import toolGutter from "./tool-gutter.js";
import { applyUserMessagePatch } from "./user-message-patch.js";
import working from "./working.js";

export default async function piCyberUi(pi: ExtensionAPI) {
  const config = loadConfig();

  // cyberState producer must register before consumers (working/footer).
  editor(pi);
  footer(pi);
  working(pi);

  // Built-in tool gutter (official wrap pattern; third-party tools keep the
  // theme's block style).
  toolGutter(pi, config);

  // Prompt-style user messages (defensive render patch; falls back to the
  // theme's block style when pi internals change).
  if (config.userMessageStyle === "prompt") {
    await applyUserMessagePatch();
  }
}
