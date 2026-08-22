/**
 * skill-agents-adapter.ts — the A.9 seam's session-scoped lifecycle (S4).
 *
 * One adapter per bound activation, wired against that activation's own event
 * bus: it consumes core's `skills:changed` / `skills:query` seam and publishes
 * and answers the `skill-agents:*` rewrite-map seam. Root and child sessions run
 * the same code and differ only in what they do with an ingested layer, which is
 * the `applyLayer` callback: the root mutates the process-global registry, a
 * child derives alias decisions from a pure per-branch registry.
 *
 * A child needs its own adapter because it has its own everything — its own
 * `DefaultResourceLoader`, event bus and `SkillRuntime`, the last of which pulls
 * `skill-agents:query` on construction (`agent-runner.ts` builds the loader; pi
 * core's `agent-session.ts` builds the runtime). A root-only subscription leaves
 * that pull unanswered, so a skill loaded inside a subagent never has a collided
 * bare agent name rewritten to its qualified form.
 */

import { randomUUID } from "node:crypto";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { SkillAgentLayer, SkillAliasDecision } from "./agent-types.js";
import { SkillAgentsController } from "./skill-agents.js";
import {
  type RpcReply,
  SKILL_AGENTS_QUERY_CHANNEL,
  SKILL_AGENTS_REWRITE_MAPS_CHANNEL,
  SKILLS_CHANGED_CHANNEL,
  SKILLS_QUERY_CHANNEL,
  type SkillAgentRewriteMapsEvent,
  type SkillSetSnapshot,
  skillAgentsQueryReplyChannel,
  skillsQueryReplyChannel,
} from "./skills-contract.js";

/** How long to wait for a `skills:query` reply before giving up on the pull. */
const QUERY_TIMEOUT_MS = 2000;

/**
 * Structural check for a snapshot off the bus. Under upstream pi nothing emits
 * on these channels at all, so this only has to reject malformed payloads from a
 * seam-bearing core, and it must do so without a warning: silent inertness is
 * the documented degradation.
 */
export function isSkillSetSnapshot(data: unknown): data is SkillSetSnapshot {
  if (typeof data !== "object" || data === null) return false;
  const snap = data as Partial<SkillSetSnapshot>;
  return typeof snap.revision === "number" && Array.isArray(snap.skills) && Array.isArray(snap.removed);
}

export class SkillAgentsAdapter {
  private readonly controller = new SkillAgentsController();
  private readonly unsubs: Array<() => void> = [];
  private wired = false;

  /**
   * @param bus this activation's event bus — never another session's.
   * @param applyLayer installs an ingested layer and returns the alias decisions
   *   to publish for it. Runs only for a non-stale snapshot.
   */
  constructor(
    private readonly bus: EventBus,
    private readonly applyLayer: (layer: SkillAgentLayer) => readonly SkillAliasDecision[],
  ) {}

  /** Subscribe to the seam and issue the initial pull. Idempotent (#142). */
  wire(): void {
    if (this.wired) return;
    this.wired = true;
    this.unsubs.push(
      this.bus.on(SKILLS_CHANGED_CHANNEL, (data: unknown) => {
        if (isSkillSetSnapshot(data)) this.ingest(data);
      }),
    );
    // Answer rewrite-map pulls (core's SkillRuntime pulls on construction).
    this.unsubs.push(
      this.bus.on(SKILL_AGENTS_QUERY_CHANNEL, (data: unknown) => {
        const requestId = (data as { requestId?: unknown })?.requestId;
        if (typeof requestId !== "string" || requestId.length === 0) return;
        const reply: RpcReply<SkillAgentRewriteMapsEvent> = { success: true, data: this.controller.current() };
        this.bus.emit(skillAgentsQueryReplyChannel(requestId), reply);
      }),
    );
    this.query();
  }

  /** Drop every subscription. No terminal re-publish: a fresh activation re-pulls. */
  unwire(): void {
    for (const unsub of this.unsubs.splice(0)) unsub();
    this.wired = false;
  }

  /** Publish these alias decisions, unless they serialize to the last published maps. */
  publish(aliases: readonly SkillAliasDecision[]): void {
    this.controller.publish(aliases, (event) => this.bus.emit(SKILL_AGENTS_REWRITE_MAPS_CHANNEL, event));
  }

  private ingest(snapshot: SkillSetSnapshot): void {
    const layer = this.controller.ingest(snapshot);
    if (!layer) return; // stale or malformed revision — ignore
    this.publish(this.applyLayer(layer));
  }

  /**
   * One-shot pull so an activation that binds after core's initial publication
   * still gets the snapshot. Core re-emits on changes, so a lost pull self-heals,
   * and under upstream pi the request is simply never answered.
   */
  private query(): void {
    const requestId = randomUUID();
    const replyChannel = skillsQueryReplyChannel(requestId);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = this.bus.on(replyChannel, (data: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsub();
      if (data && typeof data === "object" && (data as { success?: unknown }).success === true) {
        const snap = (data as { data?: unknown }).data;
        if (isSkillSetSnapshot(snap)) this.ingest(snap);
      }
    });
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsub();
    }, QUERY_TIMEOUT_MS);
    timer.unref?.();
    this.bus.emit(SKILLS_QUERY_CHANNEL, { requestId });
  }
}
