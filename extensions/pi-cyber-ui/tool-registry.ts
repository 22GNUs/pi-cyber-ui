/**
 * Tool registry
 *
 * Tracks tool execution lifecycle (start / end), per-call timing, and
 * per-row invalidation for compact tool rendering.
 *
 * Used by:
 * - tool-render.ts (per-row duration refresh)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ToolEntry {
  toolCallId: string;
  toolName: string;
  startedAt: number;
  endedAt?: number;
  isError?: boolean;
  /** Per-row invalidate callback registered by tool-render. */
  invalidate?: () => void;
}

const TICK_INTERVAL_MS = 120;

class ToolRegistry {
  private entries = new Map<string, ToolEntry>();
  /** Invalidate callbacks that rendered before tool_execution_start reached this extension. */
  private pendingInvalidates = new Map<string, () => void>();
  /** Running tool IDs only; keeps duration ticks O(running) instead of O(history). */
  private runningIds = new Set<string>();
  private tickInterval?: NodeJS.Timeout;

  start(toolCallId: string, toolName: string): void {
    if (this.entries.has(toolCallId)) return;
    const entry: ToolEntry = {
      toolCallId,
      toolName,
      startedAt: Date.now(),
      invalidate: this.pendingInvalidates.get(toolCallId),
    };
    this.pendingInvalidates.delete(toolCallId);
    this.entries.set(toolCallId, entry);
    this.runningIds.add(toolCallId);
    this.ensureTicker();
  }

  end(toolCallId: string, isError: boolean): void {
    const entry = this.entries.get(toolCallId);
    if (!entry) return;
    if (entry.endedAt !== undefined) return;
    entry.endedAt = Date.now();
    entry.isError = isError;
    entry.invalidate = undefined;
    this.runningIds.delete(toolCallId);
    if (this.runningIds.size === 0) this.stopTicker();
  }

  resetAll(): void {
    this.entries.clear();
    this.pendingInvalidates.clear();
    this.runningIds.clear();
    this.stopTicker();
  }

  setInvalidate(toolCallId: string, invalidate: () => void): void {
    const entry = this.entries.get(toolCallId);
    if (entry && entry.endedAt === undefined) {
      entry.invalidate = invalidate;
      return;
    }
    if (!entry) this.pendingInvalidates.set(toolCallId, invalidate);
  }

  getEntry(toolCallId: string): ToolEntry | undefined {
    return this.entries.get(toolCallId);
  }

  isRunning(toolCallId: string): boolean {
    const e = this.entries.get(toolCallId);
    return !!e && e.endedAt === undefined;
  }

  private ensureTicker(): void {
    if (this.tickInterval) return;
    this.tickInterval = setInterval(() => {
      if (this.runningIds.size === 0) {
        this.stopTicker();
        return;
      }
      for (const id of this.runningIds) {
        this.entries.get(id)?.invalidate?.();
      }
    }, TICK_INTERVAL_MS);
    // Don't keep the event loop alive just for ticking.
    if (typeof this.tickInterval.unref === "function") {
      this.tickInterval.unref();
    }
  }

  private stopTicker(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = undefined;
    }
  }
}

export const toolRegistry = new ToolRegistry();

/**
 * Wire pi events into the registry. Idempotent across reloads — callers should
 * register only once per extension instance.
 */
export function wireToolRegistry(pi: ExtensionAPI): void {
  pi.on("tool_execution_start", async (event) => {
    toolRegistry.start(event.toolCallId, event.toolName);
  });

  pi.on("tool_execution_end", async (event) => {
    toolRegistry.end(event.toolCallId, event.isError);
  });

  // New session → drop everything.
  pi.on("session_start", async () => {
    toolRegistry.resetAll();
  });

  pi.on("session_shutdown", async () => {
    toolRegistry.resetAll();
  });
}
