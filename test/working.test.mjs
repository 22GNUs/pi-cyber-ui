import assert from "node:assert/strict";
import test from "node:test";

import { cyberState } from "../.test-dist/pi-cyber-ui/editor-state.js";
import working from "../.test-dist/pi-cyber-ui/working.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("working HUD uses one visual clock and mounts the fading summary once", async () => {
  const handlers = new Map();
  const messages = [];
  const indicators = [];
  const widgets = [];
  let renderRequests = 0;

  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
  const tui = { requestRender: () => { renderRequests += 1; } };
  const ctx = {
    hasUI: true,
    ui: {
      setWorkingIndicator(options) {
        indicators.push(options);
      },
      setWorkingMessage(message) {
        messages.push(message);
      },
      setWidget(key, content) {
        if (typeof content === "function") {
          widgets.push({ key, component: content(tui, {}) });
        } else {
          widgets.push({ key, component: content });
        }
      },
    },
  };

  working(pi);
  await handlers.get("session_start")({ reason: "startup" }, ctx);
  assert.deepEqual(indicators[0], { frames: [] });

  cyberState.onAgentStart();
  await handlers.get("agent_start")({}, ctx);
  await wait(90);
  assert.ok(messages.some((message) => typeof message === "string" && message.includes("●")));

  cyberState.onAgentEnd();
  await handlers.get("agent_end")({}, ctx);
  const pausedCount = messages.length;
  await wait(40);
  assert.equal(messages.length, pausedCount);

  cyberState.onAgentStart();
  await handlers.get("agent_start")({}, ctx);
  await wait(40);

  cyberState.onAgentSettled();
  await handlers.get("agent_settled")({}, ctx);
  const mountedSummaries = widgets.filter((entry) => entry.component !== undefined);
  assert.equal(mountedSummaries.length, 1);
  await wait(70);
  assert.ok(renderRequests > 0);
  assert.equal(widgets.filter((entry) => entry.component !== undefined).length, 1);

  await handlers.get("session_shutdown")({}, ctx);
  cyberState.resetAll();
});
