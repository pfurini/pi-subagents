import { describe, expect, it, vi } from "vitest";
import { inChildSessionContext, runInChildSessionContext } from "../src/child-context.js";
import subagentsExtension from "../src/index.js";

describe("child session async context", () => {
  it("is scoped to the child async branch", async () => {
    expect(inChildSessionContext()).toBe(false);
    await runInChildSessionContext(async () => {
      expect(inChildSessionContext()).toBe(true);
      await Promise.resolve();
      expect(inChildSessionContext()).toBe(true);
    });
    expect(inChildSessionContext()).toBe(false);
  });

  it("keeps a child resource load to the A.9 adapter and nothing else", async () => {
    // A child activation may reach for exactly two things: `pi.on`, for its own
    // session_start/shutdown, and `pi.events`, to wire the skill-agents seam on
    // the child's own bus (S4 — the child has its own SkillRuntime, which pulls
    // rewrite maps there). Touching anything else means the full factory ran:
    // a second manager and a second set of handlers, which is what this guards.
    const allowed = new Set(["on", "events"]);
    const target: Record<string, unknown> = {
      on: vi.fn(),
      events: { on: vi.fn(() => vi.fn()), emit: vi.fn() },
    };
    const pi = new Proxy(target, {
      get: (t, prop) => {
        if (typeof prop === "string" && !allowed.has(prop)) {
          throw new Error(`child extension factory touched ${prop}`);
        }
        return t[prop as string];
      },
    });
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];

    await runInChildSessionContext(async () => {
      expect(() => subagentsExtension(pi as any)).not.toThrow();
    });

    // No manager claimed, and no tool or command registered (both would have thrown).
    expect((globalThis as any)[Symbol.for("pi-subagents:manager")]).toBeUndefined();
  });
});
