# Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "email": {
      "command": "npx",
      "args": ["-y", "mcp-mail", "stdio"],
      "env": { "STDIO_PRESET": "read-draft" }
    }
  }
}
```

Remote server instead:

```sh
mcp-mail clients add cursor --for cursor     # token printed once
```

```json
{
  "mcpServers": {
    "email": {
      "url": "https://mail.example.com/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```
