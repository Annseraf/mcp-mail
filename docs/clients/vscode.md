# VS Code (Copilot agent mode)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "email": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@annseraf/mcp-mail", "stdio"],
      "env": { "STDIO_PRESET": "read-draft" }
    }
  }
}
```

Remote server (`mcp-mail clients add vscode --for vscode` prints a token):

```json
{
  "inputs": [
    { "id": "mailToken", "type": "promptString", "description": "mcp-mail token", "password": true }
  ],
  "servers": {
    "email": {
      "type": "http",
      "url": "https://mail.example.com/mcp",
      "headers": { "Authorization": "Bearer ${input:mailToken}" }
    }
  }
}
```
