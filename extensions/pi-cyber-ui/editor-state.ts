import type { AssistantMessage } from "@earendil-works/pi-ai";

import { StreamingTokenEstimator, StreamingTokenRate } from "./token-usage.js";

export type AgentState = "idle" | "running" | "thinking";

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
  inputValue?: number;
  output: OutputDisplayValue;
  reasoningValue?: number;
  tps: DisplayValue;
  toolDepth: number;
}

/**
 * Prompt-scoped token and timing state for the cyber HUD.
 *
 * The UI keeps the original cumulative prompt presentation across tool turns.
 * Live rate is delta-driven, while the settled prompt rate uses Pi's reference
 * output / wall-clock convention. Terminal provider usage always reconciles
 * any visible-stream estimate.
 */
export class CyberEditorState {
  private agentState: AgentState = "idle";

  // Prompt totals shown continuously across turns.
  private promptIn = 0;
  private promptOut = 0;
  private promptTurns = 0;
  private promptActive = false;
  private promptStartedAt = 0;
  private promptTps: number | undefined;
  private promptOutputEstimated = false;
  private promptReasoning = 0;
  private promptReasoningKnown = false;
  private lastTurnTps: number | undefined;
  private lastTurnTpsEstimated = false;

  // Current assistant message.
  private msgActive = false;
  private msgStartMs = 0;
  private firstOutMs = 0;
  private msgDoneMs = 0;
  private msgIn: number | undefined;
  private msgOut: number | undefined;
  private msgReasoning: number | undefined;
  private estOut: number | undefined;
  private msgUsageKnown = false;
  private liveTpsActive = false;
  private readonly msgEstimator = new StreamingTokenEstimator();
  private readonly msgRate = new StreamingTokenRate();

  private toolDepth = 0;

