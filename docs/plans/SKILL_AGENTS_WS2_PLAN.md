# Skill-bundled agents (Workstream 2) implementation plan

## Summary

Implement WS2 of the pi skill system in this repo: discover agents bundled inside
skills (`<skill>/agents/*.md`), register them under qualified `skill:agent` names
with soft scoping, publish the rewrite-map seam back to core, and bump the RPC
contract to v3 (`capabilities.skillAgents`, `subagents:agent-ended`).

This plan **folds** `PACKAGE_AGENT_REGISTRATION_PLAN.md` (same directory): its
§2/§3/§4/§5/§6 mechanisms are generalized into a shared substrate that both
skill-bundled agents (implemented now) and package-registered agents (shaped for,
implemented later) sit on. The package plan's event contract, precedence and
test intent are preserved; only its substrate sections are superseded by the
generalized versions here. Rationale for building the substrate against skill
agents first: they have a real consumer already waiting (the pi fork's landed
core-prep), while package registration's consumer (pi-piv) does not exist yet.

Counterpart: the pi fork at `~/Developer/ai/pi` (branch `personal`), core-prep
commits `bd4bb3f91` + `37b4acfda` + `556c29426`. Core's
`packages/coding-agent/test/suite/support/stub-subagents-extension.ts` v3 mode is
the executable spec this implementation must conform to.

## Frozen inputs (settled with the user — do not re-litigate)

1. Two skills bundling the same otherwise-free bare name: **neither** gets the
   bare alias.
2. **No per-agent disable switch** for skill-bundled agents. Disabling the whole
   skill (visibility `off`) is the only off switch.
3. Skill agents **do** participate in `allowedSubagents: "all"` nested
   delegation.
4. Soft scoping hides **both** the qualified name and the bare alias from global
   listings and `@`-mention autocomplete. They stay spawnable.
5. Case-only collisions are collisions (the registry already folds case).
6. A skill's bundled agents are suppressed **iff** the skill's resolved
   visibility has `userInvokeError === true` (state `off`). Every other state —
   including author-set `disable-model-invocation` + `user-invocable: false`
   "container" skills — leaves the agents registered.
7. Ship v3 + `agent-ended` now.
8. Rewrite maps: re-emit on every registry change with a monotonic `revision`,
   **and** answer `skill-agents:query` pulls. Consumers ignore stale revisions.

## Core contract obligations (verified against core at `556c29426`)

These are behaviors core now implements; the fork must honor them:

- **`subagents:ready` resets negotiation.** Core invalidates its memoized
  presence probe AND captured `version`/`capabilities` on every `ready`, then
  re-pings before the next fork spawn. The fork must keep answering pings at any
  time and keep emitting `ready` on every (re)activation (it already does,
  `src/index.ts:745`).
- **`agent-ended` must always carry a string `status`.** Core drops a payload
  without one as malformed (no success-guessing). Statuses are the fork's native
  terminal set **verbatim**: `completed | steered | error | aborted | stopped` —
  no normalizing `steered` to `completed` (settled in the A.9 2026-08-22
  amendment). Core derives `ok = !(error|stopped|aborted)`.
- **Ordering:** emit `agent-ended` for an agent only after that agent's spawn
  reply has been delivered. (Core buffers pre-reply events keyed by agentId,
  first event wins, but the contract requires post-reply emission.)
- **Capability gate:** core forwards a qualified `skill:agent` type only after a
  ping reply advertising `{version: >= 3, capabilities: {skillAgents: true}}`;
  otherwise it degrades to `general-purpose`. The fork's ping bump is what
  unlocks qualified spawns.
- **Skill-set seam:** core emits `skills:changed` (full authoritative snapshot,
  monotonic `revision`, `removed` as a best-effort delta) on load, `/reload`,
  watch updates, **and visibility changes**. Each entry carries `id` (canonical
  SKILL.md path — the key), `name`, `listingName`, `baseDir`, `source`,
  `frontmatter`, and resolved `visibility {model, user, userInvokeError}`.
  `skills:query {requestId}` returns the same snapshot. A no-op reload may not
  re-emit (coalescing), so never assume one event per reload.
