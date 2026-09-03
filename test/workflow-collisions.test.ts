import { describe, expect, it } from "vitest";
import { decideWorkflowCollision, FOREIGN_WORKFLOW_TOOL_NAMES } from "../src/workflow/collisions.js";

const OWN_DESCRIPTION = "Run a deterministic script that orchestrates many subagents.";

describe("decideWorkflowCollision", () => {
  it("reports no collision when no foreign workflow tool is present", () => {
    const verdict = decideWorkflowCollision({
      tools: [{ name: "Agent", description: "Launch a sub-agent." }],
      ownDescription: OWN_DESCRIPTION,
      pinned: false,
    });
    expect(verdict).toEqual({ kind: "none" });
  });

  it("stands down for a foreign tool literally named \"Workflow\"", () => {
    const verdict = decideWorkflowCollision({
      tools: [{ name: "Workflow", description: "Some other extension's workflow tool." }],
      ownDescription: OWN_DESCRIPTION,
      pinned: false,
    });
    expect(verdict.kind).toBe("standDown");
  });

  it("stands down for a foreign tool named \"workflow\" (lowercase, e.g. pi-dynamic-workflows)", () => {
    const verdict = decideWorkflowCollision({
      tools: [{ name: "workflow", description: "Some other extension's workflow tool." }],
      ownDescription: OWN_DESCRIPTION,
      pinned: false,
    });
    expect(verdict.kind).toBe("standDown");
  });

  it("stands down for a foreign tool named \"WORKFLOW\" (any casing)", () => {
    const verdict = decideWorkflowCollision({
      tools: [{ name: "WORKFLOW", description: "Some other extension's workflow tool." }],
      ownDescription: OWN_DESCRIPTION,
      pinned: false,
    });
    expect(verdict.kind).toBe("standDown");
  });

  it("does not treat a same-name tool with our own description as foreign", () => {
    const verdict = decideWorkflowCollision({
      tools: [{ name: "SubagentWorkflow", description: OWN_DESCRIPTION }],
      ownDescription: OWN_DESCRIPTION,
      pinned: false,
    });
    expect(verdict).toEqual({ kind: "none" });
  });

  it("does not treat an unrelated tool whose name merely contains \"workflow\" as foreign", () => {
    const verdict = decideWorkflowCollision({
      tools: [{ name: "github_workflow_run", description: "Trigger a GitHub Actions workflow." }],
      ownDescription: OWN_DESCRIPTION,
      pinned: false,
    });
    expect(verdict).toEqual({ kind: "none" });
  });

  it("reports rather than stands down when a lowercase foreign tool took our own name and workflows are pinned", () => {
    const verdict = decideWorkflowCollision({
      tools: [{ name: "subagentworkflow", description: "Some other extension's workflow tool." }],
      ownDescription: OWN_DESCRIPTION,
      pinned: true,
    });
    expect(verdict.kind).toBe("report");
  });

  it("FOREIGN_WORKFLOW_TOOL_NAMES documents the canonical (non-lowercased) names", () => {
    expect([...FOREIGN_WORKFLOW_TOOL_NAMES]).toEqual(["SubagentWorkflow", "Workflow"]);
  });
});
