/** Build identity for /version, so a running deployment can be matched to a public commit. */
import { readFileSync } from "node:fs";

export interface BuildInfo {
  name: string;
  version: string;
  commit: string;
  buildTime: string | null;
  imageDigest: string | null;
}

let cached: BuildInfo | undefined;

export function buildInfo(): BuildInfo {
  if (cached) return cached;
  let file: Partial<BuildInfo> = {};
  try {
    file = JSON.parse(readFileSync(new URL("./build-info.json", import.meta.url), "utf8"));
  } catch {
    /* running from source */
  }
  cached = {
    name: file.name ?? "mcp-mail",
    version: file.version ?? "0.0.0-dev",
    commit: process.env.BUILD_COMMIT ?? file.commit ?? "unknown",
    buildTime: file.buildTime ?? null,
    imageDigest: process.env.IMAGE_DIGEST ?? file.imageDigest ?? null,
  };
  return cached;
}
