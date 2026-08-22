import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAgentsFromDirectory } from "../src/agent-dir-loader.js";

describe("loadAgentsFromDirectory", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-dir-loader-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeAgent(name: string, content: string) {
    writeFileSync(join(dir, `${name}.md`), content);
  }

  it("returns an empty map for a directory that does not exist", () => {
    expect(loadAgentsFromDirectory(join(dir, "nope"), "skill").size).toBe(0);
  });

  it("stamps the requested source on every loaded agent", () => {
    writeAgent("reviewer", "---\ndescription: Reviews\n---\n\nBody.");
    const agents = loadAgentsFromDirectory(dir, "skill");
    expect(agents.get("reviewer")?.source).toBe("skill");
  });

  it("loads .md files in deterministic filename-sorted order (last declared-name clash wins)", () => {
    // Two files claim the same declared name; sorted order makes b-second load
    // last, so it wins regardless of the platform's readdir order.
    writeAgent("b-second", "---\nname: shared\ndescription: second\n---\n\nB.");
    writeAgent("a-first", "---\nname: shared\ndescription: first\n---\n\nA.");
    const agents = loadAgentsFromDirectory(dir, "skill");
    expect(agents.get("shared")?.description).toBe("second");
  });

  it("refuses a declared name containing the reserved ':' qualifier", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeAgent("scoped", "---\nname: my-plugin:reviewer\ndescription: Reviews\n---\n\nBody.");
      const agents = loadAgentsFromDirectory(dir, "skill");
      expect(agents.get("my-plugin:reviewer")).toBeUndefined();
      expect(agents.get("scoped")).toBeUndefined();
      expect(warn.mock.calls.map(a => String(a[0])).join("\n")).toContain(
        "reserved for plugin-scoped identifiers",
      );
    } finally {
      warn.mockRestore();
    }
  });
});
