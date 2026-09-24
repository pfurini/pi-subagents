/**
 * ext-slow-input.ts — an extension whose `input` handler takes a few
 * milliseconds, as a real one that reads a file or calls a service does.
 *
 * It records every text it receives under a global symbol, so a test can tell
 * which messages went through extension `input` handlers.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SEEN = Symbol.for("pi-subagents:test:slow-input-seen");

export default function slowInput(pi: ExtensionAPI): void {
  pi.on("input", async (event) => {
    const store = globalThis as unknown as Record<symbol, string[] | undefined>;
    store[SEEN] ??= [];
    store[SEEN].push(event.text);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { action: "continue" };
  });
}
