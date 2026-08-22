# Package-provided agent registration implementation plan

> **Superseded substrate (2026-08-22).** WS2 (`SKILL_AGENTS_WS2_PLAN.md`) generalized and shipped this plan's substrate: §2 is `agent-dir-loader.ts` (`loadAgentsFromDirectory`), §3 is `agent-types.ts`'s external-layer machinery (`buildAgentRegistry(userAgents, { skillAgents })` returning `{ registry, aliases }`), §4/§5/§6 are the per-activation `session_start` wiring and the refreshable `registerAgentTool()`. The package adapter now slots in as a second, non-hidden layer below user agents on this substrate. The event contract, precedence, and test intent below still stand, EXCEPT the protocol clause: "do not bump `PROTOCOL_VERSION`" and "protocol version remains unchanged" now mean "no additional bump beyond WS2's v3 baseline" — WS2 bumped 2 → 3; package registration itself adds no version change.

## Recommendation

Implement `subagents:register-agents` as a declarative event API, not as a fourth command-style RPC method. Keep the proposed `source: import.meta.url` and relative `paths`, but do not support the one-shot factory-time emit unchanged.

Pi's shared event bus is a non-replaying `EventEmitter`, extension load order can place either package first, and factories run even for extensions later removed by an agent's `extensions:` filter. A reliable contract therefore needs:

1. Registration during `session_start`, not at factory time.
2. A direct announcement plus a replay when the matching `subagents:ready` event arrives.
3. A `sessionId` in both event payloads to prevent root and child sessions from accepting each other's registrations.
4. Idempotency keyed by `source`.
5. Dynamic re-registration of the `Agent` tool so its type list changes in the current session.

This keeps package discovery opt-in. `pi-subagents` will read only explicitly registered directories and will not scan all installed Pi packages.

## Target behavior

A package can use this layout:

```text
pi-piv/
├── package.json
├── extensions/
│   └── register-agents.ts
├── agents/
│   ├── piv-code-reviewer.md
│   ├── piv-codebase-analyst.md
│   └── ...
└── skills/
    ├── piv-review-pr/
    │   └── SKILL.md
    └── ...
```

```json
{
  "name": "@your-scope/pi-piv",
  "keywords": ["pi-package"],
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  },
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"]
  }
}
```

Pi continues to load the package's extension and skills. The extension explicitly contributes the otherwise unsupported `agents/` resource.

## Public event contract

### `subagents:register-agents`

```ts
interface RegisterAgentsEvent {
  /** import.meta.url of the registering extension; also the idempotency key. */
  source: string;

  /** Agent directories, relative to the source file unless absolute. No globs. */
  paths: string[];

  /** The active Pi session that owns this registration. */
  sessionId: string;
}
```

Semantics:

- `source` must be a valid `file:` URL. Resolve relative paths against `dirname(fileURLToPath(source))`.
- Each path names one directory. Scan only its immediate `*.md` files, matching current custom-agent behavior.
- Absolute paths are accepted. Relative paths can contain `..`; `../agents` is the expected package layout.
- A repeated event with the same canonical `source` replaces that source's path list without changing its registration order.
- `paths: []` removes that source's contribution for the current session.
- Malformed payloads and unreadable or missing directories produce a concise `console.warn` and do not break the session.
- Events for another `sessionId` are ignored silently because cross-session traffic is normal on Pi's shared bus.
- No acknowledgement event is needed in v1. Package extensions discover availability through `subagents:ready`.

Installed Pi packages already execute trusted extension code with full system access. Path validation here prevents accidental misuse and ambiguous resolution; it is not a sandbox boundary.

### `subagents:ready`

Change the existing payload from `{}` to:

```ts
interface SubagentsReadyEvent {
  sessionId: string;
}
```

This is additive for existing listeners that ignore the payload. Do not bump `cross-extension-rpc.ts`'s `PROTOCOL_VERSION`; ping, spawn, stop, and their reply envelopes are unchanged.

### Registration extension

Document this lifecycle-safe adapter instead of a factory-time one-shot emit:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const registration = {
  source: import.meta.url,
  paths: ["../agents"],
};