  resetAll(): void {
    this.promptIn = 0;
    this.promptOut = 0;
    this.promptTurns = 0;
    this.promptActive = false;
    this.promptStartedAt = 0;
    this.promptTps = undefined;
    this.promptOutputEstimated = false;
    this.promptReasoning = 0;
    this.promptReasoningKnown = false;
    this.lastTurnTps = undefined;
    this.lastTurnTpsEstimated = false;
    this.toolDepth = 0;

    this.resetMsg();
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

  onPromptStart(at = Date.now()): void {
    this.resetAll();
    this.promptActive = true;
    this.promptStartedAt = at;
    this.agentState = "running";
  }

  onAgentStart(at = Date.now()): void {
    if (!this.promptActive) this.onPromptStart(at);
    this.agentState = "running";
  }

  onTurnStart(): void {
    this.promptTurns += 1;
    this.agentState = "running";
  }

  onAgentEnd(at = Date.now()): void {
    if (!this.promptActive) return;
    this.promptActive = false;
    this.toolDepth = 0;
    this.agentState = "idle";

    const elapsedSeconds = (at - this.promptStartedAt) / 1_000;
    if (this.promptOut > 0 && elapsedSeconds > 0) {
      this.promptTps = this.promptOut / elapsedSeconds;
    }
  }

  onToolCall(): void {
    this.toolDepth += 1;
    this.agentState = "thinking";
  }

  onToolResult(): void {
    this.toolDepth = Math.max(0, this.toolDepth - 1);
    if (this.toolDepth === 0) this.agentState = "running";
  }

  onAssistantStart(message: AssistantMessage, at = Date.now()): void {
    if (message.role !== "assistant") return;
    this.resetMsg();
    this.msgActive = true;
    this.msgStartMs = at;
    this.observePartialUsage(message, at);
  }

  onAssistantTextDelta(delta: string, partial: AssistantMessage, at = Date.now()): void {
    if (!this.firstOutMs) {
      this.firstOutMs = at;
      this.msgRate.addCumulative(0, at);
    }
    this.liveTpsActive = true;
    this.msgEstimator.add(delta);
    this.estOut = this.msgEstimator.value();
    this.msgRate.addCumulative(this.estOut, at);
    this.observePartialUsage(partial);
  }

  onAssistantPartial(partial: AssistantMessage, at = Date.now()): void {
    this.observePartialUsage(partial, at);
  }

  onAssistantDone(message: AssistantMessage, at = Date.now()): void {
    this.finalizeMessage(message, at);
  }

  onAssistantError(message: AssistantMessage, at = Date.now()): void {
    this.finalizeMessage(message, at);
  }

  onAssistantTurnEnd(message: AssistantMessage, at = Date.now()): void {
    if (message.role !== "assistant") return;
    this.finalizeMessage(message, at);
    this.commitTurn();
  }

  snapshot(): CyberHudSnapshot {
    if (!this.promptActive) return this.promptSnapshot();
    if (this.msgActive) return this.messageSnapshot();
    return this.runningPromptSnapshot();
  }

  private baseSnapshot(): Omit<CyberHudSnapshot, "inputValue" | "output" | "tps"> {
    return {
      agentState: this.agentState,
      promptActive: this.promptActive,
      promptTurns: this.promptTurns,
      toolDepth: this.toolDepth,
    };
  }

  private runningPromptSnapshot(): CyberHudSnapshot {
    return {
      ...this.baseSnapshot(),
      inputValue: this.promptIn > 0 ? this.promptIn : undefined,
      output: {
        value: this.promptOut > 0 ? this.promptOut : undefined,
        estimated: this.promptOutputEstimated,
        frozen: this.toolDepth > 0,
      },
      tps: {
        value: this.lastTurnTps,
        estimated: this.lastTurnTpsEstimated,
      },
    };
  }

  private messageSnapshot(): CyberHudSnapshot {
    const exactOutput = this.msgUsageKnown ? this.msgOut : undefined;
    const currentOutput = exactOutput ?? this.estOut;
    const currentEstimated = exactOutput === undefined && currentOutput !== undefined;
    const displayOutput = this.promptOut + (currentOutput ?? 0);

    const liveTps = this.liveTpsActive ? this.msgRate.value() : undefined;
    const settledTps = this.liveTpsActive ? undefined : this.settledMessageTps();

    return {
      ...this.baseSnapshot(),
      inputValue: this.positiveOrUndefined(this.promptIn + (this.msgIn ?? 0)),
      output: {
        value: this.positiveOrUndefined(displayOutput),
        estimated: this.promptOutputEstimated || currentEstimated,
        frozen: this.toolDepth > 0 || !this.liveTpsActive,
      },
      reasoningValue: this.promptReasoningValue(),
      tps: {
        value: liveTps ?? settledTps ?? this.lastTurnTps,
        estimated:
          liveTps !== undefined
            ? true
            : settledTps !== undefined
              ? currentEstimated
              : this.lastTurnTpsEstimated,
      },
    };
  }

  private promptSnapshot(): CyberHudSnapshot {
    return {
      ...this.baseSnapshot(),
      inputValue: this.promptIn > 0 ? this.promptIn : undefined,
      output: {
        value: this.promptOut > 0 ? this.promptOut : undefined,
        estimated: this.promptOutputEstimated,
        frozen: false,
      },
      reasoningValue: this.promptReasoningValue(),
      tps: {
        value: this.promptTps,
        estimated: this.promptOutputEstimated,
      },
    };
  }

  private resetMsg(): void {
    this.msgActive = false;
    this.msgStartMs = 0;
    this.firstOutMs = 0;
    this.msgDoneMs = 0;
    this.msgIn = undefined;
    this.msgOut = undefined;
    this.msgReasoning = undefined;
    this.estOut = undefined;
    this.msgUsageKnown = false;
    this.liveTpsActive = false;
    this.msgEstimator.reset();
    this.msgRate.reset();
  }

  private observePartialUsage(message: AssistantMessage, _at?: number): void {
    const usage = message.usage;
    if (usage.input > 0) this.msgIn = usage.input;
  }

  private finalizeMessage(message: AssistantMessage, at: number): void {
    this.liveTpsActive = false;
    this.msgDoneMs = this.msgDoneMs || at;

    const usage = message.usage;
    this.msgUsageKnown =
      usage.totalTokens > 0 ||
      usage.input > 0 ||
      usage.output > 0 ||
      usage.cacheRead > 0 ||
      usage.cacheWrite > 0;

    if (this.msgUsageKnown) {
      this.msgIn = usage.input;
      this.msgOut = usage.output;
      const reasoning = this.reasoningUsage(usage);
      if (reasoning !== undefined) {
        this.msgReasoning = Math.min(usage.output, Math.max(0, reasoning));
      }
    }
  }

  private settledMessageTps(): number | undefined {
    const output = this.msgUsageKnown ? this.msgOut : this.estOut;
    if (output === undefined || output <= 0) return undefined;
    const seconds = ((this.msgDoneMs || Date.now()) - this.msgStartMs) / 1_000;
    return seconds > 0 ? output / seconds : undefined;
  }

  private commitTurn(): void {
    const output = this.msgUsageKnown ? this.msgOut : this.estOut;
    const outputEstimated = !this.msgUsageKnown && output !== undefined;

    if (this.msgUsageKnown) this.promptIn += this.msgIn ?? 0;
    if (output !== undefined) this.promptOut += output;
    if (outputEstimated) this.promptOutputEstimated = true;
    if (this.msgReasoning !== undefined) {
      this.promptReasoning += this.msgReasoning;
      this.promptReasoningKnown = true;
    }

    const turnTps = this.settledMessageTps();
    if (turnTps !== undefined) {
      this.lastTurnTps = turnTps;
      this.lastTurnTpsEstimated = outputEstimated;
    }

    this.resetMsg();
  }

  private promptReasoningValue(): number | undefined {
    return this.promptReasoningKnown && this.promptReasoning > 0
      ? this.promptReasoning
      : undefined;
  }

  private reasoningUsage(usage: AssistantMessage["usage"]): number | undefined {
    return (usage as AssistantMessage["usage"] & { reasoning?: number }).reasoning;
  }

  private positiveOrUndefined(value: number): number | undefined {
    return value > 0 ? value : undefined;
  }
}

export const cyberState = new CyberEditorState();
