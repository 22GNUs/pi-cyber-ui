import assert from "node:assert/strict";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Text, visibleWidth } from "@earendil-works/pi-tui";

import { palette, rgb } from "../.test-dist/pi-cyber-ui/palette.js";
import toolGutter from "../.test-dist/pi-cyber-ui/tool-gutter.js";
import {
  installToolRendererBridge,
} from "../.test-dist/pi-cyber-ui/tool-renderer-bridge.js";
import {
  findRunningPiRoot,
  importRunningPiModule,
} from "../.test-dist/pi-cyber-ui/runtime-pi.js";

const extensionDir = new URL("../extensions/pi-cyber-ui/", import.meta.url);

function typescriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = new URL(entry.name, directory);
    if (entry.isDirectory()) return typescriptFiles(new URL(`${entry.name}/`, directory));
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

function renderContext(overrides = {}) {
  return {
    args: {},
    toolCallId: "tool-1",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: true,
    isError: false,
    ...overrides,
  };
}

class FakeToolExecutionComponent {
  constructor(toolName, callRenderer, resultRenderer) {
    this.toolName = toolName;
    this.callRenderer = callRenderer;
    this.resultRenderer = resultRenderer;
  }

  getCallRenderer() {
    return this.callRenderer;
  }

  getResultRenderer() {
    return this.resultRenderer;
  }

  getRenderShell() {
    return "default";
  }
}

const fakeDependencies = {
  async loadToolExecutionComponent() {
    return FakeToolExecutionComponent;
  },
};

// The gutter owns rendering only. It must never re-register or toggle tools.
test("tool gutter never registers tools or changes the active set", () => {
  for (const path of typescriptFiles(extensionDir)) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /\bregisterTool\s*\(/, `${path.pathname} must not own tool execution`);
  }
  const gutterSource = readFileSync(new URL("../extensions/pi-cyber-ui/tool-gutter.ts", import.meta.url), "utf8");
  assert.doesNotMatch(gutterSource, /\bsetActiveTools\s*\(/);
});

test("running Pi renderer component resolves from the process package root", async () => {
  const originalEntry = process.argv[1];
  const cli = fileURLToPath(
    new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url),
  );
  const expectedRoot = realpathSync(
    fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent", import.meta.url)),
  );

  try {
    process.argv[1] = cli;
    assert.equal(
      findRunningPiRoot("dist/modes/interactive/components/tool-execution.js"),
      expectedRoot,
    );
    const mod = await importRunningPiModule(
      "dist/modes/interactive/components/tool-execution.js",
    );
    assert.equal(typeof mod?.ToolExecutionComponent, "function");

    const prototype = mod.ToolExecutionComponent.prototype;
    const originalCall = prototype.getCallRenderer;
    const decorators = {
      wrapCall: (_name, renderer) => renderer ?? (() => new Text("call", 0, 0)),
      wrapResult: (_name, renderer) => renderer ?? (() => new Text("result", 0, 0)),
    };
    const disposeBridge = await installToolRendererBridge(decorators);
    assert.equal(typeof disposeBridge, "function");
    assert.notEqual(prototype.getCallRenderer, originalCall);
    assert.equal(disposeBridge(), true);
    assert.equal(prototype.getCallRenderer, originalCall);

    const handlers = new Map();
    const pi = {
      on(event, handler) {
        handlers.set(event, handler);
      },
      getAllTools() {
        return [{ name: "runtime_dynamic", sourceInfo: { source: "third-party" } }];
      },
    };
    await toolGutter(pi, { toolHighlight: "gutter", userMessageStyle: "prompt" });
    const definition = {
      name: "runtime_dynamic",
      label: "Runtime Dynamic",
      description: "",
      parameters: {},
      async execute() {
        return { content: [{ type: "text", text: "ok" }] };
      },
      renderCall() {
        return new Text("runtime dynamic call", 0, 0);
      },
      renderResult() {
        return new Text("runtime dynamic result", 0, 0);
      },
    };
    const component = new mod.ToolExecutionComponent(
      "runtime_dynamic",
      "runtime-1",
      {},
      {},
      definition,
      { requestRender() {} },
      process.cwd(),
    );
    component.markExecutionStarted();
    component.setArgsComplete();
    component.updateResult({
      content: [{ type: "text", text: "ok" }],
      details: {},
      isError: false,
    });
    const lines = component.render(50);
    assert.ok(lines.some((line) => line.includes("runtime dynamic call")));
    assert.ok(lines.some((line) => line.includes("runtime dynamic result")));
    assert.ok(lines.every((line) => visibleWidth(line) <= 50));
    await handlers.get("session_shutdown")({}, {});
  } finally {
    process.argv[1] = originalEntry;
  }
});

