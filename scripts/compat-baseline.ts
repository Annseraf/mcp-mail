/**
 * Record a compatibility baseline from a git ref (default: upstream v0.2.1).
 *
 *   npm run compat:baseline -- [ref]
 *
 * Builds the ref in a temporary git worktree, replays test/compat/scenario.ts
 * against it (GreenMail must be running, see docs/COMPATIBILITY.md) and writes
 * compat/baseline/<ref>/. Baselines are committed and only ever re-recorded
 * deliberately, never from the code under test.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { legacySession, startServer } from "../test/compat/harness.js";
import { runScenario } from "../test/compat/scenario.js";

const ref = process.argv[2] ?? "v0.2.1";
const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const sha = execFileSync("git", ["rev-parse", `${ref}^{commit}`], { encoding: "utf8" }).trim();
const work = await mkdtemp(path.join(tmpdir(), "mcp-mail-baseline-"));
const run = (cmd: string, args: string[], cwd: string) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit" });

try {
  run("git", ["worktree", "add", "--detach", work, sha], repo);
  run("npm", ["ci", "--no-audit", "--no-fund"], work);
  run("npm", ["run", "build"], work);

  const server = await startServer(work);
  try {
    const call = await legacySession(server);
    const { tools, outputs } = await runScenario(call);
    const out = path.join(repo, "compat", "baseline", ref);
    await mkdir(out, { recursive: true });
    const write = (f: string, v: unknown) =>
      writeFile(path.join(out, f), JSON.stringify(v, null, 2) + "\n");
    await write("tools-list.json", tools);
    await write("outputs.json", outputs);
    await write("meta.json", {
      ref,
      commit: sha,
      protocolVersion: "2025-03-26",
      tools: tools.map((t) => t.name),
    });
    console.log(
      `Baseline for ${ref} (${sha.slice(0, 7)}): ${tools.length} tools, ${outputs.length} steps -> ${out}`,
    );
  } finally {
    await server.stop();
  }
} finally {
  execFileSync("git", ["worktree", "remove", "--force", work], { cwd: repo });
  await rm(work, { recursive: true, force: true });
}
