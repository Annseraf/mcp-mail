import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountsStore } from "../src/accounts.js";

const creds = {
  host: "imap.example.com",
  port: 993,
  user: "you@example.com",
  pass: "s3cret",
  tls: true,
};

const fixture = {
  version: 1,
  accounts: [
    {
      id: "main",
      label: "Main",
      default: true,
      imap: creds,
      smtp: { ...creds, host: "smtp.example.com", port: 465 },
      mail: { defaultFrom: "you@example.com", draftsFolder: "Drafts", sentFolder: "Sent" },
    },
  ],
};

describe("AccountsStore (smoke)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mcp-mail-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads a version 1 accounts file and resolves the default account", async () => {
    const file = path.join(dir, "accounts.json");
    await writeFile(file, JSON.stringify(fixture));
    const store = new AccountsStore(file);
    await store.reload();
    expect(store.ids()).toEqual(["main"]);
    expect(store.resolve().id).toBe("main");
  });

  it("never exposes credentials in public summaries", async () => {
    const file = path.join(dir, "accounts.json");
    await writeFile(file, JSON.stringify(fixture));
    const store = new AccountsStore(file);
    await store.reload();
    expect(JSON.stringify(store.publicSummaries())).not.toContain("s3cret");
  });

  it("treats a missing file as zero accounts", async () => {
    const store = new AccountsStore(path.join(dir, "missing.json"));
    await store.reload();
    expect(store.list()).toEqual([]);
  });
});
