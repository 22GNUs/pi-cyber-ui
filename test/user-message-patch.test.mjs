import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { palette, rgb } from "../.test-dist/pi-cyber-ui/palette.js";
import { findRunningPiRoot } from "../.test-dist/pi-cyber-ui/runtime-pi.js";
import {
  applyUserMessagePatch,
  removeUserMessagePatch,
} from "../.test-dist/pi-cyber-ui/user-message-patch.js";

const USER_MESSAGE_MODULE = join("dist", "modes", "interactive", "components", "user-message.js");

test("user message patch is idempotent and restores the original renderer", async () => {
  const originalEntry = process.argv[1];
  process.argv[1] = fileURLToPath(
    new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url),
  );

  try {
    const root = findRunningPiRoot(USER_MESSAGE_MODULE);
    assert.ok(root);
    const mod = await import(pathToFileURL(join(root, USER_MESSAGE_MODULE)).href);
    const proto = mod.UserMessageComponent.prototype;
    const original = proto.rebuild;

    assert.equal(await applyUserMessagePatch(), true);
    const firstPatch = proto.rebuild;
    assert.notEqual(firstPatch, original);

    assert.equal(await applyUserMessagePatch(), true);
    assert.equal(proto.rebuild, firstPatch);

    const component = new mod.UserMessageComponent("hello");
    const styledLines = component.render(20);
    assert.ok(styledLines.some((line) => line.includes(`${rgb(palette.pink)}▍`)));
    assert.ok(styledLines.some((line) => line.includes(`${rgb(palette.promptSilver)}❯`)));
    for (const width of [1, 2, 20]) {
      for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
    }

    await removeUserMessagePatch();
    assert.equal(proto.rebuild, original);
  } finally {
    await removeUserMessagePatch();
    process.argv[1] = originalEntry;
  }
});
