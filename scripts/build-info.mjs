#!/usr/bin/env node
// Writes dist/build-info.json so /version can report what is running.
// CI sets BUILD_COMMIT / IMAGE_DIGEST; locally we ask git.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
let commit = process.env.BUILD_COMMIT ?? process.env.GITHUB_SHA;
if (!commit) {
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    commit = "unknown";
  }
}
const info = {
  name: pkg.name.replace(/^@[^/]+\//, ""),
  version: pkg.version,
  commit,
  buildTime: process.env.BUILD_TIME ?? new Date().toISOString(),
  imageDigest: process.env.IMAGE_DIGEST ?? null,
};
writeFileSync("dist/build-info.json", JSON.stringify(info, null, 2) + "\n");
console.log(`build-info: ${info.version} ${info.commit.slice(0, 12)}`);
