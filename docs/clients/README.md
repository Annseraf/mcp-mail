# Client setup guides

| Client                       | Transport                    | Auth         | Guide                                            |
| ---------------------------- | ---------------------------- | ------------ | ------------------------------------------------ |
| Claude.ai (web, mobile)      | Remote HTTP                  | OAuth login  | [claude-ai.md](claude-ai.md)                     |
| Claude Desktop / Claude Code | stdio (local) or remote HTTP | none / token | [claude-desktop-code.md](claude-desktop-code.md) |
| ChatGPT                      | Remote HTTP                  | OAuth login  | [chatgpt.md](chatgpt.md)                         |
| Cursor                       | stdio or remote HTTP         | none / token | [cursor.md](cursor.md)                           |
| VS Code (Copilot agent mode) | stdio or remote HTTP         | none / token | [vscode.md](vscode.md)                           |
| Meta Muse                    | Remote HTTP                  | token        | [muse.md](muse.md)                               |
| Anything else                | Remote HTTP or stdio         | token        | [generic.md](generic.md)                         |

Remote HTTP needs mcp-mail reachable over HTTPS (`https://mail.example.com/mcp` below). Create
one client per agent with `mcp-mail clients add <id> --for <type>` so each gets its own
permissions and can be revoked on its own ([CLIENTS.md](../CLIENTS.md)).
