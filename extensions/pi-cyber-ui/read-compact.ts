import type { Theme } from "@earendil-works/pi-coding-agent";
import { basename, dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { homedir } from "os";

export const COMPACT_READ_STATE_KEY = "compactReadKind";

const BOLD = "\x1b[1m";
const UNBOLD = "\x1b[22m";

// Keep in sync with Pi's built-in read compact classifications in
// @earendil-works/pi-coding-agent core/tools/read.
const COMPACT_RESOURCE_FILE_NAMES = new Set([
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
]);

export type CompactReadClassification =
  | { kind: "skill"; label: string }
  | { kind: "resource"; label: string };

export interface CompactReadHeaderOptions {
  theme: Theme;
  classification: CompactReadClassification;
  suffix: string;
  renderHeader: (options: {
    theme: Theme;
    toolName: string;
    icon?: string;
    nameColor?: "toolTitle";
    primary: string;
    primarySuffix?: string;
  }) => string;
}

function resolveReadPath(rawPath: string, cwd: string): string {
  const expanded = rawPath.startsWith("~/")
    ? resolvePath(homedir(), rawPath.slice(2))
    : rawPath;
  return isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
}

export function getCompactReadClassification(
  rawPath: string,
  cwd: string,
  shortenPath: (path: string, cwd: string) => string,
): CompactReadClassification | undefined {
  if (!rawPath) return undefined;
  const absolutePath = resolveReadPath(rawPath, cwd);
  const fileName = basename(absolutePath);
  if (fileName === "SKILL.md") {
    return { kind: "skill", label: basename(dirname(absolutePath)) || fileName };
  }
  if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
    return { kind: "resource", label: shortenPath(absolutePath, cwd) };
  }
  return undefined;
}

export function renderCompactReadCall({
  theme,
  classification,
  suffix,
  renderHeader,
}: CompactReadHeaderOptions): string {
  if (classification.kind === "skill") {
    return theme.fg("customMessageLabel", `${BOLD}[skill]${UNBOLD} `) +
      theme.fg("customMessageText", classification.label) +
      theme.fg("dim", suffix);
  }
  return renderHeader({
    theme,
    toolName: `read ${classification.kind}`,
    icon: "󰈙",
    nameColor: "toolTitle",
    primary: classification.label,
    primarySuffix: suffix,
  });
}

export function markCompactRead(state: Record<string, unknown>, kind: CompactReadClassification["kind"]): void {
  state[COMPACT_READ_STATE_KEY] = kind;
}

export function clearCompactRead(state: Record<string, unknown>): void {
  delete state[COMPACT_READ_STATE_KEY];
}

export function isCompactRead(state: Record<string, unknown>): boolean {
  return typeof state[COMPACT_READ_STATE_KEY] === "string";
}
