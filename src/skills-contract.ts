/**
 * skills-contract.ts — CROSS-REPO COPY SET.
 *
 * The wire declarations below are copied byte-for-byte (modulo this repo's
 * formatting) from pi core at commit 556c29426:
 *   - the skill-set seam from `packages/coding-agent/src/core/skills/skill-set-events.ts`
 *     (`SkillSetJsonValue`, `SkillSetSnapshotSource`, `SkillSetVisibility`,
 *     `SkillSetSnapshotEntry`, `SkillSetSnapshot`, `SkillsChangedEvent`,
 *     `SkillsQueryRequest`, `RpcReply`, the channel constants,
 *     `skillsQueryReplyChannel`, and `canonicalSkillSetJson`);
 *   - the rewrite-map seam from `packages/coding-agent/src/core/skills/runtime.ts`
 *     (`SKILL_AGENTS_REWRITE_MAPS_CHANNEL`, `SKILL_AGENTS_QUERY_CHANNEL`,
 *     `skillAgentsQueryReplyChannel`, `SkillAgentRewriteEntry`,
 *     `SkillAgentRewriteMap`, `SkillAgentRewriteMaps`, `SkillAgentRewriteMapsEvent`).
 *
 * These are NEVER imported from `@earendil-works/pi-coding-agent`: the published
 * upstream package (0.87.x) does not ship these modules, so an import would break
 * this repo's independent build. Under upstream pi with no seam, the skill-agents
 * feature simply degrades to nothing. `test/skills-contract.test.ts` pins the copy
 * against core's source when the checkout is present.
 */

export const SKILLS_CHANGED_CHANNEL = "skills:changed";
export const SKILLS_QUERY_CHANNEL = "skills:query";

export function skillsQueryReplyChannel(requestId: string): string {
  return `skills:query:reply:${requestId}`;
}

/** Recursively readonly JSON-safe value as carried by skill-set payloads. */
export type SkillSetJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly SkillSetJsonValue[]
  | { readonly [key: string]: SkillSetJsonValue };

/**
 * The exact A.9 `source` object shape: the complete detached SourceInfo, never
 * the `SourceInfo.source` string alone. `baseDir` is omitted (never null) when absent.
 */
export interface SkillSetSnapshotSource {
  readonly path: string;
  readonly source: string;
  readonly scope: "user" | "project" | "temporary";
  readonly origin: "package" | "top-level";
  readonly baseDir?: string;
}

/**
 * Resolved A.6 visibility carried on the wire (decision 6): a JSON-safe
 * structural copy of `ResolvedSkillVisibility` from `./visibility.ts`. Duplicated
 * (not imported) so the wire declarations stay dependency-free for byte-for-byte
 * copying into companion repos. `userInvokeError` is `true` iff the effective state is
 * `off`; the fork suppresses a skill's bundled agents exactly when it is `true`.
 */
export interface SkillSetVisibility {
  readonly model: "full" | "name" | "no";
  readonly user: "yes" | "no";
  readonly userInvokeError: boolean;
}

export interface SkillSetSnapshotEntry {
  readonly id: string;
  readonly name: string;
  readonly listingName: string;
  readonly baseDir: string;
  readonly source: SkillSetSnapshotSource;
  readonly frontmatter: { readonly [key: string]: SkillSetJsonValue };
  readonly visibility: SkillSetVisibility;
}

export interface SkillSetSnapshot {
  readonly revision: number;
  readonly skills: readonly SkillSetSnapshotEntry[];
  readonly removed: readonly string[];
}

/** `skills:changed` carries the full authoritative snapshot after each publication. */
export type SkillsChangedEvent = SkillSetSnapshot;

export interface SkillsQueryRequest {
  readonly requestId: string;
}

export type RpcReply<T> =
  | { readonly success: true; readonly data?: T }
  | { readonly success: false; readonly error: string };

function sortKeysRecursively(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysRecursively);
  }
  if (typeof value === "object" && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) {
        sorted[key] = sortKeysRecursively(item);
      }
    }
    return sorted;
  }
  return value;
}

/**
 * Canonical-JSON rule for the A.9 wire contract: object keys sorted
 * lexicographically (recursively), absent optional fields omitted, JSON.stringify
 * with 2-space indentation, single trailing LF. The committed conformance fixture
 * and every byte comparison use exactly this function.
 */
export function canonicalSkillSetJson(snapshot: SkillSetSnapshot): string {
  return `${JSON.stringify(sortKeysRecursively(snapshot), null, 2)}\n`;
}

/**
 * A.9 rewrite-map seam (Workstream 2 fork emits; core keeps the last received).
 * Copied from `runtime.ts` — the fork-emits half of the contract whose core-emits
 * half (the skill-set seam) is above.
 */
export const SKILL_AGENTS_REWRITE_MAPS_CHANNEL = "skill-agents:rewrite-maps";
export const SKILL_AGENTS_QUERY_CHANNEL = "skill-agents:query";

export function skillAgentsQueryReplyChannel(requestId: string): string {
  return `skill-agents:query:reply:${requestId}`;
}

export interface SkillAgentRewriteEntry {
  readonly qualified: string;
  readonly collided: boolean;
}

/** Bare agent name → rewrite target for one skill. */
export type SkillAgentRewriteMap = Readonly<Record<string, SkillAgentRewriteEntry>>;

/** Canonical skill ID → rewrite map. Absence of the event = empty map (rewrite stage no-ops). */
export type SkillAgentRewriteMaps = Readonly<Record<string, SkillAgentRewriteMap>>;

export interface SkillAgentRewriteMapsEvent {
  readonly revision: number;
  readonly maps: SkillAgentRewriteMaps;
}
