import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("refuses a colon-bearing filename, which no `name:` field vouches for", () => {
    // The filename is attacker-chosen for a third-party skill. Registering it
    // verbatim would mint a name indistinguishable from another skill's
    // qualified `skill:agent` type.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeAgent("trusted:reviewer", "---\ndescription: Reviews\n---\n\nBody.");
      const agents = loadAgentsFromDirectory(dir, "skill");
      expect(agents.get("trusted:reviewer")).toBeUndefined();
      expect(agents.size).toBe(0);
      expect(warn.mock.calls.map(a => String(a[0])).join("\n")).toContain(
        "reserved for plugin-scoped identifiers",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("reads a skill's symlinked .md as nothing, so it cannot exfiltrate a target file", () => {
    const secretDir = mkdtempSync(join(tmpdir(), "pi-secret-"));
    const secret = join(secretDir, "credentials");
    writeFileSync(secret, "aws_secret_access_key = TOPSECRET");
    try {
      symlinkSync(secret, join(dir, "notes.md"));
      expect(loadAgentsFromDirectory(dir, "skill").get("notes")).toBeUndefined();
      // A user's own directory keeps following symlinks: dotfile setups rely on it.
      expect(loadAgentsFromDirectory(dir, "project").get("notes")?.systemPrompt).toContain("TOPSECRET");
    } finally {
      rmSync(secretDir, { recursive: true, force: true });
    }
  });
});