test("renderer bridge is reference-counted and restores the original methods", async () => {
  const originalCall = FakeToolExecutionComponent.prototype.getCallRenderer;
  const originalResult = FakeToolExecutionComponent.prototype.getResultRenderer;
  const originalShell = FakeToolExecutionComponent.prototype.getRenderShell;
  const decorators = {
    wrapCall: (_name, renderer) => renderer ?? (() => new Text("call", 0, 0)),
    wrapResult: (_name, renderer) => renderer ?? (() => new Text("result", 0, 0)),
  };

  const disposeFirst = await installToolRendererBridge(decorators, fakeDependencies);
  const patchedCall = FakeToolExecutionComponent.prototype.getCallRenderer;
  assert.equal(typeof disposeFirst, "function");
  assert.notEqual(patchedCall, originalCall);
  const disposeSecond = await installToolRendererBridge(decorators, fakeDependencies);
  assert.equal(typeof disposeSecond, "function");
  assert.equal(FakeToolExecutionComponent.prototype.getCallRenderer, patchedCall);

  assert.equal(disposeFirst(), true);
  assert.equal(disposeFirst(), true);
  assert.equal(FakeToolExecutionComponent.prototype.getCallRenderer, patchedCall);
  assert.equal(disposeSecond(), true);
  assert.equal(FakeToolExecutionComponent.prototype.getCallRenderer, originalCall);
  assert.equal(FakeToolExecutionComponent.prototype.getResultRenderer, originalResult);
  assert.equal(FakeToolExecutionComponent.prototype.getRenderShell, originalShell);
});

test("renderer bridge rejects readonly, frozen, and conflicting prototypes without throwing", async () => {
  class ReadonlyToolExecutionComponent {
    getCallRenderer() {}
    getResultRenderer() {}
    getRenderShell() { return "default"; }
  }
  Object.defineProperty(ReadonlyToolExecutionComponent.prototype, "getResultRenderer", {
    ...Object.getOwnPropertyDescriptor(ReadonlyToolExecutionComponent.prototype, "getResultRenderer"),
    writable: false,
    configurable: false,
  });
  const decorators = {
    wrapCall: (_name, renderer) => renderer ?? (() => new Text("call", 0, 0)),
    wrapResult: (_name, renderer) => renderer ?? (() => new Text("result", 0, 0)),
  };
  assert.equal(
    await installToolRendererBridge(decorators, {
      loadToolExecutionComponent: async () => ReadonlyToolExecutionComponent,
    }),
    undefined,
  );

  class FrozenToolExecutionComponent {
    getCallRenderer() {}
    getResultRenderer() {}
    getRenderShell() { return "default"; }
  }
  Object.freeze(FrozenToolExecutionComponent.prototype);
  assert.equal(
    await installToolRendererBridge(decorators, {
      loadToolExecutionComponent: async () => FrozenToolExecutionComponent,
    }),
    undefined,
  );

  class ConflictingToolExecutionComponent {
    getCallRenderer() {}
    getResultRenderer() {}
    getRenderShell() { return "default"; }
  }
  const conflictDependencies = {
    loadToolExecutionComponent: async () => ConflictingToolExecutionComponent,
  };
  const dispose = await installToolRendererBridge(decorators, conflictDependencies);
  assert.equal(typeof dispose, "function");
  const patchedCall = ConflictingToolExecutionComponent.prototype.getCallRenderer;
  ConflictingToolExecutionComponent.prototype.getCallRenderer = function foreignMiddleware() {
    return patchedCall.call(this);
  };
  assert.equal(dispose(), false);
  assert.equal(dispose(), false);
  assert.equal(await installToolRendererBridge(decorators, conflictDependencies), undefined);
});

