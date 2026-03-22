import type { AssistantMessage } from "@mariozechner/pi-ai";

import { getUsageMode, type UsageMode, StreamingTokenEstimator } from "./token-usage.js";

export type AgentState = "idle" | "running" | "thinking";
export type ResetNoticeKind = "compact" | "tree";

export interface ResetNotice {
  kind: ResetNoticeKind;
  startedAt: number;
}

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
  toolDepth: number;
  resetNotice?: ResetNotice;
}

/**
 * Centralized session state for the cyber editor HUD.
 *
 * Keeps token accounting, pause windows, and request lifecycle logic out of the
 * editor wiring so the rendering layer stays mostly pure.
 */
export class CyberEditorState {
  private agentState: AgentState = "idle";

  // prompt-level accumulators (reset on agent_start)
  private promptIn = 0;
  private promptOut = 0;
  private promptTurns = 0;
  private promptActive = false;

  // current assistant message
  private msgActive = false;
  private msgStartMs = 0;
  private msgIn: number | undefined;
  private msgOut: number | undefined;
  private estOut: number | undefined;
  private msgHasAccurateOut = false;
  private msgUsageMode: UsageMode = "estimated";
  private msgEstimator = new StreamingTokenEstimator();

  // timing
  private firstOutMs = 0;
  private pausedAt = 0;
  private pausedTotal = 0;
  private toolDepth = 0;

  // display cache
  private tps: number | undefined;
  private estTps: number | undefined;
  private snapOut: number | undefined;
  private snapOutEst = false;
  private snapTps: number | undefined;
  private snapTpsEst = false;

  private resetNotice: ResetNotice | undefined;

  getAgentState(): AgentState {
    return this.agentState;
  }

  getResetNotice(): ResetNotice | undefined {
    return this.resetNotice;
  }

  resetAll(): void {
    this.promptIn = 0;
    this.promptOut = 0;
    this.promptTurns = 0;
    this.promptActive = false;

    this.firstOutMs = 0;
    this.pausedAt = 0;
    this.pausedTotal = 0;
    this.toolDepth = 0;

    this.tps = undefined;
    this.estTps = undefined;
    this.snapOut = undefined;
    this.snapTps = undefined;
    this.snapOutEst = false;
    this.snapTpsEst = false;
    this.resetNotice = undefined;

    this.resetMsg();
    this.agentState = "idle";
  }

  setResetNotice(kind: ResetNoticeKind): void {
    this.resetNotice = { kind, startedAt: Date.now() };
  }

  onSessionStart(): void {
    this.resetAll();
    this.promptActive = true;
    this.agentState = "running";
  }

  onSessionSwitch(): void {
    this.resetAll();
    this.promptActive = true;
    this.agentState = "running";
  }

  onSessionCompact(): void {
    this.resetAll();
    this.setResetNotice("compact");
  }

