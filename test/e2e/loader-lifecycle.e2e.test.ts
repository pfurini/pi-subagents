/**
 * loader-lifecycle.e2e.test.ts — a subagent's resource loader must not
 * outlive its run, and the run's session must stay resumable once it is gone.
 *
 * Pi builds with resource watching (`DefaultResourceLoader.dispose`, not in
 * published 0.87.x) start directory watchers on every loader and dispose only
 * loaders they built themselves. `runAgent` builds its own, so every finished
 * subagent kept its watchers, and each write in the agent directory re-scanned
 * skills and commands once per finished agent. The watcher block runs only on
 * such a build (`npm run check:pi` against the fork); the resume block runs on
 * every pi.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../../src/agent-runner.js";
import { registerAgents } from "../../src/agent-types.js";
import type { AgentConfig } from "../../src/types.js";
import { fauxModelBackend } from "../helpers/faux-model-backend.js";
import { registerFauxProvider } from "../helpers/pi-ai.js";
import { agentCall, runPrintMode } from "../helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 30_000 });

const WATCHES = typeof (DefaultResourceLoader.prototype as { dispose?: unknown }).dispose === "function";
/** Longer than the watcher debounce (100 ms) plus FSEvents delivery latency. */
const SETTLE_MS = 1500;
const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

/** Count the rescans a loader performs from now on. */
function countRescans(loader: ResourceLoader) {
  return vi.spyOn(loader as unknown as { refreshSkillsAndCommands: () => void }, "refreshSkillsAndCommands");
}

describe.skipIf(!WATCHES)("a finished subagent's loader stops watching", () => {
  let cwd: string;
  let agentDir: string;
  let prevAgentDir: string | undefined;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-loader-"));
    agentDir = join(cwd, "agent");
    mkdirSync(join(agentDir, "skills", "demo"), { recursive: true });
    writeFileSync(join(agentDir, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\nbody\n");
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });
  afterEach(() => {
    faux.unregister();
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(cwd, { recursive: true, force: true });
  });

  /**
   * Edit the demo skill. The trigger is a skill file because pi watches skill
   * folders directly. The agent directory itself is watched only as a stand-in
   * for a missing `commands/` folder, so a write there would stop reaching the
   * watcher if pi narrowed that fallback.
   */
  const touchSkill = () =>
    writeFileSync(join(agentDir, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: changed\n---\nbody\n");

  it("control: a live loader rescans when a skill changes", async () => {
    const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noThemes: true });
    await loader.reload();
    const rescans = countRescans(loader);
    touchSkill();
    await settle();
    expect(rescans).toHaveBeenCalled();
    (loader as { dispose?: () => void }).dispose?.();
  });

  it("does not rescan once runAgent has returned", async () => {
    registerAgents(
      new Map([
        [
          "loader-e2e",
          {
            name: "loader-e2e",
            description: "loader-e2e",
            builtinToolNames: ["read"],
            extensions: false,
            skills: true,
            systemPrompt: "You are a test agent.",
            promptMode: "replace",
            inheritContext: false,
            runInBackground: false,
            isolated: false,
          } as AgentConfig,
        ],
      ]),
    );
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    faux.setResponses([fauxAssistantMessage("done")]);
    let loader: ResourceLoader | undefined;
    const ctx = {
      cwd,
      model,
      getSystemPrompt: () => "PARENT",
      modelRegistry: { ...backend.modelRegistry, runtime: backend.modelRuntime },
    } as never;

    await runAgent(ctx, "loader-e2e", "go", {
      pi: { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as never,
      model,
      onSessionCreated: (session) => {
        loader = session.resourceLoader;
      },
    });

    expect(loader).toBeDefined();
    const rescans = countRescans(loader as ResourceLoader);
    touchSkill();
    await settle();
    expect(rescans).not.toHaveBeenCalled();
  });
});

describe("a finished subagent stays resumable after its loader is disposed", () => {
  it("resumes the same conversation by agent id", async () => {
    let parentCalls = 0;
    let agentId: string | undefined;
    const childUserTurns: number[] = [];
    const run = await runPrintMode({
      prompt: "go",
      maxModelCalls: 12,
      respond: (context) => {
        const isParent = (context.tools ?? []).some((tool) => tool.name === "Agent");
        if (!isParent) {
          childUserTurns.push(context.messages.filter((m) => m.role === "user").length);
          return childUserTurns.length === 1 ? "FIRST ANSWER" : "RESUMED ANSWER";
        }
        parentCalls++;
        if (parentCalls === 1) return [agentCall({ prompt: "first task", description: "d1", run_in_background: true })];
        if (parentCalls === 2) {
          const spawn = context.messages.find((m) => m.role === "toolResult");
          agentId = JSON.stringify(spawn?.content).match(/Agent ID: ([\w-]+)/)?.[1];
          return "waiting";
        }
        if (parentCalls === 3) {
          return [agentCall({ resume: agentId, prompt: "follow-up", description: "d2", run_in_background: false })];
        }
        return "ALL DONE";
      },
    });
    try {
      expect(agentId).toBeDefined();
      // The resume continued the first conversation: its turn saw both user messages.
      expect(childUserTurns).toEqual([1, 2]);
      const last = run.parentSession.messages.filter((m) => m.role === "toolResult").at(-1);
      expect(JSON.stringify(last?.content)).toContain("RESUMED ANSWER");
    } finally {
      await run.dispose();
    }
  });
});
