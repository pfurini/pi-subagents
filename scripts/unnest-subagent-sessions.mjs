#!/usr/bin/env node
/**
 * Move already-written subagent session files into the `.subagents/`
 * subdirectory this extension now writes them to.
 *
 * Nothing runs this for you. It is not wired into activation, it is not shipped
 * in the npm package, and it changes nothing without `--apply`.
 *
 * Before `.subagents/` existed, every persisted subagent session landed beside
 * your own in the project session directory, where pi's four directory scans
 * (`/resume`, the all-projects list, `--continue`, project-scope prompt history)
 * treat a delegation prompt as something you typed. This relocates the old ones
 * so those scans stop seeing them. It only ever renames a file within its own
 * project directory: nothing is deleted, rewritten, truncated or reordered.
 *
 * Usage:
 *   node scripts/unnest-subagent-sessions.mjs                     # dry run, every project
 *   node scripts/unnest-subagent-sessions.mjs --verbose           # ... and why each file was skipped
 *   node scripts/unnest-subagent-sessions.mjs --project '--Users-me-code-app--'
 *   node scripts/unnest-subagent-sessions.mjs --sessions-dir /path/to/sessions
 *   node scripts/unnest-subagent-sessions.mjs --apply             # actually move them
 */

import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

/** Matches the session name this extension writes: `<agentType>#<first 8 hex of the agent id>`. */
const SUBAGENT_NAME = /^.+#[0-9a-f]{8}$/;

/** Must stay in sync with SUBAGENT_SESSION_DIR_NAME in src/agent-runner.ts. */
const SUBAGENT_DIR = ".subagents";

/**
 * A session file still being appended to must not move. `SessionManager`
 * re-opens its path on every append, so renaming one out from under a live
 * agent leaves it writing a second file at the old path and splits the
 * transcript in two. There is deliberately no flag to override this: quit pi
 * and re-run once the file has aged.
 */
const MIN_AGE_MS = 10 * 60 * 1000;

function parseArgs(argv) {
  const opts = { apply: false, force: false, verbose: false, project: undefined, sessionsDir: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") opts.apply = true;
    else if (arg === "--force") opts.force = true;
    else if (arg === "--verbose" || arg === "-v") opts.verbose = true;
    else if (arg === "--project") opts.project = argv[++i];
    else if (arg === "--sessions-dir") opts.sessionsDir = argv[++i];
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else {
      console.error(`Unknown argument: ${arg}. Run with --help.`);
      process.exit(2);
    }
  }
  if (opts.project === undefined && argv.includes("--project")) {
    console.error("--project needs a directory name.");
    process.exit(2);
  }
  if (opts.sessionsDir === undefined && argv.includes("--sessions-dir")) {
    console.error("--sessions-dir needs a path.");
    process.exit(2);
  }
  return opts;
}

/** Mirrors pi's `getAgentDir()`, so a custom agent directory is honoured. */
function defaultSessionsDir() {
  const env = process.env.PI_CODING_AGENT_DIR;
  let agentDir;
  if (!env) agentDir = join(homedir(), ".pi", "agent");
  else if (env.startsWith("~")) agentDir = join(homedir(), env.slice(1));
  else agentDir = resolve(env);
  return join(agentDir, "sessions");
}

/**
 * PIDs of pi processes in `ps -axo pid=,comm=` output, excluding `ignorePids`.
 *
 * Matched on the command's basename being exactly `pi`, so `pip`, `pigz` and
 * `python` are not pi and an absolute `/usr/local/bin/pi` is. Split out from the
 * `ps` call so the matching is testable without a real pi to find.
 */
export function parsePiPids(psOutput, ignorePids = []) {
  return psOutput
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line.trim()))
    .filter((match) => match !== null && /(^|\/)pi$/.test(match[2].trim()))
    .map((match) => Number(match[1]))
    .filter((pid) => !ignorePids.includes(pid));
}

/**
 * PIDs of running pi processes, or an empty array when that cannot be
 * determined (a `ps` this platform spells differently, say).
 *
 * `--apply` refuses while any is alive, because the per-file age floor below is
 * only a backstop: an agent that has spent twenty minutes inside one slow tool
 * call has a stale mtime and would pass it, and moving its file mid-run leaves
 * the tail of its transcript in a headerless orphan at the old path. Quitting
 * pi is the actual precondition; this makes it one rather than a suggestion.
 */
function runningPiPids() {
  try {
    return parsePiPids(execFileSync("ps", ["-axo", "pid=,comm="], { encoding: "utf8" }), [process.pid, process.ppid]);
  } catch {
    return [];
  }
}

/**
 * Read one session file's identity. Returns `null` when the first line is not a
 * valid pi session header, which is what disqualifies anything that merely ends
 * in `.jsonl`. The LAST `session_info` name wins, matching pi's
 * `getSessionName()`, so a file someone renamed is judged by its current name.
 */
async function readIdentity(path) {
  const stream = createReadStream(path, { encoding: "utf8" });
  try {
    let header = null;
    let name;
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!header) {
        if (entry?.type !== "session" || typeof entry.id !== "string" || typeof entry.cwd !== "string") return null;
        header = entry;
        continue;
      }
      if (entry?.type === "session_info") name = typeof entry.name === "string" ? entry.name.trim() : undefined;
    }
    return header ? { parentSession: header.parentSession, name } : null;
  } catch (error) {
    return { unreadable: error instanceof Error ? error.message : String(error) };
  } finally {
    stream.destroy();
  }
}

