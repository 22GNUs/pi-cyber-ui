import type { AssistantMessage } from "@earendil-works/pi-ai";

import { getUsageMode, type UsageMode, StreamingTokenEstimator } from "./token-usage.js";

export type AgentState = "idle" | "running" | "tool";

export interface DisplayValue {
  value?: number;
  estimated: boolean;
}

export interface OutputDisplayValue extends DisplayValue {
  frozen: boolean;
}

export interface CyberHudSnapshot {
  agentState: AgentState;
  promptActive: boolean;
  promptTurns: number;
  promptIn: number;
  inputValue?: number;
  output: OutputDisplayValue;
  tps: DisplayValue;
  responseActive: boolean;
}

interface MessageOutput {
  value?: number;
  estimated: boolean;
}

/**
 * Prompt-scoped telemetry state.
 *
 * Live output includes text, thinking, and tool-call deltas. Values remain
 * explicitly estimated until a trusted cumulative/final usage count arrives.
 * Final prompt throughput is total prompt output divided by assistant response
 * wall time; tool execution time is excluded.
 */
export class CyberEditorState {
  /** Hide rate during the statistically unstable first half-second. */
  private static readonly MIN_RATE_WINDOW_MS = 500;

  private agentState: AgentState = "idle";

  // Prompt-level totals (reset on agent_start).
  private promptIn = 0;
  private promptInputComplete = true;
  private promptOut = 0;
  private promptOutEstimated = false;
  private promptTurns = 0;
  private promptActive = false;
  private promptResponseMs = 0;

  // Current assistant response.
  private msgActive = false;
  private msgStartedAt: number | undefined;
  private msgEndedAt: number | undefined;
  private msgIn: number | undefined;
  private msgOut: number | undefined;
  private msgOutEstimated = false;
  private msgHasFinalUsage = false;
  private estOut: number | undefined;
  private msgUsageMode: UsageMode = "estimated";
  private msgEstimator = new StreamingTokenEstimator();

  private toolDepth = 0;

  resetAll(): void {
    this.promptIn = 0;
    this.promptInputComplete = true;
    this.promptOut = 0;
    this.promptOutEstimated = false;
    this.promptTurns = 0;
    this.promptActive = false;
    this.promptResponseMs = 0;
    this.toolDepth = 0;

    this.resetMessage();
    this.agentState = "idle";
  }

  onSessionStart(): void {
    this.resetAll();
  }

  onSessionSwitch(): void {
    this.resetAll();
  }

  onSessionCompact(): void {
    this.resetAll();
  }

  onSessionTree(): void {
    this.resetAll();
  }

  onAgentStart(): void {
    this.resetAll();
    this.promptActive = true;
    this.agentState = "running";
  }

  onTurnStart(): void {
    this.promptTurns += 1;
    this.agentState = "running";
  }

  onAgentEnd(at = Date.now()): void {
    if (this.msgActive) {
      this.closeResponse(at);
      if (!this.msgHasFinalUsage) this.finalizeFallbackOutput();
      this.commitMessage();
    }
    this.promptActive = false;
    this.agentState = "idle";
  }

  onToolCall(): void {
    this.toolDepth += 1;
    this.agentState = "tool";
  }

  onToolResult(): void {
    this.toolDepth = Math.max(0, this.toolDepth - 1);
    if (this.toolDepth === 0) this.agentState = "running";
  }

  onAssistantStart(message: AssistantMessage, at = Date.now()): void {
    if (message.role !== "assistant") return;
    this.resetMessage();
    this.msgActive = true;
    this.msgStartedAt = at;
    this.msgUsageMode = getUsageMode(message.api);
    this.syncMessage(message);
  }

  onAssistantDelta(delta: string, partial: AssistantMessage, _at = Date.now()): void {
    this.msgEstimator.add(delta);
    this.estOut = this.msgEstimator.value();
    this.syncMessage(partial);
  }

  onAssistantPartial(partial: AssistantMessage, _at = Date.now()): void {
    this.syncMessage(partial);
  }

  onAssistantDone(message: AssistantMessage, at = Date.now()): void {
    this.syncMessage(message, true);
    this.closeResponse(at);
  }

  onAssistantError(message: AssistantMessage, at = Date.now()): void {
    this.syncMessage(message, true);
    this.closeResponse(at);
  }

