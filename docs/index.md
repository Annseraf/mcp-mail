---
title: mcp-mail — self-hosted email MCP server
description: Self-hosted IMAP/SMTP email MCP server for Claude, ChatGPT, Cursor and any MCP client, with per-client permissions, audit log and one-line install.
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "SoftwareSourceCode",
  "name": "mcp-mail",
  "description": "Self-hosted IMAP/SMTP email MCP server for Claude, ChatGPT, Cursor and any MCP client, with per-client permissions, audit log and one-line install.",
  "codeRepository": "https://github.com/Annseraf/mcp-mail",
  "programmingLanguage": "TypeScript",
  "runtimePlatform": "Node.js",
  "license": "https://opensource.org/licenses/MIT",
  "keywords": "MCP, Model Context Protocol, email, IMAP, SMTP, Claude, ChatGPT, Cursor, self-hosted"
}
</script>

# mcp-mail

Self-hosted IMAP/SMTP email MCP server for Claude, ChatGPT, Cursor and any MCP client, with
per-client permissions, audit log and one-line install.

```sh
curl -fsSL https://raw.githubusercontent.com/Annseraf/mcp-mail/main/install.sh | sudo bash -s -- --auto-update
```

## Set up your client

- [Claude.ai](clients/claude-ai.md)
- [Claude Desktop and Claude Code](clients/claude-desktop-code.md)
- [ChatGPT](clients/chatgpt.md)
- [Cursor](clients/cursor.md)
- [VS Code](clients/vscode.md)
- [Meta Muse](clients/muse.md)
- [Any MCP client](clients/generic.md)

## Learn more

- [Permissions, OAuth and audit](CLIENTS.md)
- [Compatibility with claude-mail-mcp](COMPATIBILITY.md)
- [Multi-tenant platform mode](PLATFORM.md)
- [Adding a tool](ADDING_A_TOOL.md)
- [Source on GitHub](https://github.com/Annseraf/mcp-mail)