/**
 * Why this file may not be moved, or `null` when every condition holds. Each
 * condition is a positive identification, not a heuristic: a file that fails any
 * one of them is left exactly where it is.
 */
async function reasonToSkip(dir, fileName, now) {
  const path = join(dir, fileName);

  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (!stats?.isFile()) return "not a regular file";
  if (now - stats.mtimeMs < MIN_AGE_MS) return "modified in the last 10 minutes (may still be open)";

  const identity = await readIdentity(path);
  if (identity === null) return "not a pi session file";
  if (identity.unreadable) return `unreadable: ${identity.unreadable}`;
  if (typeof identity.parentSession !== "string" || identity.parentSession === "") return "no parentSession in header";
  if (!identity.name) return "no session name";
  if (!SUBAGENT_NAME.test(identity.name)) return `session name "${identity.name}" is not <agentType>#<8 hex>`;
  if (existsSync(join(dir, SUBAGENT_DIR, fileName))) return "a file of that name already exists in .subagents/";

  return null;
}

/**
 * Every directory that may hold session files directly. That is each project
 * directory under `root`, plus `root` itself — a store pointed at by
 * `PI_CODING_AGENT_SESSION_DIR` or the `sessionDir` setting is one flat
 * directory rather than a tree of project directories, and both layouts should
 * work without a mode flag. `.subagents/` is never a candidate: its files are
 * already where this puts them.
 */
function candidateDirs(root, only) {
  const projects = readdirSync(root, { withFileTypes: true })
    .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && entry.name !== SUBAGENT_DIR)
    .map((entry) => ({ label: entry.name, path: join(root, entry.name) }));
  if (only !== undefined) return projects.filter((dir) => dir.label === only);
  return [{ label: ".", path: root }, ...projects];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      [
        "Move already-written subagent session files into .subagents/.",
        "",
        "  --apply                actually move them (default is a dry run)",
        "  --force                move even while pi is running (see the warning it prints)",
        "  --project <dir-name>   limit to one project directory",
        "  --sessions-dir <path>  session root (default: pi's own)",
        "  --verbose, -v          print why each skipped file was skipped",
      ].join("\n"),
    );
    return;
  }

  const livePids = opts.apply && !opts.force ? runningPiPids() : [];
  if (livePids.length > 0) {
    console.error(
      [
        `Refusing to move anything: pi is running (pid ${livePids.join(", ")}).`,
        "",
        "A subagent that is mid-run keeps appending to its session file by path. Moving",
        "that file leaves it writing a new headerless one at the old path, and the tail of",
        "the real transcript is lost. The age floor below does not catch an agent that has",
        "been quiet inside one long tool call.",
        "",
        "Quit pi, then re-run. --force overrides this if you know those sessions are idle.",
      ].join("\n"),
    );
    process.exit(1);
  }

  const root = opts.sessionsDir ? resolve(opts.sessionsDir) : defaultSessionsDir();
  if (!existsSync(root)) {
    console.error(`No session directory at ${root}`);
    process.exit(1);
  }

  const dirs = candidateDirs(root, opts.project);
  if (dirs.length === 0) {
    console.error(`No project directory named ${opts.project} under ${root}`);
    process.exit(1);
  }

  console.log(`${opts.apply ? "Moving" : "Dry run"} — ${root}\n`);

  const now = Date.now();
  const skipTally = new Map();
  let totalMoved = 0;
  let totalProjects = 0;

  for (const dir of dirs) {
    let fileNames;
    try {
      fileNames = readdirSync(dir.path).filter((f) => f.endsWith(".jsonl"));
    } catch (error) {
      console.log(`${dir.label}: unreadable (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }

    const movable = [];
    const skipped = [];
    for (const fileName of fileNames) {
      const reason = await reasonToSkip(dir.path, fileName, now);
      if (reason === null) movable.push(fileName);
      else skipped.push({ fileName, reason });
    }

    for (const { reason } of skipped) skipTally.set(reason, (skipTally.get(reason) ?? 0) + 1);

    if (movable.length === 0 && !opts.verbose) continue;
    totalProjects += movable.length > 0 ? 1 : 0;

    console.log(`${dir.label}  ${movable.length}/${fileNames.length} subagent sessions`);

    if (opts.apply && movable.length > 0) {
      mkdirSync(join(dir.path, SUBAGENT_DIR), { recursive: true });
    }
    for (const fileName of movable) {
      if (opts.apply) {
        renameSync(join(dir.path, fileName), join(dir.path, SUBAGENT_DIR, fileName));
      }
      if (opts.verbose) console.log(`  ${opts.apply ? "moved" : "would move"}  ${fileName}`);
      totalMoved++;
    }
    if (opts.verbose) {
      for (const { fileName, reason } of skipped) console.log(`  kept       ${fileName}  (${reason})`);
    }
  }

  console.log(
    `\n${opts.apply ? "Moved" : "Would move"} ${totalMoved} file(s) across ${totalProjects} project(s).`,
  );
  if (skipTally.size > 0) {
    console.log("Left alone:");
    for (const [reason, count] of [...skipTally].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${count}  ${reason}`);
    }
  }
  if (!opts.apply && totalMoved > 0) {
    console.log("\nRe-run with --apply to move them. Quit pi first.");
  }
}

// Only when run as a command. Importing this file (test/unnest-script.test.ts does,
// for `parsePiPids`) must not start moving a store.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
