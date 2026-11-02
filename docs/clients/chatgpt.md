# ChatGPT

Checked against OpenAI's documentation on 2026-11-02.

ChatGPT connects to remote MCP servers in **developer mode** (Settings → Apps → Advanced) using
OAuth 2.1 with dynamic client registration and PKCE. mcp-mail implements RFC 9207 issuer
identification, so ChatGPT uses its stable callback
`https://chatgpt.com/connector_platform_oauth_redirect`, which is in the default
`ALLOWED_REDIRECT_URIS`.

1. Server:
   ```sh
   # .env
   OAUTH=true
   TOKEN_SECRET_FILE=/etc/mcp-mail/token-secret
   CHATGPT_COMPAT=true        # adds read-only `search` and `fetch` for deep research
   ```
   ```sh
   mcp-mail clients add chatgpt --for chatgpt     # read-only preset, OAuth login printed once
   ```
2. In ChatGPT: **Apps → + → Add custom MCP server**, URL `https://mail.example.com/mcp`,
   authentication **OAuth**. Sign in with the login from step 1.
3. After changing presets or tools, press **Refresh** on the app so ChatGPT re-reads the tool list.

Notes:

- Deep research and company knowledge only use tools named `search` and `fetch`; mcp-mail's
  versions search Inbox and Sent of every account and return fenced message text.
- Read tools carry `readOnlyHint`, so ChatGPT runs them without asking; anything else needs your
  confirmation in the conversation.
- Write tools (drafts, sending) depend on your ChatGPT plan's developer-mode support.
