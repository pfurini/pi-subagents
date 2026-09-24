# pi 0.87 floor and fork compatibility plan

This plan raises the pi floor of this extension to 0.87.0. It fixes four defects found against the pi fork at `~/Developer/ai/pi` (branch `personal`). It also closes the test gaps that let those defects pass `npm run check`. A fresh agent can implement it from this file alone. Every source and test change below was prototyped and run on 2026-09-24 against published pi 0.87.1 and against the fork. Appendix A records the evidence.

## 1. Decisions (frozen, settled with the user)

Do not re-litigate these.

1. `peerDependencies` for `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` become `>=0.87.0`.
2. `typebox` and `@sinclair/typebox` stay in `peerDependencies` with `"*"`. Commit `0dcb600` already did this.
3. The three pi `devDependencies` pin `0.87.1`, the latest published version.
4. The CI job `compat-floor-pi` in `.github/workflows/ci.yml` installs `0.87.0`.
5. `README.md` states the new floor.
6. Code may assume pi 0.87.0 APIs. Compatibility shims for older pi are removed, because `AGENTS.md` forbids keeping backward compatibility unasked.
7. APIs that exist only in the fork stay feature-detected. These are `DefaultResourceLoader.dispose()`, the `discardIf` option of `sendMessage`, and the skills seam.

## 2. Background

### 2.1 How pi loads this extension

- The user's `pi` command runs pi-fence, which starts `~/Developer/ai/pi/packages/coding-agent/dist/cli.js`.
- `~/.pi/agent/settings.json` loads this repo as a local package (`../../Developer/ai/pi-subagents`).
- pi loads `src/index.ts` through jiti and aliases every `@earendil-works/*` import to the host's own packages.
- The extension therefore runs against the host pi, never against its own `node_modules`.
- `npm run check` typechecks and tests against the pinned devDependencies (0.84.2 before this plan). That gap hid every defect below.

### 2.2 Defects and drift

| ID | Severity | Symptom | Cause | First pi |
|---|---|---|---|---|
| D1 | High | Every finished subagent keeps watching `/`, every ancestor of the cwd, the agent dir and each skill dir. One write in the agent dir rescans skills once per finished agent. | `src/agent-runner.ts` builds a `DefaultResourceLoader` per run and never disposes it. pi disposes only loaders it built itself. | fork only (unreleased resource watching) |
| D2 | Medium | Every `@agent` mention in `model` mode falls back to a direct start with a warning notice. | `src/mention-clone.ts` assigns `agent.state.systemPrompt`, which is read-only since 0.87.0 and throws. It also pushes messages that pi 0.87 no longer sends. | 0.87.0 |
| D3 | Low | A subagent `.output` transcript contains the prompt twice. A mid-run system message would be written labelled `toolResult`. | `src/output-file.ts` starts at message index 1, assuming index 0 is the prompt. Since 0.86 index 0 is the system message. | 0.86.0 |
| D4 | Low | The turn-limit wrap-up message arrives a turn late, or never with a slow extension `input` handler. The agent is then hard-aborted. | `AgentSession.steer()` awaits every extension `input` handler before queueing since 0.86. `src/agent-runner.ts` calls it un-awaited from a `turn_end` listener. | 0.86.0 |
| T1 | Test | 16 real-pi tests fail. | Faux providers receive a `TranscriptContext` since 0.86. The test responders read `context.tools` and `context.systemPrompt`, which no longer exist. | 0.86.0 |
| T2 | Test | `usage-reaches-session-stats` fails one assertion. | pi 0.87 estimates a trailing tool result's own text into context usage. The test expected an unchanged percentage. | 0.87.0 |
| T3 | Test | `test/worktree.test.ts` fails intermittently on the user's machine. | The user's global `core.hooksPath` runs a post-checkout hook (`tokensave init &`) inside test worktrees. | environment |
| T4 | Tooling | Nothing checks the extension against the fork. | The repo only tests against pinned devDependencies. | n/a |

### 2.3 Verified compatible (do not change)

- Extension loading through the fork's bundled CLI. `/agents` registers, and no load error occurs.
- Subagent session construction, `bindExtensions`, and the tool-scope guard. `agent.beforeToolCall` is installed once, and `turn_end` listeners run before `prepareNextTurn`.
- The cross-extension RPC (`src/cross-extension-rpc.ts`). The fork's `SkillForkClient` reads every field this extension emits.
- The skill-agent seams. `test/skills-contract.test.ts` pins them against the fork source and passes.
- Completion delivery. The fork supports `discardIf` and `nextTurn`, and catches async `sendMessage` failures.
- Command names. The extension registers only `/agents`, which collides with no fork built-in.

## 3. Ground rules

- Read `AGENTS.md` in the repo root first. It governs style, docs, changelog and git.
- Line numbers in this plan match commit `0dcb600`. Locate code by symbol if they drifted.
- Treat `~/Developer/ai/pi` as read-only. Never edit, build or commit there.
- The fork must be built for `npm run check:pi`. It was built at `personal` @ `c28081104`. If `check:pi` reports a missing `dist`, ask the user to build it.
- Finish each phase's verification before starting the next phase.
- Commit at the end of each phase with the given subject, but only when the user's request includes committing (`AGENTS.md`, section Git).
- Stage files by path. Never use `git add -A` or `git add .`.

## 4. Phases at a glance

| Phase | Content | Commit subject |
|---|---|---|
| 0 | `npm run check:pi` against a local pi checkout | `build(scripts): check against a local pi checkout` |
| 1 | Test git isolation (T3) | `test: isolate git from the developer's global config` |
| 2 | Floor 0.87.0, test harness (T1, T2), mention clone (D2) | `feat!: require pi 0.87.0 and rebuild the mention clone on it` |
| 3 | Loader disposal (D1) | `fix(agent): dispose each run's resource loader` |
| 4 | Wrap-up steer (D4) | `fix(agent): queue the turn-limit wrap-up on the agent` |
| 5 | Transcript (D3) | `fix(transcript): skip system messages and the written prompt` |
| 6 | Remove shims for pi below 0.87 | `refactor: drop compatibility shims below pi 0.87` |
| 7 | Final verification and smoke test | none |

Phase 2 must be one commit. The devDependency bump alone breaks the typecheck, and only the new clone fixes it.

## 5. Phase 0: check against a local pi checkout

**Goal.** Give every later phase a command that runs `tsc` and the suite against the fork.

**Design.** The script copies the repo into a scratch directory. It symlinks every pinned package from the repo's `node_modules`, then overrides `@earendil-works/*` with the checkout's workspace packages. `tsc`, vitest and pi's own jiti loader then share one module identity. A `pi` symlink beside the copy makes `test/skills-contract.test.ts` pin against the checkout. The repo itself is never modified.

### 5.1 Create `scripts/check-against-pi.mjs`

