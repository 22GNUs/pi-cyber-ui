import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const extensionDir = new URL("../extensions/pi-cyber-ui/", import.meta.url);

function typescriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = new URL(entry.name, directory);
    if (entry.isDirectory()) return typescriptFiles(new URL(`${entry.name}/`, directory));
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

test("pi-cyber-ui never registers or overrides tools", () => {
  for (const path of typescriptFiles(extensionDir)) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(
      source,
      /\bregisterTool\s*\(/,
      `${path.pathname} must leave tool definitions and rendering to Pi or the owning extension`,
    );
  }
});
