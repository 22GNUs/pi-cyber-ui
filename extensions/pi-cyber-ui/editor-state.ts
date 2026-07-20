import type { AssistantMessage } from "@earendil-works/pi-ai";

import { StreamingTokenEstimator, StreamingTokenRate } from "./token-usage.js";

export type AgentState = "idle" | "running" | "thinking";
type LiveUsageMode = "exact" | "estimated";

export interface DisplayValue {
  value?: number;
  estimated: boolean;
}

export interface OutputDisplayValue extends DisplayValue {
  frozen: boolean;
}

export interface TpsDisplayValue extends DisplayValue {
  quiet: boolean;
}

export interface CyberHudSnapshot {
  agentState: AgentState;
  promptActive: boolean;
  promptTurns: number;
  inputValue?: number;
  inputPending: boolean;
  cacheReadValue?: number;
  cacheWriteValue?: number;
  output: OutputDisplayValue;
  tps: TpsDisplayValue;
  toolDepth: number;
}

interface SettledTurn {
  input?: number;
  inputPending: boolean;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  outputEstimated: boolean;
  tps?: number;
  tpsEstimated: boolean;
}

/**
 * Session-scoped token and timing state for the cyber HUD.
 *
 * Running metrics describe the current model call. Settled prompt metrics sum
 * provider usage across turns and use prompt wall-clock time, matching Pi's
 * reference TPS convention. Providers without in-flight usage fall back to a
 * clearly marked visible-stream estimate until terminal usage arrives.
 */
export class CyberEditorState {
  private static readonly STREAM_QUIET_MS = 900;

  private agentState: AgentState = "idle";

  // Prompt-level billed usage, reset once per user-visible prompt run.
  private promptIn = 0;
  private promptOut = 0;
  private promptCacheRead = 0;
  private promptCacheWrite = 0;
  private promptTurns = 0;
  private promptActive = false;
  private promptStartedAt = 0;
  private promptTps: number | undefined;
  private promptOutputEstimated = false;
  private promptInputComplete = true;

  // Current turn/message.
  private turnActive = false;
  private msgActive = false;
  private msgStartMs = 0;
  private firstOutMs = 0;
  private msgDoneMs = 0;
  private msgIn: number | undefined;
  private msgOut: number | undefined;
  private msgCacheRead: number | undefined;
  private msgCacheWrite: number | undefined;
  private estOut: number | undefined;
  private msgUsageKnown = false;
  private liveTpsActive = false;
  private liveUsageMode: LiveUsageMode = "estimated";
  private lastPartialUsageOut = 0;
  private lastPartialUsageAt = 0;
  private msgEstimator = new StreamingTokenEstimator();
  private msgRate = new StreamingTokenRate();
  private lastTurn: SettledTurn | undefined;

  private toolDepth = 0;

