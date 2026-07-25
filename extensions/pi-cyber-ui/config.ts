/**
 * User configuration for pi-cyber-ui.
 *
 * Read once at extension load from `~/.pi/agent/pi-cyber-ui.json`.
 * Missing file or invalid fields fall back to defaults. Edit the file and run
 * `/reload` to apply changes.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CyberUiConfig {
  /** Tool highlight mode: "gutter" wraps built-in tools with a status bar; "blocks" keeps pi's default background blocks. */
  toolHighlight: "gutter" | "blocks";
  /** User message style: "prompt" renders `❯` + silver gutter (render patch); "block" keeps the themed background box. */
  userMessageStyle: "prompt" | "block";
  /** Animate the gutter bar while a tool is running. */
  gutterAnimation: boolean;
}

const DEFAULTS: CyberUiConfig = {
  toolHighlight: "gutter",
  userMessageStyle: "prompt",
  gutterAnimation: true,
};

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-cyber-ui.json");

function pick<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function loadConfig(): CyberUiConfig {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
    return {
      toolHighlight: pick(raw.toolHighlight, ["gutter", "blocks"] as const, DEFAULTS.toolHighlight),
      userMessageStyle: pick(raw.userMessageStyle, ["prompt", "block"] as const, DEFAULTS.userMessageStyle),
      gutterAnimation: typeof raw.gutterAnimation === "boolean" ? raw.gutterAnimation : DEFAULTS.gutterAnimation,
    };
  } catch {
    return { ...DEFAULTS };
  }
}
