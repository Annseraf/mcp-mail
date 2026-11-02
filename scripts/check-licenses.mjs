#!/usr/bin/env node
/**
 * Fails if any production dependency carries a copyleft (or unknown) license,
 * unless it is explicitly allowlisted below with a reason.
 *
 * Usage: npm run licenses
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Weak/strong copyleft and source-available licenses we refuse by default.
const DENY =
  /\b(A?GPL|LGPL|MPL|EPL|EUPL|CDDL|CPAL|OSL|SSPL|BUSL|CC-BY-SA|CC-BY-NC|RPL|Sleepycat)\b/i;

// package name -> allowed license expression. Keep reasons next to entries.
const ALLOW = {
  // MPL-2.0 is file-level copyleft; allowed because we use ical.js unmodified.
  "ical.js": "MPL-2.0",
};

/** An "A OR B" expression is fine if any alternative is acceptable; "A AND B" needs all. */
function acceptable(expr) {
  const e = expr.replace(/^\(|\)$/g, "").trim();
  if (/\sOR\s/i.test(e)) return e.split(/\s+OR\s+/i).some(acceptable);
  if (/\sAND\s/i.test(e)) return e.split(/\s+AND\s+/i).every(acceptable);
  return !DENY.test(e) && !/UNKNOWN|UNLICENSED|Custom/i.test(e);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const self = `${pkg.name}@${pkg.version}`;

const out = execFileSync(
  "npx",
  ["--no-install", "license-checker-rseidelsohn", "--production", "--json"],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
const deps = JSON.parse(out);

const problems = [];
for (const [id, info] of Object.entries(deps)) {
  if (id === self) continue;
  const name = id.slice(0, id.lastIndexOf("@"));
  const license = String(info.licenses ?? "UNKNOWN");
  if (ALLOW[name] === license) continue;
  if (!acceptable(license)) {
    problems.push(`${id}: ${license}`);
  }
}

if (problems.length) {
  console.error("Disallowed licenses in production dependencies:\n  " + problems.join("\n  "));
  console.error(
    "\nIf one is acceptable, add it to ALLOW in scripts/check-licenses.mjs with a reason.",
  );
  process.exit(1);
}
console.log(`License check passed (${Object.keys(deps).length - 1} production packages).`);
