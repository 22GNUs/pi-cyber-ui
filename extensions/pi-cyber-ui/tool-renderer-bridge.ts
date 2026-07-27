import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { importRunningPiModule } from "./runtime-pi.js";

type RenderCall = NonNullable<ToolDefinition["renderCall"]>;
type RenderResult = NonNullable<ToolDefinition["renderResult"]>;
type RenderShell = "default" | "self";
type BridgeDisposer = () => boolean;

interface ToolExecutionInstance {
  toolName?: unknown;
}

type GetCallRenderer = (this: ToolExecutionInstance) => RenderCall | undefined;
type GetResultRenderer = (this: ToolExecutionInstance) => RenderResult | undefined;
type GetRenderShell = (this: ToolExecutionInstance) => RenderShell;

interface ToolExecutionPrototype {
  getCallRenderer?: GetCallRenderer;
  getResultRenderer?: GetResultRenderer;
  getRenderShell?: GetRenderShell;
}

interface ToolExecutionConstructor {
  prototype: ToolExecutionPrototype;
}

interface MethodDescriptor<T extends (...args: never[]) => unknown> extends PropertyDescriptor {
  value: T;
}

interface BridgeState {
  references: number;
  prototype: ToolExecutionPrototype;
  originalCall: MethodDescriptor<GetCallRenderer>;
  originalResult: MethodDescriptor<GetResultRenderer>;
  originalShell: MethodDescriptor<GetRenderShell>;
  patchedCall: GetCallRenderer;
  patchedResult: GetResultRenderer;
  patchedShell: GetRenderShell;
}

export interface ToolRendererBridgeDecorators {
  wrapCall(toolName: string, renderer: RenderCall | undefined): RenderCall;
  wrapResult(toolName: string, renderer: RenderResult | undefined): RenderResult;
}

export interface ToolRendererBridgeDependencies {
  loadToolExecutionComponent(): Promise<ToolExecutionConstructor | undefined>;
}

const TOOL_EXECUTION_MODULE = "dist/modes/interactive/components/tool-execution.js";
const BRIDGE_REGISTRY = Symbol.for("pi-cyber-ui.tool-renderer-bridge.registry");

const DEFAULT_DEPENDENCIES: ToolRendererBridgeDependencies = {
  async loadToolExecutionComponent() {
    const mod = await importRunningPiModule(TOOL_EXECUTION_MODULE);
    const constructor = mod?.ToolExecutionComponent;
    if (typeof constructor !== "function") return undefined;
    return constructor as unknown as ToolExecutionConstructor;
  },
};

function getBridgeRegistry(): WeakMap<ToolExecutionPrototype, BridgeState> {
  const host = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = host[BRIDGE_REGISTRY];
  if (existing instanceof WeakMap) {
    return existing as WeakMap<ToolExecutionPrototype, BridgeState>;
  }
  const registry = new WeakMap<ToolExecutionPrototype, BridgeState>();
  Object.defineProperty(host, BRIDGE_REGISTRY, { value: registry });
  return registry;
}

function getToolName(instance: ToolExecutionInstance): string {
  return typeof instance.toolName === "string" && instance.toolName.length > 0
    ? instance.toolName
    : "tool";
}

function getPatchableMethod<T extends (...args: never[]) => unknown>(
  prototype: ToolExecutionPrototype,
  name: keyof ToolExecutionPrototype,
): MethodDescriptor<T> | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
  if (
    !descriptor ||
    typeof descriptor.value !== "function" ||
    (descriptor.writable !== true && descriptor.configurable !== true)
  ) {
    return undefined;
  }
  return descriptor as MethodDescriptor<T>;
}

function bridgeMethodsMatch(state: BridgeState): boolean {
  const { prototype } = state;
  return (
    prototype.getCallRenderer === state.patchedCall &&
    prototype.getResultRenderer === state.patchedResult &&
    prototype.getRenderShell === state.patchedShell
  );
}

function restoreBridgeMethods(state: BridgeState): boolean {
  try {
    Object.defineProperties(state.prototype, {
      getCallRenderer: state.originalCall,
      getResultRenderer: state.originalResult,
      getRenderShell: state.originalShell,
    });
    return true;
  } catch {
    return false;
  }
}

