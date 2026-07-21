import assert from "node:assert/strict";
import test from "node:test";

import { CyberEditorState } from "../.test-dist/pi-cyber-ui/editor-state.js";

function usage({ input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = {}) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistant(overrides = {}) {
  return {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "test",
    model: "test-model",
    usage: usage(),
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

function completeTurn(state, values, times, delta = "streamed response") {
  const empty = assistant();
  const final = assistant({ usage: usage(values), timestamp: times.done });
  state.onTurnStart();
  state.onAssistantStart(empty, times.start);
  state.onAssistantDelta(delta, empty, times.firstDelta);
  state.onAssistantDone(final, times.done);
  state.onAssistantTurnEnd(final, times.turnEnd ?? times.done);
}

test("thinking deltas feed prompt output and prompt rate keeps moving with time", () => {
  const state = new CyberEditorState();
  const empty = assistant();

  state.onAgentStart();
  state.onTurnStart();
  state.onAssistantStart(empty, 100);
  state.onAssistantDelta("thinking through the problem carefully", empty, 200);

  const first = state.snapshot(700);
  assert.equal(first.responseActive, true);
  assert.equal(first.output.estimated, true);
  assert.ok((first.output.value ?? 0) > 0);
  assert.equal(first.tps.estimated, true);
  assert.ok((first.tps.value ?? 0) > 0);

  const later = state.snapshot(1_200);
  assert.equal(later.output.value, first.output.value);
  assert.ok((later.tps.value ?? Infinity) < (first.tps.value ?? 0));
});

test("trusted cumulative streaming usage removes the output approximation marker", () => {
  const state = new CyberEditorState();
  const start = assistant({ api: "anthropic-messages", usage: usage({ input: 50 }) });
  const partial5 = assistant({ api: "anthropic-messages", usage: usage({ input: 50, output: 5 }) });
  const partial10 = assistant({ api: "anthropic-messages", usage: usage({ input: 50, output: 10 }) });

  state.onAgentStart();
  state.onTurnStart();
  state.onAssistantStart(start, 100);
  state.onAssistantDelta("thinking", partial5, 200);

  const first = state.snapshot(700);
  assert.equal(first.inputValue, 50);
  assert.equal(first.output.value, 5);
  assert.equal(first.output.estimated, false);
  assert.equal(first.tps.estimated, false);

  state.onAssistantPartial(partial10, 800);
  const second = state.snapshot(1_000);
  assert.equal(second.output.value, 10);
  assert.equal(second.output.estimated, false);
});

test("missing final usage downgrades partial exact output back to an estimate", () => {
  const state = new CyberEditorState();
  const partial = assistant({ api: "anthropic-messages", usage: usage({ input: 50, output: 10 }) });
  const missingFinal = assistant({ api: "anthropic-messages", usage: usage({ input: 50 }) });

  state.onAgentStart();
  state.onTurnStart();
  state.onAssistantStart(partial, 100);
  state.onAssistantDelta("more streamed thinking and text", partial, 300);
  assert.equal(state.snapshot(700).output.estimated, false);

  state.onAssistantDone(missingFinal, 1_000);
  const fallback = state.snapshot(1_000);
  assert.ok((fallback.output.value ?? 0) >= 10);
  assert.equal(fallback.output.estimated, true);
});

test("final usage reconciles estimates and tool phase freezes token rate", () => {
  const state = new CyberEditorState();
  const empty = assistant();
  const final = assistant({ usage: usage({ input: 129, output: 164 }) });

  state.onAgentStart();
  state.onTurnStart();
  state.onAssistantStart(empty, 100);
  state.onAssistantDelta("draft answer with hidden thinking", empty, 300);
  assert.equal(state.snapshot(700).output.estimated, true);

  state.onAssistantDone(final, 1_000);
  state.onToolCall();
  const tool = state.snapshot(1_100);
  assert.equal(tool.agentState, "tool");
  assert.equal(tool.output.value, 164);
  assert.equal(tool.output.estimated, false);
  assert.equal(tool.output.frozen, true);
  assert.ok(Math.abs((tool.tps.value ?? 0) - (164 / 0.9)) < 0.001);
  assert.equal(tool.tps.estimated, false);

  state.onToolResult();
  state.onAssistantTurnEnd(final, 1_200);
  state.onAgentEnd(2_000);

  const settled = state.snapshot(2_000);
  assert.equal(settled.inputValue, 129);
  assert.equal(settled.output.value, 164);
  assert.equal(settled.output.estimated, false);
  assert.ok(Math.abs((settled.tps.value ?? 0) - (164 / 0.9)) < 0.001);
  assert.equal(settled.tps.estimated, false);
});

test("a new unresolved response makes prior prompt totals provisional", () => {
  const state = new CyberEditorState();
  state.onAgentStart();

  completeTurn(
    state,
    { input: 10, output: 20 },
    { start: 100, firstDelta: 200, done: 1_000 },
  );

  state.onTurnStart();
  state.onAssistantStart(assistant(), 2_000);
  const unresolved = state.snapshot(2_600);
  assert.equal(unresolved.output.value, 20);
  assert.equal(unresolved.output.estimated, true);
  assert.equal(unresolved.tps.estimated, true);
});

test("prompt totals accumulate across turns and exclude tool time from t/s", () => {
  const state = new CyberEditorState();
  state.onAgentStart();

  completeTurn(
    state,
    { input: 10, output: 20 },
    { start: 100, firstDelta: 200, done: 1_000, turnEnd: 1_500 },
    "thinking and tool selection",
  );
  completeTurn(
    state,
    { input: 15, output: 30 },
    { start: 2_000, firstDelta: 2_200, done: 4_000 },
    "final response",
  );
  state.onAgentEnd(10_000);

  const settled = state.snapshot(10_000);
  assert.equal(settled.promptTurns, 2);
  assert.equal(settled.inputValue, 25);
  assert.equal(settled.output.value, 50);
  assert.equal(settled.output.estimated, false);
  assert.ok(Math.abs((settled.tps.value ?? 0) - (50 / 2.9)) < 0.001);
  assert.equal(settled.tps.estimated, false);
});

test("missing final usage preserves an explicitly estimated prompt summary", () => {
  const state = new CyberEditorState();
  const empty = assistant();

  state.onAgentStart();
  state.onTurnStart();
  state.onAssistantStart(empty, 100);
  state.onAssistantDelta("fallback output without provider usage", empty, 200);
  state.onAssistantDone(empty, 1_000);
  state.onAssistantTurnEnd(empty, 1_000);
  state.onAgentEnd(2_000);

  const settled = state.snapshot(2_000);
  assert.equal(settled.inputValue, undefined);
  assert.ok((settled.output.value ?? 0) > 0);
  assert.equal(settled.output.estimated, true);
  assert.ok((settled.tps.value ?? 0) > 0);
  assert.equal(settled.tps.estimated, true);
});

test("input total is hidden when any prompt turn lacks trustworthy input usage", () => {
  const state = new CyberEditorState();
  state.onAgentStart();

  completeTurn(
    state,
    { input: 10, output: 20 },
    { start: 100, firstDelta: 200, done: 1_000 },
  );
  completeTurn(
    state,
    { output: 30 },
    { start: 2_000, firstDelta: 2_100, done: 3_000 },
  );
  state.onAgentEnd(3_100);

  const settled = state.snapshot(3_100);
  assert.equal(settled.inputValue, undefined);
  assert.equal(settled.output.value, 50);
  assert.equal(settled.output.estimated, false);
});
