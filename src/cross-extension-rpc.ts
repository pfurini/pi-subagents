/**
 * Cross-extension RPC handlers for the subagents extension.
 *
 * Exposes ping, spawn, and stop RPCs over the pi.events event bus,
 * using per-request scoped reply channels.
 *
 * Reply envelope follows pi-mono convention:
 *   success → { success: true, data?: T }
 *   error   → { success: false, error: string }
 */

import { type ModelRegistry, resolveModel } from "./model-resolver.js";

/** Minimal event bus interface needed by the RPC handlers. */
export interface EventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

/** RPC reply envelope — matches pi-mono's RpcResponse shape. */
export type RpcReply<T = void> =
  | { success: true; data?: T }
  | { success: false; error: string };

/**
 * RPC protocol version — bumped when the envelope or method contracts change.
 * v3 advertises `capabilities.skillAgents` on ping, emits `subagents:agent-ended`
 * for every terminal transition, and answers the skill-agents rewrite-map seam.
 */
export const PROTOCOL_VERSION = 3;

/** Broadcast channel carrying a terminal event for one agent (v3). */
export const AGENT_ENDED_CHANNEL = "subagents:agent-ended";

/**
 * Ordering gate for `subagents:agent-ended`. The A.9 contract requires an agent's
 * terminal event to be emitted only AFTER its spawn reply. `handleRpc` awaits the
 * spawn handler before emitting the reply, so an immediately-failing run's
 * completion can be queued as a microtask ahead of the reply — this gate buffers
 * such an event until the spawn reply flushes it. Agent-tool spawns have no RPC
 * reply to wait for (never marked pending), so their terminal event emits at once.
 */
export interface AgentEndedGate {
  /** Emit (or buffer, when the agent's spawn reply is still pending) a terminal event. */
  emit(agentId: string, payload: Record<string, unknown>): void;
  /** Mark an RPC-spawned agent's reply as pending (called synchronously at spawn). */
  markSpawnPending(agentId: string): void;
  /** Flush any buffered terminal event once the agent's spawn reply has been emitted. */
  flushSpawnReply(agentId: string): void;
}

export function createAgentEndedGate(
  rawEmit: (payload: Record<string, unknown>) => void,
): AgentEndedGate {
  const pendingReply = new Set<string>();
  const buffered = new Map<string, Record<string, unknown>>();
  return {
    emit(agentId, payload) {
      if (pendingReply.has(agentId)) {
        buffered.set(agentId, payload);
        return;
      }
      rawEmit(payload);
    },
    markSpawnPending(agentId) {
      pendingReply.add(agentId);
    },
    flushSpawnReply(agentId) {
      if (!pendingReply.delete(agentId)) return;
      const payload = buffered.get(agentId);
      if (payload) {
        buffered.delete(agentId);
        rawEmit(payload);
      }
    },
  };
}

/** Minimal AgentManager interface needed by the spawn/stop RPCs. */
export interface SpawnCapable {
  spawn(pi: unknown, ctx: unknown, type: string, prompt: string, options: any): string;
  abort(id: string): boolean;
}

export interface RpcDeps {
  events: EventBus;
  pi: unknown;                    // passed through to manager.spawn
  getCtx: () => unknown | undefined;  // returns current ExtensionContext
  manager: SpawnCapable;
  /** Ordering gate so an RPC-spawned agent's `agent-ended` waits for its spawn reply. */
  agentEnded?: Pick<AgentEndedGate, "markSpawnPending" | "flushSpawnReply">;
}

export interface RpcHandle {
  unsubPing: () => void;
  unsubSpawn: () => void;
  unsubStop: () => void;
}

/**
 * Wire a single RPC handler: listen on `channel`, run `fn(params)`,
 * emit the reply envelope on `channel:reply:${requestId}`.
 */
function handleRpc<P extends { requestId: string }>(
  events: EventBus,
  channel: string,
  fn: (params: P) => unknown | Promise<unknown>,
  onReplied?: (params: P, data: unknown) => void,
): () => void {
  return events.on(channel, async (raw: unknown) => {
    const params = raw as P;
    try {
      const data = await fn(params);
      const reply: { success: true; data?: unknown } = { success: true };
      if (data !== undefined) reply.data = data;
      events.emit(`${channel}:reply:${params.requestId}`, reply);
      onReplied?.(params, data);
    } catch (err: any) {
      events.emit(`${channel}:reply:${params.requestId}`, {
        success: false, error: err?.message ?? String(err),
      });
    }
  });
}

/**
 * Register ping, spawn, and stop RPC handlers on the event bus.
 * Returns unsub functions for cleanup.
 */
export function registerRpcHandlers(deps: RpcDeps): RpcHandle {
  const { events, pi, getCtx, manager, agentEnded } = deps;

  const unsubPing = handleRpc(events, "subagents:rpc:ping", () => {
    return { version: PROTOCOL_VERSION, capabilities: { skillAgents: true } };
  });

  const unsubSpawn = handleRpc<{ requestId: string; type: string; prompt: string; options?: any }>(
    events, "subagents:rpc:spawn", ({ type, prompt, options }) => {
      const ctx = getCtx();
      if (!ctx) throw new Error("No active session");

      // Cross-extension RPC callers (e.g. pi-tasks TaskExecute) naturally
      // forward serializable values, so options.model can be a string like
      // "openai-codex/gpt-5.5". Resolve it to a real Model instance here
      // — same pattern the scheduler path already uses — so the spawned
      // agent's auth lookup doesn't crash with "No API key found for
      // undefined".
      let normalizedOptions = options ?? {};
      if (typeof normalizedOptions.model === "string") {
        const registry = (ctx as { modelRegistry?: ModelRegistry }).modelRegistry;
        if (!registry) {
          throw new Error(
            `Model override "${normalizedOptions.model}" provided but ctx.modelRegistry is unavailable`,
          );
        }
        const resolved = resolveModel(normalizedOptions.model, registry);
        if (typeof resolved === "string") {
          // resolveModel returns a human-readable error string when the
          // input doesn't match any available model. Surface it instead of
          // silently falling back so the caller sees the auth/typo issue.
          throw new Error(resolved);
        }
        normalizedOptions = { ...normalizedOptions, model: resolved };
      }

      const id = manager.spawn(pi, ctx, type, prompt, normalizedOptions);
      // Mark synchronously (before handleRpc's await yields) so an
      // immediately-failing run's `agent-ended` buffers until the reply.
      agentEnded?.markSpawnPending(id);
      return { id };
    },
    (_params, data) => {
      const id = (data as { id?: string } | undefined)?.id;
      if (id) agentEnded?.flushSpawnReply(id);
    },
  );

  const unsubStop = handleRpc<{ requestId: string; agentId: string }>(
    events, "subagents:rpc:stop", ({ agentId }) => {
      if (!manager.abort(agentId)) throw new Error("Agent not found");
    },
  );

  return { unsubPing, unsubSpawn, unsubStop };
}
