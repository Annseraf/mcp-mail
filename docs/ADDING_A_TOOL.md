# Adding a tool

Tools are registered in `src/tools-mail.ts` (mail) or `src/tools-calendar.ts` (calendar). Every
tool gets client policy, auditing, annotations and server instructions for free: the guard and
annotation wrappers sit in front of `registerTool`. You only declare the tool and its capability.

Example: `count_unread` (a read-only tool), 30 lines.

```ts
// 1. src/policy/capabilities.ts — declare exactly one capability
export const TOOL_CAPABILITY = {
  // ...
  count_unread: "read",
};

// 2. src/imap-client.ts — the provider method (keep IMAP details here)
async countUnread(mailbox: string): Promise<number> {
  const client = await this.ensureConnected();
  const status = await client.status(mailbox, { unseen: true });
  return status.unseen ?? 0;
}

// 3. src/tools-mail.ts — inside registerMailTools()
server.registerTool(
  "count_unread",
  {
    description: "Count unread messages in a folder.",
    inputSchema: z.object({
      mailbox: z.string().optional().describe("Folder (default INBOX)"),
      account: accountSchema,
    }),
  },
  async ({ mailbox, account }) => {
    const { imap } = pool.for(account);
    return asJson({ mailbox: mailbox ?? "INBOX", unread: await imap.countUnread(mailbox ?? "INBOX") });
  },
);
```

Then:

- Add a test in `test/platform/mail-tools.int.test.ts` (runs against GreenMail).
- Treat message content as untrusted: wrap bodies with `fence()` from `src/content.ts`.
- Never add a required parameter to an existing tool or remove an output field; the
  compatibility gate (`npm run test:compat`) fails if you do.
