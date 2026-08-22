/**
 * skill-agents.ts — Skill adapter for the A.9 seam.
 *
 * Turns a core `SkillSetSnapshot` into a `SkillAgentLayer` (discover + mint), and
 * turns the registry's alias decisions into the `skill-agents:rewrite-maps` the
 * fork publishes back to core. Pure discovery/transform functions plus one small
 * per-session stateful controller that tracks snapshot/rewrite revisions and
 * suppresses no-op re-emits.
 */

import { join } from "node:path";
import { loadAgentsFromDirectory } from "./agent-dir-loader.js";
import type { SkillAgentEntry, SkillAgentLayer, SkillAliasDecision } from "./agent-types.js";
import type {
  SkillAgentRewriteEntry,
  SkillAgentRewriteMaps,
  SkillAgentRewriteMapsEvent,
  SkillSetSnapshot,
} from "./skills-contract.js";
import { QUALIFIED_SEPARATOR } from "./types.js";

/**
 * Discover the skill-bundled agents of a snapshot as a registry layer.
 *
 * A skill contributes its `<baseDir>/agents/*.md` iff its resolved visibility is
 * not the `off` state (frozen input 6), read fail-closed. Qualified names are
 * minted from `listingName` (unique per snapshot), NOT `name`: two
 * nested skills may share a bare `name`, and minting from it would let them
 * produce the same qualified type and cross-wire their rewrite maps. The
 * qualified string is fork-owned — core rewrites to it verbatim — so dir-qualified
 * listing names legitimately yield double-colon forms.
 *
 * A missing `agents/` directory is the normal case (no warning); parse failures
 * warn exactly as user agents do (via the shared directory loader).
 */
export function discoverSkillAgents(snapshot: SkillSetSnapshot): SkillAgentLayer {
  const layer: SkillAgentEntry[] = [];
  const qualifiedOwner = new Map<string, string>();
  for (const skill of snapshot.skills) {
    // Fail closed: a visibility block that does not arrive as a boolean `false`
    // is treated as `off`. This gate decides whether third-party agents enter
    // the registry at all, so a malformed or absent payload must suppress them
    // rather than admit them.
    if (skill.visibility?.userInvokeError !== false) continue;
    const agents = loadAgentsFromDirectory(join(skill.baseDir, "agents"), "skill");
    for (const [agentType, config] of agents) {
      const qualified = `${skill.listingName}${QUALIFIED_SEPARATOR}${agentType}`;
      // Defensive: within one snapshot `listingName` is unique (core's
      // `takenListingNames`), so qualified collisions cannot occur — but if one
      // ever did, the first skill by iteration order (canonical id) keeps it.
      const owner = qualifiedOwner.get(qualified);
      if (owner !== undefined && owner !== skill.id) {
        console.warn(
          `[pi-subagents] skill agent "${qualified}" is claimed by multiple skills; keeping the first (${owner}).`,
        );
        continue;
      }
      qualifiedOwner.set(qualified, skill.id);
      layer.push({ skillId: skill.id, qualified, bareName: agentType, config });
    }
  }
  return layer;
}

/**
 * Turn the registry build's alias decisions into rewrite maps. Every bundled
 * agent appears in its skill's map; `collided` is `true` exactly when the bare
 * alias was NOT granted (core then rewrites the bare name to `qualified`).
 */
export function buildRewriteMaps(aliases: readonly SkillAliasDecision[]): SkillAgentRewriteMaps {
  const maps: Record<string, Record<string, SkillAgentRewriteEntry>> = {};
  for (const decision of aliases) {
    let map = maps[decision.skillId];
    if (!map) {
      map = {};
      maps[decision.skillId] = map;
    }
    map[decision.bareName] = { qualified: decision.qualified, collided: !decision.granted };
  }
  return maps;
}

/** Stable JSON with recursively sorted keys, so equal maps serialize identically. */
function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map(k => `${JSON.stringify(k)}:${stableSerialize((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Freeze the maps at the ownership boundary. `publish` hands listeners the same
 * object it retains, and `current` returns it again to answer a query, so a
 * listener mutating it would leave the controller's state disagreeing with the
 * `lastSerialized` fingerprint that decides the next re-emit.
 */
function freezeMaps(maps: SkillAgentRewriteMaps): SkillAgentRewriteMaps {
  for (const map of Object.values(maps)) {
    for (const entry of Object.values(map)) Object.freeze(entry);
    Object.freeze(map);
  }
  return Object.freeze(maps);
}

/**
 * Per-session state for one bound activation's skill adapter: snapshot-revision
 * monotonicity (ignore stale `skills:changed`) plus the rewrite-map revision and
 * change detection (never re-emit an unchanged map, so core sees no revision churn).
 */
export class SkillAgentsController {
  private lastSnapshotRevision = -1;
  private rewriteRevision = 0;
  private lastMaps: SkillAgentRewriteMaps = {};
  /**
   * Seeded with the empty map's fingerprint, not `undefined`: the contract reads
   * absence of the event as the empty map, so that IS the published state before
   * anything happens. Without the seed, the first rebuild in a session with no
   * skill agents at all — every session under upstream pi — would announce an
   * empty map that says nothing.
   */
  private lastSerialized: string | undefined = stableSerialize(this.lastMaps);

  /**
   * Accept a snapshot, returning the recomputed layer — or `undefined` when the
   * snapshot is stale (a lower revision than one already processed) or carries a
   * revision that is not a finite number. The latter is dropped before the
   * watermark records it: `Infinity` would pin it forever and freeze this
   * session's skill agents against every genuine snapshot that follows.
   */
  ingest(snapshot: SkillSetSnapshot): SkillAgentLayer | undefined {
    if (!Number.isFinite(snapshot.revision)) return undefined;
    if (snapshot.revision < this.lastSnapshotRevision) return undefined;
    this.lastSnapshotRevision = snapshot.revision;
    return discoverSkillAgents(snapshot);
  }

  /**
   * Publish rewrite maps derived from the current registry's alias decisions,
   * but only when they changed. Returns the emitted event, or `undefined` when
   * nothing changed (the caller skips the bus emit).
   */
  publish(
    aliases: readonly SkillAliasDecision[],
    emit: (event: SkillAgentRewriteMapsEvent) => void,
  ): SkillAgentRewriteMapsEvent | undefined {
    const maps = freezeMaps(buildRewriteMaps(aliases));
    const serialized = stableSerialize(maps);
    if (serialized === this.lastSerialized) return undefined;
    this.lastSerialized = serialized;
    this.lastMaps = maps;
    this.rewriteRevision += 1;
    const event: SkillAgentRewriteMapsEvent = { revision: this.rewriteRevision, maps };
    emit(event);
    return event;
  }

  /** The current maps and revision, for answering a `skill-agents:query` pull. */
  current(): SkillAgentRewriteMapsEvent {
    return { revision: this.rewriteRevision, maps: this.lastMaps };
  }
}