- **Copy, never import.** The wire types (incl. `SkillSetVisibility`),
  `canonicalSkillSetJson`, the rewrite-map types, and the fixture
  `skill-set-snapshot.json` are copied byte-for-byte from core at `556c29426`.
  The published upstream `@earendil-works/pi-coding-agent` (0.84.x) does not ship
  these modules; an import would break this repo's independent build. Under
  upstream pi (no seam), the feature degrades silently: zero skill agents, no
  diagnostics noise.

## Verified repo anchors (as of 0.18.0, HEAD `3f9d35c`)

- `src/custom-agents.ts` — private `loadFromDir(dir, agents, source, strict)`;
  `RESERVED_IN_TYPE = ":"` (:24): a declared `name:` containing `:` is refused,
  so qualified names are unforgeable from files and must be minted by the loader.
- `src/agent-types.ts` — module-global `agents` map; `buildAgentRegistry(userAgents)`
  (:62) = defaults + user overlay, **also called by nested-tools**;
  `registerAgents` (:76) clears and rebuilds; case-insensitive `resolveKeyIn`;
  `getAvailableTypesIn` filters `enabled !== false` (:117); `getAllTypes` (:242);
  ambiguity-refusing `resolveUnambiguousKeyIn`.
- `src/index.ts` — `reloadCustomAgents` (:359) runs on every spawn (a skill layer
  must survive it); `ownsManagerRegistry` root gating (:678); `session_start`
  binding + `subagents:ready` emit `{}` (:720/:745); mention roster
  `mentionTypes()` = `getAvailableTypes()` (:767); Agent tool description +
  `subagent_type` param computed **once** at factory time (:1440-1478);
  `registeredAgentTool` registered once (:2100) and the mention clone holds that
  exact object (:2097-2099); `/agents` uses `getAllTypes` (:2274/:2333); fallback
  selector uses `getAvailableTypes` (:2851).
- `src/nested-tools.ts` (:148-157) — nested registry is
  `buildAgentRegistry(loadCustomAgents(configCwd))`, deliberately not the global
  map; `allowedSubagents: "all"` → no filter.
- `src/cross-extension-rpc.ts` — `PROTOCOL_VERSION = 2` (:26), ping handler
  (:78), reply channel template (:62).
- `src/index.ts:515-520` — completion broadcasts: `isError = error|stopped|aborted`
  routes to `subagents:failed`, everything else (incl. `steered`) to
  `subagents:completed`.
- `src/types.ts:159` — terminal status union incl. `steered`.
- `src/skill-loader.ts` — serves the `skills:` **preload** feature (reads skill
  files into subagent prompts). It scans its own fixed roots and must NOT be
  reused for WS2 discovery: WS2's input is the A.9 snapshot's `baseDir` set
  (which includes CLI `--skill`, settings paths, packages, and nested roots this
  repo cannot re-derive).
- `docs/` is currently **untracked** in this repo.

## Architecture: substrate + adapters

```text
src/agent-layers.ts        (new)  shared substrate: external layer store
src/agent-dir-loader.ts    (new)  shared substrate: directory -> AgentConfig map
src/skills-contract.ts     (new)  byte-for-byte copy of core wire types
src/skill-agents.ts        (new)  skill adapter: A.9 consumer + rewrite-map publisher
src/package-agents.ts      (LATER, not this slice) package adapter
```

The substrate knows nothing about skills or packages. Each adapter turns its
input (A.9 events; `subagents:register-agents` events) into a layer and hands it
to the substrate.

### S1 — Directory loader extraction (substrate; package plan §2 generalized)

Extract the body of `custom-agents.ts`'s private `loadFromDir` into a new
exported function in `src/agent-dir-loader.ts`:

