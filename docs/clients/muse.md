# Meta Muse

Checked 2026-11-02 against public setup guides; Meta's own documentation is still sparse.

Muse has no "add MCP server" setting. You ask it in chat to build a **Custom Connector**; it
writes an MCP client on its cloud VM, tests it and saves it as a skill. The server must be
public HTTPS speaking Streamable HTTP (a localhost or stdio server is unreachable from Muse).
A static bearer token is the smoothest auth.

1. Create a token client:
   ```sh
   mcp-mail clients add muse --for muse          # read-draft preset, token printed once
   ```
2. In Muse, send:
   > Build a Custom Connector that acts as an MCP client for my email.
   > Server URL: https://mail.example.com/mcp
   > Transport: remote streamable HTTP
   > Auth: HTTP header `Authorization: Bearer <token>`. I'll paste the token in the secure
   > credential prompt, not in chat.
3. Paste the token only into Muse's secure credential prompt.

Muse can then list, search and read mail and save drafts. Grant `send` only if you need it.
