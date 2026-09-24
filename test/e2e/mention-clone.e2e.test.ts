/**
 * mention-clone.e2e.test.ts — the mention clone against a REAL parent session.
 *
 * The unit suite stubs the model call and hands the clone a hand-built
 * projection. What it cannot establish is that pi's own projection of a real
 * session, sent as the clone sends it, reaches the model as the conversation
 * under the parent's live system prompt, with the `Agent` tool as the only
 * tool. Pi 0.87 changed exactly that seam: a session-based clone kept passing
 * its unit tests while every real mention fell back to a direct start.
 *
 * No network: a faux provider answers, and the assertions read the one request
 * it received.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentMentionReminder } from "../../src/mention.js";
import { runMentionClone } from "../../src/mention-clone.js";
import { fauxModelBackend } from "../helpers/faux-model-backend.js";
import { registerFauxProvider } from "../helpers/pi-ai.js";

vi.setConfig({ testTimeout: 30_000 });

describe("mention clone over a real session", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-mention-clone-"));
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });
  afterEach(() => {
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
  });

  /** A real parent session with a custom prompt, read/bash tools and one finished exchange. */
  async function parentWithHistory() {
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: join(cwd, "agent"),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => "PARENT PROMPT",
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd,
      model,
      modelRuntime: backend.modelRuntime,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      tools: ["read", "bash"],
    } as never);
    faux.setResponses([fauxAssistantMessage("EARLIER ANSWER")]);
    await session.prompt("EARLIER QUESTION");
    const ctx = { cwd, model, modelRegistry: backend.modelRegistry, sessionManager: session.sessionManager } as never;
    return { session, ctx };
  }

  const agentTool = () =>
    ({
      name: "Agent",
      label: "Agent",
      description: "start an agent",
      parameters: Type.Object({ prompt: Type.String(), description: Type.String() }),
      execute: vi.fn(async () => ({ content: [{ type: "text", text: "started" }], details: undefined })),
    }) as any;

  it("sends the conversation under the live system prompt, with Agent as the only tool", async () => {
    const { session, ctx } = await parentWithHistory();
    const entriesBefore = JSON.stringify(session.sessionManager.getEntries());
    const seen: any[] = [];
    faux.setResponses([
      (context) => {
        seen.push(context);
        return fauxAssistantMessage([fauxToolCall("Agent", { prompt: "written", description: "d" })], {
          stopReason: "toolUse",
        });
      },
    ]);
    const tool = agentTool();

    const result = await runMentionClone({ ctx, type: "Explore", message: "MENTION", agentTool: tool });

    expect(result).toEqual({ spawned: true });
    expect(seen).toHaveLength(1);
    expect(faux.getPendingResponseCount()).toBe(0);
    const [request] = seen;
    expect(request.systemPrompt).toBe(session.systemPrompt);
    expect(request.tools.map((t: { name: string }) => t.name)).toEqual(["Agent"]);
    expect(request.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(request.messages[0].content)).toContain("EARLIER QUESTION");
    expect(request.messages[2].content[0].text).toBe(`MENTION\n\n${agentMentionReminder("Explore")}`);
    expect(tool.execute.mock.calls[0][1]).toEqual({ prompt: "written", description: "d", run_in_background: true });
    expect(JSON.stringify(session.sessionManager.getEntries())).toBe(entriesBefore);
    session.dispose();
  });

  it("sends the compaction summary instead of the turns it replaced", async () => {
    const { session, ctx } = await parentWithHistory();
    session.sessionManager.appendCompaction("SUMMARY OF EARLIER WORK", null, 1000);
    const seen: any[] = [];
    faux.setResponses([
      (context) => {
        seen.push(context);
        return fauxAssistantMessage([fauxToolCall("Agent", { prompt: "p", description: "d" })], { stopReason: "toolUse" });
      },
    ]);

    await runMentionClone({ ctx, type: "Explore", message: "MENTION", agentTool: agentTool() });

    const conversation = JSON.stringify(seen[0].messages);
    expect(conversation).toContain("SUMMARY OF EARLIER WORK");
    expect(conversation).not.toContain("EARLIER QUESTION");
    session.dispose();
  });
});
