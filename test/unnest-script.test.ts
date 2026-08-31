// scripts/unnest-subagent-sessions.mjs relocates session files that were written
// before `.subagents/` existed. It is driven as a subprocess rather than imported,
// because what needs pinning is the thing a user actually runs: the `--apply` gate,
// the exact set it identifies, and that a rejected file is left untouched.
//
// It is outside tsconfig's `include` and biome's `files.includes`, so this suite is
// the only automated check it has.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Plain .mjs, outside tsconfig's `include`; vitest resolves it at runtime.
import { parsePiPids } from "../scripts/unnest-subagent-sessions.mjs";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "unnest-subagent-sessions.mjs");
const PROJECT = "--tmp-project--";

let root: string;
let projectDir: string;

/** An hour old, so the script's 10-minute "may still be open" floor never applies. */
function writeAged(path: string, lines: object[]): void {
  writeFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(path, anHourAgo, anHourAgo);
}

function header(extra: Record<string, unknown> = {}) {
  return { type: "session", version: 3, id: "abc123", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/project", ...extra };
}

function sessionInfo(name: string) {
  return { type: "session_info", id: "e1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", name };
}

/** A file the script must move: parented, and named the way runAgent names a subagent session. */
function writeSubagentSession(fileName: string, name = "Explore#a1b2c3d4"): string {
  const path = join(projectDir, fileName);
  writeAged(path, [header({ parentSession: "/sessions/parent.jsonl" }), sessionInfo(name)]);
  return path;
}

/**
 * `--force` rides along with every `--apply` here: the script refuses to move
 * anything while a pi process is alive, and the developer running this suite is
 * very likely inside one. The refusal itself is covered separately below.
 */
function run(...args: string[]): string {
  const force = args.includes("--apply") ? ["--force"] : [];
  return execFileSync(process.execPath, [SCRIPT, "--sessions-dir", root, ...force, ...args], { encoding: "utf8" });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "unnest-test-"));
  projectDir = join(root, PROJECT);
  mkdirSync(projectDir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("unnest-subagent-sessions", () => {
  it("moves nothing without --apply, and lists exactly what it would move", () => {
    writeSubagentSession("sub.jsonl");
    writeAged(join(projectDir, "human.jsonl"), [header()]);

    const output = run("--verbose");

    expect(output).toContain("would move  sub.jsonl");
    expect(output).toContain("Would move 1 file(s) across 1 project(s).");
    expect(existsSync(join(projectDir, "sub.jsonl"))).toBe(true);
    expect(existsSync(join(projectDir, ".subagents"))).toBe(false);
  });

  it("moves the identified files under --apply, byte for byte", () => {
    const path = writeSubagentSession("sub.jsonl");
    const before = readFileSync(path, "utf8");

    const output = run("--apply");

    expect(output).toContain("Moved 1 file(s)");
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(join(projectDir, ".subagents", "sub.jsonl"), "utf8")).toBe(before);
  });

  it("is a no-op when re-run after --apply", () => {
    writeSubagentSession("sub.jsonl");
    run("--apply");

    expect(run("--apply")).toContain("Moved 0 file(s)");
  });

  it("scopes to one project directory with --project", () => {
    writeSubagentSession("sub.jsonl");
    const other = join(root, "--tmp-other--");
    mkdirSync(other);
    writeAged(join(other, "other.jsonl"), [header({ parentSession: "/sessions/parent.jsonl" }), sessionInfo("Plan#0f0f0f0f")]);

    run("--project", PROJECT, "--apply");

    expect(existsSync(join(projectDir, ".subagents", "sub.jsonl"))).toBe(true);
    expect(existsSync(join(other, "other.jsonl"))).toBe(true);
  });

  it("finds sessions directly in a flat custom session root", () => {
    // `PI_CODING_AGENT_SESSION_DIR` and the `sessionDir` setting point at one flat
    // directory, not a tree of project directories.
    const path = join(root, "flat.jsonl");
    writeAged(path, [header({ parentSession: "/sessions/parent.jsonl" }), sessionInfo("Explore#a1b2c3d4")]);

    run("--apply");

    expect(existsSync(join(root, ".subagents", "flat.jsonl"))).toBe(true);
  });

  describe("refuses to move anything while pi is running", () => {
    it("exits non-zero and moves nothing, naming the pids", () => {
      writeSubagentSession("sub.jsonl");
      // No --force: this suite almost certainly runs inside a pi session, which is
      // exactly the condition the interlock exists for. Skipped rather than
      // asserted backwards on the rare machine where no pi is running.
      if (parsePiPids(execFileSync("ps", ["-axo", "pid=,comm="], { encoding: "utf8" })).length === 0) return;

      let stderr = "";
      let status = 0;
      try {
        execFileSync(process.execPath, [SCRIPT, "--sessions-dir", root, "--apply"], { encoding: "utf8", stdio: "pipe" });
      } catch (error) {
        const failure = error as { status?: number; stderr?: string };
        status = failure.status ?? 0;
        stderr = failure.stderr ?? "";
      }

      expect(status).toBe(1);
      expect(stderr).toMatch(/Refusing to move anything: pi is running \(pid \d+/);
      expect(existsSync(join(projectDir, "sub.jsonl"))).toBe(true);
      expect(existsSync(join(projectDir, ".subagents"))).toBe(false);
    });

    it("does nothing at all when the module is imported rather than run", () => {
      // This suite imports it for `parsePiPids`. Without the entry guard that import
      // would run `main()` against whatever store the ambient argv pointed at.
      // `PI_CODING_AGENT_DIR` aims the default resolution at the empty temp root, so
      // a regression here fails loudly instead of scanning the developer's real store.
      const output = execFileSync(process.execPath, ["-e", `import(${JSON.stringify(SCRIPT)})`], {
        encoding: "utf8",
        env: { ...process.env, PI_CODING_AGENT_DIR: root },
      });

      expect(output).toBe("");
    });

    it("reads a command's basename, so pip and pigz are not pi", () => {
      const ps = [
        "  501 pi",
        "  502 /usr/local/bin/pi",
        "  503 pip",
        "  504 pigz",
        "  505 python",
        "  506 pi-lens",
        "  507 node",
        "",
      ].join("\n");

      expect(parsePiPids(ps)).toEqual([501, 502]);
      expect(parsePiPids(ps, [501])).toEqual([502]);
      expect(parsePiPids("")).toEqual([]);
    });
  });

  describe("leaves alone every file it cannot positively identify", () => {
    const cases: Array<[string, () => void, string]> = [
      [
        "a session with no session_info entry",
        () => writeAged(join(projectDir, "x.jsonl"), [header({ parentSession: "/sessions/parent.jsonl" })]),
        "no session name",
      ],
      [
        "a human-named session",
        () => writeAged(join(projectDir, "x.jsonl"), [header({ parentSession: "/p.jsonl" }), sessionInfo("my refactor")]),
        "is not <agentType>#<8 hex>",
      ],
      [
        "a subagent-named session with no parentSession",
        () => writeAged(join(projectDir, "x.jsonl"), [header(), sessionInfo("Explore#a1b2c3d4")]),
        "no parentSession in header",
      ],
      [
        "a file whose first line is not a session header",
        () => writeAged(join(projectDir, "x.jsonl"), [sessionInfo("Explore#a1b2c3d4")]),
        "not a pi session file",
      ],
      [
        "a session renamed away from the subagent shape after the fact",
        () =>
          writeAged(join(projectDir, "x.jsonl"), [
            header({ parentSession: "/p.jsonl" }),
            sessionInfo("Explore#a1b2c3d4"),
            sessionInfo("kept for later"),
          ]),
        "is not <agentType>#<8 hex>",
      ],
      [
        "a name whose suffix is not 8 hex digits",
        () => writeAged(join(projectDir, "x.jsonl"), [header({ parentSession: "/p.jsonl" }), sessionInfo("Explore#a1b2c3")]),
        "is not <agentType>#<8 hex>",
      ],
    ];

    for (const [label, arrange, reason] of cases) {
      it(label, () => {
        arrange();

        const output = run("--apply", "--verbose");

        expect(output).toContain(reason);
        expect(output).toContain("Moved 0 file(s)");
        expect(existsSync(join(projectDir, "x.jsonl"))).toBe(true);
      });
    }

    it("a file modified inside the 10-minute floor, which may still be open", () => {
      const path = join(projectDir, "fresh.jsonl");
      writeFileSync(
        path,
        [header({ parentSession: "/p.jsonl" }), sessionInfo("Explore#a1b2c3d4")].map((l) => `${JSON.stringify(l)}\n`).join(""),
      );

      const output = run("--apply", "--verbose");

      expect(output).toContain("modified in the last 10 minutes");
      expect(existsSync(path)).toBe(true);
    });

    it("a name collision in .subagents/, rather than overwriting", () => {
      writeSubagentSession("sub.jsonl");
      mkdirSync(join(projectDir, ".subagents"));
      writeFileSync(join(projectDir, ".subagents", "sub.jsonl"), "existing\n");

      const output = run("--apply", "--verbose");

      expect(output).toContain("already exists in .subagents/");
      expect(existsSync(join(projectDir, "sub.jsonl"))).toBe(true);
      expect(readFileSync(join(projectDir, ".subagents", "sub.jsonl"), "utf8")).toBe("existing\n");
    });
  });
});
