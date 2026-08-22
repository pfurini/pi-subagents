/**
 * rpc-lifecycle-gating.test.ts — issue #142.
 *
 * pi runs every extension factory BEFORE applying an agent's `extensions:`
 * filter, and only delivers lifecycle events (session_start, …) to the
 * survivors — but the `pi.events` bus is shared with the filtered-out
 * activations. The old code registered the RPC handlers and emitted
 * `subagents:ready` at factory time, so a child session that excluded
 * pi-subagents still saw `subagents:ready` + a working `subagents:rpc:ping`,
 * yet every spawn failed with "No active session" (its session_start never
 * fired, so currentCtx stayed undefined).
 *
 * The fix defers BOTH the RPC registration and the readiness broadcast to the
 * first bound session_start. These tests drive the real extension factory with
 * a mock ExtensionAPI and assert the timing: nothing is wired at factory time;
 * everything is wired (once) on session_start.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import { clearSkillAgents, getSkillAgents, isValidType } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";

const RPC_CHANNELS = ["subagents:rpc:ping", "subagents:rpc:spawn", "subagents:rpc:stop"] as const;

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>(); // pi.on(...) — session_start, session_shutdown, …
  const busHandlers = new Map<string, (raw: any) => unknown>(); // pi.events.on(...) — rpc channels
  const pi = {
    registerMessageRenderer: vi.fn(),
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

function ctx(hasUI = false, setWidget = vi.fn()) {
  return {
    hasUI,
    ui: {
      setStatus: vi.fn(),
      setWidget,
      notify: vi.fn(),
      onTerminalInput: vi.fn(() => vi.fn()),
      getEditorText: vi.fn(() => ""),
      custom: vi.fn(),
    },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const readyEmits = (pi: any): unknown[] =>
  pi.events.emit.mock.calls.filter((c: any[]) => c[0] === "subagents:ready");
const onCallsFor = (pi: any, channel: string): unknown[] =>
  pi.events.on.mock.calls.filter((c: any[]) => c[0] === channel);

describe("issue #142: RPC handlers + subagents:ready are gated on session_start", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    // Hermetic cwd + global dir with scheduling off, so session_start doesn't
    // spin a scheduler or touch the dev's filesystem — isolates the RPC wiring.
    tmpDir = mkdtempSync(join(tmpdir(), "pi-142-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-142-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("does NOT advertise or register RPC at factory time (the filtered-out case)", () => {
    const { pi, busHandlers } = makePi();

    // A filtered-out activation only ever gets the factory run — its
    // session_start never fires. So after the factory alone, nothing should
    // be on the shared bus.
    subagentsExtension(pi);

    expect(readyEmits(pi), "no subagents:ready before session_start").toHaveLength(0);
    for (const channel of RPC_CHANNELS) {
      expect(busHandlers.has(channel), `${channel} must not be registered at factory time`).toBe(false);
    }
  });

  it("advertises and registers RPC on session_start, and spawn works once bound", async () => {
    const { pi, lifecycle, busHandlers } = makePi();
    subagentsExtension(pi);

    await lifecycle.get("session_start")({}, ctx());

    // Readiness broadcast once, all three channels now live.
    expect(readyEmits(pi), "subagents:ready fires once bound").toHaveLength(1);
    for (const channel of RPC_CHANNELS) {
      expect(busHandlers.has(channel), `${channel} registered on session_start`).toBe(true);
    }

    // spawn no longer hits the "No active session" trap — currentCtx is set.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any); // never resolves
    const requestId = "req-142";
    await busHandlers.get("subagents:rpc:spawn")!({
      requestId,
      type: "general-purpose",
      prompt: "go",
      options: { description: "rpc gating test" },
    });

    const reply = pi.events.emit.mock.calls.find(
      (c: any[]) => c[0] === `subagents:rpc:spawn:reply:${requestId}`,
    );
    expect(reply, "spawn emitted a reply").toBeTruthy();
    expect(reply![1].success, `spawn succeeded, got: ${JSON.stringify(reply![1])}`).toBe(true);
    expect(reply![1].data.id).toBeTruthy();
  });

  it("renders an RPC-spawned agent in the native widget while it is running", async () => {
    const { pi, lifecycle, busHandlers } = makePi();
    const activeCtx = ctx(true);
    subagentsExtension(pi);

    await lifecycle.get("session_start")({}, activeCtx);

    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any); // keep agent running
    try {
      await busHandlers.get("subagents:rpc:spawn")!({
        requestId: "req-widget",
        type: "general-purpose",
        prompt: "go",
        options: { description: "visible RPC agent" },
      });

      await vi.waitFor(() => {
        expect(activeCtx.ui.setWidget).toHaveBeenCalledWith(
          "agents",
          expect.any(Function),
          { placement: "aboveEditor" },
        );
        expect(activeCtx.ui.setStatus).toHaveBeenCalledWith("subagents", "1 running agent");
      });
    } finally {
      await lifecycle.get("session_shutdown")();
    }
  });

  it("shows live tool activity for an RPC-spawned background agent", async () => {
    const { pi, lifecycle, busHandlers } = makePi();
    let widgetFactory: any;
    const setWidget = vi.fn((key: string, content: any) => {
      if (key === "agents" && content) widgetFactory = content;
    });
    const extensionCtx = ctx(true, setWidget);
    let onToolActivity: ((activity: { type: "start" | "end"; toolName: string }) => void) | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options: any) => {
      onToolActivity = options.onToolActivity;
      options.onSessionCreated?.({ subscribe: () => vi.fn() });
      return new Promise(() => {}) as any;
    });
    subagentsExtension(pi);

    await lifecycle.get("session_start")({}, extensionCtx);
    // TaskExecute runs inside a root tool call, so the extension already has
    // the UI context before pi-tasks sends its cross-extension spawn request.
    await lifecycle.get("tool_execution_start")({}, extensionCtx);
    await busHandlers.get("subagents:rpc:spawn")!({
      requestId: "req-activity",
      type: "general-purpose",
      prompt: "go",
      options: { description: "rpc activity test", isBackground: true },
    });
    await vi.waitFor(() => expect(onToolActivity).toBeTypeOf("function"));
    onToolActivity!({ type: "start", toolName: "bash" });

    expect(widgetFactory).toBeTypeOf("function");
    const lines = widgetFactory(
      { terminal: { columns: 120 }, requestRender: vi.fn() },
      { fg: (_color: string, text: string) => text, bold: (text: string) => text },
    ).render().join("\n");
    expect(lines).toContain("running command…");
    expect(lines).not.toContain("thinking…");
  });

  it("is idempotent — a second session_start does not re-advertise or double-register", async () => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);

    await lifecycle.get("session_start")({}, ctx());
    await lifecycle.get("session_start")({}, ctx());

    expect(readyEmits(pi), "subagents:ready emitted exactly once across two session_starts").toHaveLength(1);
    for (const channel of RPC_CHANNELS) {
      expect(onCallsFor(pi, channel), `${channel} registered exactly once`).toHaveLength(1);
    }
  });
});

describe("A.9 skill-agents adapter lifecycle (S4)", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-s4-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-s4-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    process.chdir(tmpDir);
    // Free the process-global manager slot so this extension instance is the
    // root owner (an earlier test's factory may have claimed and not released it).
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  });

  afterEach(() => {
    clearSkillAgents();
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    vi.restoreAllMocks();
  });

  function skillSnapshot(listingName: string, agentName: string, revision = 1) {
    const baseDir = join(tmpDir, listingName.replace(/[:/]/g, "_"));
    const agentsDir = join(baseDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, `${agentName}.md`), "---\ndescription: bundled\n---\n\nBody.");
    const id = join(baseDir, "SKILL.md");
    return {
      snapshot: {
        revision,
        removed: [],
        skills: [{
          id,
          name: listingName,
          listingName,
          baseDir,
          source: { path: id, source: "local", scope: "project", origin: "top-level" },
          frontmatter: {},
          visibility: { model: "full", user: "yes", userInvokeError: false },
        }],
      },
      id,
    };
  }

  const emitsOn = (pi: any, channel: string) =>
    pi.events.emit.mock.calls.filter((c: any[]) => c[0] === channel);

  it("wires no A.9 listeners at factory time", () => {
    const { pi, busHandlers } = makePi();
    subagentsExtension(pi);
    expect(busHandlers.has("skills:changed")).toBe(false);
    expect(busHandlers.has("skill-agents:query")).toBe(false);
    expect(emitsOn(pi, "skills:query")).toHaveLength(0);
  });

  it("on session_start subscribes to the seam and issues one skills:query pull", async () => {
    const { pi, lifecycle, busHandlers } = makePi();
    subagentsExtension(pi);
    await lifecycle.get("session_start")({}, ctx());

    expect(busHandlers.has("skills:changed")).toBe(true);
    expect(busHandlers.has("skill-agents:query")).toBe(true);
    expect(emitsOn(pi, "skills:query")).toHaveLength(1);
  });

  it("registers skill agents and publishes rewrite maps on skills:changed", async () => {
    const { pi, lifecycle, busHandlers } = makePi();
    subagentsExtension(pi);
    await lifecycle.get("session_start")({}, ctx());

    const { snapshot, id } = skillSnapshot("simplify", "reviewer");
    busHandlers.get("skills:changed")!(snapshot);

    // Global registry mutated (root activation owns it): qualified + free bare alias.
    expect(isValidType("simplify:reviewer")).toBe(true);
    expect(isValidType("reviewer")).toBe(true);

    const publishes = emitsOn(pi, "skill-agents:rewrite-maps");
    expect(publishes.length).toBeGreaterThanOrEqual(1);
    const event = publishes.at(-1)![1];
    expect(event.maps[id].reviewer.qualified).toBe("simplify:reviewer");
    expect(event.maps[id].reviewer.collided).toBe(false); // bare alias granted
  });

  it("answers skill-agents:query with the current maps", async () => {
    const { pi, lifecycle, busHandlers } = makePi();
    subagentsExtension(pi);
    await lifecycle.get("session_start")({}, ctx());
    const { snapshot, id } = skillSnapshot("simplify", "reviewer");
    busHandlers.get("skills:changed")!(snapshot);

    busHandlers.get("skill-agents:query")!({ requestId: "q1" });
    const reply = pi.events.emit.mock.calls.find((c: any[]) => c[0] === "skill-agents:query:reply:q1");
    expect(reply).toBeTruthy();
    expect(reply![1].success).toBe(true);
    expect(reply![1].data.maps[id].reviewer.qualified).toBe("simplify:reviewer");
  });

  it("ignores a stale snapshot (lower revision)", async () => {
    const { pi, lifecycle, busHandlers } = makePi();
    subagentsExtension(pi);
    await lifecycle.get("session_start")({}, ctx());

    busHandlers.get("skills:changed")!(skillSnapshot("simplify", "reviewer", 5).snapshot);
    const before = emitsOn(pi, "skill-agents:rewrite-maps").length;
    // A lower-revision snapshot with a different agent must be ignored.
    busHandlers.get("skills:changed")!(skillSnapshot("other", "auditor", 4).snapshot);
    expect(isValidType("other:auditor")).toBe(false);
    expect(emitsOn(pi, "skill-agents:rewrite-maps").length).toBe(before);
  });

  it("widens the ready payload to carry the sessionId", async () => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    await lifecycle.get("session_start")({}, ctx());
    expect(readyEmits(pi)[0]![1]).toEqual({ sessionId: "s1" });
  });

  it("wires the seam exactly once across duplicate session_starts", async () => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    await lifecycle.get("session_start")({}, ctx());
    await lifecycle.get("session_start")({}, ctx());
    expect(onCallsFor(pi, "skills:changed")).toHaveLength(1);
    expect(onCallsFor(pi, "skill-agents:query")).toHaveLength(1);
    expect(emitsOn(pi, "skills:query")).toHaveLength(1);
  });

  it("drops the skill layer on shutdown", async () => {
    const { pi, lifecycle, busHandlers } = makePi();
    subagentsExtension(pi);
    await lifecycle.get("session_start")({}, ctx());
    busHandlers.get("skills:changed")!(skillSnapshot("simplify", "reviewer").snapshot);
    expect(getSkillAgents()).toBeDefined();

    await lifecycle.get("session_shutdown")();
    expect(getSkillAgents()).toBeUndefined();
  });
});