```ts
export function loadAgentsFromDirectory(
  dir: string,
  source: AgentConfig["source"],
  strict?: boolean,
): Map<string, AgentConfig>
```

- Preserve all current frontmatter behavior byte-for-byte (same parser, same
  warnings, same `RESERVED_IN_TYPE` rejection, `enabled: false` retention).
- Sort `*.md` filenames before parsing (deterministic order — the package plan's
  requirement, applied now).
- `loadCustomAgents` becomes a thin composition over it (same merge order).
- Extend `AgentConfig.source` in `src/types.ts` with `"skill"` (and `"package"`
  now, so the later adapter is purely additive). Add optional provenance fields:
  `skillId?: string` (canonical SKILL.md path) and `hidden?: boolean` (soft
  scoping; see S2).

### S2 — External layers in the registry (substrate; package plan §3 generalized)

In `src/agent-types.ts`:

- Add a **root** skill layer: `setSkillAgents(layer)` / `clearSkillAgents()`,
  set only by the root session's adapter (S4). `registerAgents(userAgents)`
  passes it to `buildAgentRegistry`; child/nested registries pass their own
  session's layer explicitly instead (next bullet). Layer entries carry the
  per-skill agent configs plus their minted qualified names and desired bare
  aliases (computed by the adapter, applied at build time).
- Keep `buildAgentRegistry` **pure**. Give it an optional external-layer
  parameter instead of module-global reads:
  `buildAgentRegistry(userAgents, layers?: {skillAgents?: SkillAgentLayer})`.
  The global path (`registerAgents`) passes the root session's layer; the
  nested-tools path receives the layer for **its own session** through
  `NestedToolContext` (frozen input 3 — nested "all" delegation sees skill
  agents), so a worktree/child registry is built from that session's snapshot,
  never the root's. Alias decisions are computed inside the build (they need
  the merged registry) and returned as metadata alongside the map, so the
  caller that owns publication can diff them; a nested rebuild NEVER publishes
  rewrite maps (see S4). Merge order:

  ```text
  defaults < package (empty for now) < user agents   ← existing precedence chain
  + skill layer, applied last but non-competing:
      qualified names: always added (unforgeable — user files cannot contain ":")
      bare aliases:   added only when the name is absent (case-insensitively)
                      from the merged registry AND claimed by exactly one skill
  ```

  Because bare aliases are recomputed on every rebuild, a user adding
  `.pi/agents/reviewer.md` mid-session correctly steals the bare name back on
  the next spawn's `reloadCustomAgents` — the skill agent keeps its qualified
  name. The alias flip changes `collided`, and the returned alias metadata is
  what the session adapter diffs to decide a rewrite-map re-publish (S4).
- Soft scoping: skill-layer entries have `hidden: true`. `getAvailableTypesIn`
  additionally filters `hidden` — this single choke point hides them from the
  Agent tool type list, the `subagent_type` description, `@`-mention roster, the
  fallback selector, and nested `availableIn` text (all verified callers).
  Spawn-time resolution (`resolveSpawnTypeIn`, `isValidTypeIn`, `resolveTypeIn`)
  does **not** filter hidden — spawnable by exact (case-insensitive) name.
  `getAllTypes()` (the `/agents` list) also excludes hidden entries this slice:
  skill agents are managed through the skill (`/skills` in pi core), and
  decision 2 rules out per-agent toggles, so `/agents` has no action to offer.
- Reset helpers for test teardown (`clearSkillAgents` mirrors the package plan's
  layer-reset requirement).

### S3 — Refreshable Agent tool (substrate; package plan §5, needed now)

The Agent tool description and `subagent_type` parameter are computed once at
factory time; skill sets arrive after that (`skills:changed` on load and on
every watch/visibility update). Refactor in `src/index.ts`:

- Wrap the `defineTool({...})` construction (:1452) and registration (:2100) in
  a `registerAgentTool()` function; rebuild the description, the
  `subagent_type` parameter text, and the custom-template expansion each call.
