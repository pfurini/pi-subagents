/**
 * mention-clone.test.ts — the clone's one request and what it does with the
 * reply. The model call is stubbed at `ctx.modelRegistry.streamSimple`; pi's
 * own `convertToLlm` and pi-ai's transcript and validation helpers are real.
 * test/e2e/mention-clone.e2e.test.ts runs the same path over a real session.
 */
import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Message,
} from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentMentionReminder } from "../src/mention.js";
import { runMentionClone } from "../src/mention-clone.js";

const readTool = { name: "read", description: "read a file", parameters: Type.Object({ path: Type.String() }) };
const agentDeclaration = {
  name: "Agent",
  description: "start an agent",
  parameters: Type.Object({
    prompt: Type.String(),
    description: Type.String(),
    subagent_type: Type.Optional(Type.String()),
    run_in_background: Type.Optional(Type.Boolean()),
  }),
};

/** The parent's projection: a system message, then one exchange. */
const PROJECTION = [
  { role: "system", content: "PARENT PROMPT", toolsAdded: [readTool, agentDeclaration], timestamp: 1 },
  { role: "user", content: [{ type: "text", text: "earlier question" }], timestamp: 2 },
  { role: "assistant", content: [{ type: "text", text: "earlier answer" }], stopReason: "stop", timestamp: 3 },
  { role: "compactionSummary", summary: "what happened before", tokensBefore: 10, timestamp: 4 },
];

const agentCallReply = (args: Record<string, unknown>, ...more: AssistantMessage["content"]) =>
  fauxAssistantMessage([fauxToolCall("Agent", args), ...more], { stopReason: "toolUse" });
const validArgs = { prompt: "written from context", description: "look", subagent_type: "Explore" };

let reply: AssistantMessage;
let streamSimple: ReturnType<typeof vi.fn>;
let agentTool: any;
let ctx: any;

beforeEach(() => {
  reply = agentCallReply(validArgs);
  streamSimple = vi.fn(() => ({ result: async () => reply }));
  agentTool = {
    ...agentDeclaration,
    label: "Agent",
    execute: vi.fn(async () => ({ content: [{ type: "text", text: "started" }], details: undefined })),
  };
  ctx = {
    cwd: "/work",
    model: { provider: "p", id: "m" },
    thinkingLevel: "high",
    modelRegistry: { streamSimple },
    sessionManager: {
      buildSessionProjection: vi.fn(() => ({ entries: [], messages: PROJECTION })),
      getSessionId: () => "parent-session",
    },
  };
});

const clone = () => runMentionClone({ ctx, type: "Explore", message: "check the RPC path", agentTool });
const sentMessages = (): Message[] => streamSimple.mock.calls[0][1].messages;

describe("the clone's request", () => {
  it("is exactly one call", async () => {
    await clone();
    expect(streamSimple).toHaveBeenCalledTimes(1);
  });

  it("carries the conversation pi would send, compaction summary included", async () => {
    await clone();
    const texts = sentMessages()
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => JSON.stringify(m.content));
    expect(texts[0]).toContain("earlier question");
    expect(texts[1]).toContain("earlier answer");
    expect(texts[2]).toContain("what happened before");
  });

  it("keeps the parent's system prompt byte for byte", async () => {
    await clone();
    expect(getCurrentSystemPrompt(sentMessages())).toBe("PARENT PROMPT");
  });

  it("declares the Agent tool and nothing else", async () => {
    await clone();
    expect(getCurrentTools(sentMessages()).map((t) => t.name)).toEqual(["Agent"]);
  });

  it("ends with the message, then the reminder", async () => {
    await clone();
    const last = sentMessages().at(-1) as { role: string; content: Array<{ text: string }> };
    expect(last.role).toBe("user");
    expect(last.content[0].text).toBe(`check the RPC path\n\n${agentMentionReminder("Explore")}`);
  });

  it("uses the parent's model, session id and thinking level", async () => {
    await clone();
    const [model, , options] = streamSimple.mock.calls[0];
    expect(model).toBe(ctx.model);
    expect(options).toMatchObject({ sessionId: "parent-session", reasoning: "high" });
  });

  it("sends no reasoning level when the session thinks at off", async () => {
    ctx.thinkingLevel = "off";
    await clone();
    expect(streamSimple.mock.calls[0][2]).not.toHaveProperty("reasoning");
  });

  it("leaves the parent's projection untouched", async () => {
    const before = JSON.stringify(PROJECTION);
    await clone();
    expect(JSON.stringify(PROJECTION)).toBe(before);
  });
});

describe("attributing the spawn to the real session", () => {
  it("runs the real Agent handler with the MAIN context and no tool-call id", async () => {
    expect(await clone()).toEqual({ spawned: true });
    const [toolCallId, , signal, , passedCtx] = agentTool.execute.mock.calls[0];
    expect(toolCallId).toBeUndefined();
    expect(signal.aborted).toBe(false);
    expect(passedCtx).toBe(ctx);
  });

  it("forwards the parameters the model chose, forced into the background", async () => {
    reply = agentCallReply({ ...validArgs, run_in_background: false });
    await clone();
    expect(agentTool.execute.mock.calls[0][1]).toEqual({ ...validArgs, run_in_background: true });
  });

  it("honours only the first Agent call", async () => {
    reply = agentCallReply(validArgs, fauxToolCall("Agent", { ...validArgs, prompt: "second" }));
    await clone();
    expect(agentTool.execute).toHaveBeenCalledTimes(1);
    expect(agentTool.execute.mock.calls[0][1].prompt).toBe("written from context");
  });

  it("applies the tool's prepareArguments before validating, as pi's loop does", async () => {
    agentTool.prepareArguments = (args: any) => ({ ...args, prompt: `prepared: ${args.prompt}` });
    await clone();
    expect(agentTool.execute.mock.calls[0][1].prompt).toBe("prepared: written from context");
  });
});

describe("when the clone cannot deliver", () => {
  it("reports a reply that never called the tool", async () => {
    reply = fauxAssistantMessage([fauxText("I would start Explore.")]);
    expect(await clone()).toEqual({ spawned: false, error: "the conversation clone did not start it" });
    expect(agentTool.execute).not.toHaveBeenCalled();
  });

  it("reports a provider error", async () => {
    reply = fauxAssistantMessage([], { stopReason: "error", errorMessage: "rate limited" });
    expect(await clone()).toEqual({ spawned: false, error: "rate limited" });
  });

  it("rejects arguments that do not match the tool schema", async () => {
    reply = agentCallReply({ description: "no prompt" });
    const result = await clone();
    expect(result.spawned).toBe(false);
    expect(result.error).toContain("prompt");
    expect(agentTool.execute).not.toHaveBeenCalled();
  });

  it("reports a missing model without calling anything", async () => {
    ctx.model = undefined;
    expect(await clone()).toEqual({ spawned: false, error: "no model is selected" });
    expect(streamSimple).not.toHaveBeenCalled();
  });

  it("returns a thrown error rather than rejecting", async () => {
    streamSimple.mockImplementation(() => {
      throw new Error("no credentials");
    });
    await expect(clone()).resolves.toEqual({ spawned: false, error: "no credentials" });
  });

  it("keeps a spawn the tool already started when the tool then throws", async () => {
    agentTool.execute.mockRejectedValue(new Error("late failure"));
    expect(await clone()).toEqual({ spawned: true, error: "late failure" });
  });
});
