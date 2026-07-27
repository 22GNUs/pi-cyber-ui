import assert from "node:assert/strict";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import toolGutter, {
  loadRunningBuiltinDefinitions,
} from "../.test-dist/pi-cyber-ui/tool-gutter.js";
import { findRunningPiRoot } from "../.test-dist/pi-cyber-ui/runtime-pi.js";

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

test("running Pi factories resolve from the process package root", async () => {
  const originalEntry = process.argv[1];
  const cli = fileURLToPath(
    new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url),
  );
  const expectedRoot = realpathSync(
    fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent", import.meta.url)),
  );

  try {
    process.argv[1] = cli;
    assert.equal(findRunningPiRoot(), expectedRoot);
    const definitions = await loadRunningBuiltinDefinitions(process.cwd());
    assert.deepEqual(
      [...(definitions?.keys() ?? [])],
      ["read", "bash", "edit", "write", "grep", "find", "ls"],
    );
  } finally {
    process.argv[1] = originalEntry;
  }
});

test("tool gutter wraps only built-ins and warns once for active extension tools", async () => {
  const activeTools = ["read", "bash", "edit", "ask_user", "todo", "web_search"];
  const registered = [];
  const notifications = [];
  let sessionStart;

  const pi = {
    on(event, handler) {
      if (event === "session_start") sessionStart = handler;
    },
    getAllTools() {
      return [
        { name: "read", sourceInfo: { source: "builtin" } },
        { name: "bash", sourceInfo: { source: "builtin" } },
        { name: "edit", sourceInfo: { source: "third-party" } },
        { name: "write", sourceInfo: { source: "builtin" } },
        { name: "ask_user", sourceInfo: { source: "third-party" } },
        { name: "todo", sourceInfo: { source: "third-party" } },
        { name: "web_search", sourceInfo: { source: "third-party" } },
      ];
    },
    getActiveTools() {
      return [...activeTools];
    },
    registerTool(definition) {
      registered.push(definition);
    },
  };

  const definitions = new Map(
    ["read", "bash", "edit", "write"].map((name) => {
      const execute = async () => ({ content: [{ type: "text", text: name }] });
      return [
        name,
        {
          name,
          label: name,
          description: name,
          parameters: {},
          execute,
        },
      ];
    }),
  );

  toolGutter(
    pi,
    { toolHighlight: "gutter", userMessageStyle: "prompt" },
    { loadBuiltinDefinitions: async () => definitions },
  );

  assert.equal(typeof sessionStart, "function");
  await sessionStart(
    { reason: "startup" },
    {
      cwd: process.cwd(),
      hasUI: true,
      mode: "tui",
      ui: {
        notify(message, type) {
          notifications.push({ message, type });
        },
      },
    },
  );

  assert.deepEqual(registered.map((definition) => definition.name), ["read", "bash", "write"]);
  for (const definition of registered) {
    assert.equal(definition.execute, definitions.get(definition.name).execute);
    assert.equal(definition.renderShell, "self");
  }
  assert.deepEqual(activeTools, ["read", "bash", "edit", "ask_user", "todo", "web_search"]);
  assert.deepEqual(notifications, [
    {
      message:
        "pi-cyber-ui gutter wrap skipped for extension tools: edit, ask_user +2 · using themed block fallback",
      type: "warning",
    },
  ]);
});
