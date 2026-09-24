/**
 * output-transcript.e2e.test.ts — a subagent's `.output` transcript over a
 * real session: the prompt appears once, and system messages never appear.
 *
 * Since pi 0.86 a session's first message is the system message that carries
 * the prompt and the tool declarations. The writer assumed message 0 was the
 * prompt and started at 1, so it re-wrote the prompt and would have written
 * later system messages labelled `toolResult`.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { sessionTaskDir } from "../../src/output-file.js";
import { agentCall, routeBySession, runPrintMode } from "../helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 30_000 });

describe("subagent transcript over a real session", () => {
  it("writes the prompt once, then the conversation, and no system messages", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "subagents-transcript-"));
    let childCalls = 0;
    const run = await runPrintMode({
      cwd,
      prompt: "go",
      respond: routeBySession({
        parentInitial: agentCall({ prompt: "CHILD PROMPT", description: "d", run_in_background: false }),
        parentFinal: "Done.",
        subagent: () => (++childCalls === 1 ? [fauxToolCall("ls", { path: "." })] : "CHILD ANSWER"),
      }),
    });
    const tasks = sessionTaskDir(cwd, run.parentSession.sessionManager.getSessionId());
    try {
      const files = readdirSync(tasks).filter((name) => name.endsWith(".output"));
      expect(files).toHaveLength(1);
      const entries = readFileSync(join(tasks, files[0]), "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(entries.map((entry) => entry.type)).toEqual(["user", "assistant", "toolResult", "assistant"]);
      expect(JSON.stringify(entries[0].message.content)).toContain("CHILD PROMPT");
      expect(entries.some((entry) => entry.message?.role === "system")).toBe(false);
    } finally {
      await run.dispose();
      rmSync(dirname(tasks), { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
