/**
 * Tool registry
 *
 * Tracks tool execution lifecycle (start / end), per-call timing, current
 * running tool, and a per-prompt tally consumed by the cyber HUD and the
 * working indicator.
 *
 * Used by:
 * - tool-render.ts (per-row duration + spinner refresh)
 * - editor-state.ts (HUD tally snapshot)
 * - working.ts (footer "working" message)
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

export interface ToolTally {
  running: number;
  ok: number;
  err: number;
  total: number;
  /** Most recent running tool, if any. */
  currentName?: string;
  currentToolCallId?: string;
  currentElapsedMs?: number;
  /** Whether any tool ran in the current turn (running or completed). */
  active: boolean;
}

const TICK_INTERVAL_MS = 250;

class ToolRegistry {
  private entries = new Map<string, ToolEntry>();
  /** Insertion order of entries since registry started. */
  private order: string[] = [];
  /** Index in `order` where the current turn begins; entries before it are excluded from tally. */
  private turnFloor = 0;
  private listeners = new Set<() => void>();
  private tickInterval?: NodeJS.Timeout;

  start(toolCallId: string, toolName: string): void {
    if (this.entries.has(toolCallId)) return;
    const entry: ToolEntry = {
      toolCallId,
      toolName,
      startedAt: Date.now(),
    };
    this.entries.set(toolCallId, entry);
    this.order.push(toolCallId);
    this.ensureTicker();
    this.notify();
  }

  end(toolCallId: string, isError: boolean): void {
    const entry = this.entries.get(toolCallId);
    if (!entry) return;
    if (entry.endedAt !== undefined) return;
    entry.endedAt = Date.now();
    entry.isError = isError;
    if (this.runningCount() === 0) this.stopTicker();
    this.notify();
  }

  /** Mark a new turn boundary — old entries kept for per-row duration but excluded from tally. */
  beginTurn(): void {
    this.turnFloor = this.order.length;
    this.notify();
  }

  resetAll(): void {
    this.entries.clear();
    this.order = [];
    this.turnFloor = 0;
    this.stopTicker();
    this.notify();
  }

  setInvalidate(toolCallId: string, invalidate: () => void): void {
    const entry = this.entries.get(toolCallId);
    if (entry) entry.invalidate = invalidate;
  }

  getEntry(toolCallId: string): ToolEntry | undefined {
    return this.entries.get(toolCallId);
  }

  getDuration(toolCallId: string): number | undefined {
    const e = this.entries.get(toolCallId);
    if (!e) return undefined;
    const end = e.endedAt ?? Date.now();
    return Math.max(0, end - e.startedAt);
  }

  isRunning(toolCallId: string): boolean {
    const e = this.entries.get(toolCallId);
    return !!e && e.endedAt === undefined;
  }

  getTally(): ToolTally {
    let running = 0;
    let ok = 0;
    let err = 0;
    let currentName: string | undefined;
    let currentToolCallId: string | undefined;
    let currentElapsedMs: number | undefined;
    const now = Date.now();
    let total = 0;

    for (let i = this.turnFloor; i < this.order.length; i++) {
      const id = this.order[i]!;
      const e = this.entries.get(id);
      if (!e) continue;
      total += 1;
      if (e.endedAt === undefined) {
        running += 1;
        // Most recent running tool wins.
        currentName = e.toolName;
        currentToolCallId = id;
        currentElapsedMs = now - e.startedAt;
      } else if (e.isError) {
        err += 1;
      } else {
        ok += 1;
      }
    }

    return {
      running,
      ok,
      err,
      total,
      currentName,
      currentToolCallId,
      currentElapsedMs,
      active: total > 0,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Listener errors must not break the registry.
      }
    }
  }

  private runningCount(): number {
    let n = 0;
    for (const e of this.entries.values()) {
      if (e.endedAt === undefined) n += 1;
    }
    return n;
  }

  private ensureTicker(): void {
    if (this.tickInterval) return;
    this.tickInterval = setInterval(() => {
      let any = false;
      for (const e of this.entries.values()) {
        if (e.endedAt === undefined) {
          any = true;
          e.invalidate?.();
        }
      }
      if (any) this.notify();
      else this.stopTicker();
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

  // New prompt → fresh tally floor; keep history for per-row durations.
  pi.on("agent_start", async () => {
    toolRegistry.beginTurn();
  });

  // New session → drop everything.
  pi.on("session_start", async () => {
    toolRegistry.resetAll();
  });

  pi.on("session_shutdown", async () => {
    toolRegistry.resetAll();
  });
}
