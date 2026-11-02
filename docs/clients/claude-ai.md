# Claude.ai

Claude.ai connects to remote MCP servers that support OAuth 2.1 with dynamic client registration.

1. On the server, enable OAuth and create a login for Claude:
   ```sh
   # .env
   OAUTH=true
   TOKEN_SECRET_FILE=/etc/mcp-mail/token-secret   # openssl rand -hex 32 > ...
   ```
   ```sh
   mcp-mail clients add claude --for claude --preset read-draft
   # prints a username and password once
   ```
2. In Claude.ai: **Settings → Connectors → Add custom connector**.
   - Name: `Email`
   - URL: `https://mail.example.com/mcp`
3. Click **Connect**. A sign-in page from your server opens; use the username and password from
   step 1. Claude returns to the chat with the connector enabled.

To let Claude send mail, use `--preset full-no-delete`, and consider `sendRecipientAllowlist`
in `clients.json`. Revoke at any time with `mcp-mail clients revoke claude`.
