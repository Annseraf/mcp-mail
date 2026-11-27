import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { expect, it } from "vitest";
import { OAuthServer } from "../src/auth/oauth.js";

it.each([
  ["https://client.example/callback?source=mcp", " https://client.example/callback"],
  ["https://client.example/call;back", " https://client.example/call%3Bback"],
  ["https://*.example/callback", ""],
])("limits the login form policy for redirect URI %s", async (redirectUri, source) => {
  const dir = await mkdtemp(path.join(tmpdir(), "mcp-mail-oauth-"));
  const oauth = new OAuthServer({
    publicUrl: "https://mail.example",
    tokenSecretHex: "ab".repeat(32),
    stateFile: path.join(dir, "state.json"),
    allowedRedirectUris: [redirectUri, "https://other.example/callback"],
  });
  const server = express().use(oauth.router()).listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const register = await fetch(`${url}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri, "https://other.example/callback"] }),
    });
    expect(register.status).toBe(201);
    const { client_id } = await register.json();
    const params = new URLSearchParams({
      client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: "test-challenge",
      code_challenge_method: "S256",
    });
    const login = await fetch(`${url}/authorize?${params}`);
    expect(login.status).toBe(200);
    expect(login.headers.get("content-security-policy")).toContain(`form-action 'self'${source};`);
    expect(await login.text()).toContain('method="post" action="login"');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
