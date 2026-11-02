# Any MCP client

**Remote (Streamable HTTP).** `POST https://mail.example.com/mcp` with
`Authorization: Bearer <token>` (from `mcp-mail clients add <id> --for generic`). Both
2026-07-28 (stateless, per-request `_meta`) and initialize-based clients work.

```sh
curl -s https://mail.example.com/mcp \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -H "MCP-Protocol-Version: 2025-06-18" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**Local (stdio).** `npx -y @annseraf/mcp-mail stdio`, with `ACCOUNTS_FILE` and optional `STDIO_PRESET`.

Clients that only support OAuth sign-in can use the built-in OAuth server (`OAUTH=true`); see
[claude-ai.md](claude-ai.md).
