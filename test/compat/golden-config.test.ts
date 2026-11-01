/**
 * Upstream v0.2.1 configuration files must load unchanged (docs/COMPATIBILITY.md).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountsStore } from "../../src/accounts.js";

const dir = path.resolve(import.meta.dirname, "../../compat/fixtures/upstream-v0.2.1");

describe("golden accounts.json files", () => {
  it("loads the upstream README example", async () => {
    const store = new AccountsStore(path.join(dir, "accounts.readme.json"));
    await store.reload();
    expect(store.ids()).toEqual(["main"]);
    expect(store.resolve().id).toBe("main");
  });

  it("loads every optional field and tolerates unknown fields", async () => {
    const store = new AccountsStore(path.join(dir, "accounts.full.json"));
    await store.reload();
    expect(store.ids()).toEqual(["main", "work_2"]);
    expect(store.resolve().id).toBe("main");
    expect(store.resolve("main").caldav?.url).toBe("https://dav.example.com/");
    expect(store.resolve("main").mail.defaultFromName).toBe("You Example");
    expect(store.resolve("work_2").mail.sentFolder).toBeNull();
  });

  it("never leaks credentials through public summaries", async () => {
    const store = new AccountsStore(path.join(dir, "accounts.full.json"));
    await store.reload();
    expect(JSON.stringify(store.publicSummaries())).not.toMatch(/secret-/);
  });
});

describe("golden .env", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("loads upstream's .env.example with only AUTH_TOKEN filled in", async () => {
    const lines = readFileSync(path.join(dir, "env.example"), "utf8").split("\n");
    for (const line of lines) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m) vi.stubEnv(m[1], m[2]);
    }
    vi.stubEnv("AUTH_TOKEN", "test-token");
    const { config } = await import("../../src/config.js");
    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 3220,
      publicUrl: "https://mcp-mail.example.com",
      logLevel: "info",
      accountsFile: "/root/.config/mail-mcp/accounts.json",
      authToken: "test-token",
    });
  });

  it("keeps upstream defaults when variables are unset", async () => {
    for (const k of ["HOST", "PORT", "PUBLIC_URL", "LOG_LEVEL", "ACCOUNTS_FILE"]) vi.stubEnv(k, "");
    vi.stubEnv("AUTH_TOKEN", "test-token");
    const { config } = await import("../../src/config.js");
    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 3220,
      logLevel: "info",
      accountsFile: "/root/.config/mail-mcp/accounts.json",
    });
  });
});
