import assert from "node:assert/strict";
import test from "node:test";

import { CyberEditorState } from "../.test-dist/pi-cyber-ui/editor-state.js";
import { StreamingTokenRate } from "../.test-dist/pi-cyber-ui/token-usage.js";

function usage({ input = 0, output = 0, cacheRead = 0, cacheWrite = 0, totalTokens } = {}) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: totalTokens ?? input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistant(overrides = {}) {
  return {
    role: "assistant",
    content: [],
    api: "cliproxyapi-codex-responses",
    provider: "cliproxyapi",
    model: "grok-4.5",
    usage: usage(),
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

function completeTurn(state, values, times) {
  const empty = assistant();
  const final = assistant({ usage: usage(values), timestamp: times.done });
  state.onTurnStart();
  state.onAssistantStart(empty, times.start);
  state.onAssistantDelta("streamed answer", empty, times.firstDelta);
  state.onAssistantDone(final, times.done);
  state.onAssistantTurnEnd(final, times.done);
}

test("StreamingTokenRate changes only when cumulative progress increases", () => {
  const rate = new StreamingTokenRate(1_500, 600);
  rate.addCumulative(0, 0);
  assert.equal(rate.value(), undefined);

  assert.equal(rate.addCumulative(10, 500), 20);
  const stable = rate.value();
  assert.equal(rate.addCumulative(10, 900), stable);
  assert.equal(rate.value(), stable);
  assert.equal(rate.lastProgressTimestamp(), 500);
});

test("final-only usage keeps live values estimated, then reconciles to exact usage", () => {
  const state = new CyberEditorState();
  const empty = assistant();
  const final = assistant({
    usage: usage({ input: 129, output: 164, cacheRead: 1_536 }),
    timestamp: 2_000,
  });

  state.onPromptStart(0);
  state.onAgentStart(0);
  state.onTurnStart();
  state.onAssistantStart(empty, 100);
  state.onAssistantDelta("Reasoning about the requested change.", empty, 200);
  state.onAssistantDelta("Writing the final answer now.", empty, 500);

  const live = state.snapshot(600);
  assert.equal(live.inputPending, true);
  assert.equal(live.output.estimated, true);
  assert.ok((live.output.value ?? 0) > 0);
  assert.equal(live.tps.estimated, true);

  const quiet = state.snapshot(1_500);
  assert.equal(quiet.tps.quiet, true);
  assert.equal(quiet.tps.value, undefined);

  state.onAssistantDone(final, 2_000);
  const reconciled = state.snapshot(2_000);
  assert.equal(reconciled.inputValue, 129);
  assert.equal(reconciled.inputPending, false);
  assert.equal(reconciled.cacheReadValue, 1_536);
  assert.equal(reconciled.output.value, 164);
  assert.equal(reconciled.output.estimated, false);

  state.onAssistantTurnEnd(final, 2_000);
  const toolPhase = state.snapshot(2_100);
  assert.equal(toolPhase.output.value, 164);
  assert.equal(toolPhase.output.frozen, true);
});

test("partial cumulative usage dynamically enables exact live output", () => {
  const state = new CyberEditorState();
  const start = assistant({ api: "anthropic-messages", usage: usage({ input: 50 }) });
  const partial5 = assistant({ api: "anthropic-messages", usage: usage({ input: 50, output: 5 }) });
  const partial10 = assistant({ api: "anthropic-messages", usage: usage({ input: 50, output: 10 }) });

  state.onPromptStart(0);
  state.onTurnStart();
  state.onAssistantStart(start, 100);
  state.onAssistantDelta("hello", partial5, 200);
  state.onAssistantDelta(" world", partial10, 500);

  const live = state.snapshot(500);
  assert.equal(live.inputValue, 50);
  assert.equal(live.output.value, 10);
  assert.equal(live.output.estimated, false);
  assert.equal(live.tps.estimated, false);
  assert.ok((live.tps.value ?? 0) > 0);
});

test("settled prompt aggregates exact Pi usage and uses prompt wall-clock TPS", () => {
  const state = new CyberEditorState();
  state.onPromptStart(0);
  state.onAgentStart(0);

  completeTurn(
    state,
    { input: 10, output: 20, cacheRead: 100 },
    { start: 100, firstDelta: 200, done: 1_000 },
  );
  completeTurn(
    state,
    { input: 15, output: 30, cacheRead: 200, cacheWrite: 5 },
    { start: 2_000, firstDelta: 2_200, done: 4_000 },
  );

  // Re-entrant starts during retries must not reset accumulated prompt usage.
  state.onPromptStart(4_500);
  state.onAgentSettled(10_000);

  const settled = state.snapshot(10_000);
  assert.equal(settled.promptTurns, 2);
  assert.equal(settled.inputValue, 25);
  assert.equal(settled.cacheReadValue, 300);
  assert.equal(settled.cacheWriteValue, 5);
  assert.equal(settled.output.value, 50);
  assert.equal(settled.output.estimated, false);
  assert.equal(settled.tps.value, 5);
  assert.equal(settled.tps.estimated, false);
});

test("missing terminal usage preserves an explicitly estimated fallback", () => {
  const state = new CyberEditorState();
  const empty = assistant();

  state.onPromptStart(0);
  state.onTurnStart();
  state.onAssistantStart(empty, 100);
  state.onAssistantDelta("fallback output without provider usage", empty, 200);
  state.onAssistantDone(empty, 1_000);
  state.onAssistantTurnEnd(empty, 1_000);
  state.onAgentSettled(2_000);

  const settled = state.snapshot(2_000);
  assert.equal(settled.inputValue, undefined);
  assert.ok((settled.output.value ?? 0) > 0);
  assert.equal(settled.output.estimated, true);
  assert.equal(settled.tps.estimated, true);
});
