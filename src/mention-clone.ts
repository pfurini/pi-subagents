/**
 * mention-clone.ts — start a mentioned agent from a clone of this
 * conversation, without putting anything in the chat.
 *
 * Claude Code routes `@agent-<type>` through the main model: the mention
 * becomes a `<system-reminder>` appended to the prompt and the model makes the
 * tool call (see `agentMentionReminder`). That buys the spawned agent a prompt
 * written with conversation context, and costs a visible turn for a decision
 * the user already made when they typed the handle.
 *
 * So the turn happens off-screen, as ONE model request. The request is the
 * conversation pi itself would send next: the session projection (compaction
 * and context edits applied), converted by pi's own `convertToLlm`, system
 * messages included. The parent's live system prompt therefore arrives
 * byte-for-byte, because it lives in those system messages. One trailing
 * system message swaps the declared tools for the `Agent` tool alone, and the
 * mention closes the request.
 *
 * No throwaway session is built. Since pi 0.87 a session reads provider
 * context from its SessionManager and rebuilds its own system prompt, so a
 * session-based clone either lost the conversation or replaced the prompt.
 * One request also saves the second model call a session spent answering the
 * tool result.
 *
 * Four details make the spawn belong to the real session:
 *
 *   - the registered `Agent` tool runs with the MAIN `ExtensionContext`, which
 *     places the transcript and the `rootSessionId` under the real session;
 *   - it is called with no tool-call id, because the real session never
 *     issued one;
 *   - it is forced into the background, because a foreground agent answers
 *     through a tool result nobody reads here;
 *   - only the first `Agent` call is honoured, and no other tool is declared,
 *     so an invisible turn can do nothing but start one agent.
 */

import {
  getCurrentTools,
  type Message,
  type Tool,
  type ToolCall,
  validateToolArguments,
} from "@earendil-works/pi-ai";
import { convertToLlm, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { agentMentionReminder } from "./mention.js";
import type { SubagentType } from "./types.js";

export interface MentionCloneOptions {
  /** The MAIN session's context: what the spawn is attributed to, and the
   * source of the conversation, the model and the provider credentials. */
  ctx: ExtensionContext;
  /** Agent type the handle resolved to. */
  type: SubagentType;
  /** What the user typed after the handle. */
  message: string;
  /** The registered `Agent` tool, reused so the spawn is an ordinary one. */
  agentTool: ToolDefinition;
}

export interface MentionCloneResult {
  /** True once the clone's `Agent` call was handed to the tool. */
  spawned: boolean;
  /** Why not, when it didn't. Absent on success. */
  error?: string;
}

/**
 * Send the conversation plus the mention as one request that can only call
 * `Agent`, and run that call against the real session. Never rejects: a clone
 * that cannot deliver is reported so the caller can start the agent directly.
 */
export async function runMentionClone(opts: MentionCloneOptions): Promise<MentionCloneResult> {
  const { ctx, type, message, agentTool } = opts;
  let spawned = false;
  try {
    const model = ctx.model;
    if (!model) return { spawned, error: "no model is selected" };

    const conversation: Message[] = convertToLlm(ctx.sessionManager.buildSessionProjection().messages);
    const declaration: Tool = {
      name: agentTool.name,
      description: agentTool.description,
      parameters: agentTool.parameters,
    };
    const now = Date.now();
    const request: Message[] = [
      ...conversation,
      {
        role: "system",
        content: "",
        toolsRemoved: getCurrentTools(conversation)
          .filter((tool) => tool.name !== declaration.name)
          .map(({ name }) => ({ name })),
        toolsAdded: [declaration],
        timestamp: now,
      },
      {
        role: "user",
        // User text first, reminder after: the order Claude Code's attachment
        // renderer produces, where the reminder trails the message it is about.
        content: [{ type: "text", text: `${message}\n\n${agentMentionReminder(type)}` }],
        timestamp: now,
      },
    ];

    const thinkingLevel = ctx.thinkingLevel;
    const reply = await ctx.modelRegistry
      .streamSimple(model, { messages: request }, {
        // The parent's id keeps provider cache routing on the parent's prefix.
        sessionId: ctx.sessionManager.getSessionId(),
        ...(thinkingLevel && thinkingLevel !== "off" && { reasoning: thinkingLevel }),
      })
      .result();
    if (reply.stopReason === "error" || reply.stopReason === "aborted") {
      return { spawned, error: reply.errorMessage ?? `the clone's request ended with "${reply.stopReason}"` };
    }

    const call = reply.content.find(
      (block): block is ToolCall => block.type === "toolCall" && block.name === declaration.name,
    );
    if (!call) return { spawned, error: "the conversation clone did not start it" };

    // Same preparation and validation pi's own agent loop applies to a call.
    const prepared = agentTool.prepareArguments
      ? { ...call, arguments: agentTool.prepareArguments(call.arguments) as ToolCall["arguments"] }
      : call;
    const params = validateToolArguments(declaration, prepared);
    spawned = true;
    await agentTool.execute(
      undefined as never,
      { ...params, run_in_background: true },
      new AbortController().signal,
      undefined,
      ctx,
    );
    return { spawned };
  } catch (err) {
    return { spawned, error: err instanceof Error ? err.message : String(err) };
  }
}