  onAssistantTurnEnd(message: AssistantMessage, at = Date.now()): void {
    if (message.role !== "assistant") return;
    this.syncMessage(message, true);
    this.closeResponse(at);
    this.commitMessage();
  }

  snapshot(at = Date.now()): CyberHudSnapshot {
    const currentOutput = this.currentMessageOutput();
    const outputValue = this.promptOut + (currentOutput.value ?? 0);
    const hasOutput = outputValue > 0;
    const responseActive = this.msgActive && this.msgEndedAt === undefined;
    const responseUnresolved = responseActive && this.msgOut === undefined;
    const outputEstimated =
      this.promptOutEstimated || currentOutput.estimated || responseUnresolved;
    const responseMs = this.responseElapsedMs(at);
    const rateAvailable =
      hasOutput &&
      responseMs >= CyberEditorState.MIN_RATE_WINDOW_MS;

    return {
      agentState: this.agentState,
      promptActive: this.promptActive,
      promptTurns: this.promptTurns,
      promptIn: this.promptIn,
      inputValue: this.exactInputValue(),
      output: {
        value: hasOutput ? outputValue : undefined,
        estimated: hasOutput && outputEstimated,
        frozen: this.toolDepth > 0,
      },
      tps: {
        value: rateAvailable ? outputValue / (responseMs / 1_000) : undefined,
        estimated: rateAvailable && outputEstimated,
      },
      responseActive,
    };
  }

  private resetMessage(): void {
    this.msgActive = false;
    this.msgStartedAt = undefined;
    this.msgEndedAt = undefined;
    this.msgIn = undefined;
    this.msgOut = undefined;
    this.msgOutEstimated = false;
    this.msgHasFinalUsage = false;
    this.estOut = undefined;
    this.msgUsageMode = "estimated";
    this.msgEstimator.reset();
  }

  private syncMessage(message: AssistantMessage, final = false): void {
    const input = this.usageToken(message.usage.input);
    const output = this.usageToken(message.usage.output);

    if (input !== undefined) this.msgIn = input;

    if (output !== undefined && (final || this.msgUsageMode === "exact")) {
      this.msgOut = output;
      this.msgOutEstimated = false;
      if (final) this.msgHasFinalUsage = true;
    }

    if (final && !this.msgHasFinalUsage) this.finalizeFallbackOutput();
  }

  private finalizeFallbackOutput(): void {
    const fallback = Math.max(this.msgOut ?? 0, this.estOut ?? 0);
    if (fallback <= 0) return;
    this.msgOut = fallback;
    this.msgOutEstimated = true;
  }

  private closeResponse(at: number): void {
    if (!this.msgActive || this.msgEndedAt !== undefined) return;
    this.msgEndedAt = at;
  }

  private commitMessage(): void {
    if (!this.msgActive) return;

    if (this.msgIn === undefined) {
      this.promptInputComplete = false;
    } else {
      this.promptIn += this.msgIn;
    }

    const output = this.currentMessageOutput();
    if (output.value !== undefined && output.value > 0) {
      this.promptOut += output.value;
      this.promptOutEstimated ||= output.estimated;
    }

    if (this.msgStartedAt !== undefined && this.msgEndedAt !== undefined) {
      this.promptResponseMs += Math.max(0, this.msgEndedAt - this.msgStartedAt);
    }

    this.resetMessage();
  }

  private currentMessageOutput(): MessageOutput {
    if (!this.msgActive) return { estimated: false };
    if (this.msgOut !== undefined) {
      return { value: this.msgOut, estimated: this.msgOutEstimated };
    }
    if (this.estOut !== undefined && this.estOut > 0) {
      return { value: this.estOut, estimated: true };
    }
    return { estimated: false };
  }

  private exactInputValue(): number | undefined {
    if (!this.promptInputComplete) return undefined;
    if (this.msgActive) {
      if (this.msgIn === undefined) return undefined;
      const value = this.promptIn + this.msgIn;
      return value > 0 ? value : undefined;
    }
    return this.promptIn > 0 ? this.promptIn : undefined;
  }

  private responseElapsedMs(at: number): number {
    let elapsed = this.promptResponseMs;
    if (!this.msgActive || this.msgStartedAt === undefined) return elapsed;
    const end = this.msgEndedAt ?? at;
    return elapsed + Math.max(0, end - this.msgStartedAt);
  }

  private usageToken(value: number): number | undefined {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return value;
  }
}

export const cyberState = new CyberEditorState();
