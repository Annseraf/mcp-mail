# Claude Desktop and Claude Code

## Local (stdio), simplest

mcp-mail runs as a child process and reads `~/.config/mcp-mail/accounts.json` (or `ACCOUNTS_FILE`).

Claude Desktop, `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "email": {
      "command": "npx",
      "args": ["-y", "mcp-mail", "stdio"],
      "env": {
        "ACCOUNTS_FILE": "/Users/you/.config/mcp-mail/accounts.json",
        "STDIO_PRESET": "read-draft"
      }
    }
  }
}
```

Claude Code:

```sh
claude mcp add email -e STDIO_PRESET=read-draft -- npx -y mcp-mail stdio
```

`STDIO_PRESET` is optional (`read-only`, `read-draft`, `organize`, `full-no-delete`, `full`).

## Remote (HTTP)

```sh
mcp-mail clients add claude-code --for generic --preset read-draft   # prints a token once
claude mcp add --transport http email https://mail.example.com/mcp --header "Authorization: Bearer <token>"
```
