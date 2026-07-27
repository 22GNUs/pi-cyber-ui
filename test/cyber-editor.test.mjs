import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import CyberEditor from "../.test-dist/pi-cyber-ui/cyber-editor.js";

const identity = (value) => value;

function createEditor() {
  const tui = {
    terminal: { rows: 24 },
    requestRender() {},
  };
  const theme = new Proxy(
    { borderColor: identity },
    { get: (target, key) => (key in target ? target[key] : identity) },
  );
  const keybindings = { matches: () => false };
  const editor = new CyberEditor(tui, theme, keybindings);
  editor.focused = false;
  return editor;
}

test("prompt layout wraps without dropping characters", () => {
  for (const length of [18, 19, 20, 21, 38, 57]) {
    const editor = createEditor();
    editor.setText("x".repeat(length));
    const lines = editor.render(20);

    assert.equal((lines.join("").match(/x/g) ?? []).length, length);
    for (const line of lines) assert.ok(visibleWidth(line) <= 20);
  }
});

test("pathological narrow widths still honor the component width", () => {
  const editor = createEditor();
  editor.setText("abc");

  for (const width of [1, 2]) {
    for (const line of editor.render(width)) {
      assert.ok(visibleWidth(line) <= width);
    }
  }
});
