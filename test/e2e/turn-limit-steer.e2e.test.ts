/**
 * turn-limit-steer.e2e.test.ts — the wrap-up message must reach the agent on
 * the turn after it hits `max_turns`, whatever extensions the child loads.
 *
 * Since pi 0.86 `AgentSession.steer()` awaits every extension `input` handler
 * before it queues. The wrap-up was sent that way from a `turn_end` listener
 * that pi does not await, so with a slow handler in the child the loop polled
 * its steering queue first: the agent never saw the wrap-up and was
 * hard-aborted at the end of its grace turns. The fixture extension supplies
 * that slow handler; it is installed in the hermetic agent directory, so only
 * the child loads it.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { TURN_LIMIT_STEER } from "../../src/agent-runner.js";
import { agentCall, routeBySession, runPrintMode } from "../helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 30_000 });

const FIXTURE = fileURLToPath(new URL("../fixtures/ext-slow-input.ts", import.meta.url));
const SEEN = Symbol.for("pi-subagents:test:slow-input-seen");
const seenByInputHandler = () => (globalThis as unknown as Record<symbol, string[] | undefined>)[SEEN] ?? [];

describe("turn-limit wrap-up with a slow child input handler", () => {
  it("reaches the agent on its next turn and bypasses input handlers", async () => {
    (globalThis as unknown as Record<symbol, unknown>)[SEEN] = [];
    const childSawWrapUp: boolean[] = [];
    const run = await runPrintMode({
      prompt: "go",
      maxModelCalls: 24,
      beforeRun: () => {
        const extensions = join(process.env.PI_CODING_AGENT_DIR as string, "extensions");
        mkdirSync(extensions, { recursive: true });
        copyFileSync(FIXTURE, join(extensions, "ext-slow-input.ts"));
      },
      respond: routeBySession({
        parentInitial: agentCall({
          prompt: "work until told to stop",
          description: "loop",
          run_in_background: false,
          max_turns: 1,
        }),
        parentFinal: "Done.",
        subagent: (context) => {
          const told = JSON.stringify(context.messages).includes(TURN_LIMIT_STEER);
          childSawWrapUp.push(told);
          return told ? "WRAPPED" : [fauxToolCall("ls", { path: "." })];
        },
      }),
    });
    try {
      expect(childSawWrapUp).toEqual([false, true]);
      const agentResult = run.parentSession.messages.find(
        (m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent",
      );
      expect(JSON.stringify(agentResult?.content)).toContain("wrapped up at the turn limit");
      // The fixture really ran in the child: it saw the child's prompt.
      expect(seenByInputHandler()).toContain("work until told to stop");
      expect(seenByInputHandler().some((text) => text.includes("turn limit"))).toBe(false);
    } finally {
      await run.dispose();
    }
  });
});
