import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/** Write a file atomically (temp file + rename) with owner-only permissions. */
export async function writeFileAtomic(
  file: string,
  data: string | Buffer,
  durable = false,
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  if (!durable) {
    await fs.writeFile(tmp, data, { mode: 0o600 });
    await fs.rename(tmp, file);
    return;
  }
  try {
    const handle = await fs.open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
    const directory = await fs.open(path.dirname(file), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (err) {
    await removeFile(tmp).catch(() => {});
    throw err;
  }
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
