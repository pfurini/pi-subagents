/**
 * custom-agents.ts — Load user-defined agents from project (.pi/agents/, plus the shared .agents/agents/ workspace) and global ($PI_CODING_AGENT_DIR/agents/, default ~/.pi/agent/agents/) locations.
 */

import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadAgentsFromDirectoryInto, resetLoadWarnings } from "./agent-dir-loader.js";
import type { AgentConfig } from "./types.js";

/**
 * Scan for custom agent .md files from multiple locations.
 * Discovery hierarchy (higher priority wins):
 *   1. Project:   <cwd>/.pi/agents/*.md (authoritative — also where /agents writes)
 *   2. Workspace: <cwd>/.agents/agents/*.md (shared cross-tool .agents workspace, read-only)
 *   3. Global:    $PI_CODING_AGENT_DIR/agents/*.md (default: ~/.pi/agent/agents/*.md)
 *
 * Project-level agents override global ones with the same name. On a name clash
 * between the two project locations, .pi/agents wins — .pi stays the project
 * authority; .agents/agents is an additional read location.
 * Any name is allowed — names matching defaults (e.g. "Explore") override them.
 *
 * An agent's type comes from its frontmatter `name:`, falling back to the
 * filename — Claude Code's rule, where "the filename doesn't have to match".
 * Because the type is now declared rather than derived from a unique path, two
 * files can claim the same one; the later load wins, as it always has for a
 * filename clash, and `warnSkippedOverride` reports the substitution.
 */
export function loadCustomAgents(cwd: string, strict = false): Map<string, AgentConfig> {
  const globalDir = join(getAgentDir(), "agents");
  const workspaceProjectDir = join(cwd, ".agents", "agents");
  const projectDir = join(cwd, ".pi", "agents");

  const agents = new Map<string, AgentConfig>();
  loadAgentsFromDirectoryInto(agents, globalDir, "global", strict);            // lowest priority
  loadAgentsFromDirectoryInto(agents, workspaceProjectDir, "project", strict); // shared workspace
  loadAgentsFromDirectoryInto(agents, projectDir, "project", strict);          // highest priority (overwrites)

  resetLoadWarnings();
  return agents;
}

export { parseAgentFrontmatter } from "./agent-dir-loader.js";