- The mention clone must keep working after a refresh: `mention-clone` is handed
  the registered tool object. Hold the current registered tool in a mutable
  reference and hand the mention path an accessor (or re-create the clone on
  refresh) — pick whichever is smaller after reading `mention-clone.ts` in full.
- Call `registerAgentTool()` once at factory init (unchanged behavior) and again
  only when the skill layer actually changes (S4's change signal). Type lists
  exclude hidden entries, so the *visible* text rarely changes — but the
  refresh keeps custom templates (`{{typeList}}`) and future package agents
  correct, and this is where the ADR-0006 parenthetical lands:
- **Agent tool description gains "(Claude Code skills may call this the Task
  tool)"** (WS2 deliverable, ADR-0006 layer 2). Add it to the full and compact
  descriptions and update `examples/agent-tool-description.md` so the shipped
  byte-for-byte parity test still matches.

### S4 — A.9 lifecycle wiring (substrate boundary; package plan §4 generalized)

**Per-bound-activation, not root-only.** Every subagent session constructs its
own `DefaultResourceLoader` — its own event bus, its own `SkillSetController`,
its own `SkillRuntime` issuing its own `skill-agents:query` pull
(`src/agent-runner.ts:709-731`; the runtime is built per session in core's
`agent-session.ts`). A root-only
subscription would leave every child/worktree session without rewrite maps and
without visibility updates on its own bus. So the seam adapter is
**session-scoped**: each bound activation (root and child alike) wires, on its
own `session_start`, against its own session bus:

1. Subscribe to `skills:changed`; each event replaces that session's skill
   layer wholesale (recompute from `snapshot.skills`; treat `removed` as a hint
   only and `revision` monotonically — ignore stale).
2. Subscribe to `skill-agents:query` and answer pulls with that session's
   current maps (`{success: true, data: {revision, maps}}` on
   `skill-agents:query:reply:<requestId>`).
3. Issue one `skills:query {requestId}` pull with a 2s timeout so an activation
   that binds after core's initial publication still gets the snapshot. (Core
   also re-emits on changes, so a lost pull self-heals; and core's own
   rewrite-map subscription is constructor-installed, so this adapter's initial
   `skill-agents:rewrite-maps` emit after processing the first snapshot covers
   core's possibly-missed constructor pull.)
4. Publication discipline: an adapter publishes rewrite maps **only on its own
   session bus**, derived from its own registry view (root: global registry;
   child: the nested/branch registry for its configCwd). Nested tool-call
   rebuilds never publish (S2).

Only the **root** activation additionally mutates the process-global registry
(`setSkillAgents`) — the existing `ownsManagerRegistry` rule. Child adapters
keep their layer session-local and hand it to `createNestedSubagentTools` via
`NestedToolContext`.

Root activation also: emit `subagents:ready` as today, with the payload widened
from `{}` to `{sessionId}` (additive; core reads no fields — verified. The
package adapter needs it later; landing it now keeps `ready` stable across
slices).

On `session_shutdown`: unsubscribe everything wired above; the root adapter
also runs `clearSkillAgents()`. No terminal re-publish.

