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