  onSessionTree(): void {
    this.resetAll();
    this.setResetNotice("tree");
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

  onAgentEnd(): void {
    this.resumeClock();
    this.promptActive = false;
    this.agentState = "idle";
    this.refreshTps();
    this.refreshEstTps();
  }

  onToolCall(): void {
    this.toolDepth += 1;
    if (this.firstOutMs && !this.pausedAt) this.pausedAt = Date.now();
    this.agentState = "thinking";
  }

  onToolResult(): void {
    this.toolDepth = Math.max(0, this.toolDepth - 1);
    if (this.toolDepth === 0) {
      this.resumeClock();
      this.refreshTps();
      this.refreshEstTps();
      this.agentState = "running";
    }
  }

  onAssistantStart(message: AssistantMessage): void {
    if (message.role !== "assistant") return;
    this.resetMsg();
    this.msgActive = true;
    this.msgStartMs = Date.now();
    this.msgUsageMode = getUsageMode(message.api);
    this.syncMessage(message);
  }

  onAssistantDelta(delta: string, partial: AssistantMessage): void {
    if (!this.firstOutMs) this.firstOutMs = Date.now();
    this.msgEstimator.add(delta);
    this.estOut = this.msgEstimator.value();
    this.syncMessage(partial);
    this.refreshEstTps();
  }

  onAssistantPartial(partial: AssistantMessage): void {
    this.syncMessage(partial);
  }

  onAssistantDone(message: AssistantMessage): void {
    if (!this.firstOutMs && message.usage.output > 0) {
      this.firstOutMs = this.msgStartMs || Date.now();
    }
    this.syncMessage(message, true);
    this.refreshTps();
  }

  onAssistantError(message: AssistantMessage): void {
    if (!this.firstOutMs && message.usage.output > 0) {
      this.firstOutMs = this.msgStartMs || Date.now();
    }
    this.syncMessage(message, true);
    this.refreshTps();
  }

  onAssistantTurnEnd(message: AssistantMessage): void {
    if (message.role !== "assistant") return;
    this.resumeClock();
    if (!this.firstOutMs && message.usage.output > 0) {
      this.firstOutMs = this.msgStartMs || Date.now();
    }
    this.syncMessage(message, true);
    this.commit();
    this.refreshTps();
  }

  snapshot(): CyberHudSnapshot {
    const exactIn = this.exactIn();
    const exactOut = this.exactOut();
    const displayOut = exactOut ?? this.estDisplayOut() ?? this.snapOut;
    const outputEstimated = exactOut === undefined && (this.estDisplayOut() !== undefined || this.snapOutEst);
    const displayTps = this.tps ?? this.estTps ?? this.snapTps;
    const tpsEstimated = this.tps === undefined && (this.estTps !== undefined || this.snapTpsEst);

    return {
      agentState: this.agentState,
      promptActive: this.promptActive,
      promptTurns: this.promptTurns,
      promptIn: this.promptIn,
      inputValue: exactIn,
      output: {
        value: displayOut,
        estimated: outputEstimated,
        frozen: this.toolDepth > 0,
      },
      tps: {
        value: displayTps,
        estimated: tpsEstimated,
      },
      toolDepth: this.toolDepth,
      resetNotice: this.resetNotice,
    };
  }

  private resetMsg(): void {
    this.msgActive = false;
    this.msgStartMs = 0;
    this.msgIn = undefined;
    this.msgOut = undefined;
    this.estOut = undefined;
    this.msgHasAccurateOut = false;
    this.msgUsageMode = "estimated";
    this.msgEstimator.reset();
  }

  private elapsed(): number {
    if (!this.firstOutMs) return 0;
    const activePause = this.pausedAt ? Date.now() - this.pausedAt : 0;
    return Math.max(0, Date.now() - this.firstOutMs - this.pausedTotal - activePause);
  }

  private resumeClock(): void {
    if (!this.pausedAt) return;
    this.pausedTotal += Date.now() - this.pausedAt;
    this.pausedAt = 0;
  }

  private exactOut(): number | undefined {
    if (this.msgActive) {
      if (!this.msgHasAccurateOut || this.msgOut === undefined) return undefined;
      return this.promptOut + this.msgOut;
    }
    return this.promptOut > 0 ? this.promptOut : undefined;
  }

  private estDisplayOut(): number | undefined {
    if (!this.msgActive || this.estOut === undefined) return undefined;
    return this.promptOut + this.estOut;
  }

  private exactIn(): number | undefined {
    if (this.msgActive) {
      if (this.msgIn === undefined) return this.promptIn > 0 ? this.promptIn : undefined;
      return this.promptIn + this.msgIn;
    }
    return this.promptIn > 0 ? this.promptIn : undefined;
  }

  private refreshTps(): void {
    const out = this.exactOut();
    if (out !== undefined && out > 0) {
      this.snapOut = out;
      this.snapOutEst = false;
    }
    if (out === undefined || out <= 0 || !this.firstOutMs) return;

    const seconds = this.elapsed() / 1000;
    if (seconds > 0) {
      this.tps = out / seconds;
      this.snapTps = this.tps;
      this.snapTpsEst = false;
    }
  }

  private refreshEstTps(): void {
    const out = this.estDisplayOut();
    if (out === undefined || out <= 0 || !this.firstOutMs) return;

    if (this.snapOut === undefined) {
      this.snapOut = out;
      this.snapOutEst = true;
    }

    const seconds = this.elapsed() / 1000;
    if (seconds > 0) {
      this.estTps = out / seconds;
      if (this.snapTps === undefined) {
        this.snapTps = this.estTps;
        this.snapTpsEst = true;
      }
    }
  }

  private syncMessage(message: AssistantMessage, final = false): void {
    const usage = message.usage;
    if (final || usage.input > 0) this.msgIn = usage.input;
    if (final || usage.output > 0 || this.msgOut !== undefined) {
      this.msgOut = usage.output;
      if (final || (this.msgUsageMode === "exact" && usage.output > 0)) {
        this.msgHasAccurateOut = true;
      }
      this.refreshTps();
    }
  }

  private commit(): void {
    this.promptIn += this.msgIn ?? 0;
    this.promptOut += this.msgOut ?? 0;
    this.estTps = undefined;
    this.resetMsg();
    this.refreshTps();
  }
}
