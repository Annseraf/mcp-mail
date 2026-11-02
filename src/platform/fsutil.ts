import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/** Write a file atomically (temp file + rename) with owner-only permissions. */
export async function writeFileAtomic(file: string, data: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(tmp, data, { mode: 0o600 });
  await fs.rename(tmp, file);
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function removeFile(file: string): Promise<void> {
  await fs.rm(file, { force: true });
}
