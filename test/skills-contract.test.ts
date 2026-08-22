import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalSkillSetJson,
  type SkillSetSnapshot,
} from "../src/skills-contract.js";

const FIXTURE_PATH = join(__dirname, "fixtures", "skills-contract", "skill-set-snapshot.json");

describe("skills-contract conformance", () => {
  it("round-trips the committed fixture byte-for-byte", () => {
    // The canonical rule is a fixpoint on canonical input: re-serializing the
    // committed fixture must reproduce its exact bytes.
    const raw = readFileSync(FIXTURE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as SkillSetSnapshot;
    expect(canonicalSkillSetJson(parsed)).toBe(raw);
  });

  it("parses the fixture into the copied wire types", () => {
    const parsed = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as SkillSetSnapshot;
    expect(parsed.revision).toBe(2);
    expect(parsed.removed).toHaveLength(1);
    const entry = parsed.skills.find(s => s.listingName === "full-contract");
    expect(entry).toBeDefined();
    expect(entry?.visibility.userInvokeError).toBe(false);
    expect(entry?.source.origin).toBe("top-level");
    expect(entry?.baseDir).toContain("full-contract");
  });
});

// Reverse contract pin: the copied wire declarations must still match core's
// source. Whitespace is normalized so this repo's formatting (spaces) can differ
// from core's (tabs) while the declarations stay identical. Skips visibly when
// the pi checkout is absent (CI without the sibling repo, upstream contributors).
const CORE_SKILLS_DIR = join(process.cwd(), "..", "pi", "packages", "coding-agent", "src", "core", "skills");
const EVENTS_SRC = join(CORE_SKILLS_DIR, "skill-set-events.ts");
const RUNTIME_SRC = join(CORE_SKILLS_DIR, "runtime.ts");
const haveCore = existsSync(EVENTS_SRC) && existsSync(RUNTIME_SRC);

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

describe.skipIf(!haveCore)("skills-contract reverse pin (against core source)", () => {
  const eventsWire = [
    'export const SKILLS_CHANGED_CHANNEL = "skills:changed";',
    'export const SKILLS_QUERY_CHANNEL = "skills:query";',
    'export interface SkillSetVisibility { readonly model: "full" | "name" | "no"; readonly user: "yes" | "no"; readonly userInvokeError: boolean; }',
    "export interface SkillSetSnapshot { readonly revision: number; readonly skills: readonly SkillSetSnapshotEntry[]; readonly removed: readonly string[]; }",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: verbatim mirror of core's canonicalSkillSetJson body.
    "export function canonicalSkillSetJson(snapshot: SkillSetSnapshot): string { return `${JSON.stringify(sortKeysRecursively(snapshot), null, 2)}\\n`; }",
  ];
  const runtimeWire = [
    'export const SKILL_AGENTS_REWRITE_MAPS_CHANNEL = "skill-agents:rewrite-maps";',
    'export const SKILL_AGENTS_QUERY_CHANNEL = "skill-agents:query";',
    "export interface SkillAgentRewriteEntry { readonly qualified: string; readonly collided: boolean; }",
    "export interface SkillAgentRewriteMapsEvent { readonly revision: number; readonly maps: SkillAgentRewriteMaps; }",
  ];

  it("skill-set-events wire declarations appear verbatim in core", () => {
    const core = norm(readFileSync(EVENTS_SRC, "utf-8"));
    for (const decl of eventsWire) expect(core).toContain(norm(decl));
  });

  it("rewrite-map wire declarations appear verbatim in core", () => {
    const core = norm(readFileSync(RUNTIME_SRC, "utf-8"));
    for (const decl of runtimeWire) expect(core).toContain(norm(decl));
  });
});
