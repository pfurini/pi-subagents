/**
 * notification-boundary.test.ts — completion notifications are delivered at a
 * turn boundary, not pushed into pi's follow-up queue as they arrive.
 *
 * Between agent_start and agent_end the model is mid-turn: a completion is
 * parked, and at agent_end whatever is still unread goes out as ONE
 * notification. A result the model fetched with get_subagent_result in the
 * meantime is dropped. While idle the notification is sent after the 200ms
 * hold and starts a turn, as before. After an aborted run it is attached to the
 * next prompt (`nextTurn`) instead of starting a turn the user just cancelled.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { type BootedPi, ctx, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

/** pi-subagents holds an idle completion notification for NUDGE_HOLD_MS (200ms). */
const PAST_THE_HOLD_MS = 400;

const notifications = (pi: any): any[][] =>
  pi.sendMessage.mock.calls.filter((c: any[]) => c[0]?.customType === "subagent-notification");

const assistant = (stopReason: "stop" | "aborted" | "error") => ({ role: "assistant", content: [], stopReason });

describe("completion notifications at the turn boundary", () => {
  let hermetic: Hermetic | undefined;
  let booted: BootedPi | undefined;

  afterEach(async () => {
    await booted?.lifecycle.get("session_shutdown")?.({}, ctx());
    booted = undefined;
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    hermetic?.restore();
    hermetic = undefined;
    vi.restoreAllMocks();
  });

  async function boot(): Promise<BootedPi> {
    hermetic = hermeticDir({ settings: { outputTranscript: false, schedulingEnabled: false } });
    booted = makePi();
    subagentsExtension(booted.pi);
    await booted.lifecycle.get("session_start")({}, ctx());
    return booted;
  }

  /** A session stub with what a background resume touches; `prompt` settles when the caller says so. */
  function fakeSession(prompt: () => Promise<void> = () => Promise.resolve()) {
    return { dispose: vi.fn(), abort: vi.fn(), subscribe: vi.fn(() => () => {}), messages: [] as unknown[], prompt: vi.fn(prompt) };
  }

  /** Spawn a background agent whose (mocked) run answers `responseText` at once. */
  async function spawn(b: BootedPi, responseText: string, session: unknown = fakeSession()): Promise<string> {
    vi.mocked(runAgent).mockResolvedValueOnce({
      responseText,
      session,
      aborted: false,
      steered: false,
    } as any);
    const result = await b.tools.get("Agent").execute(
      `tc-${responseText}`,
      { prompt: "go", description: responseText, subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );
    return /Agent ID: (\S+)/.exec(textOf(result))![1];
  }

  const read = (b: BootedPi, id: string) =>
    b.tools.get("get_subagent_result").execute("tc-read", { agent_id: id }, undefined, undefined, ctx());

  const startRun = (b: BootedPi) => b.lifecycle.get("agent_start")({ type: "agent_start" }, ctx());
  const endRun = (b: BootedPi, stopReason: "stop" | "aborted" = "stop") =>
    b.lifecycle.get("agent_end")({ type: "agent_end", messages: [assistant(stopReason)] }, ctx());

  const settle = () => new Promise(r => setTimeout(r, PAST_THE_HOLD_MS));

  it("parks a completion while the model is mid-turn and drops it once the result is read", async () => {
    const b = await boot();
    startRun(b);
    const id = await spawn(b, "RESULT-A");
    await settle();
    expect(notifications(b.pi)).toHaveLength(0);

    expect(textOf(await read(b, id))).toContain("RESULT-A");
    await endRun(b);
    expect(notifications(b.pi)).toHaveLength(0);
  });

  it("delivers unread completions once, consolidated, when the turn ends", async () => {
    const b = await boot();
    startRun(b);
    const a = await spawn(b, "RESULT-A");
    const c = await spawn(b, "RESULT-B");
    await settle();
    expect(notifications(b.pi)).toHaveLength(0);

    await endRun(b);
    const sent = notifications(b.pi);
    expect(sent).toHaveLength(1);
    const [message, options] = sent[0];
    expect(message.content).toContain(a);
    expect(message.content).toContain(c);
    expect(options).toMatchObject({ deliverAs: "followUp", triggerTurn: true });
    // Both agents are done, so the consolidated label must not claim otherwise.
    expect(message.content).not.toContain("others still running");
    // The queued message can still be dropped at injection: the predicate turns
    // true only once every record it covers has been read.
    expect(options.discardIf()).toBe(false);
    await read(b, a);
    expect(options.discardIf()).toBe(false);
    await read(b, c);
    expect(options.discardIf()).toBe(true);
  });

  it("attaches completions from an aborted turn to the next prompt instead of starting one", async () => {
    const b = await boot();
    startRun(b);
    await spawn(b, "RESULT-A");
    await endRun(b, "aborted");
    expect(notifications(b.pi)).toHaveLength(1);
    expect(notifications(b.pi)[0][1]).toMatchObject({ deliverAs: "nextTurn" });
  });

  it("treats a run whose signal was aborted as interrupted even when the tail is a tool result", async () => {
    const b = await boot();
    startRun(b);
    await spawn(b, "RESULT-A");
    await b.lifecycle.get("agent_end")(
      { type: "agent_end", messages: [{ role: "toolResult", content: [] }] },
      ctx({ signal: AbortSignal.abort() }),
    );
    expect(notifications(b.pi)).toHaveLength(1);
    expect(notifications(b.pi)[0][1]).toMatchObject({ deliverAs: "nextTurn" });
  });

  it("keeps completions parked across a provider error that pi retries", async () => {
    const b = await boot();
    startRun(b);
    const id = await spawn(b, "RESULT-A");
    await b.lifecycle.get("agent_end")({ type: "agent_end", messages: [assistant("error")] }, ctx());
    await settle();
    expect(notifications(b.pi)).toHaveLength(0);

    startRun(b); // the retry
    await endRun(b);
    expect(notifications(b.pi)).toHaveLength(1);
    expect(notifications(b.pi)[0][0].content).toContain(id);
  });

  it("releases completions parked by an errored run once pi settles without a retry", async () => {
    const b = await boot();
    startRun(b);
    await spawn(b, "RESULT-A");
    await b.lifecycle.get("agent_end")({ type: "agent_end", messages: [assistant("error")] }, ctx());
    await b.lifecycle.get("agent_settled")({ type: "agent_settled" }, ctx());
    await settle();
    expect(notifications(b.pi)).toHaveLength(1);
    expect(notifications(b.pi)[0][1]).toMatchObject({ deliverAs: "followUp", triggerTurn: true });
  });

  it("retires a parked completion when its agent is resumed, and announces the new run when it ends", async () => {
    const b = await boot();
    let finishResume: () => void = () => {};
    const session = fakeSession(() => new Promise<void>(resolve => { finishResume = resolve; }));
    startRun(b);
    const id = await spawn(b, "RESULT-A", session);
    expect(textOf(await read(b, id))).toContain("RESULT-A");

    const resumed = await b.tools.get("Agent").execute(
      "tc-resume",
      { resume: id, prompt: "again", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );
    expect(textOf(resumed)).toContain("resumed in background");

    // The first run's record was read; the resume reset it, which must not
    // resurrect the first run's notification.
    await endRun(b);
    expect(notifications(b.pi)).toHaveLength(0);

    finishResume();
    await settle();
    expect(notifications(b.pi)).toHaveLength(1);
    expect(notifications(b.pi)[0][0].content).toContain(id);
  });

  it("keeps delivering to the next prompt after an abort until a new turn starts", async () => {
    const b = await boot();
    startRun(b);
    await endRun(b, "aborted");
    await spawn(b, "RESULT-A"); // lands while idle, after the abort
    await settle();
    expect(notifications(b.pi)).toHaveLength(1);
    expect(notifications(b.pi)[0][1]).toMatchObject({ deliverAs: "nextTurn" });

    startRun(b);
    await endRun(b);
    await spawn(b, "RESULT-B");
    await settle();
    expect(notifications(b.pi)).toHaveLength(2);
    expect(notifications(b.pi)[1][1]).toMatchObject({ deliverAs: "followUp", triggerTurn: true });
  });

  it("sends an idle completion after the hold and starts a turn, as before", async () => {
    const b = await boot();
    const id = await spawn(b, "RESULT-A");
    await settle();
    const sent = notifications(b.pi);
    expect(sent).toHaveLength(1);
    expect(sent[0][0].content).toContain(id);
    expect(sent[0][1]).toMatchObject({ deliverAs: "followUp", triggerTurn: true });
  });
});
