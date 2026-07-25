import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const extensionDir = new URL("../extensions/pi-cyber-ui/", import.meta.url);
const GUTTER_FILE = "tool-gutter.ts";

function typescriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = new URL(entry.name, directory);
    if (entry.isDirectory()) return typescriptFiles(new URL(`${entry.name}/`, directory));
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

// Architecture contract: tool registration is confined to the gutter module,
// which wraps built-in tools rendering-only (execute delegates 1:1 to the
// built-in implementations obtained at runtime).
test("tool registration is confined to the gutter module", () => {
  for (const path of typescriptFiles(extensionDir)) {
    if (path.pathname.endsWith(`/${GUTTER_FILE}`)) continue;
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(
      source,
      /\bregisterTool\s*\(/,
      `${path.pathname} must leave tool definitions and rendering to Pi or the owning extension`,
    );
  }
});

test("tool gutter wraps built-ins without touching behavior", () => {
  const source = readFileSync(new URL(GUTTER_FILE, extensionDir), "utf8");
  // Definitions must come from pi's runtime factories so behavior follows updates.
  assert.match(source, /create(Read|Bash|Edit|Write|Grep|Find|Ls)ToolDefinition\s*\(/);
  // The wrapper must not redefine execution or mutate the active tool set.
  assert.doesNotMatch(source, /\bexecute\s*[:(]/, "must not override execute");
  assert.doesNotMatch(source, /\bsetActiveTools\s*\(/, "must not change active tool sets");
  // Spread of the built-in definition keeps name/schema/execute intact.
  assert.match(source, /\.\.\.def\b/, "must spread the built-in definition");
});