test("dynamic extension and SDK tools keep their renderers inside the gutter", async () => {
  const tools = [
    { name: "read", sourceInfo: { source: "builtin" } },
    { name: "ask_user", sourceInfo: { source: "third-party" } },
  ];
  const activeTools = ["read", "ask_user"];
  const handlers = new Map();
  const notifications = [];
  let originalLastComponent;

  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    getAllTools() {
      return [...tools];
    },
    getActiveTools() {
      return [...activeTools];
    },
    registerTool() {
      throw new Error("renderer bridge must not register tools");
    },
    setActiveTools() {
      throw new Error("renderer bridge must not alter active tools");
    },
  };

  await toolGutter(
    pi,
    { toolHighlight: "gutter", userMessageStyle: "prompt" },
    fakeDependencies,
  );

  const theme = {
    fg: (_color, text) => text,
    bold: (text) => text,
  };
  const customCall = (_args, _theme, context) => {
    originalLastComponent = context.lastComponent;
    return context.lastComponent ?? new Text("third-party call", 0, 0);
  };
  const customResult = () => new Text("third-party result", 0, 0);
  const extensionTool = new FakeToolExecutionComponent("ask_user", customCall, customResult);
  assert.equal(extensionTool.getRenderShell(), "self");

  const firstComponent = extensionTool.getCallRenderer()({}, theme, renderContext());
  const firstLines = firstComponent.render(40);
  assert.ok(firstLines.some((line) => line.includes("third-party call")));
  assert.ok(firstLines.every((line) => visibleWidth(line) <= 40));

  const secondComponent = extensionTool.getCallRenderer()(
    {},
    theme,
    renderContext({ lastComponent: firstComponent }),
  );
  assert.equal(secondComponent, firstComponent);
  assert.ok(originalLastComponent instanceof Text);

  tools.push({ name: "throwing_tool", sourceInfo: { source: "third-party" } });
  const throwingTool = new FakeToolExecutionComponent(
    "throwing_tool",
    () => { throw new Error("call renderer failed"); },
    () => { throw new Error("result renderer failed"); },
  );
  const sharedState = {};
  const fallbackCall = throwingTool
    .getCallRenderer()({}, theme, renderContext({ state: sharedState, isPartial: true }))
    .render(40);
  assert.ok(fallbackCall.some((line) => line.includes("throwing_tool")));
  assert.ok(fallbackCall.some((line) => line.includes(`${rgb(palette.blue)}▍`)));
  const fallbackResult = throwingTool
    .getResultRenderer()(
      { content: [{ type: "text", text: "raw fallback" }] },
      { expanded: false, isPartial: false },
      theme,
      renderContext({ state: sharedState, isError: true }),
    )
    .render(40);
  assert.ok(fallbackResult.some((line) => line.includes("raw fallback")));
  assert.ok(fallbackResult.some((line) => line.includes(`${rgb(palette.red)}▍`)));
  assert.ok(fallbackResult.every((line) => visibleWidth(line) <= 40));

  tools.push({ name: "long_tool", sourceInfo: { source: "third-party" } });
  const longText = Array.from({ length: 650 }, (_, index) => `${index} ${"x".repeat(72)}`).join("\n");
  const longTool = new FakeToolExecutionComponent(
    "long_tool",
    () => new Text(longText, 0, 0),
    undefined,
  );
  const longComponent = longTool.getCallRenderer()({}, theme, renderContext());
  const longLines = longComponent.render(100);
  assert.ok(longLines.length >= 650);
  assert.ok(longLines.every((line) => visibleWidth(line) <= 100));
  assert.equal(longComponent.render(100), longLines);

  tools.push({ name: "bash", sourceInfo: { source: "third-party" } });
  const overriddenBash = new FakeToolExecutionComponent(
    "bash",
    () => new Text("owner-defined bash renderer", 0, 0),
    undefined,
  );
  const bashLines = overriddenBash
    .getCallRenderer()({ command: "echo replaced" }, theme, renderContext())
    .render(40);
  assert.ok(bashLines.some((line) => line.includes("owner-defined bash renderer")));

  tools.push({ name: "late_sdk_tool", sourceInfo: { source: "sdk" } });
  activeTools.push("late_sdk_tool");
  const dynamicTool = new FakeToolExecutionComponent(
    "late_sdk_tool",
    () => new Text("registered later", 0, 0),
    undefined,
  );
  const dynamicLines = dynamicTool.getCallRenderer()({}, theme, renderContext()).render(30);
  assert.ok(dynamicLines.some((line) => line.includes("registered later")));
  assert.equal(dynamicTool.getRenderShell(), "self");

  assert.deepEqual(activeTools, ["read", "ask_user", "late_sdk_tool"]);
  assert.deepEqual(notifications, []);
  assert.equal(typeof handlers.get("session_shutdown"), "function");
  await handlers.get("session_shutdown")({}, {});
  assert.equal(extensionTool.getRenderShell(), "default");
});

test("incompatible renderer bridge warns once and keeps Pi fallback rendering", async () => {
  let sessionStart;
  const notifications = [];
  const pi = {
    on(event, handler) {
      if (event === "session_start") sessionStart = handler;
    },
  };
  await toolGutter(
    pi,
    { toolHighlight: "gutter", userMessageStyle: "prompt" },
    { loadToolExecutionComponent: async () => undefined },
  );

  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
  };
  await sessionStart({ reason: "startup" }, ctx);
  await sessionStart({ reason: "reload" }, ctx);
  assert.deepEqual(notifications, [
    {
      message:
        "pi-cyber-ui dynamic gutter unavailable · all tools use themed block fallback",
      type: "warning",
    },
  ]);
});