Idempotency across duplicate `session_start` delivery and no-listener-at-factory
follow the existing `#142` pattern (`test/rpc-lifecycle-gating.test.ts` encodes
it; extend, don't fork, that test).

**Amendment (2026-08-22, during implementation).** The premise above that a
child activation already binds `session_start` was wrong: this extension's
factory early-returns under `inChildSessionContext()`
(`src/index.ts`, pre-dating WS2), so `bindExtensions` fires `session_start` into
a void and no handler exists to bind. `session_start` alone was never the
obstacle — the factory returning before registering one was. Implemented as
specified by narrowing that early return: a child now runs `bindChildSkillAgents`
and nothing else (no manager, no tools, no commands, no RPC, no readiness
broadcast), and the shared adapter lives in `src/skill-agents-adapter.ts` so root
and child wire identical code over their own buses.

### A1 — Skill-agents adapter (`src/skill-agents.ts`)

Pure functions + one small stateful publisher, mirroring the package plan's
"pure update function + loader" shape:

- **Input:** an A.9 `SkillSetSnapshot` (from `skills:changed` or the query
  reply).
- **Filter:** drop entries with `visibility.userInvokeError === true` (frozen
  input 6).
- **Discover:** for each remaining skill, `loadAgentsFromDirectory(join(baseDir,
  "agents"), "skill")`. A missing `agents/` dir is the normal case — no warning.
  Parse failures warn exactly as user agents do.
- **Mint names:** qualified = `${skill.listingName}:${agentType}`. `listingName`
  (NOT `name`) is the skill's unique callable identity: on a nested collision
  core keeps `name` bare and disambiguates only `listingName`
  (`pi/packages/coding-agent/src/core/skills.ts:414-417` — `apps/web:deploy`
  has `name === "deploy"`, `listingName === "apps/web:deploy"`), and A.9 states
  two nested skills may share a bare `name`. Minting from `name` would let two
  skills produce the same qualified type and cross-wire their rewrite maps.
  Core imposes no grammar on the qualified string — `rewriteAgentNames` and
  `resolveForkAgentType` rewrite to whatever `qualified` value this repo
  publishes in the map, verbatim — so the fork fully owns the qualified form,
  including double-colon forms from dir-qualified listing names. Within one
  snapshot `listingName` is unique (core's `takenListingNames`), so qualified
  collisions cannot occur; keep a defensive first-by-canonical-id warning
  anyway.
- **Bare aliases:** claimed for every bundled agent whose name is
  case-insensitively absent from the non-skill registry AND claimed by no other
  skill (frozen inputs 1 + 5). Alias computation happens in S2's rebuild (it
  needs the merged registry); the adapter just declares candidates.
- **Rewrite maps:** after each rebuild, produce
  `{[skillId]: {[bareName]: {qualified, collided}}}` where `collided` is `true`
  exactly when the bare alias was NOT granted. Every bundled agent appears in
  its skill's map (non-collided entries are inert for core but keep the map
  complete). Publish `skill-agents:rewrite-maps {revision, maps}` when the maps
  changed (deep-compare or serialize-compare; a spawn-triggered rebuild with no
  changes must not spam events), with `revision` monotonically increasing.
  Core keys rewrite lookups by canonical skill id and folds case — emit bare
  names as authored.

### A2 — Protocol v3 (`src/cross-extension-rpc.ts` + `src/index.ts`)

- `PROTOCOL_VERSION` 2 → 3. Ping reply becomes
  `{version: 3, capabilities: {skillAgents: true}}`.
- Emit `subagents:agent-ended {agentId, status, result?, error?}` for **every**
  terminal transition, alongside the existing v2 broadcasts (core dedups; older
  cores only know v2). `status` is the record's native terminal status, always
  present as a string.
- **Ordering is NOT automatic — buffer until the spawn reply.** `handleRpc`
  awaits the handler before emitting the reply
  (`src/cross-extension-rpc.ts:56-62`), so an immediately-failing
  `runAgent(...).catch` completion can be enqueued as a microtask ahead of the
  spawn-reply emission. The A.9 rule requires `agent-ended` only after that
  agent's spawn reply. Implement explicit tracking: hold terminal events for an
  agentId until its spawn reply has been emitted, then flush (RPC-spawned
  agents only; Agent-tool spawns have no RPC reply to wait for and emit
  immediately). Test with an immediately-rejecting run, not just a normally
  async completion.