```js
#!/usr/bin/env node
/**
 * check-against-pi.mjs: typecheck and test this extension against a local pi
 * checkout instead of the pinned devDependencies.
 *
 * pi loads this extension from source and aliases every `@earendil-works/*`
 * import to the host's own packages, so a pi build newer than the pinned
 * devDependencies can break the extension while `npm run check` stays green.
 * This script copies the repo to a scratch directory, links the checkout's
 * workspace packages over the pinned ones, and runs `tsc` and `vitest` there.
 * The repo itself is never modified.
 *
 * Usage: node scripts/check-against-pi.mjs [<checkout>] [--keep] [-- <vitest args>]
 * The checkout defaults to $PI_CHECKOUT, then to ../pi. It must be built.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const dashDash = argv.indexOf("--");
const ownArgs = dashDash === -1 ? argv : argv.slice(0, dashDash);
const vitestArgs = dashDash === -1 ? [] : argv.slice(dashDash + 1);
const keep = ownArgs.includes("--keep");
const checkout = resolve(repo, ownArgs.find((a) => !a.startsWith("--")) ?? process.env.PI_CHECKOUT ?? "../pi");

function fail(message) {
  console.error(`check-against-pi: ${message}`);
  process.exit(2);
}

const checkoutModules = join(checkout, "node_modules", "@earendil-works");
if (!existsSync(join(checkout, "packages", "coding-agent", "dist", "index.js"))) {
  fail(`${checkout} has no built pi; run \`npm run build\` in it first`);
}
if (!existsSync(checkoutModules)) fail(`${checkoutModules} is missing; run \`npm install\` in the checkout first`);

const git = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf-8" }).stdout?.trim() ?? "";
console.log(`pi checkout: ${checkout} (${git(["rev-parse", "--abbrev-ref", "HEAD"], checkout)} @ ${git(["rev-parse", "--short", "HEAD"], checkout)})`);

// <base>/pi-subagents is the copy; <base>/pi points at the checkout, because
// test/skills-contract.test.ts pins its wire types against `../pi` from the cwd.
const base = mkdtempSync(join(tmpdir(), "pi-subagents-check-"));
const work = join(base, "pi-subagents");
symlinkSync(checkout, join(base, "pi"));
const skipTopLevel = new Set(["node_modules", ".git", "dist", ".tokensave", "coverage"]);
cpSync(repo, work, { recursive: true, filter: (src) => !skipTopLevel.has(relative(repo, src)) });
// test/env.test.ts asserts that the cwd is a git work tree.
spawnSync("git", ["init", "-q"], { cwd: work });

// Every pinned package stays, except the host packages the checkout provides.
const modules = join(work, "node_modules");
mkdirSync(join(modules, "@earendil-works"), { recursive: true });
for (const entry of readdirSync(join(repo, "node_modules"))) {
  if (entry !== "@earendil-works") symlinkSync(join(repo, "node_modules", entry), join(modules, entry));
}
const hostPackages = new Map();
for (const entry of readdirSync(join(repo, "node_modules", "@earendil-works"))) {
  hostPackages.set(entry, join(repo, "node_modules", "@earendil-works", entry));
}
for (const entry of readdirSync(checkoutModules)) hostPackages.set(entry, realpathSync(join(checkoutModules, entry)));
for (const [name, target] of hostPackages) symlinkSync(target, join(modules, "@earendil-works", name));
for (const name of ["pi-ai", "pi-coding-agent", "pi-tui"]) {
  const version = JSON.parse(readFileSync(join(hostPackages.get(name), "package.json"), "utf-8")).version;
  console.log(`  @earendil-works/${name} ${version} -> ${hostPackages.get(name)}`);
}

const run = (label, args) => {
  console.log(`\n== ${label}`);
  return spawnSync(process.execPath, args, { cwd: work, stdio: "inherit" }).status ?? 1;
};
const typecheck = run("typecheck", [join(modules, "typescript", "bin", "tsc"), "--noEmit"]);
const tests = run("vitest", [join(modules, "vitest", "vitest.mjs"), "run", ...vitestArgs]);

if (keep) console.log(`\nscratch copy kept at ${work}`);
else rmSync(base, { recursive: true, force: true });
console.log(`\ncheck-against-pi: typecheck ${typecheck === 0 ? "passed" : "FAILED"}, tests ${tests === 0 ? "passed" : "FAILED"}`);
process.exit(typecheck === 0 && tests === 0 ? 0 : 1);
```

`fs.rmSync` removes symlinks without following them, so the cleanup never touches the checkout. The prototype verified this.

### 5.2 Wire and document it

- `package.json`, `scripts`: add `"check:pi": "node scripts/check-against-pi.mjs"` after `"check"`.
- `AGENTS.md`, section Commands, after the `npm run lint:fix` bullet, add:
  - `` `npm run check:pi` typechecks and tests against a local pi checkout (`../pi`, or `PI_CHECKOUT=<dir>`), which must be built. It is not part of `npm run check`. Run it after any change that touches pi APIs, and before a release. `npm run check:pi -- <file>` limits vitest to one file. ``
- `AGENTS.md`, section Releasing, in the pre-release command block, add `npm run check:pi` after `npm run build`.

### 5.3 Verify

- Run `npm run check`. It must pass unchanged.
- Run `npm run check:pi`. It must fail as Appendix B lists: one TS2540 error in `src/mention-clone.ts`, the 16 harness failures and the usage test. `test/worktree.test.ts` fails too when the hook race hits, which makes 18.
- Run `ls "$TMPDIR" | grep pi-subagents-check-`. It must print nothing.

## 6. Phase 1: isolate tests from the developer's git config (T3)

**Goal.** Make every git child process in the suite ignore global and system git configuration.

### 6.1 Create `test/setup/git-isolation.ts`

```ts
/**
 * git-isolation.ts — run every git child process of the suite without the
 * developer's global or system git configuration.
 *
 * A global `core.hooksPath` runs the developer's hooks inside test repos. A
 * post-checkout hook that writes into a fresh worktree (tokensave's `init` is
 * one) makes `cleanupWorktree` see an untracked change, so worktree tests fail
 * intermittently on that machine and never in CI. Tests configure the identity
 * they need locally, so nothing is lost.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const emptyConfig = join(mkdtempSync(join(tmpdir(), "pi-subagents-gitconfig-")), "gitconfig");
writeFileSync(emptyConfig, "");
process.env.GIT_CONFIG_GLOBAL = emptyConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";
```

### 6.2 Register it in `vitest.config.ts`

In the `test` object, directly after the `server: { deps: ... }` line, add:

```ts
    // Every git child process runs without the developer's global hooks and config.
    setupFiles: ["test/setup/git-isolation.ts"],
```

### 6.3 Verify

- Run `for i in 1 2 3 4 5; do npx vitest run test/worktree.test.ts; done`. All five runs must pass.
- Mutation check: remove the `setupFiles` line and rerun the loop. On the user's machine at least one run fails. Restore the line.
- Run `npm run check`.

## 7. Phase 2: floor 0.87.0, test harness and mention clone

**Goal.** Move to pi 0.87, make the suite speak 0.87, and rebuild the mention clone on 0.87 APIs (D2, T1, T2).

### 7.1 Dependencies

1. Run `npm install --save-dev --save-exact @earendil-works/pi-ai@0.87.1 @earendil-works/pi-coding-agent@0.87.1 @earendil-works/pi-tui@0.87.1`.
2. In `package.json`, set the three pi `peerDependencies` to `">=0.87.0"`. Leave `typebox` and `@sinclair/typebox` at `"*"`.
3. Run `npm ls @earendil-works/pi-coding-agent`. It must report `0.87.1`.

`pi-coding-agent` ships an `npm-shrinkwrap.json` that pins its own nested `typebox`. That nested copy is expected, and no manifest change removes it.

After step 1, `npm run typecheck` fails with TS2540 in `src/mention-clone.ts`, and 17 tests fail. Sections 7.2 to 7.6 fix them.

### 7.2 Test harness: legacy context view (T1)

Replace `test/helpers/pi-ai.ts` entirely:

```ts
/**
 * pi-ai.ts — single import point for the faux-provider test helpers.
 *
 * `getModel`, `registerFauxProvider` and `streamSimple` exist only on the
 * `/compat` subpath since pi-ai 0.80. Upstream deletes `/compat` with its
 * coding-agent ModelManager migration; the replacement then is
 * `fauxProvider()` + `createModels()`.
 *
 * `registerFauxProvider` is wrapped. Since pi 0.86 a provider receives a
 * `TranscriptContext`: the system prompt and the tool declarations travel as
 * `role: "system"` messages, and `context.systemPrompt` / `context.tools` are
 * gone. Every scripted responder in this suite reads the older shape, so the
 * wrapper hands each one the context as it looked before: `systemPrompt` and
 * `tools` replayed from the system messages, and `messages` without them.
 */