export default function registerPackageAgents(pi: ExtensionAPI) {
  let sessionId: string | undefined;
  let unsubscribeReady: (() => void) | undefined;

  const announce = () => {
    if (!sessionId) return;
    pi.events.emit("subagents:register-agents", {
      ...registration,
      sessionId,
    });
  };

  pi.on("session_start", (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    unsubscribeReady?.();
    unsubscribeReady = pi.events.on("subagents:ready", (raw) => {
      const ready = raw as { sessionId?: string };
      if (ready.sessionId === sessionId) announce();
    });

    // Handles the case where pi-subagents started first.
    announce();
  });

  pi.on("session_shutdown", () => {
    unsubscribeReady?.();
    unsubscribeReady = undefined;
    sessionId = undefined;
  });
}
```

The two load-order cases are then deterministic:

- Provider starts first: its direct announcement is missed, then it replays when `pi-subagents` emits `subagents:ready`.
- `pi-subagents` starts first: the provider misses readiness, then its direct `session_start` announcement is received.

Both listeners are installed only for bound extensions and removed on shutdown, so filtered-out child activations do not leak listeners.

## Registry and precedence

Use four explicit layers:

```text
embedded defaults
  < package registrations
  < global agents
  < .agents/agents
  < .pi/agents
```

Consequences:

- Package agents can override an embedded default.
- User-owned files always override package agents.
- A project `enabled: false` stub disables a package agent in the same way it disables a default.
- Within one registration, later `paths` win.
- Across package registrations, later sources win and emit a collision warning naming both sources.
- Replaying an unchanged source is idempotent and must not reorder it.

Keep the package-agent layer separate from user agents. The runtime registry in `src/agent-types.ts` is already module-global and child activations call the normal reload path. A persistent package layer prevents those reloads from erasing package agents.

Only the activation that owns `Symbol.for("pi-subagents:manager")` should accept package registrations. That is the existing root-activation ownership rule. Its registration handler must also require the root session's `sessionId`. Child activations can read the shared package layer but cannot mutate it from child-session events.

## File-level implementation plan

### 1. Add package registration parsing and loading

Create `src/package-agents.ts` containing:

- Event name constants and payload types.
- A registration map type keyed by canonical source URL.
- A pure update function that validates a raw payload against the expected session ID, resolves paths, handles replacement/removal, and reports whether state changed.
- A loader that scans registered directories in deterministic order and returns `Map<string, AgentConfig>` with `source: "package"`.
- Package-to-package collision warnings with the losing and winning `source` values.

Use top-level Node imports only:

- `fileURLToPath` from `node:url`.
- `dirname`, `isAbsolute`, and `resolve` from `node:path`.
- Directory validation helpers from `node:fs`.

Do not inspect package-manager caches, walk `node_modules`, parse package manifests, recurse below a registered directory, or support globs.

### 2. Reuse the existing Markdown parser

Refactor `src/custom-agents.ts` so its current private `loadFromDir` logic is reusable by `src/package-agents.ts`.

Recommended shape:

```ts
export function loadAgentsFromDirectory(
  dir: string,
  source: "project" | "global" | "package",
): Map<string, AgentConfig>
```

Then make `loadCustomAgents(cwd)` merge the returned maps in its existing order. Preserve all frontmatter behavior. Sort `*.md` filenames before parsing so type-list order and tests are deterministic.

Extend `AgentConfig.source` in `src/types.ts` with `"package"`.

### 3. Add a persistent package layer to the unified registry

Update `src/agent-types.ts`:

- Add a module-level `packageAgents` map.
- Add `setPackageAgents(next)` and `clearPackageAgents()` helpers.
- Change `registerAgents(userAgents)` to rebuild in this order: defaults, package agents, user agents.
- Rename local comments and parameter wording from "user agents" to "custom agents" where the map now contains an overlay above the package layer.
- Keep `getUserAgentNames()` limited to actual project/global agents. Add `getPackageAgentNames()` only if tests or UI need it.
- Reset the package layer in test teardown to prevent cross-test state leakage.

Do not move the whole agent registry to a new abstraction in this change. Per-activation registry injection would be a broader refactor and is not required for package declarations.

### 4. Wire registration into the bound root lifecycle

Update `src/index.ts` after the existing manager ownership decision:

- Keep a root-activation registration map and an unsubscribe handle.
- On the first bound `session_start`, before emitting `subagents:ready`:
  1. Capture the current session ID.
  2. If this activation owns the manager registry, subscribe to `subagents:register-agents`.
  3. Validate incoming events against that session ID.
  4. On a changed registration, reload the package layer, rebuild the unified registry, and refresh the `Agent` tool definition.
  5. Register RPC handlers as today.
  6. Emit `subagents:ready` with `{ sessionId }`.
- Keep this idempotent across accidental duplicate `session_start` delivery.
- On `session_shutdown`, unsubscribe the registration listener, clear the root registration map and package-agent layer, then perform the existing RPC/manager cleanup.
- Rename `reloadCustomAgents` to `reloadAgentRegistry` (or equivalent) and make clear that each rebuild preserves the package layer while refreshing user-owned directories.
- Keep per-`Agent` invocation reloads for project/global files. Package directories are refreshed when their source announces and again after `/reload` reactivates the package extension.

Do not register the event listener at factory time. This preserves the lifecycle guarantee established by the issue #142 RPC fix.

### 5. Make Agent tool metadata refreshable

The current full description, compact description, custom template expansion, and `subagent_type` parameter description are computed once. Refactor the Agent tool registration in `src/index.ts` so it can run again after a package registration:

- Convert full and compact description constants into builder functions.
- Keep `buildTypeListText()` and `buildCompactTypeListText()` as the source of truth.
- Build the custom description template each time so `{{typeList}}` and `{{compactTypeList}}` include package agents.
- Wrap the existing `defineTool({...})` body in a `registerAgentTool()` function.
- Call it once during factory initialization and again only when package registration state changes.
- Rebuild the `subagent_type` parameter description at the same time.
- Update the full, compact, and parameter prose to say that installed packages can register agent types.

Pi 0.80 supports `pi.registerTool()` after startup and refreshes a same-named tool immediately. Verify this with a real-session test rather than relying only on a mock.

Do not make settings changes unexpectedly live. `toolDescriptionMode` and scheduling settings should retain their current apply-on-next-session behavior; package registration is the only new refresh trigger.

### 6. Make package agents safe in `/agents`

Update the source handling in `src/index.ts`:

- Add a package source indicator, recommended `◆`.
- Extend the legend to include `◆ = package`.
- Treat an unoverridden package agent as read-only source material.
- Offer `Eject (copy to .md)`, `Disable`, and `Back`.
- Never offer direct Edit or Delete for a package-owned file.
- Reuse the current eject serializer to create a project or personal override.
- Reuse the current disable flow to create an `enabled: false` user stub.
- Once a project/global override exists, show the normal custom-agent actions because the winning config's source is no longer `package`.

Add a focused test for menu action selection. This prevents the current fallback branch from presenting Edit/Delete actions that have no writable file and do nothing.

### 7. Document the API and package layout

Update `README.md`:

- Add package-provided agents to the feature list.
- Add a dedicated section with the package tree, manifest, lifecycle-safe registration extension, path rules, precedence, and collision behavior.
- State that Pi has no native `pi.agents` manifest key, so the adapter extension is required.
- Update custom-agent discovery prose and Agent tool description examples.
- Add `subagents:register-agents` to the event table.
- Document the new `{ sessionId }` payload for `subagents:ready`.
- Update `/agents` source indicators and actions.
- Add `src/package-agents.ts` to the architecture listing.

Add `examples/register-package-agents.ts` using the exact documented adapter. Update `examples/agent-tool-description.md` so its byte-for-byte parity test still matches the full built-in description.

Add one detailed `### Added` bullet under `CHANGELOG.md`'s existing `## [Unreleased]` section. This is a notable feature and should be released as the next `0.x.0` minor when a release is prepared, but do not change the package version as part of implementation.