- **Queued-abort terminal path.** `AgentManager.abort()` on a *queued* record
  sets `status = "stopped"` and returns without any completion callback
  (`src/agent-manager.ts:942-947`) — today that path emits no v2 broadcast
  either (a pre-existing gap: core's foreground waiter would hang to its cap).
  Route queued cancellation through the same terminal-notification mechanism
  exactly once, so both `agent-ended` and the v2 `subagents:failed` fire with
  `status: "stopped"`. Test: saturate the queue, spawn, stop the queued agent,
  observe exactly one post-reply `agent-ended {status: "stopped"}` plus one v2
  broadcast.
- **Cross-repo consequence (do not skip):** core's contract-pin test
  (`pi/packages/coding-agent/test/suite/skills-fork.test.ts` ~:770) asserts
  `PROTOCOL_VERSION = 2` against this repo's source. Landing v3 here breaks that
  test in the pi repo. The follow-up is a one-line pin update in pi (2 → 3);
  record it in the final report and do not attempt to edit the pi repo from the
  implementation session.

### A3 — Copy set + conformance (`src/skills-contract.ts` + fixture)

- Copy from core at `556c29426`, byte-for-byte where marked:
  - the wire declarations of `skill-set-events.ts` (`SkillSetJsonValue`,
    `SkillSetVisibility`, `SkillSetSnapshotSource`, `SkillSetSnapshotEntry`,
    `SkillSetSnapshot`, `SkillsChangedEvent`, `SkillsQueryRequest`, `RpcReply`,
    channel constants, `skillsQueryReplyChannel`, `canonicalSkillSetJson` with
    its `sortKeysRecursively` helper);
  - the rewrite-map declarations of `runtime.ts`
    (`SKILL_AGENTS_REWRITE_MAPS_CHANNEL`, `SKILL_AGENTS_QUERY_CHANNEL`,
    `skillAgentsQueryReplyChannel`, `SkillAgentRewrite*` types);
  - the fixture `skill-set-snapshot.json` into `test/fixtures/skills-contract/`.
- Conformance test: the fixture parses into the copied types, and
  `canonicalSkillSetJson(JSON.parse(fixture))` reproduces the fixture bytes
  exactly (the canonical rule is a fixpoint on canonical input).
- Reverse contract-pin test mirroring core's: when
  `~/Developer/ai/pi/packages/coding-agent/src/core/skills/skill-set-events.ts`
  exists, assert the copied wire-type source text appears in it verbatim;
  visible skip when the checkout is absent.

### Package-agents adapter — SHAPED, NOT IMPLEMENTED

This slice must leave `PACKAGE_AGENT_REGISTRATION_PLAN.md`'s adapter
implementable without substrate rework. Explicit carry-throughs done now:
`source: "package"` in the type union; `ready` carrying `{sessionId}`; the
S1 loader taking any source; S2's layer store designed so a package layer slots
in below user agents (a second, non-hidden layer — the skill layer's
hidden/alias machinery is not entangled with layer ordering). Nothing else from
that plan is built now; its §2/§3/§4/§5/§6 are superseded by S1-S4, the rest
stands.

## TDD plan (red → green per work item)

Order: S1 → S2 → A3 → A1 → S4 → A2 → S3. Run each new/changed test file
immediately (`npx vitest run test/<file>.test.ts`); full suite + lint +
typecheck at the end. `npm ci` first (no `node_modules` in this checkout).

1. **S1 `test/agent-dir-loader.test.ts`:** extraction is behavior-preserving —
   run the existing `custom-agents` tests untouched (green stays green), add:
   deterministic filename-sorted order; `source: "skill"` stamped; `:` in a
   declared `name:` still refused.
2. **S2 `test/agent-types.test.ts` (extend):** qualified always registered +
   hidden; bare alias granted when free, withheld on case-insensitive conflict
   with a user agent, withheld when two skills claim it (neither wins);
   user file added later steals the bare name on rebuild; hidden entries absent
   from `getAvailableTypes`/`getAllTypes` but resolvable by
   `resolveSpawnType`/`isValidType`; nested `buildAgentRegistry` path sees the
   layer (frozen input 3); `clearSkillAgents` teardown.
3. **A3 `test/skills-contract.test.ts`:** fixture round-trip byte-exact; reverse
   contract pin (visible skip without the pi checkout).
4. **A1 `test/skill-agents.test.ts`:** snapshot → layer: discovers
   `<baseDir>/agents/*.md`; skips `userInvokeError: true` skills; re-admits them
   when a later snapshot flips visibility back; missing `agents/` silent;
   qualified names minted from `listingName` (two skills sharing a bare `name`,
   one dir-qualified, produce distinct qualified agents and distinct rewrite
   maps — the review's cross-wiring case); defensive duplicate warning;
   rewrite-map production — `collided` mirrors alias denial, map complete,
   revision monotone, no re-emit when unchanged; stale-revision snapshots
   ignored.
5. **S4 extend `test/rpc-lifecycle-gating.test.ts`:** no A.9 listeners at
   factory time; each bound activation wires its own session bus on
   `session_start` (root and child); only the root mutates the global registry;
   `skills:query` pull issued once with timeout; `skill-agents:query` answered
   with the core envelope; duplicate `session_start` adds nothing; shutdown
   unsubscribes and (root) clears the layer; `ready` carries `{sessionId}`.
   Child-session case: a child activation answers its own bus's
   `skill-agents:query` with maps from the child's snapshot (the review's
   starvation case).
6. **A2 `test/cross-extension-rpc.test.ts` (extend) + completion tests:** ping
   advertises v3 + capabilities; `agent-ended` emitted after the spawn reply
   with a status for every terminal path (`completed`, `steered`, `error`,
   `stopped`, `aborted` — the same split as :515-520), alongside the v2
   broadcasts; payload always has string `status`.
7. **S3 `test/tool-description-mode.test.ts` (extend):** description and
   `subagent_type` text exclude skill agents; refresh on layer change preserves
   custom-template parity (`examples/agent-tool-description.md` updated for the
   Task-tool parenthetical); mention clone still spawns through the refreshed
   tool.
8. **Acceptance (`test/skill-agents-e2e.test.ts` or extend a real-session
   test):** build the reference scenario from the frozen plan in-repo (do NOT
   depend on the external furiai-skills checkout): a `simplify` skill fixture
   with 4 bundled agents exercising qualified/bare resolution, a case-only
   collision (`Reviewer` vs a user `reviewer`), an agent name inside a code
   block (rewrite-map side only — the prose rewrite itself is core's, this repo
   just asserts the map marks it collided), and the Agent-unavailable fallback
   documented as the portable-skill idiom. Drive: publish a snapshot on the
   bus → spawn by qualified name via `subagents:rpc:spawn` → assert the skill
   agent's prompt/tools; assert bare-name spawn works when free; assert a
   `skills:changed` flipping the skill to `off` deregisters it. Post-deregister
   spawn expectation must match `resolveSpawnTypeIn`'s real behavior: with the
   default unset `fallbackSubagent` an unknown type **falls back to
   `general-purpose` with a `fellBackFrom` notice** (agent-types.ts:174-218) —
   assert that; add a second case with `fallbackSubagent: "none"` asserting the
   hard unknown-type error.

## Validation

```bash
npm ci
npx vitest run test/<changed>.test.ts   # per item, red → green
npm run lint
npm run typecheck
npm run test                            # full suite incl. e2e
```

All errors and warnings fixed. LSP diagnostics on every changed file before
declaring done. Per repo rules: **never commit** — leave the tree dirty and
suggest a commit message as text.

## Documentation

- `README.md`: skill-bundled agents section (discovery input = the pi skill-set
  seam, qualified naming, soft scoping, the off-switch being the skill's
  visibility, degradation under upstream pi), event-table rows for
  `skills:changed`/`skills:query` (consumed) and
  `skill-agents:rewrite-maps`/`skill-agents:query` (emitted/answered),
  `subagents:agent-ended` + v3 ping, `ready` payload change, architecture
  listing for the new files.
- `CHANGELOG.md`: one `### Added` bullet under `[Unreleased]` for the feature +
  one `### Changed` for PROTOCOL_VERSION 3 / `ready` payload. Next release is a
  minor.
- Amend `PACKAGE_AGENT_REGISTRATION_PLAN.md` (short note at top): substrate
  sections §2/§3/§4/§5/§6 superseded by this plan's S1-S4; the event contract
  and the rest stand, EXCEPT its protocol clause: "do not bump
  `PROTOCOL_VERSION`" and the "protocol version remains unchanged" acceptance
  criterion now mean "no additional bump beyond WS2's v3 baseline" (WS2 bumps
  2 → 3; package registration itself adds no version change).

## Risks / open points (for adversarial review)

1. **Rebuild frequency:** `reloadCustomAgents` runs per spawn; alias recompute +
   map-diff runs with it. Cost is trivial (in-memory), but the no-change
   re-emit suppression must be correct or core sees revision churn.
2. **Mention-clone refresh:** the clone captures the registered tool object;
   verify the accessor refactor against `mention-clone.ts` before implementing.
3. **`/agents` exclusion** (S2) is a judgment call: skill agents are invisible
   there this slice. If review argues users need introspection, the fallback is
   a read-only row with no actions — do not add per-agent disable (frozen 2).
4. **Child-session layer scope** (S4): the per-activation adapter is the
   corrected design. RESOLVED during implementation — a child activation does
   NOT bind `session_start` for this extension by default (the factory returns
   first under `inChildSessionContext()`); the early return was narrowed to run
   the adapter alone. See the S4 amendment. `NestedToolContext` carries the
   layer per branch without leaking it across branches.

## Adversarial review incorporated (2026-08-22, pre-implementation)

Reviewed by an adversarial subagent (model `openai-codex/gpt-5.6-sol`) grounded
in both repos; all findings verified against source and accepted:

- **Blocking, qualified identity:** minting from `skill.name` was wrong — core
  keeps `name` bare on nested collisions and disambiguates `listingName` only
  (`skills.ts:414-417`), so two skills can share a `name` and would have
  cross-wired rewrite maps. A1 now mints from `listingName` (unique per
  snapshot; the qualified string is fork-owned, core rewrites to it verbatim).
- **Blocking, root-only starvation:** each subagent session has its own
  loader/bus/SkillRuntime (`agent-runner.ts:709-731`), so a root-only
  subscription left child sessions without rewrite maps and visibility. S4 is
  now a per-bound-activation session-scoped adapter; only the root mutates the
  global registry; publication is per-session-bus only.
- **Blocking, `agent-ended` ordering:** `handleRpc` awaits before replying, so
  an instantly-failing run's completion can precede the spawn reply. A2 now
  buffers terminal events per agentId until the spawn reply is emitted.
- **Blocking, queued abort:** `abort()` on a queued record emits no completion
  at all (pre-existing v2 gap). A2 routes queued cancellation through the
  terminal notification exactly once.
- **Important, registry purity:** folding a mutable layer into
  `buildAgentRegistry` clashed with nested-tools' pure per-branch use. S2 keeps
  it pure with an explicit layer parameter + alias metadata return; nested
  rebuilds never publish.
- **Important, e2e fallback:** unknown-type spawns fall back to
  `general-purpose` by default; the acceptance test now asserts fallback and
  adds a `fallbackSubagent: "none"` case.
- **Important, package-plan coherence:** its "do not bump PROTOCOL_VERSION"
  clause now reads against the WS2 v3 baseline (documented amendment).
- **Verified-correct claims** (unchanged): the `:`-unforgeability of qualified
  names, `buildAgentRegistry`'s two callers, the `getAvailableTypesIn` choke
  point, core's case-insensitive lexical rewrite + verbatim qualified
  passthrough, no `:`-splitting in this repo, the SkillRuntime constructor-pull
  race healed by the initial map emit, the cross-repo pin breakage on v3, the
  fixture being a byte-exact canonical fixpoint, and the copy set's
  import-freedom.
