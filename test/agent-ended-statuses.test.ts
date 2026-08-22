/**
 * agent-ended-statuses.test.ts — the v3 terminal-event contract, end to end.
 *
 * `subagents:agent-ended` must fire exactly once per top-level agent, carrying
 * the record's NATIVE status (core drops a payload without a string status and
 * derives `ok = !(error|stopped|aborted)` from it). The gate's ordering is unit
 * tested in `cross-extension-rpc.test.ts`; what is covered here is the real
 * `AgentManager` → `src/index.ts` completion callback, for every terminal path,
 * alongside the v2 `subagents:completed` / `subagents:failed` broadcast.
 *
 * `steered` is the load-bearing case: the v2 broadcasts fold it into "completed",
 * and it must reach core unnormalized.
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
import subagentsExtension from "../src/index.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
const AGENT_ENDED = "subagents:agent-ended";

function makePi() {
  const lifecycle = new Map<string, any>();
  const busHandlers = new Map<string, (raw: any) => unknown>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn(),
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
  return { pi, lifecycle, busHandlers };
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

describe("subagents:agent-ended (v3) terminal statuses", () => {
  let tmpDir: string;
  let prevCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-ended-"));
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    prevCwd = process.cwd();
    process.chdir(tmpDir);
    delete (globalThis as any)[MANAGER_KEY];
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    delete (globalThis as any)[MANAGER_KEY];
    vi.restoreAllMocks();
  });

  async function boot() {
    const h = makePi();
    subagentsExtension(h.pi);
    await h.lifecycle.get("session_start")({}, ctx());
    return h;
  }

  const endedEvents = (pi: any) => pi.events.emit.mock.calls.filter((c: any[]) => c[0] === AGENT_ENDED).map((c: any[]) => c[1]);
  const channelsFor = (pi: any, ...names: string[]) =>
    pi.events.emit.mock.calls.filter((c: any[]) => names.includes(c[0])).map((c: any[]) => c[0]);

  /** Spawn through the RPC and wait for the agent's terminal event. */
  async function spawnAndSettle(pi: any, busHandlers: Map<string, any>, requestId: string) {
    await busHandlers.get("subagents:rpc:spawn")!({
      requestId,
      type: "general-purpose",
      prompt: "go",
      options: { description: "terminal status", isBackground: true },
    });
    await vi.waitFor(() => expect(endedEvents(pi).length).toBeGreaterThan(0));
  }

  it.each([
    ["completed", { steered: false, aborted: false }, "subagents:completed"],
    ["steered", { steered: true, aborted: false }, "subagents:completed"],
    ["aborted", { steered: false, aborted: true }, "subagents:failed"],
  ] as const)("emits %s verbatim alongside the v2 broadcast", async (status, outcome, v2Channel) => {
    (runAgent as any).mockResolvedValue({
      responseText: "done",
      session: undefined,
      aborted: outcome.aborted,
      steered: outcome.steered,
      failure: undefined,
    });
    const { pi, busHandlers } = await boot();

    await spawnAndSettle(pi, busHandlers, `s-${status}`);

    const events = endedEvents(pi);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe(status);
    expect(typeof events[0].agentId).toBe("string");
    expect(channelsFor(pi, "subagents:completed", "subagents:failed")).toEqual([v2Channel]);
  });

  it("emits error with the failure text", async () => {
    (runAgent as any).mockResolvedValue({
      responseText: "",
      session: undefined,
      aborted: false,
      steered: false,
      failure: "provider exploded",
    });
    const { pi, busHandlers } = await boot();

    await spawnAndSettle(pi, busHandlers, "s-error");

    const events = endedEvents(pi);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("error");
    expect(events[0].error).toBe("provider exploded");
    expect(channelsFor(pi, "subagents:completed", "subagents:failed")).toEqual(["subagents:failed"]);
  });

  it("emits error exactly once when the run rejects", async () => {
    (runAgent as any).mockRejectedValue(new Error("boom"));
    const { pi, busHandlers } = await boot();

    await spawnAndSettle(pi, busHandlers, "s-reject");

    const events = endedEvents(pi);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("error");
    expect(events[0].error).toContain("boom");
  });

  it("emits stopped once for an agent aborted while still queued", async () => {
    // A queued record never reaches a settle path; before v3 it emitted nothing
    // at all and a foreground RPC waiter hung to its cap.
    (runAgent as any).mockImplementation(() => new Promise(() => {}));
    const { pi, busHandlers } = await boot();
    const manager = (globalThis as any)[MANAGER_KEY];

    const running: string[] = [];
    for (let i = 0; i < 12; i++) {
      await busHandlers.get("subagents:rpc:spawn")!({
        requestId: `fill-${i}`,
        type: "general-purpose",
        prompt: "go",
        options: { description: "filler", isBackground: true },
      });
      const reply = pi.events.emit.mock.calls.find((c: any[]) => c[0] === `subagents:rpc:spawn:reply:fill-${i}`);
      running.push(reply![1].data.id);
    }
    const queued = running.find(id => manager.getRecord(id)?.status === "queued");
    expect(queued, "expected the concurrency cap to queue an agent").toBeTruthy();
    expect(endedEvents(pi)).toHaveLength(0);

    await busHandlers.get("subagents:rpc:stop")!({ requestId: "stop-q", agentId: queued });

    const events = endedEvents(pi);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ agentId: queued, status: "stopped" });
    expect(channelsFor(pi, "subagents:completed", "subagents:failed")).toEqual(["subagents:failed"]);
  });
});