### 8. Keep RPC registration out of scope

Do not add `subagents:rpc:register-agents` and do not extend `RpcHandle`.

Spawn and stop are request/response operations tied to an active session. Agent-directory contribution is declarative, long-lived, replayable state with source precedence. Treating it as RPC would add request IDs and acknowledgements without solving extension load order, lifecycle filtering, or tool metadata refresh.

## Test plan

### `test/package-agents.test.ts` (new)

Cover the pure registration and loader behavior:

- Resolve `../agents` relative to a `file:` source URL.
- Accept an absolute directory.
- Reject malformed and non-`file:` sources.
- Ignore a foreign session ID without warning.
- Warn and skip missing or non-directory paths.
- Parse package Markdown with the same frontmatter semantics as project/global agents.
- Mark loaded configs with `source: "package"`.
- Preserve declared path order.
- Replace a repeated source idempotently.
- Remove a source with `paths: []`.
- Resolve package collisions deterministically and warn.
- Skip non-Markdown files and do not recurse.

### `test/agent-types.test.ts`

Add registry-layer tests:

- Defaults remain below package agents.
- Package agents remain below project/global agents.
- A user `enabled: false` config suppresses the package agent.
- Disabling embedded defaults does not disable package agents.
- `getUserAgentNames()` excludes package-only entries.
- Package state is cleared after each test.

