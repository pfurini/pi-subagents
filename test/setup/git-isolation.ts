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