function createDisposer(
  registry: WeakMap<ToolExecutionPrototype, BridgeState>,
  state: BridgeState,
): BridgeDisposer {
  let disposeResult: boolean | undefined;
  return () => {
    if (disposeResult !== undefined) return disposeResult;

    state.references = Math.max(0, state.references - 1);
    if (state.references > 0) {
      disposeResult = true;
      return disposeResult;
    }
    // Another middleware replaced one of our methods. Do not clobber it; keep
    // the state as a conflict marker so a later install fails safe instead of
    // stacking a second gutter around stale closures.
    if (!bridgeMethodsMatch(state)) {
      disposeResult = false;
      return disposeResult;
    }
    if (!restoreBridgeMethods(state)) {
      disposeResult = false;
      return disposeResult;
    }
    registry.delete(state.prototype);
    disposeResult = true;
    return disposeResult;
  };
}

export async function installToolRendererBridge(
  decorators: ToolRendererBridgeDecorators,
  dependencies: ToolRendererBridgeDependencies = DEFAULT_DEPENDENCIES,
): Promise<BridgeDisposer | undefined> {
  const constructor = await dependencies.loadToolExecutionComponent();
  const prototype = constructor?.prototype;
  if (!prototype) return undefined;

  const registry = getBridgeRegistry();
  const existing = registry.get(prototype);
  if (existing) {
    if (!bridgeMethodsMatch(existing)) return undefined;
    if (existing.references === 0) {
      if (!restoreBridgeMethods(existing)) return undefined;
      registry.delete(prototype);
    } else {
      existing.references += 1;
      return createDisposer(registry, existing);
    }
  }

  const originalCall = getPatchableMethod<GetCallRenderer>(prototype, "getCallRenderer");
  const originalResult = getPatchableMethod<GetResultRenderer>(prototype, "getResultRenderer");
  const originalShell = getPatchableMethod<GetRenderShell>(prototype, "getRenderShell");
  if (!originalCall || !originalResult || !originalShell) return undefined;

  const callCache = new WeakMap<RenderCall, Map<string, RenderCall>>();
  const resultCache = new WeakMap<RenderResult, Map<string, RenderResult>>();
  const fallbackCalls = new Map<string, RenderCall>();
  const fallbackResults = new Map<string, RenderResult>();

  const wrapCall = (toolName: string, renderer: RenderCall | undefined): RenderCall => {
    if (!renderer) {
      const cached = fallbackCalls.get(toolName);
      if (cached) return cached;
      const wrapped = decorators.wrapCall(toolName, undefined);
      fallbackCalls.set(toolName, wrapped);
      return wrapped;
    }
    let byName = callCache.get(renderer);
    if (!byName) {
      byName = new Map();
      callCache.set(renderer, byName);
    }
    const cached = byName.get(toolName);
    if (cached) return cached;
    const wrapped = decorators.wrapCall(toolName, renderer);
    byName.set(toolName, wrapped);
    return wrapped;
  };

  const wrapResult = (toolName: string, renderer: RenderResult | undefined): RenderResult => {
    if (!renderer) {
      const cached = fallbackResults.get(toolName);
      if (cached) return cached;
      const wrapped = decorators.wrapResult(toolName, undefined);
      fallbackResults.set(toolName, wrapped);
      return wrapped;
    }
    let byName = resultCache.get(renderer);
    if (!byName) {
      byName = new Map();
      resultCache.set(renderer, byName);
    }
    const cached = byName.get(toolName);
    if (cached) return cached;
    const wrapped = decorators.wrapResult(toolName, renderer);
    byName.set(toolName, wrapped);
    return wrapped;
  };

  const patchedCall: GetCallRenderer = function () {
    return wrapCall(getToolName(this), originalCall.value.call(this));
  };
  const patchedResult: GetResultRenderer = function () {
    return wrapResult(getToolName(this), originalResult.value.call(this));
  };
  const patchedShell: GetRenderShell = function () {
    return "self";
  };

  const state: BridgeState = {
    references: 1,
    prototype,
    originalCall,
    originalResult,
    originalShell,
    patchedCall,
    patchedResult,
    patchedShell,
  };

  try {
    Object.defineProperties(prototype, {
      getCallRenderer: { ...originalCall, value: patchedCall },
      getResultRenderer: { ...originalResult, value: patchedResult },
      getRenderShell: { ...originalShell, value: patchedShell },
    });
  } catch {
    restoreBridgeMethods(state);
    return undefined;
  }

  registry.set(prototype, state);
  return createDisposer(registry, state);
}
