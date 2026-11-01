/**
 * The deterministic scenario the compatibility gate replays against a server.
 *
 * Every step is a tools/call whose output shape is recorded. Steps are named
 * so baselines stay readable and diffs point at the exact call that changed.
 * Steps only use parameters that exist in upstream v0.2.1, by design.
 */
import { seedMail, toolPayload, mail, type RpcResult } from "./harness.js";
import { shapeOf, type OutputRecord, type Tool } from "./schema-compat.js";

type Call = (method: string, params?: object) => Promise<RpcResult>;

export interface ScenarioResult {
  tools: Tool[];
  outputs: OutputRecord[];
  /** Set when a step failed at the protocol level and later steps could not run. */
  aborted?: string;
}

class ScenarioAbort extends Error {
  constructor(step: string, error: unknown) {
    super(`${step}: JSON-RPC error ${JSON.stringify(error)}`);
  }
}

/** List tools only; kept separate so schema checks run even if the scenario aborts. */
export async function listTools(call: Call): Promise<Tool[]> {
  const list = await call("tools/list");
  if (list.body?.error) throw new Error(`tools/list failed: ${JSON.stringify(list.body.error)}`);
  return list.body.result.tools as Tool[];
}

const FAR_PAST = "2000-01-01T00:00:00Z";
const FAR_FUTURE = "2000-01-02T00:00:00Z";

export async function runScenario(call: Call): Promise<ScenarioResult> {
  await seedMail();
  const outputs: OutputRecord[] = [];
  const tools = await listTools(call);
  try {
    await steps();
  } catch (err) {
    if (err instanceof ScenarioAbort) return { tools, outputs, aborted: err.message };
    throw err;
  }
  return { tools, outputs };

  async function steps(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const step = async (name: string, tool: string, args: object = {}): Promise<any> => {
      const res = await call("tools/call", { name: tool, arguments: args });
      if (res.body?.error) {
        // Record protocol-level failures as outputs so the gate reports them per step.
        outputs.push({
          step: name,
          tool,
          isError: true,
          shape: { "$.jsonrpcError": [String(res.body.error.code)] },
        });
        throw new ScenarioAbort(name, res.body.error);
      }
      const result = res.body.result;
      const payload = toolPayload(result);
      outputs.push({ step: name, tool, isError: result.isError === true, shape: shapeOf(payload) });
      return payload;
    };

    const uidBySubject = (
      payload: { messages: { uid: number; subject: string }[] },
      subject: string,
    ) => {
      const m = payload.messages.find((x) => x.subject === subject);
      if (!m) throw new Error(`no message with subject "${subject}"`);
      return m.uid;
    };

    await step("list_accounts", "list_accounts");
    await step("list_folders", "list_folders");
    const inbox = await step("list_messages INBOX", "list_messages", {
      mailbox: "INBOX",
      limit: 10,
    });
    await step("list_messages INBOX unread_only", "list_messages", {
      mailbox: "INBOX",
      unread_only: true,
    });
    await step("search_messages subject", "search_messages", {
      mailbox: "INBOX",
      subject: "report",
    });
    await step("search_messages from+since", "search_messages", {
      mailbox: "INBOX",
      from: "dave@example.com",
      since: "2000-01-01",
    });

    const reportUid = uidBySubject(inbox, "Quarterly report");
    const lunchUid = uidBySubject(inbox, "Lunch on Friday?");
    await step("get_message with attachment", "get_message", { mailbox: "INBOX", uid: reportUid });
    await step("get_message html", "get_message", { mailbox: "INBOX", uid: lunchUid });
    await step("get_message unknown uid", "get_message", { mailbox: "INBOX", uid: 999999 });

    await step("create_draft", "create_draft", {
      to: mail.users.bob.email,
      subject: "Draft subject",
      text: "Draft body",
      cc: [mail.users.bob.email],
    });
    await step("send_message", "send_message", {
      to: mail.users.bob.email,
      subject: "Sent from scenario",
      text: "Hello Bob",
      attachments: [
        {
          filename: "a.txt",
          content_base64: Buffer.from("hi").toString("base64"),
          content_type: "text/plain",
        },
      ],
    });

    await step("mark_read", "mark_read", { mailbox: "INBOX", uid: lunchUid, read: true });
    await step("move_message", "move_message", {
      source_mailbox: "INBOX",
      uid: reportUid,
      destination_mailbox: "Archive",
    });
    const archive = await step("list_messages Archive", "list_messages", { mailbox: "Archive" });
    await step("delete_message", "delete_message", {
      mailbox: "Archive",
      uid: uidBySubject(archive, "Quarterly report"),
    });

    // Second account: bob should have received the scenario send.
    for (let i = 0; i < 50; i++) {
      const res = await call("tools/call", {
        name: "list_messages",
        arguments: { mailbox: "INBOX", account: "work" },
      });
      if (JSON.stringify(res.body).includes("Sent from scenario")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await step("list_messages work INBOX", "list_messages", { mailbox: "INBOX", account: "work" });
    await step("list_messages unknown account", "list_messages", {
      mailbox: "INBOX",
      account: "nope",
    });

    // No account has CalDAV: upstream registers calendar tools and errors per call.
    await step("list_calendars without caldav", "list_calendars");
    await step("list_events without caldav", "list_events", {
      calendar_url: "https://cal.example.com/c/",
      start: FAR_PAST,
      end: FAR_FUTURE,
    });
    await step("create_event without caldav", "create_event", {
      calendar_url: "https://cal.example.com/c/",
      summary: "x",
      start: FAR_PAST,
      end: FAR_FUTURE,
    });
    await step("find_free_slot without caldav", "find_free_slot", {
      calendar_urls: ["https://cal.example.com/c/"],
      range_start: FAR_PAST,
      range_end: FAR_FUTURE,
      duration_minutes: 30,
    });
  }
}
