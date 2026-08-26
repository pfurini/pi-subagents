/**
 * skill-agents-e2e.test.ts — acceptance for skill-bundled agents (WS2).
 *
 * Drives the REAL extension with a mock pi: publishes an A.9 skill-set snapshot
 * on the bus, spawns skill agents by qualified and bare name through the
 * cross-extension spawn RPC, and asserts registration, the rewrite-map contract,
 * deregistration on a visibility flip, and the unknown-type fallback policy.
 *
 * The reference scenario is built in-repo (no external skill checkout): a
 * `simplify` skill bundling four review agents, a case-only collision between its
 * `Reviewer` and a user `reviewer`, and the portable Agent-unavailable fallback.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(() => new Promise(() => {})) };
});

import { clearSkillAgents, getAgentConfig, isValidType, NO_FALLBACK, setFallbackSubagent } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const busHandlers = new Map<string, (raw: any) => unknown>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    getAllTools: vi.fn(() => [] as any[]),
    setActiveTools: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        busHandlers.set(event, handler);
        return vi.fn();
      }),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle, busHandlers };
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "root"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

describe("skill-bundled agents acceptance (WS2)", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;
  let skillBaseDir: string;
  let skillId: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-wsa-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-wsa-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi", "agents"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));

    // A user agent that collides case-insensitively with the skill's `Reviewer`.
    writeFileSync(join(tmpDir, ".pi", "agents", "reviewer.md"), "---\ndescription: User reviewer\n---\n\nUser review.");

    // The `simplify` skill bundling four review agents.
    skillBaseDir = join(tmpDir, "simplify");
    skillId = join(skillBaseDir, "SKILL.md");
    const agents = join(skillBaseDir, "agents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "simplifier.md"), "---\ndescription: Simplify code\ntools: read, grep\n---\n\nSimplify the code.");
    writeFileSync(join(agents, "Reviewer.md"), "---\nname: Reviewer\ndescription: Review the diff\n---\n\nReview.");
    writeFileSync(join(agents, "efficiency.md"), "---\ndescription: Efficiency pass\n---\n\nEfficiency.");
    writeFileSync(join(agents, "altitude.md"), "---\ndescription: Altitude pass\n---\n\nAltitude.");

    process.chdir(tmpDir);
    delete (globalThis as any)[MANAGER_KEY];
  });

  afterEach(() => {
    clearSkillAgents();
    setFallbackSubagent(undefined);
    delete (globalThis as any)[MANAGER_KEY];
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function snapshot(revision: number, off = false) {
    return {
      revision,
      removed: [],
      skills: [{
        id: skillId,
        name: "simplify",
        listingName: "simplify",
        baseDir: skillBaseDir,
        source: { path: skillId, source: "local", scope: "project", origin: "top-level" },
        frontmatter: {},
        visibility: { model: "full", user: "yes", userInvokeError: off },
      }],
    };
  }

  async function boot() {
    const h = makePi();
    subagentsExtension(h.pi);
    await h.lifecycle.get("session_start")({}, ctx());
    return h;
  }

  const lastRewriteMaps = (pi: any) => {
    const calls = pi.events.emit.mock.calls.filter((c: any[]) => c[0] === "skill-agents:rewrite-maps");
    return calls.at(-1)?.[1];
  };

  async function spawnRpc(busHandlers: Map<string, any>, type: string, requestId: string) {
    await busHandlers.get("subagents:rpc:spawn")!({
      requestId,
      type,
      prompt: "go",
      options: { description: "acceptance spawn", isBackground: true },
    });
  }
  const spawnReply = (pi: any, requestId: string) =>
    pi.events.emit.mock.calls.find((c: any[]) => c[0] === `subagents:rpc:spawn:reply:${requestId}`)?.[1];
  const recordType = (id: string) => (globalThis as any)[MANAGER_KEY]?.getRecord(id)?.type;

  it("registers four bundled agents with their bundled prompt and tools", async () => {
    const { pi, busHandlers } = await boot();
    busHandlers.get("skills:changed")!(snapshot(1));

    for (const name of ["simplifier", "Reviewer", "efficiency", "altitude"]) {
      expect(isValidType(`simplify:${name}`), `simplify:${name} registered`).toBe(true);
    }
    const simplifier = getAgentConfig("simplify:simplifier");
    expect(simplifier?.systemPrompt).toBe("Simplify the code.");
    expect(simplifier?.builtinToolNames).toEqual(["read", "grep"]);
    expect(simplifier?.skillId).toBe(skillId);
    // A rewrite map is published for the skill.
    expect(lastRewriteMaps(pi)?.maps[skillId]).toBeDefined();
  });

  it("grants free bare aliases but denies the one colliding with a user agent", async () => {
    const { pi, busHandlers } = await boot();
    busHandlers.get("skills:changed")!(snapshot(1));

    // Free bare names resolve to the skill agents.
    expect(getAgentConfig("simplifier")?.skillId).toBe(skillId);
    expect(getAgentConfig("efficiency")?.skillId).toBe(skillId);
    // `reviewer` stays the USER agent (case-only collision denies the alias).
    expect(getAgentConfig("reviewer")?.skillId).toBeUndefined();

    const map = lastRewriteMaps(pi).maps[skillId];
    expect(map.simplifier.collided).toBe(false);
    expect(map.Reviewer.collided).toBe(true);   // the code-block/prose rewrite case
    expect(map.Reviewer.qualified).toBe("simplify:Reviewer");
  });

  it("spawns a skill agent by qualified and by bare name through the spawn RPC", async () => {
    const { pi, busHandlers } = await boot();
    busHandlers.get("skills:changed")!(snapshot(1));

    await spawnRpc(busHandlers, "simplify:simplifier", "q1");
    const qualifiedReply = spawnReply(pi, "q1");
    expect(qualifiedReply.success).toBe(true);
    expect(recordType(qualifiedReply.data.id)).toBe("simplify:simplifier");

    await spawnRpc(busHandlers, "efficiency", "b1"); // free bare alias
    const bareReply = spawnReply(pi, "b1");
    expect(bareReply.success).toBe(true);
    expect(recordType(bareReply.data.id)).toBe("efficiency");
  });

  it("deregisters the agents when the skill flips to off", async () => {
    const { busHandlers } = await boot();
    busHandlers.get("skills:changed")!(snapshot(1));
    expect(isValidType("simplify:simplifier")).toBe(true);

    busHandlers.get("skills:changed")!(snapshot(2, true)); // userInvokeError → suppressed
    expect(isValidType("simplify:simplifier")).toBe(false);
    expect(getAgentConfig("simplifier")?.skillId).toBeUndefined();
  });

  it("falls back to general-purpose for a deregistered type by default", async () => {
    const { pi, busHandlers } = await boot();
    busHandlers.get("skills:changed")!(snapshot(1));
    busHandlers.get("skills:changed")!(snapshot(2, true));

    await spawnRpc(busHandlers, "simplify:simplifier", "f1");
    const reply = spawnReply(pi, "f1");
    // Default (unset) fallback resolves an unknown type to general-purpose.
    expect(reply.success).toBe(true);
    expect(recordType(reply.data.id)).toBe("general-purpose");
  });

  it("hard-errors on a deregistered type under fallbackSubagent: none", async () => {
    const { pi, busHandlers } = await boot();
    busHandlers.get("skills:changed")!(snapshot(1));
    busHandlers.get("skills:changed")!(snapshot(2, true));
    setFallbackSubagent(NO_FALLBACK);

    await spawnRpc(busHandlers, "simplify:simplifier", "e1");
    const reply = spawnReply(pi, "e1");
    expect(reply.success).toBe(false);
    expect(reply.error).toContain("Unknown or disabled agent type");
  });

  it("republishes the rewrite map when a user agent steals a bare alias mid-session", async () => {
    const { pi, busHandlers } = await boot();
    busHandlers.get("skills:changed")!(snapshot(1));
    expect(lastRewriteMaps(pi).maps[skillId].simplifier.collided).toBe(false);
    const beforeRevision = lastRewriteMaps(pi).revision;

    // The user takes the name back. Nothing about the SKILL changed, so no
    // `skills:changed` follows — only the next registry rebuild sees it.
    writeFileSync(join(tmpDir, ".pi", "agents", "simplifier.md"), "---\ndescription: Mine\n---\n\nMine.");
    await spawnRpc(busHandlers, "general-purpose", "r1");

    const after = lastRewriteMaps(pi);
    expect(after.maps[skillId].simplifier.collided).toBe(true);
    expect(after.revision).toBeGreaterThan(beforeRevision);
    expect(getAgentConfig("simplifier")?.skillId).toBeUndefined();
  });

  it("does not republish when a rebuild leaves the alias decisions unchanged", async () => {
    const { pi, busHandlers } = await boot();
    busHandlers.get("skills:changed")!(snapshot(1));
    const emitted = () => pi.events.emit.mock.calls.filter((c: any[]) => c[0] === "skill-agents:rewrite-maps").length;
    const before = emitted();

    await spawnRpc(busHandlers, "general-purpose", "n1");
    await spawnRpc(busHandlers, "general-purpose", "n2");

    expect(emitted()).toBe(before);
  });

  it("drops the agents and empties the map when the skill disappears from the snapshot", async () => {
    const { pi, busHandlers } = await boot();
    busHandlers.get("skills:changed")!(snapshot(1));
    expect(isValidType("simplify:simplifier")).toBe(true);

    busHandlers.get("skills:changed")!({ revision: 2, skills: [], removed: [skillId] });

    expect(isValidType("simplify:simplifier")).toBe(false);
    expect(getAgentConfig("simplifier")?.skillId).toBeUndefined();
    expect(lastRewriteMaps(pi).maps).toEqual({});
  });

  it("keeps a container skill's agents: only the `off` state suppresses them", async () => {
    // `disable-model-invocation` + `user-invocable: false` is a legitimate
    // container skill (frozen input 6): not `off`, so its agents stay.
    const { busHandlers } = await boot();
    const snap = snapshot(1);
    snap.skills[0].visibility = { model: "no", user: "no", userInvokeError: false };
    busHandlers.get("skills:changed")!(snap);

    expect(isValidType("simplify:simplifier")).toBe(true);
  });

  it("ignores a snapshot whose revision is not a finite number", async () => {
    const { busHandlers } = await boot();
    busHandlers.get("skills:changed")!(snapshot(1));

    // Would otherwise pin the watermark and freeze every later snapshot out.
    busHandlers.get("skills:changed")!({ ...snapshot(Number.POSITIVE_INFINITY), skills: [] });
    expect(isValidType("simplify:simplifier")).toBe(true);

    busHandlers.get("skills:changed")!(snapshot(2, true));
    expect(isValidType("simplify:simplifier")).toBe(false);
  });

  it("stays silent and inert under upstream pi, which has no skill-set seam", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Nobody answers `skills:query`, and no `skills:changed` ever arrives.
      const { pi, busHandlers } = await boot();
      // Spawning drives a registry rebuild, which is the other publish path:
      // with no skill agents there is nothing to announce, and the contract
      // already reads absence of the event as the empty map.
      await spawnRpc(busHandlers, "general-purpose", "u1");

      expect(isValidType("simplify:simplifier")).toBe(false);
      expect(pi.events.emit.mock.calls.filter((c: any[]) => c[0] === "skill-agents:rewrite-maps")).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });
});