import { type Context, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import {
  type FauxResponseStep,
  getModel,
  registerFauxProvider as registerTranscriptFauxProvider,
  streamSimple,
} from "@earendil-works/pi-ai/compat";

export { getModel, streamSimple };

/** The pre-0.86 `Context` view of a transcript, as the suite's responders expect it. */
export function toLegacyContext(context: { messages: Context["messages"] }): Context {
  return {
    systemPrompt: getCurrentSystemPrompt(context.messages),
    tools: getCurrentTools(context.messages),
    messages: context.messages.filter((message) => message.role !== "system"),
  };
}

function withLegacyContext(step: FauxResponseStep): FauxResponseStep {
  if (typeof step !== "function") return step;
  return (context, options, state) => step(toLegacyContext(context) as never, options, state);
}

export function registerFauxProvider(...args: Parameters<typeof registerTranscriptFauxProvider>) {
  const registration = registerTranscriptFauxProvider(...args);
  const setResponses = registration.setResponses.bind(registration);
  const appendResponses = registration.appendResponses.bind(registration);
  registration.setResponses = (steps) => setResponses(steps.map(withLegacyContext));
  registration.appendResponses = (steps) => appendResponses(steps.map(withLegacyContext));
  return registration;
}
```

Rationale: one normalization at the faux boundary keeps 16 test files unchanged. Filtering system messages keeps text searches over `context.messages` free of tool descriptions.

### 7.3 Faux registry: `streamSimple`

In `test/helpers/faux-model-backend.ts`, inside the `modelRegistry` object, after `unregisterProvider: () => {},`, add:

```ts
      // ctx.modelRegistry.streamSimple (pi >= 0.86): the mention clone's one request.
      stream: streamSimple,
      streamSimple,
```

### 7.4 Usage test (T2)

In `test/e2e/usage-reaches-session-stats.e2e.test.ts`, replace the whole `it("leaves the context-window percentage alone", ...)` block:

```ts
  it("leaves the context-window percentage alone", async () => {
    // The reported usage must never count as context. If it did, a delegating
    // session would look like it was filling its context with work that happened
    // somewhere else entirely, and users would compact for no reason. Since pi
    // 0.87 the tool result's own text is estimated into context usage, so the
    // control is the same tool result without usage, not an unchanged percentage.
    const withUsage = await realSession();
    const withoutUsage = await realSession();
    try {
      const pool = new PendingUsagePool();
      pool.add({ input: 150_000, output: 400, cacheWrite: 100, cost: 1.5 });
      withUsage.sessionManager.appendMessage(toolResultCarrying(pool.drain()) as any);
      withoutUsage.sessionManager.appendMessage(toolResultCarrying(undefined) as any);

      expect(withUsage.getSessionStats().contextUsage?.percent ?? null).toBe(
        withoutUsage.getSessionStats().contextUsage?.percent ?? null,
      );
    } finally {
      withUsage.dispose?.();
      withoutUsage.dispose?.();
    }
  });
```

In the same file's header comment, replace the sentence that begins "The floor has since moved on past it" with: `The floor has since moved on past it (to 0.87.0), so this no longer pins the range's lower edge. It still pins the behaviour that made 0.80.x unsupportable.`

### 7.5 Mention clone redesign (D2)

**Why a redesign, not a patch.** Since 0.87.0 a session builds every request from its `SessionManager` and rebuilds its own system prompt. The prototype tried the session-based alternatives on the fork:

| Variant | Conversation reaches the model | Parent prompt exact |
|---|---|---|
| Current code | no (pushed messages ignored), and it throws first | no |
| Seed `SessionManager.inMemory(cwd, undefined, [header, ...branch])` | yes | no, pi's default prompt replaces it |
| Seeded, plus a loader with `systemPromptOverride` set to the parent prompt | yes | no, the `<cwd>` section is doubled |
| **One direct request via `ctx.modelRegistry.streamSimple`** | **yes** | **yes, byte for byte** |

The direct request is the conversation pi itself would send next. It is `convertToLlm(ctx.sessionManager.buildSessionProjection().messages)`, system messages included, plus one system message that swaps the tools for `Agent`, plus the mention. It also removes the throwaway session, its loader and extension loading, and the wasted second model call. `toolChoice` cannot force the tool: in pi-ai 0.87 `ToolChoice` is only `"auto" | "none"`. The model keeps the free choice it has today.

The exported interfaces `MentionCloneOptions` and `MentionCloneResult` stay unchanged. `test/agent-mention-wiring.test.ts` mocks `runMentionClone` and needs no change.

Replace `src/mention-clone.ts` entirely:

```ts
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
```

Behavior notes that the code encodes:

- `spawned` turns true once `execute` is called, as before. A tool that throws after that point is reported as `{ spawned: true, error }`, so the caller never starts a second agent.
- The `Agent` tool reports its own failures as plain text, not `isError`. The clone cannot tell them apart, which is unchanged behavior.
- The background spawn path never reads `signal`, so a fresh, never-aborted signal is correct.
- jiti maps the `@earendil-works/pi-ai` root to its `compat` entry at runtime. That entry re-exports `getCurrentTools` and `validateToolArguments`. The prototype verified both on the fork.

### 7.6 Mention clone tests

Delete `test/e2e/mention-clone-tool-reachability.e2e.test.ts` (`git rm`). The new e2e test asserts the same property on the real request: `Agent` is the only declared tool.

Replace `test/mention-clone.test.ts` entirely:

```ts
/**
 * mention-clone.test.ts — the clone's one request and what it does with the
 * reply. The model call is stubbed at `ctx.modelRegistry.streamSimple`; pi's
 * own `convertToLlm` and pi-ai's transcript and validation helpers are real.
 * test/e2e/mention-clone.e2e.test.ts runs the same path over a real session.
 */
import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Message,
} from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentMentionReminder } from "../src/mention.js";
import { runMentionClone } from "../src/mention-clone.js";

const readTool = { name: "read", description: "read a file", parameters: Type.Object({ path: Type.String() }) };
const agentDeclaration = {
  name: "Agent",
  description: "start an agent",
  parameters: Type.Object({
    prompt: Type.String(),
    description: Type.String(),
    subagent_type: Type.Optional(Type.String()),
    run_in_background: Type.Optional(Type.Boolean()),
  }),
};

/** The parent's projection: a system message, then one exchange. */
const PROJECTION = [
  { role: "system", content: "PARENT PROMPT", toolsAdded: [readTool, agentDeclaration], timestamp: 1 },
  { role: "user", content: [{ type: "text", text: "earlier question" }], timestamp: 2 },
  { role: "assistant", content: [{ type: "text", text: "earlier answer" }], stopReason: "stop", timestamp: 3 },
  { role: "compactionSummary", summary: "what happened before", tokensBefore: 10, timestamp: 4 },
];

const agentCallReply = (args: Record<string, unknown>, ...more: AssistantMessage["content"]) =>
  fauxAssistantMessage([fauxToolCall("Agent", args), ...more], { stopReason: "toolUse" });
const validArgs = { prompt: "written from context", description: "look", subagent_type: "Explore" };

let reply: AssistantMessage;
let streamSimple: ReturnType<typeof vi.fn>;
let agentTool: any;
let ctx: any;

beforeEach(() => {
  reply = agentCallReply(validArgs);
  streamSimple = vi.fn(() => ({ result: async () => reply }));
  agentTool = {
    ...agentDeclaration,
    label: "Agent",
    execute: vi.fn(async () => ({ content: [{ type: "text", text: "started" }], details: undefined })),
  };
  ctx = {
    cwd: "/work",
    model: { provider: "p", id: "m" },
    thinkingLevel: "high",
    modelRegistry: { streamSimple },
    sessionManager: {
      buildSessionProjection: vi.fn(() => ({ entries: [], messages: PROJECTION })),
      getSessionId: () => "parent-session",
    },
  };
});

const clone = () => runMentionClone({ ctx, type: "Explore", message: "check the RPC path", agentTool });
const sentMessages = (): Message[] => streamSimple.mock.calls[0][1].messages;

describe("the clone's request", () => {
  it("is exactly one call", async () => {
    await clone();
    expect(streamSimple).toHaveBeenCalledTimes(1);
  });

  it("carries the conversation pi would send, compaction summary included", async () => {
    await clone();
    const texts = sentMessages()
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => JSON.stringify(m.content));
    expect(texts[0]).toContain("earlier question");
    expect(texts[1]).toContain("earlier answer");
    expect(texts[2]).toContain("what happened before");
  });

  it("keeps the parent's system prompt byte for byte", async () => {
    await clone();
    expect(getCurrentSystemPrompt(sentMessages())).toBe("PARENT PROMPT");
  });

  it("declares the Agent tool and nothing else", async () => {
    await clone();
    expect(getCurrentTools(sentMessages()).map((t) => t.name)).toEqual(["Agent"]);
  });

  it("ends with the message, then the reminder", async () => {
    await clone();
    const last = sentMessages().at(-1) as { role: string; content: Array<{ text: string }> };
    expect(last.role).toBe("user");
    expect(last.content[0].text).toBe(`check the RPC path\n\n${agentMentionReminder("Explore")}`);
  });

  it("uses the parent's model, session id and thinking level", async () => {
    await clone();
    const [model, , options] = streamSimple.mock.calls[0];
    expect(model).toBe(ctx.model);
    expect(options).toMatchObject({ sessionId: "parent-session", reasoning: "high" });
  });

  it("sends no reasoning level when the session thinks at off", async () => {
    ctx.thinkingLevel = "off";
    await clone();
    expect(streamSimple.mock.calls[0][2]).not.toHaveProperty("reasoning");
  });

  it("leaves the parent's projection untouched", async () => {
    const before = JSON.stringify(PROJECTION);
    await clone();
    expect(JSON.stringify(PROJECTION)).toBe(before);
  });
});

describe("attributing the spawn to the real session", () => {
  it("runs the real Agent handler with the MAIN context and no tool-call id", async () => {
    expect(await clone()).toEqual({ spawned: true });
    const [toolCallId, , signal, , passedCtx] = agentTool.execute.mock.calls[0];
    expect(toolCallId).toBeUndefined();
    expect(signal.aborted).toBe(false);
    expect(passedCtx).toBe(ctx);
  });

  it("forwards the parameters the model chose, forced into the background", async () => {
    reply = agentCallReply({ ...validArgs, run_in_background: false });
    await clone();
    expect(agentTool.execute.mock.calls[0][1]).toEqual({ ...validArgs, run_in_background: true });
  });

  it("honours only the first Agent call", async () => {
    reply = agentCallReply(validArgs, fauxToolCall("Agent", { ...validArgs, prompt: "second" }));
    await clone();
    expect(agentTool.execute).toHaveBeenCalledTimes(1);
    expect(agentTool.execute.mock.calls[0][1].prompt).toBe("written from context");
  });

  it("applies the tool's prepareArguments before validating, as pi's loop does", async () => {
    agentTool.prepareArguments = (args: any) => ({ ...args, prompt: `prepared: ${args.prompt}` });
    await clone();
    expect(agentTool.execute.mock.calls[0][1].prompt).toBe("prepared: written from context");
  });
});

describe("when the clone cannot deliver", () => {
  it("reports a reply that never called the tool", async () => {
    reply = fauxAssistantMessage([fauxText("I would start Explore.")]);
    expect(await clone()).toEqual({ spawned: false, error: "the conversation clone did not start it" });
    expect(agentTool.execute).not.toHaveBeenCalled();
  });

  it("reports a provider error", async () => {
    reply = fauxAssistantMessage([], { stopReason: "error", errorMessage: "rate limited" });
    expect(await clone()).toEqual({ spawned: false, error: "rate limited" });
  });

  it("rejects arguments that do not match the tool schema", async () => {
    reply = agentCallReply({ description: "no prompt" });
    const result = await clone();
    expect(result.spawned).toBe(false);
    expect(result.error).toContain("prompt");
    expect(agentTool.execute).not.toHaveBeenCalled();
  });

  it("reports a missing model without calling anything", async () => {
    ctx.model = undefined;
    expect(await clone()).toEqual({ spawned: false, error: "no model is selected" });
    expect(streamSimple).not.toHaveBeenCalled();
  });

  it("returns a thrown error rather than rejecting", async () => {
    streamSimple.mockImplementation(() => {
      throw new Error("no credentials");
    });
    await expect(clone()).resolves.toEqual({ spawned: false, error: "no credentials" });
  });

  it("keeps a spawn the tool already started when the tool then throws", async () => {
    agentTool.execute.mockRejectedValue(new Error("late failure"));
    expect(await clone()).toEqual({ spawned: true, error: "late failure" });
  });
});
```

Create `test/e2e/mention-clone.e2e.test.ts`:

```ts
/**
 * mention-clone.e2e.test.ts — the mention clone against a REAL parent session.
 *
 * The unit suite stubs the model call and hands the clone a hand-built
 * projection. What it cannot establish is that pi's own projection of a real
 * session, sent as the clone sends it, reaches the model as the conversation
 * under the parent's live system prompt, with the `Agent` tool as the only
 * tool. Pi 0.87 changed exactly that seam: a session-based clone kept passing
 * its unit tests while every real mention fell back to a direct start.
 *
 * No network: a faux provider answers, and the assertions read the one request
 * it received.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentMentionReminder } from "../../src/mention.js";
import { runMentionClone } from "../../src/mention-clone.js";
import { fauxModelBackend } from "../helpers/faux-model-backend.js";
import { registerFauxProvider } from "../helpers/pi-ai.js";

vi.setConfig({ testTimeout: 30_000 });

describe("mention clone over a real session", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-mention-clone-"));
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });
  afterEach(() => {
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
  });

  /** A real parent session with a custom prompt, read/bash tools and one finished exchange. */
  async function parentWithHistory() {
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: join(cwd, "agent"),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => "PARENT PROMPT",
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd,
      model,
      modelRuntime: backend.modelRuntime,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      tools: ["read", "bash"],
    } as never);
    faux.setResponses([fauxAssistantMessage("EARLIER ANSWER")]);
    await session.prompt("EARLIER QUESTION");
    const ctx = { cwd, model, modelRegistry: backend.modelRegistry, sessionManager: session.sessionManager } as never;
    return { session, ctx };
  }

  const agentTool = () =>
    ({
      name: "Agent",
      label: "Agent",
      description: "start an agent",
      parameters: Type.Object({ prompt: Type.String(), description: Type.String() }),
      execute: vi.fn(async () => ({ content: [{ type: "text", text: "started" }], details: undefined })),
    }) as any;

  it("sends the conversation under the live system prompt, with Agent as the only tool", async () => {
    const { session, ctx } = await parentWithHistory();
    const entriesBefore = JSON.stringify(session.sessionManager.getEntries());
    const seen: any[] = [];
    faux.setResponses([
      (context) => {
        seen.push(context);
        return fauxAssistantMessage([fauxToolCall("Agent", { prompt: "written", description: "d" })], {
          stopReason: "toolUse",
        });
      },
    ]);
    const tool = agentTool();

    const result = await runMentionClone({ ctx, type: "Explore", message: "MENTION", agentTool: tool });

    expect(result).toEqual({ spawned: true });
    expect(seen).toHaveLength(1);
    expect(faux.getPendingResponseCount()).toBe(0);
    const [request] = seen;
    expect(request.systemPrompt).toBe(session.systemPrompt);
    expect(request.tools.map((t: { name: string }) => t.name)).toEqual(["Agent"]);
    expect(request.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(request.messages[0].content)).toContain("EARLIER QUESTION");
    expect(request.messages[2].content[0].text).toBe(`MENTION\n\n${agentMentionReminder("Explore")}`);
    expect(tool.execute.mock.calls[0][1]).toEqual({ prompt: "written", description: "d", run_in_background: true });
    expect(JSON.stringify(session.sessionManager.getEntries())).toBe(entriesBefore);
    session.dispose();
  });

  it("sends the compaction summary instead of the turns it replaced", async () => {
    const { session, ctx } = await parentWithHistory();
    session.sessionManager.appendCompaction("SUMMARY OF EARLIER WORK", null, 1000);
    const seen: any[] = [];
    faux.setResponses([
      (context) => {
        seen.push(context);
        return fauxAssistantMessage([fauxToolCall("Agent", { prompt: "p", description: "d" })], { stopReason: "toolUse" });
      },
    ]);

    await runMentionClone({ ctx, type: "Explore", message: "MENTION", agentTool: agentTool() });

    const conversation = JSON.stringify(seen[0].messages);
    expect(conversation).toContain("SUMMARY OF EARLIER WORK");
    expect(conversation).not.toContain("EARLIER QUESTION");
    session.dispose();
  });
});
```

### 7.7 CI, README and changelog

**`.github/workflows/ci.yml`:**

- In the comment above `compat-floor-pi`, change `(0.84.2)` to `(0.87.1)` and `` (`>=0.84.0`) `` to `` (`>=0.87.0`) ``. Change "That is what moved it twice." to "That is what moved it three times."
- Append this sentence after the 0.81.0 to 0.84.0 explanation: `0.84.0 -> 0.87.0: pi 0.87.0 made SessionManager the only source of provider context and AgentState.systemPrompt read-only, a typecheck failure in the mention clone. The rebuilt clone needs ctx.modelRegistry.streamSimple and transcript system messages (0.86.0).`
- In the `Install floor Pi` step, change the three `@0.84.0` to `@0.87.0`.
- In the `compat-latest-pi` comment, change "as of the 0.84.2 baseline" to "as of the 0.87.1 baseline".

**`README.md` line 53**, replace the paragraph with:

> Requires pi **0.87.0 or newer**. The [`@mention` clone](#starting-a-new-agent) sends the conversation as pi's canonical session projection (pi 0.87.0) through `ctx.modelRegistry.streamSimple` (pi 0.86.0). The `peerDependencies` range declares the floor, so npm flags an older pi at install time.

**`README.md` line 174**, replace the text from "This extension keeps the mechanism and moves it off-screen." through the colon that ends the paragraph with:

> This extension keeps the mechanism and moves it off-screen. The conversation, exactly as pi would send it next, goes out in one extra model request that declares only the `Agent` tool, and what that request starts is an ordinary top-level agent:

**`README.md` line 183**, replace the first sentence with:

> It is a literal clone: pi's own projection of the session (compaction and context edits applied) under the same system prompt, not [`inherit_context`](#agent-frontmatter)'s text rendering of it.

Keep the rest of that paragraph. Keep line 195 unchanged; it stays accurate.

**`CHANGELOG.md`**, under `## [Unreleased]`:

- Add this blockquote directly below the existing protocol v3 blockquote:

  > **⚠️ Breaking: this release requires pi 0.87.0 or newer** (`peerDependencies` moves from `>=0.84.0`). The `@mention` clone now reads pi's canonical session projection (0.87.0) and calls the model through `ctx.modelRegistry.streamSimple` (0.86.0). npm flags an older pi at install time; upgrade pi first.

- Under `### Fixed`, append:

  - **`@agent` mentions in `model` mode start the agent from the conversation again on pi 0.87.** The clone assigned a system prompt that pi 0.87 made read-only, so every mention fell back to a direct start with a warning. The clone is now one off-screen model request carrying the conversation and system prompt pi itself would send, with the `Agent` tool as the only tool.

### 7.8 Verify

1. `npm run check`: lint, typecheck and all tests pass.
2. `npm run check:pi`: typecheck passes. All tests pass, apart from a `worktree` flake if Phase 1 was skipped.
3. Mutation checks, each restored afterwards:
   - In `src/mention-clone.ts`, change `toolsAdded: [declaration],` to `toolsAdded: [declaration, ...getCurrentTools(conversation)],`. Two tests fail across `test/mention-clone.test.ts` and `test/e2e/mention-clone.e2e.test.ts`.
   - Change `...conversation,` to `...conversation.filter((m) => m.role === "system"),`. Three tests fail in those files.

## 8. Phase 3: dispose each run's resource loader (D1)

**Goal.** A subagent's loader stops watching when its run ends, however the run ends.

**Design.** `runAgent` becomes a thin wrapper. It disposes the loader in a `finally` around the renamed body, `runAgentWithLoader`. The body reports its loader through a callback right after constructing it. Disposal at run end, not at session eviction, is deliberate. Completed records live up to 10 minutes (`src/agent-manager.ts`, `cleanup`), and their watchers would keep rescanning for that long. The session stays resumable after disposal, and a test pins that.

### 8.1 Edit `src/agent-runner.ts`

Add this function directly above `export async function runAgent(`:

```ts
/**
 * Stop a subagent loader's resource watchers. Pi builds that watch skill and
 * command directories (`DefaultResourceLoader.dispose`) leave a caller-built
 * loader to its caller, and a finished run no longer needs live reloads.
 * Optional because pi 0.87.x as published has no `dispose`.
 */
function disposeLoader(loader: DefaultResourceLoader): void {
  try {
    (loader as { dispose?: () => void }).dispose?.();
  } catch {
    /* a failed teardown must not replace the run's own outcome */
  }
}
```

Replace the signature of `runAgent` with a wrapper plus the renamed body:

```ts
export async function runAgent(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  // Disposed when the run settles, whichever way: the session stays usable
  // for a later resume, which does not need live skill reloads.
  let loader: DefaultResourceLoader | undefined;
  try {
    return await runAgentWithLoader(ctx, type, prompt, options, (created) => {
      loader = created;
    });
  } finally {
    if (loader) disposeLoader(loader);
  }
}

async function runAgentWithLoader(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
  onLoader: (loader: DefaultResourceLoader) => void,
): Promise<RunResult> {
  const config = getConfig(type);
  // ... the existing body continues unchanged ...
```

Directly after the `const loader = new DefaultResourceLoader({ ... });` statement, and before `await runInChildSessionContext(() => loader.reload());`, add:

```ts
  onLoader(loader);
```

### 8.2 Unit tests in `test/agent-runner.test.ts`

1. In the `vi.hoisted` object, after `defaultResourceLoaderCtor: vi.fn(),`, add:

   ```ts
     loaderDispose: vi.fn(),
     // Published pi 0.87.x has no DefaultResourceLoader.dispose; builds that watch resources do.
     loaderShape: { hasDispose: true },
   ```

   Add `loaderDispose,` and `loaderShape,` to the destructuring above it.

2. In the mocked `DefaultResourceLoader` constructor, after `defaultResourceLoaderCtor(options);`, add:

   ```ts
         if (loaderShape.hasDispose) (this as { dispose?: () => void }).dispose = loaderDispose;
   ```

3. In the top-level `beforeEach`, after `createAgentSession.mockReset();`, add:

   ```ts
     loaderDispose.mockReset();
     loaderShape.hasDispose = true;
   ```

4. Append this block at the end of the file:

   ```ts
   describe("agent-runner loader lifecycle", () => {
     // A loader's resource watchers outlive the run unless runAgent disposes it:
     // pi leaves a caller-built loader to its caller.
     it("disposes the loader once the run completes", async () => {
       const { session } = createSession("OK");
       createAgentSession.mockResolvedValue({ session });
       session.prompt.mockImplementation(async () => {
         expect(loaderDispose).not.toHaveBeenCalled();
         session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
       });
       await runAgent(ctx, "Explore", "go", { pi });
       expect(loaderDispose).toHaveBeenCalledTimes(1);
     });

     it("disposes the loader when the session cannot be built", async () => {
       createAgentSession.mockRejectedValue(new Error("no model"));
       await expect(runAgent(ctx, "Explore", "go", { pi })).rejects.toThrow("no model");
       expect(loaderDispose).toHaveBeenCalledTimes(1);
     });

     it("disposes the loader when the prompt rejects", async () => {
       const { session } = createSession("OK");
       session.prompt.mockRejectedValue(new Error("provider down"));
       createAgentSession.mockResolvedValue({ session });
       await expect(runAgent(ctx, "Explore", "go", { pi })).rejects.toThrow("provider down");
       expect(loaderDispose).toHaveBeenCalledTimes(1);
     });

     it("runs on a pi whose loader has no dispose", async () => {
       loaderShape.hasDispose = false;
       const { session } = createSession("OK");
       createAgentSession.mockResolvedValue({ session });
       await expect(runAgent(ctx, "Explore", "go", { pi })).resolves.toMatchObject({ responseText: "OK" });
     });

     it("keeps the run's result when dispose throws", async () => {
       loaderDispose.mockImplementation(() => {
         throw new Error("watcher already closed");
       });
       const { session } = createSession("OK");
       createAgentSession.mockResolvedValue({ session });
       await expect(runAgent(ctx, "Explore", "go", { pi })).resolves.toMatchObject({ responseText: "OK" });
     });
   });
   ```

### 8.3 Integration test `test/e2e/loader-lifecycle.e2e.test.ts`

The watcher block runs only on a pi whose loader has `dispose`, which today means `npm run check:pi` against the fork. It includes a control that proves the detector sees rescans on that build. The resume block runs on every pi.

Both watcher tests trigger a rescan by editing a skill file, never by writing into the agent directory. Pi watches skill folders directly, but it watches the agent directory only as a stand-in for a missing `commands/` folder. A future fork fix may drop that stand-in. The prototype measured this on the fork, with one loader per row:

| `commands/` exists | Trigger | Rescans |
|---|---|---|
| no | write `extension.log` in the agent directory | 2 |
| no | edit `skills/demo/SKILL.md` | 1 |
| yes | write `extension.log` in the agent directory | 0 |
| yes | edit `skills/demo/SKILL.md` | 1 |

```ts
/**
 * loader-lifecycle.e2e.test.ts — a subagent's resource loader must not
 * outlive its run, and the run's session must stay resumable once it is gone.
 *
 * Pi builds with resource watching (`DefaultResourceLoader.dispose`, not in
 * published 0.87.x) start directory watchers on every loader and dispose only
 * loaders they built themselves. `runAgent` builds its own, so every finished
 * subagent kept its watchers, and each write in the agent directory re-scanned
 * skills and commands once per finished agent. The watcher block runs only on
 * such a build (`npm run check:pi` against the fork); the resume block runs on
 * every pi.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../../src/agent-runner.js";
import { registerAgents } from "../../src/agent-types.js";
import type { AgentConfig } from "../../src/types.js";
import { fauxModelBackend } from "../helpers/faux-model-backend.js";
import { registerFauxProvider } from "../helpers/pi-ai.js";
import { agentCall, runPrintMode } from "../helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 30_000 });

const WATCHES = typeof (DefaultResourceLoader.prototype as { dispose?: unknown }).dispose === "function";
/** Longer than the watcher debounce (100 ms) plus FSEvents delivery latency. */
const SETTLE_MS = 1500;
const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

/** Count the rescans a loader performs from now on. */
function countRescans(loader: ResourceLoader) {
  return vi.spyOn(loader as unknown as { refreshSkillsAndCommands: () => void }, "refreshSkillsAndCommands");
}

describe.skipIf(!WATCHES)("a finished subagent's loader stops watching", () => {
  let cwd: string;
  let agentDir: string;
  let prevAgentDir: string | undefined;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-loader-"));
    agentDir = join(cwd, "agent");
    mkdirSync(join(agentDir, "skills", "demo"), { recursive: true });
    writeFileSync(join(agentDir, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\nbody\n");
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });
  afterEach(() => {
    faux.unregister();
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(cwd, { recursive: true, force: true });
  });

  /**
   * Edit the demo skill. The trigger is a skill file because pi watches skill
   * folders directly. The agent directory itself is watched only as a stand-in
   * for a missing `commands/` folder, so a write there would stop reaching the
   * watcher if pi narrowed that fallback.
   */
  const touchSkill = () =>
    writeFileSync(join(agentDir, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: changed\n---\nbody\n");

  it("control: a live loader rescans when a skill changes", async () => {
    const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noThemes: true });
    await loader.reload();
    const rescans = countRescans(loader);
    touchSkill();
    await settle();
    expect(rescans).toHaveBeenCalled();
    (loader as { dispose?: () => void }).dispose?.();
  });

  it("does not rescan once runAgent has returned", async () => {
    registerAgents(
      new Map([
        [
          "loader-e2e",
          {
            name: "loader-e2e",
            description: "loader-e2e",
            builtinToolNames: ["read"],
            extensions: false,
            skills: true,
            systemPrompt: "You are a test agent.",
            promptMode: "replace",
            inheritContext: false,
            runInBackground: false,
            isolated: false,
          } as AgentConfig,
        ],
      ]),
    );
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    faux.setResponses([fauxAssistantMessage("done")]);
    let loader: ResourceLoader | undefined;
    const ctx = {
      cwd,
      model,
      getSystemPrompt: () => "PARENT",
      modelRegistry: { ...backend.modelRegistry, runtime: backend.modelRuntime },
    } as never;

    await runAgent(ctx, "loader-e2e", "go", {
      pi: { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as never,
      model,
      onSessionCreated: (session) => {
        loader = session.resourceLoader;
      },
    });

    expect(loader).toBeDefined();
    const rescans = countRescans(loader as ResourceLoader);
    touchSkill();
    await settle();
    expect(rescans).not.toHaveBeenCalled();
  });
});

describe("a finished subagent stays resumable after its loader is disposed", () => {
  it("resumes the same conversation by agent id", async () => {
    let parentCalls = 0;
    let agentId: string | undefined;
    const childUserTurns: number[] = [];
    const run = await runPrintMode({
      prompt: "go",
      maxModelCalls: 12,
      respond: (context) => {
        const isParent = (context.tools ?? []).some((tool) => tool.name === "Agent");
        if (!isParent) {
          childUserTurns.push(context.messages.filter((m) => m.role === "user").length);
          return childUserTurns.length === 1 ? "FIRST ANSWER" : "RESUMED ANSWER";
        }
        parentCalls++;
        if (parentCalls === 1) return [agentCall({ prompt: "first task", description: "d1", run_in_background: true })];
        if (parentCalls === 2) {
          const spawn = context.messages.find((m) => m.role === "toolResult");
          agentId = JSON.stringify(spawn?.content).match(/Agent ID: ([\w-]+)/)?.[1];
          return "waiting";
        }
        if (parentCalls === 3) {
          return [agentCall({ resume: agentId, prompt: "follow-up", description: "d2", run_in_background: false })];
        }
        return "ALL DONE";
      },
    });
    try {
      expect(agentId).toBeDefined();
      // The resume continued the first conversation: its turn saw both user messages.
      expect(childUserTurns).toEqual([1, 2]);
      const last = run.parentSession.messages.filter((m) => m.role === "toolResult").at(-1);
      expect(JSON.stringify(last?.content)).toContain("RESUMED ANSWER");
    } finally {
      await run.dispose();
    }
  });
});
```

### 8.4 Changelog

Under `### Fixed`, append:

- **Finished subagents no longer keep watching files on pi builds with live resource reloading.** Each run now disposes its resource loader when it ends. Before, every finished subagent kept its directory watchers, and each write in the agent directory rescanned skills and commands once per finished agent.

### 8.5 Verify

1. `npm run check` passes. The watcher block reports as skipped on published pi.
2. `npm run check:pi -- test/e2e/loader-lifecycle.e2e.test.ts` runs 3 tests and passes them all.
3. Mutation check: delete `if (loader) disposeLoader(loader);`. `test/agent-runner.test.ts` fails 3 tests, and `npm run check:pi -- test/e2e/loader-lifecycle.e2e.test.ts` fails "does not rescan once runAgent has returned". Restore the line.

## 9. Phase 4: queue the turn-limit wrap-up on the agent (D4)

**Goal.** The wrap-up message reaches the agent on the turn after `max_turns`, independent of extension `input` handlers.

**Design.** The wrap-up is an internal control message, not user input. `session.agent.steer(message)` enqueues synchronously, before the loop polls its steering queue. This restores the pre-0.86 behavior. `steerAgent` (the `steer_subagent` tool) keeps `session.steer`, because that path carries user-directed input.

### 9.1 Edit `src/agent-runner.ts`

1. Change `import type { Model } from "@earendil-works/pi-ai";` to `import type { Model, UserMessage } from "@earendil-works/pi-ai";`.
2. Directly above `/** Additional turns allowed after the soft limit steer message. */`, add:

   ```ts
   /** The wrap-up instruction a run receives once, at its soft turn limit. */
   export const TURN_LIMIT_STEER = "You have reached your turn limit. Wrap up immediately — provide your final answer now.";

   function turnLimitMessage(): UserMessage {
     return { role: "user", content: [{ type: "text", text: TURN_LIMIT_STEER }], timestamp: Date.now() };
   }
   ```

   Keep the message text byte-identical. `README.md` quotes it in "Graceful Max Turns".

3. In the `turn_end` branch of the `unsubTurns` subscriber, replace `session.steer("You have reached your turn limit. Wrap up immediately — provide your final answer now.");` with:

   ```ts
             // Queued on the agent, not through `session.steer`: since pi 0.86 that
             // awaits every extension `input` handler before queueing, and this
             // listener is not awaited, so the loop's steering poll could run first.
             session.agent.steer(turnLimitMessage());
   ```

### 9.2 Unit tests in `test/agent-runner.test.ts`

1. In `createSession`, replace the `agent` property with:

   ```ts
       agent: { beforeToolCall: undefined, steer: vi.fn() } as {
         beforeToolCall?: (context: any, signal?: any) => Promise<any>;
         steer: ReturnType<typeof vi.fn>;
       },
   ```

2. Inside `describe("agent-runner turn limits", ...)` only, replace every `expect(session.steer)` with `expect(session.agent.steer)`.
3. In the test "steers exactly once on reaching the limit, and does not abort", replace `expect(session.steer.mock.calls[0][0]).toContain("turn limit");` with:

   ```ts
       expect(session.agent.steer.mock.calls[0][0]).toMatchObject({
         role: "user",
         content: [{ type: "text", text: expect.stringContaining("turn limit") }],
       });
   ```

### 9.3 Fixture `test/fixtures/ext-slow-input.ts`

pi discovers extensions in an agent directory only as `.ts` or `.js`, not `.mjs`. Keep this file `.ts`.

```ts
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
```

### 9.4 Integration test `test/e2e/turn-limit-steer.e2e.test.ts`

```ts
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
```

### 9.5 Changelog

Under `### Fixed`, append:

- **The turn-limit wrap-up message reaches the agent on its next turn again.** Since pi 0.86, `steer()` waits for every extension `input` handler before queueing. The wrap-up could therefore miss its turn, and with a slow handler the agent was hard-aborted without ever seeing it. It is now queued on the agent directly.

### 9.6 Verify

1. `npm run check` and `npm run check:pi` pass.
2. Mutation check: replace `session.agent.steer(turnLimitMessage());` with `session.steer(TURN_LIMIT_STEER);`. `test/e2e/turn-limit-steer.e2e.test.ts` fails, and so do four turn-limit unit tests. Restore the line.

## 10. Phase 5: transcript skips system messages and the written prompt (D3)

**Goal.** A spawn's `.output` transcript holds the prompt once and never holds a system message.

### 10.1 Edit `src/output-file.ts`, function `streamToOutputFile`

Replace the comment and initialization of `writtenCount`, and the loop head, with:

```ts
  // Index of the first message this stream is responsible for. A resume hands
  // in the session's length as of just before the run: the session already
  // holds every prior turn, and re-emitting those would duplicate history that
  // is already in the file. A spawn starts at 0 and skips its first user
  // message instead, because `writeInitialEntry` already wrote the prompt. The
  // index cannot be fixed at 1: since pi 0.86 the first message is the system
  // message, not the prompt.
  let writtenCount = startIndex ?? 0;
  let skipInitialPrompt = startIndex === undefined;

  const flush = () => {
    const messages = session.messages;
    while (writtenCount < messages.length) {
      const msg = messages[writtenCount++];
      // System messages carry the prompt and tool declarations, not conversation.
      if (msg.role === "system") continue;
      if (skipInitialPrompt && msg.role === "user") {
        skipInitialPrompt = false;
        continue;
      }
      const entry = {
```

Then delete the now-redundant `writtenCount++;` at the end of the loop body. Leave the `type` mapping and the compaction re-anchor unchanged.

### 10.2 Unit tests in `test/output-file.test.ts`

Inside `describe("streamToOutputFile", ...)`, before the test "writes nothing past the initial entry until turn_end fires", add:

```ts
  it("skips system messages and the already-written prompt (pi >= 0.86 message order)", () => {
    const session = makeFakeSession([
      { role: "system", content: "prompt and tool declarations" },
      { role: "user", content: "do the thing" },
    ]);
    streamToOutputFile(session as never, outPath, "agent-1", "/work");

    session.push(
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "system", content: "", toolsAdded: [{ name: "late_tool" }] },
      { role: "toolResult", content: [{ type: "text", text: "x" }] },
    );
    session.fire({ type: "turn_end" });

    const entries = readEntries();
    expect(entries.map((e) => e.type)).toEqual(["user", "assistant", "toolResult"]);
    expect(entries.some((e) => (e.message as { role?: string }).role === "system")).toBe(false);
  });

  it("writes a resumed run's prompt, which no initial entry covers", () => {
    const session = makeFakeSession([
      { role: "system", content: "p" },
      { role: "user", content: "do the thing" },
      { role: "assistant", content: [{ type: "text", text: "first answer" }] },
    ]);
    streamToOutputFile(session as never, outPath, "agent-1", "/work", 3);

    session.push({ role: "user", content: "and again" }, { role: "assistant", content: [{ type: "text", text: "second" }] });
    session.fire({ type: "turn_end" });

    expect(readEntries().map((e) => e.type)).toEqual(["user", "user", "assistant"]);
  });
```

The existing tests stay valid. A later `user` message is still written; only the first one is skipped.

### 10.3 Integration test `test/e2e/output-transcript.e2e.test.ts`

```ts
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
```

### 10.4 Changelog

Under `### Fixed`, append:

- **Subagent transcripts no longer repeat the initial prompt or record system messages.** Since pi 0.86 a session's first message is the system message, so the writer's fixed starting offset re-wrote the prompt. System messages carry prompt and tool metadata, and the transcript now skips them.

### 10.5 Verify

1. `npm run check` and `npm run check:pi` pass.
2. Mutation check: change `startIndex ?? 0` back to `startIndex ?? 1` and delete the `if (msg.role === "system") continue;` line. Three tests fail across `test/output-file.test.ts` and `test/e2e/output-transcript.e2e.test.ts`. Restore both lines.

## 11. Phase 6: remove compatibility shims below pi 0.87

**Goal.** Delete code and test scaffolding that only served pi below 0.87.0.

| File | Change |
|---|---|
| `src/agent-runner.ts` | Stop passing `modelRegistry` to `createAgentSession`. pi 0.80.8 removed that option, and 0.87.1 never reads it. See 11.1. |
| `test/agent-runner.test.ts` | Update the test "passes the parent model runtime while retaining the legacy model registry". See 11.2. |
| `test/e2e/isolated-provider.e2e.test.ts` | Import `ModelRuntime` statically and drop the version gate. See 11.3. |
| `test/output-file-compaction-e2e.test.ts` | Delete the `modelRegistry: backend.modelRegistry as never,` line and its comment line "Registry for pre-0.80.8 Pi, runtime for post". |
| `test/helpers/faux-model-backend.ts` | Rewrite the header, which still explains the pre-0.80.8 split. See 11.4. |
| `src/skills-contract.ts` | In the header, change `(0.84.x)` to `(0.87.x)`. |
| `src/agent-dir-loader.ts` | No change. The BOM strip is redundant from pi 0.84.3 but harmless, and `test/agent-file-bom.test.ts` pins it. |

### 11.1 `src/agent-runner.ts`

Replace the block from `// Pi 0.80.8 replaced createAgentSession's modelRegistry option with` through the `...(parentModelRuntime !== undefined && { modelRuntime: parentModelRuntime as never }),` line with:

```ts
  // The child must reach the parent's providers, including ones extensions
  // registered at runtime. ExtensionContext exposes only the registry facade,
  // whose private `runtime` field is the ModelRuntime createAgentSession takes.
  // `as never`: an opaque value read off a private field cannot satisfy the
  // ModelRuntime type.
  const parentModelRuntime = (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime;
  const sessionOpts: Parameters<typeof createAgentSession>[0] = {
    cwd: effectiveCwd,
    agentDir,
    sessionManager,
    settingsManager,
    ...(parentModelRuntime !== undefined && { modelRuntime: parentModelRuntime as never }),
```

The remaining object members (`model`, `tools`, `customTools`, `resourceLoader`) stay unchanged.

### 11.2 `test/agent-runner.test.ts`

Rename the test to "passes the parent model runtime, and no registry pi no longer reads". Replace its assertion with:

```ts
    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ modelRuntime }));
    expect(createAgentSession.mock.calls[0][0]).not.toHaveProperty("modelRegistry");
```

### 11.3 `test/e2e/isolated-provider.e2e.test.ts`

- Delete the header paragraph that starts with "VERSION GATE:".
- Replace everything from the comment "// Dynamic, so this file LOADS on pre-migration Pi" through the closing brace of `interface ModelRuntimeLike` with the import `import { ModelRuntime } from "@earendil-works/pi-coding-agent";`. Place it above the `vitest` import.
- Change `describe.skipIf(!MIGRATED)("PR #152 reach: real ModelRegistry exposes .runtime (Pi >= 0.80.8)", () => {` to `describe("PR #152 reach: real ModelRegistry exposes .runtime", () => {`.
- Replace every `RT.create(` with `ModelRuntime.create(`.
- Replace the remaining `ModelRuntimeLike` type reference (the `ModelRegistry` constructor cast) with `ModelRuntime`.

### 11.4 `test/helpers/faux-model-backend.ts`

Replace the header text from "`registerFauxProvider` scripts the *responses*" through "no local login state." with:

```ts
 * `registerFauxProvider` scripts the *responses*, but a session still has to get
 * past model lookup and auth before it streams anything.
 * `createAgentSession` takes `modelRuntime`; the turn itself streams through
 * `modelRuntime.streamSimple`. `modelRegistry` stands in for
 * `ExtensionContext.modelRegistry` in code under test: model lookup, auth
 * checks, and `streamSimple` for the mention clone's one request.
 *
 * Structural fakes (not real instances) keep the suites hermetic: no
 * auth.json, no network, no local login state.
```

### 11.5 Verify

1. `npm run check` and `npm run check:pi` pass.
2. Run `grep -rnE "0\.80\.[0-9]|0\.8[1-6]\.[0-9]|pre-0\.8" src test`. Every remaining hit must describe history, never gate behaviour.

## 12. Phase 7: final verification

1. `npm run check`. Expected on published 0.87.1: 116 test files, about 2241 passed, 11 skipped.
2. `npm run test:e2e`.
3. `npm run build`.
4. `npm run check:pi`. Expected on the fork: typecheck passed, about 2245 passed, 7 skipped.
5. Smoke test through the fork's real CLI. Run it from the repo root. It starts pi in a throwaway directory, with a throwaway agent directory and no network:

   ```bash
   AD=$(mktemp -d); WD=$(mktemp -d)
   printf '{"packages":["%s"]}\n' "$PWD" > "$AD/settings.json"
   ( printf '{"id":"1","type":"get_commands"}\n'; sleep 6 ) \
     | (cd "$WD" && PI_CODING_AGENT_DIR="$AD" PI_OFFLINE=1 \
        node ~/Developer/ai/pi/packages/coding-agent/dist/cli.js --mode rpc --no-session --offline) 2>&1 \
     | tr ',' '\n' | grep -iE 'warning|error|"name":"agents"'
   rm -rf "$AD" "$WD"
   ```

   `$PWD` names this package in the throwaway settings. Expected output: the line `{"name":"agents"`, and no `Warning` or `error` line.

6. Ask the user before a live run: `PI_E2E_LIVE=1 npm run test:e2e` spends real model credits.
7. Hand the user these interactive checks, which no automated test covers:
   - `@explore <text>` in a real session shows `Prompting @explore…` and starts the agent without a "Started @explore directly" warning.
   - A finished agent's `.output` transcript shows the prompt once.
8. Report the numbers the commands printed, not the expected ones above. Counts drift when the tree moves.

## 13. Out of scope

| Item | Why it stays out | Owner |
|---|---|---|
| The fork's main-session loader watches every ancestor of the cwd up to `/`, and all of `~/.pi/agent` when `commands/` is missing. | This is a fork behavior, not this extension's. Phase 3 only stops subagent loaders from multiplying it. | pi fork |
| Subagents never get the fork's `skill` and `slash_command` tools. | `BUILTIN_TOOL_NAMES` comes from `createCodingTools`, so tool scoping drops them. This is a missing feature, not a regression. | follow-up |
| Transcript entries label `custom` and `bashExecution` messages as `toolResult`. | This predates the fork and needs its own format decision. | follow-up |
| `inherit_context` (`src/context.ts`) ignores `context_edit` entries. | This predates the fork, and the text rendering is lossy by design. | follow-up |
| The tokensave post-checkout hook runs `tokensave init` in every agent worktree. | This is the user's environment. Phase 1 only shields the tests from it. | user |
| A CI job against the fork. | CI cannot build a private personal branch. `npm run check:pi` is the local gate. | n/a |

## Appendix A: prototype evidence (2026-09-24)

The prototype applied every source and test change of Phases 0 to 6 to a scratch copy of commit `0dcb600`. The CI, README, CHANGELOG and AGENTS.md edits are prose, so they were not run.

| Check | Published pi 0.87.1 | Fork `personal` @ `c28081104` |
|---|---|---|
| `tsc --noEmit` | clean | clean |
| `biome check src/ test/` | clean | n/a |
| Test suite | 116 files, 2241 passed, 11 skipped | 2245 passed, 7 skipped |
| Watcher tests (Phase 3) | skipped (no `dispose`) | passed |

Behavior probes on the fork, before and after the fixes:

| Probe | Before | After |
|---|---|---|
| Live loaders after 5 completed foreground spawns | 5 (12 watched dirs each) | 0 |
| Rescans after one write in the agent dir, 5 finished spawns | 5 | 0 |
| Wrap-up with a 5 ms child `input` handler, `max_turns: 1` | never seen in 7 calls, hard abort | seen on call 2, "wrapped up" |
| Mention clone with a real parent prompt | throws `Cannot set property systemPrompt` | spawns, one request |
| Clone request: parent prompt exact / tools / conversation | n/a | yes / `["Agent"]` / present |
| Transcript of one spawn | prompt written twice | prompt once, no system entries |
| Resume after the loader was disposed | n/a | continues the same conversation |

Mutation checks run on the prototype:

| Mutation | Result |
|---|---|
| `session.steer` instead of `session.agent.steer` | 5 tests fail |
| Old transcript offset, no system skip | 3 tests fail |
| No loader disposal (published pi, unit tests) | 3 tests fail |
| No loader disposal (fork, e2e) | "does not rescan once runAgent has returned" fails |
| Clone keeps the parent's tools | 2 tests fail |
| Clone drops the conversation | 3 tests fail |

## Appendix B: `npm run check:pi` failures at commit `0dcb600`

- Typecheck: `src/mention-clone.ts(178,43): error TS2540: Cannot assign to 'systemPrompt' because it is a read-only property.`
- Harness drift (T1), 16 tests:
  - `test/e2e/workflow.e2e.test.ts` (3)
  - `test/foreground-concurrency-print-mode-e2e.test.ts` (2)
  - `test/nested-delegation-e2e.test.ts` (1)
  - `test/subagent-error-status-e2e.test.ts` (3)
  - `test/subagents-nested-print-mode-e2e.test.ts` (1)
  - `test/subagents-print-mode-e2e.test.ts` (6)
- Usage test (T2): `test/e2e/usage-reaches-session-stats.e2e.test.ts` › "leaves the context-window percentage alone".
- Environment (T3): `test/worktree.test.ts` › "falls back to pruning when `git worktree remove` fails", intermittently.

Published pi 0.87.1 without the fork reproduces the same list. Bumping the devDependencies alone therefore makes `npm run check` catch this class of drift.