### `test/rpc-lifecycle-gating.test.ts` or a new wiring test

Keep the issue #142 guarantees and add registration lifecycle coverage:

- No package registration listener exists at factory time.
- The root listener appears only on bound `session_start`.
- `subagents:ready` includes the current session ID.
- A same-session registration is accepted.
- A foreign-session registration is ignored.
- Duplicate `session_start` does not add listeners.
- `session_shutdown` invokes the registration unsubscribe and clears package state.
- A filtered-out activation never advertises or accepts registration.

Use a shared in-memory event bus and run provider/subagents `session_start` handlers in both possible orders. In each order, assert that the package agent appears exactly once.

### `test/tool-description-mode.test.ts`

Add dynamic metadata assertions:

- Register a package agent after initial tool registration.
- Assert that the current `Agent` tool description contains the new type without starting a new session.
- Assert that the `subagent_type` parameter description also contains it.
- Verify full, compact, and custom `{{typeList}}` modes.
- Replaying an unchanged source should not repeatedly re-register the tool.
- Preserve the shipped custom-template parity test.

### `/agents` UI test

Drive the real extension with mocked UI selections or test an extracted pure action selector:

- A package agent offers Eject/Disable/Back.
- It never offers Edit/Delete while package-owned.
- A project override restores normal custom-agent actions.
- The package indicator and legend render.

### Real Pi session integration test

Create a temporary Pi package fixture containing:

- `package.json` with `pi.extensions` and `pi.skills`.
- `extensions/register-agents.ts` using the documented adapter.
- `agents/piv-code-reviewer.md` with a distinctive prompt and tool list.

Load the fixture and `pi-subagents` through the existing real-session test helpers. Prove that:

1. The type is listed after startup in either extension load order.
2. The refreshed Agent tool is callable with that type.
3. The spawned agent receives the package prompt and tool configuration.
4. A `.pi/agents/piv-code-reviewer.md` file overrides it.
5. An `enabled: false` project stub prevents spawning it.

This test is the acceptance proof for the package structure in the problem statement.

## Validation sequence

Run focused tests while implementing, then run the complete required suite:

```bash
npx vitest run test/package-agents.test.ts
npx vitest run test/agent-types.test.ts
npx vitest run test/rpc-lifecycle-gating.test.ts
npx vitest run test/tool-description-mode.test.ts

npm run lint
npm run typecheck
npm run test
```

If dependencies are absent in the new session, run `npm ci` first. Before declaring completion, run LSP diagnostics on every changed TypeScript file and inspect `git diff --check` plus `git status --short`. Do not commit or publish.

## Acceptance criteria

- An installed Pi package can contribute agents from an explicit directory without copying them into `.pi/agents` or the global agent directory.
- Registration works regardless of package extension load order.
- Filtered and concurrent child sessions cannot register agents into the root through shared-bus cross-talk.
- Repeated readiness and registration events are idempotent and do not leak listeners.
- Existing per-invocation custom-agent reloads do not erase package agents.
- Precedence is deterministic: defaults < packages < global < `.agents` < `.pi`.
- Package collisions warn; user overrides remain intentional and quiet.
- Full, compact, custom-template, and parameter type lists update in the current session.
- `/agents` identifies package agents and never edits or deletes installed package files.
- Existing ping/spawn/stop RPC behavior and protocol version remain unchanged.
- README, example adapter, architecture listing, and Unreleased changelog entry describe the shipped behavior.
- Lint, typecheck, and the complete test suite pass with no warnings.

## Explicit non-goals

- Adding native `agents` support to Pi core or its package manifest.
- Automatically scanning npm, git, local package roots, or `node_modules`.
- Recursive agent-directory discovery or glob support.
- Loading agent definitions from remote URLs.
- Directly editing installed package files.
- Refactoring the complete agent registry into per-session dependency injection.
- Preserving a factory-time one-shot registration form that cannot be made load-order and filter safe on Pi's non-replaying event bus.