  resetAll(): void {
    this.promptIn = 0;
    this.promptOut = 0;
    this.promptCacheRead = 0;
    this.promptCacheWrite = 0;
    this.promptTurns = 0;
    this.promptActive = false;
    this.promptStartedAt = 0;
    this.promptTps = undefined;
    this.promptOutputEstimated = false;
    this.promptInputComplete = true;

    this.turnActive = false;
    this.toolDepth = 0;
    this.lastTurn = undefined;

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

  /** Start one user-visible prompt run. Re-entrant calls during retries are ignored. */
  onPromptStart(at = Date.now()): void {
    if (this.promptActive) return;
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
    this.turnActive = true;
    this.lastTurn = undefined;
    this.agentState = "running";
  }

  onAgentSettled(at = Date.now()): void {
    if (!this.promptActive) return;
    this.promptActive = false;
    this.turnActive = false;
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

  onAssistantDelta(delta: string, partial: AssistantMessage, at = Date.now()): void {
    if (!this.firstOutMs) {
      this.firstOutMs = at;
      this.msgRate.addCumulative(0, at);
    }
    this.liveTpsActive = true;
    this.msgEstimator.add(delta);
    this.estOut = this.msgEstimator.value();

    this.observePartialUsage(partial, at);
    if (this.liveUsageMode === "estimated") {
      this.msgRate.addCumulative(this.estOut, at);
    }
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
    this.turnActive = false;
  }

  snapshot(at = Date.now()): CyberHudSnapshot {
    if (!this.promptActive) return this.promptSnapshot();

    if (this.msgActive) return this.messageSnapshot(at);
    if (this.turnActive) return this.waitingTurnSnapshot();
    if (this.lastTurn) return this.settledTurnSnapshot(this.lastTurn);
    return this.waitingTurnSnapshot();
  }

  private baseSnapshot(): Omit<
    CyberHudSnapshot,
    "inputValue" | "inputPending" | "cacheReadValue" | "cacheWriteValue" | "output" | "tps"
  > {
    return {
      agentState: this.agentState,
      promptActive: this.promptActive,
      promptTurns: this.promptTurns,
      toolDepth: this.toolDepth,
    };
  }

  private waitingTurnSnapshot(): CyberHudSnapshot {
    return {
      ...this.baseSnapshot(),
      inputPending: true,
      output: { estimated: false, frozen: this.toolDepth > 0 },
      tps: { estimated: false, quiet: false },
    };
  }

  private messageSnapshot(at: number): CyberHudSnapshot {
    const exactOutput =
      this.msgUsageKnown || this.liveUsageMode === "exact" ? this.msgOut : undefined;
    const output = exactOutput ?? this.estOut;
    const outputEstimated = exactOutput === undefined && output !== undefined;

    let tps = this.liveTpsActive ? this.msgRate.value() : this.settledMessageTps();
    let quiet = false;
    if (this.liveTpsActive && output !== undefined && output > 0) {
      const lastProgressAt = this.msgRate.lastProgressTimestamp();
      quiet = lastProgressAt > 0 && at - lastProgressAt >= CyberEditorState.STREAM_QUIET_MS;
      if (quiet) tps = undefined;
    }

    return {
      ...this.baseSnapshot(),
      inputValue: this.msgIn,
      inputPending: this.msgIn === undefined,
      cacheReadValue: this.msgCacheRead,
      cacheWriteValue: this.msgCacheWrite,
      output: {
        value: output,
        estimated: outputEstimated,
        frozen: this.toolDepth > 0 || !this.liveTpsActive,
      },
      tps: {
        value: tps,
        estimated: this.liveTpsActive ? this.liveUsageMode === "estimated" : outputEstimated,
        quiet,
      },
    };
  }

  private settledTurnSnapshot(turn: SettledTurn): CyberHudSnapshot {
    return {
      ...this.baseSnapshot(),
      inputValue: turn.input,
      inputPending: turn.inputPending,
      cacheReadValue: turn.cacheRead,
      cacheWriteValue: turn.cacheWrite,
      output: {
        value: turn.output,
        estimated: turn.outputEstimated,
        frozen: true,
      },
      tps: {
        value: turn.tps,
        estimated: turn.tpsEstimated,
        quiet: false,
      },
    };
  }

  private promptSnapshot(): CyberHudSnapshot {
    return {
      ...this.baseSnapshot(),
      inputValue: this.promptInputComplete && this.promptIn > 0 ? this.promptIn : undefined,
      inputPending: false,
      cacheReadValue: this.promptCacheRead > 0 ? this.promptCacheRead : undefined,
      cacheWriteValue: this.promptCacheWrite > 0 ? this.promptCacheWrite : undefined,
      output: {
        value: this.promptOut > 0 ? this.promptOut : undefined,
        estimated: this.promptOutputEstimated,
        frozen: false,
      },
      tps: {
        value: this.promptTps,
        estimated: this.promptOutputEstimated,
        quiet: false,
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
    this.msgCacheRead = undefined;
    this.msgCacheWrite = undefined;
    this.estOut = undefined;
    this.msgUsageKnown = false;
    this.liveTpsActive = false;
    this.liveUsageMode = "estimated";
    this.lastPartialUsageOut = 0;
    this.lastPartialUsageAt = 0;
    this.msgEstimator.reset();
    this.msgRate.reset();
  }

  private observePartialUsage(message: AssistantMessage, at: number): void {
    const usage = message.usage;
    if (usage.input > 0) this.msgIn = usage.input;
    if (usage.cacheRead > 0) this.msgCacheRead = usage.cacheRead;
    if (usage.cacheWrite > 0) this.msgCacheWrite = usage.cacheWrite;

    if (usage.output > this.lastPartialUsageOut) {
      if (this.liveUsageMode === "exact") {
        this.msgRate.addCumulative(usage.output, at);
        this.msgOut = usage.output;
      } else if (this.lastPartialUsageOut > 0) {
        // Require two increasing partial observations before trusting a
        // provider as cumulative-live. A single terminal-like value attached
        // to a late partial event must not freeze the visible estimate.
        this.liveUsageMode = "exact";
        this.msgRate.reset();
        this.msgRate.addCumulative(this.lastPartialUsageOut, this.lastPartialUsageAt);
        this.msgRate.addCumulative(usage.output, at);
        this.msgOut = usage.output;
      }
      this.lastPartialUsageOut = usage.output;
      this.lastPartialUsageAt = at;
    }
  }

  private finalizeMessage(message: AssistantMessage, at: number): void {
    this.liveTpsActive = false;
    this.msgDoneMs = this.msgDoneMs || at;

    const usage = message.usage;
    const hasUsage =
      usage.totalTokens > 0 ||
      usage.input > 0 ||
      usage.output > 0 ||
      usage.cacheRead > 0 ||
      usage.cacheWrite > 0;

    this.msgUsageKnown = hasUsage;
    if (hasUsage) {
      this.msgIn = usage.input;
      this.msgOut = usage.output;
      this.msgCacheRead = usage.cacheRead;
      this.msgCacheWrite = usage.cacheWrite;
      if (usage.output > 0 && this.liveUsageMode === "exact") {
        this.msgRate.addCumulative(usage.output, at);
      }
    }
  }

  private settledMessageTps(): number | undefined {
    const output = this.msgUsageKnown ? this.msgOut : this.estOut;
    if (output === undefined || output <= 0) return undefined;
    const startedAt = this.firstOutMs || this.msgStartMs;
    const endedAt = this.msgDoneMs || Date.now();
    const seconds = (endedAt - startedAt) / 1_000;
    return seconds > 0 ? output / seconds : undefined;
  }

  private commitTurn(): void {
    const output = this.msgUsageKnown ? this.msgOut : this.estOut;
    const outputEstimated = !this.msgUsageKnown && output !== undefined;
    const tps = this.settledMessageTps();

    if (this.msgUsageKnown) {
      this.promptIn += this.msgIn ?? 0;
      this.promptCacheRead += this.msgCacheRead ?? 0;
      this.promptCacheWrite += this.msgCacheWrite ?? 0;
    } else {
      this.promptInputComplete = false;
    }
    if (output !== undefined) this.promptOut += output;
    if (outputEstimated) this.promptOutputEstimated = true;

    this.lastTurn = {
      input: this.msgUsageKnown ? this.msgIn : undefined,
      inputPending: !this.msgUsageKnown,
      cacheRead: this.msgUsageKnown ? this.msgCacheRead : undefined,
      cacheWrite: this.msgUsageKnown ? this.msgCacheWrite : undefined,
      output,
      outputEstimated,
      tps,
      tpsEstimated: outputEstimated,
    };

    this.resetMsg();
  }
}

export const cyberState = new CyberEditorState();
