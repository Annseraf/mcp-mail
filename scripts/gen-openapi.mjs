#!/usr/bin/env node
// Generates openapi/admin-v1.json. Edit this file, run `npm run openapi`, commit both.
import { writeFileSync } from "node:fs";

const ref = (n) => ({ $ref: `#/components/schemas/${n}` });
const json = (schema, description = "OK") => ({
  description,
  content: { "application/json": { schema } },
});
const err = (description) => json(ref("Error"), description);
const tenantPath = {
  name: "tenantId",
  in: "path",
  required: true,
  schema: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{2,62}$" },
};
const mailboxPath = { name: "mailboxId", in: "path", required: true, schema: ref("ObjectId") };
const clientPath = { name: "clientId", in: "path", required: true, schema: ref("ObjectId") };
const common = { 401: err("Missing or invalid service token") };
const withTenant = { ...common, 404: err("Tenant not found") };
const body = (schema) => ({ required: true, content: { "application/json": { schema } } });
const op = (operationId, summary, extra) => ({ operationId, summary, ...extra });

const endpoint = (withPassword) => ({
  type: "object",
  additionalProperties: false,
  required: withPassword
    ? ["host", "port", "tls", "user", "password"]
    : ["host", "port", "tls", "user"],
  properties: {
    host: { type: "string" },
    port: { type: "integer", minimum: 1, maximum: 65535 },
    tls: {
      type: "boolean",
      description: "true = implicit TLS (993/465); false = plain or STARTTLS",
    },
    user: { type: "string" },
    ...(withPassword ? { password: { type: "string", writeOnly: true } } : {}),
  },
});

const spec = {
  openapi: "3.1.0",
  info: {
    title: "mcp-mail admin API",
    version: "1.0.0",
    description:
      "Private, service-token-authenticated API for driving a multi-tenant mcp-mail engine (MULTI_TENANT=true, ADMIN_API=true). " +
      "Secrets are write-only: they can be set or replaced, never read back. Breaking changes ship as /admin/v2; v1 is kept for at least one major version.",
    license: { name: "MIT" },
  },
  servers: [{ url: "http://127.0.0.1:3330/admin/v1" }],
  security: [{ serviceToken: [] }],
  paths: {
    "/health": {
      get: op("getHealth", "Liveness", { responses: { 200: json(ref("Health")), ...common } }),
    },
    "/version": {
      get: op("getVersion", "Build identity", {
        responses: { 200: json(ref("Version")), ...common },
      }),
    },
    "/tenants": {
      post: op("createTenant", "Create a tenant", {
        requestBody: body(ref("TenantCreate")),
        responses: {
          201: json(ref("Tenant"), "Created"),
          400: err("Invalid request"),
          409: err("Tenant exists or config is managed externally"),
          ...common,
        },
      }),
    },
    "/tenants/{tenantId}": {
      parameters: [tenantPath],
      get: op("getTenant", "Get a tenant", {
        responses: { 200: json(ref("Tenant")), ...withTenant },
      }),
      delete: op(
        "deleteTenant",
        "Delete a tenant and purge its secrets, cache, tokens and audit log",
        {
          responses: { 204: { description: "Deleted" }, ...withTenant },
        },
      ),
    },
    "/tenants/{tenantId}/suspend": {
      parameters: [tenantPath],
      post: op(
        "suspendTenant",
        "Suspend: every agent tool call fails with an 'account suspended' error",
        { responses: { 200: json(ref("Tenant")), ...withTenant } },
      ),
    },
    "/tenants/{tenantId}/unsuspend": {
      parameters: [tenantPath],
      post: op("unsuspendTenant", "Unsuspend", {
        responses: { 200: json(ref("Tenant")), ...withTenant },
      }),
    },
    "/tenants/{tenantId}/limits": {
      parameters: [tenantPath],
      put: op("setTenantLimits", "Merge new limits into the tenant's limits", {
        requestBody: body(ref("LimitsPatch")),
        responses: { 200: json(ref("Tenant")), 400: err("Invalid request"), ...withTenant },
      }),
    },
    "/tenants/{tenantId}/mailboxes": {
      parameters: [tenantPath],
      get: op("listMailboxes", "List mailboxes (never credentials)", {
        responses: {
          200: json({
            type: "object",
            required: ["mailboxes"],
            properties: { mailboxes: { type: "array", items: ref("Mailbox") } },
          }),
          ...withTenant,
        },
      }),
      post: op("addMailbox", "Add a mailbox; credentials are stored encrypted and never returned", {
        requestBody: body(ref("MailboxCreate")),
        responses: {
          201: json(ref("Mailbox"), "Created"),
          400: err("Invalid request"),
          409: err("Mailbox exists"),
          422: err("Mailbox limit reached"),
          ...withTenant,
        },
      }),
    },
    "/tenants/{tenantId}/mailboxes/test": {
      parameters: [tenantPath],
      post: op(
        "testMailbox",
        "Check IMAP and SMTP connectivity and login without saving anything",
        {
          requestBody: body(ref("MailboxTest")),
          responses: {
            200: json(ref("MailboxTestResult")),
            400: err("Invalid request"),
            ...withTenant,
          },
        },
      ),
    },
    "/tenants/{tenantId}/mailboxes/{mailboxId}": {
      parameters: [tenantPath, mailboxPath],
      patch: op("updateMailbox", "Update a mailbox; passwords given here replace the stored ones", {
        requestBody: body(ref("MailboxPatch")),
        responses: { 200: json(ref("Mailbox")), 400: err("Invalid request"), ...withTenant },
      }),
      delete: op("removeMailbox", "Remove a mailbox and its credentials", {
        responses: { 204: { description: "Removed" }, ...withTenant },
      }),
    },
    "/tenants/{tenantId}/clients": {
      parameters: [tenantPath],
      get: op("listClients", "List agent clients", {
        responses: {
          200: json({
            type: "object",
            required: ["clients"],
            properties: { clients: { type: "array", items: ref("Client") } },
          }),
          ...withTenant,
        },
      }),
      post: op(
        "addClient",
        "Add an agent client; returns its endpoint and a token shown only once",
        {
          requestBody: body(ref("ClientCreate")),
          responses: {
            201: json(ref("ClientWithToken"), "Created"),
            400: err("Invalid request"),
            409: err("Client exists"),
            422: err("Client limit reached"),
            ...withTenant,
          },
        },
      ),
    },
    "/tenants/{tenantId}/clients/{clientId}": {
      parameters: [tenantPath, clientPath],
      patch: op("updateClient", "Change a client's name, preset, mailboxes or send toggle", {
        requestBody: body(ref("ClientPatch")),
        responses: { 200: json(ref("Client")), 400: err("Invalid request"), ...withTenant },
      }),
    },
    "/tenants/{tenantId}/clients/{clientId}/revoke": {
      parameters: [tenantPath, clientPath],
      post: op("revokeClient", "Revoke a client immediately", {
        responses: { 200: json(ref("Client")), ...withTenant },
      }),
    },
    "/tenants/{tenantId}/clients/{clientId}/rotate": {
      parameters: [tenantPath, clientPath],
      post: op("rotateClient", "Issue a new token; the old one stops working immediately", {
        responses: {
          200: json(ref("ClientWithToken")),
          409: err("Client is revoked"),
          ...withTenant,
        },
      }),
    },
    "/tenants/{tenantId}/audit": {
      parameters: [tenantPath],
      get: op("listAudit", "Read the audit log, newest first", {
        parameters: [
          { name: "client", in: "query", schema: ref("ObjectId") },
          { name: "cursor", in: "query", schema: { type: "string" } },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 500, default: 50 },
          },
        ],
        responses: { 200: json(ref("AuditPage")), 400: err("Invalid request"), ...withTenant },
      }),
    },
    "/tenants/{tenantId}/usage": {
      parameters: [tenantPath],
      get: op("getUsage", "Tool calls per day, per client (last 35 days)", {
        responses: { 200: json(ref("Usage")), ...withTenant },
      }),
    },
  },
  components: {
    securitySchemes: {
      serviceToken: { type: "http", scheme: "bearer", description: "ADMIN_TOKEN" },
    },
    schemas: {
      ObjectId: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,31}$" },
      Error: {
        type: "object",
        required: ["error", "message"],
        properties: { error: { type: "string" }, message: { type: "string" } },
      },
      Health: { type: "object", required: ["status"], properties: { status: { const: "ok" } } },
      Version: {
        type: "object",
        required: ["name", "version", "commit", "buildTime", "imageDigest"],
        properties: {
          name: { type: "string" },
          version: { type: "string" },
          commit: { type: "string" },
          buildTime: { type: ["string", "null"] },
          imageDigest: { type: ["string", "null"] },
        },
      },
      Limits: {
        type: "object",
        additionalProperties: false,
        required: [
          "maxMailboxes",
          "maxClients",
          "toolCallsPerDay",
          "allowSend",
          "maxRecipientsPerSend",
          "auditRetentionDays",
        ],
        properties: {
          maxMailboxes: { type: "integer", minimum: 0 },
          maxClients: { type: "integer", minimum: 0 },
          toolCallsPerDay: { type: "integer", minimum: 0 },
          allowSend: { type: "boolean" },
          maxRecipientsPerSend: { type: "integer", minimum: 1 },
          auditRetentionDays: { type: "integer", minimum: 1 },
        },
      },
      LimitsPatch: { type: "object", additionalProperties: false, properties: {} },
      TenantCreate: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{2,62}$" },
          limits: ref("LimitsPatch"),
        },
      },
      Tenant: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "status",
          "createdAt",
          "updatedAt",
          "revision",
          "limits",
          "mailboxes",
          "clients",
        ],
        properties: {
          id: { type: "string" },
          status: { enum: ["active", "suspended"] },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          revision: { type: "integer" },
          limits: ref("Limits"),
          mailboxes: { type: "array", items: ref("Mailbox") },
          clients: { type: "array", items: ref("Client") },
        },
      },
      Endpoint: endpoint(false),
      EndpointWithPassword: endpoint(true),
      MailDefaults: {
        type: "object",
        additionalProperties: false,
        required: ["defaultFrom"],
        properties: {
          defaultFrom: { type: "string" },
          defaultFromName: { type: ["string", "null"] },
          draftsFolder: { type: "string", default: "Drafts" },
          sentFolder: { type: ["string", "null"], default: "Sent" },
        },
      },
      Mailbox: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "label",
          "default",
          "status",
          "imap",
          "smtp",
          "mail",
          "caldav",
          "createdAt",
        ],
        properties: {
          id: ref("ObjectId"),
          label: { type: "string" },
          default: { type: "boolean" },
          status: { enum: ["active", "suspended"] },
          imap: ref("Endpoint"),
          smtp: ref("Endpoint"),
          mail: ref("MailDefaults"),
          caldav: {
            oneOf: [
              { type: "null" },
              {
                type: "object",
                additionalProperties: false,
                required: ["url", "user"],
                properties: { url: { type: "string" }, user: { type: "string" } },
              },
            ],
          },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      MailboxCreate: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "imap", "smtp", "mail"],
        properties: {
          id: ref("ObjectId"),
          label: { type: "string", minLength: 1, maxLength: 100 },
          default: { type: "boolean" },
          imap: ref("EndpointWithPassword"),
          smtp: ref("EndpointWithPassword"),
          mail: ref("MailDefaults"),
          caldav: {
            type: "object",
            additionalProperties: false,
            required: ["url", "user", "password"],
            properties: {
              url: { type: "string" },
              user: { type: "string" },
              password: { type: "string", writeOnly: true },
            },
          },
        },
      },
      MailboxPatch: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string" },
          default: { type: "boolean" },
          status: { enum: ["active", "suspended"] },
          imap: { type: "object", description: "Any subset of EndpointWithPassword" },
          smtp: { type: "object", description: "Any subset of EndpointWithPassword" },
          mail: { type: "object", description: "Any subset of MailDefaults" },
          caldav: { description: "Replace (object with password) or remove (null)" },
        },
      },
      MailboxTest: {
        type: "object",
        additionalProperties: false,
        required: ["imap", "smtp"],
        properties: { imap: ref("EndpointWithPassword"), smtp: ref("EndpointWithPassword") },
      },
      CheckResult: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: { ok: { type: "boolean" }, error: { type: "string" } },
      },
      MailboxTestResult: {
        type: "object",
        additionalProperties: false,
        required: ["imap", "smtp"],
        properties: { imap: ref("CheckResult"), smtp: ref("CheckResult") },
      },
      Preset: { enum: ["read-only", "read-draft", "organize", "full-no-delete", "full"] },
      Client: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "name",
          "type",
          "preset",
          "accounts",
          "sendEnabled",
          "status",
          "createdAt",
          "rotatedAt",
          "revokedAt",
        ],
        properties: {
          id: ref("ObjectId"),
          name: { type: "string" },
          type: {
            type: "string",
            description: "claude | chatgpt | cursor | vscode | muse | generic (free text)",
          },
          preset: ref("Preset"),
          accounts: {
            type: ["array", "null"],
            items: ref("ObjectId"),
            description: "null = all mailboxes",
          },
          sendEnabled: { type: "boolean" },
          status: { enum: ["active", "revoked"] },
          createdAt: { type: "string", format: "date-time" },
          rotatedAt: { type: ["string", "null"] },
          revokedAt: { type: ["string", "null"] },
        },
      },
      ClientCreate: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: {
          id: ref("ObjectId"),
          name: { type: "string", minLength: 1, maxLength: 100 },
          type: { type: "string", default: "generic" },
          preset: { ...ref("Preset"), default: "read-draft" },
          accounts: { type: "array", items: ref("ObjectId") },
          sendEnabled: { type: "boolean", default: false },
        },
      },
      ClientPatch: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          preset: ref("Preset"),
          accounts: { type: ["array", "null"], items: ref("ObjectId") },
          sendEnabled: { type: "boolean" },
        },
      },
      ClientWithToken: {
        type: "object",
        additionalProperties: false,
        required: ["client", "token", "endpoint"],
        properties: {
          client: ref("Client"),
          token: {
            type: "string",
            description: "Bearer token for the agent. Shown once; only its hash is stored.",
          },
          endpoint: { type: "string", description: "MCP endpoint URL for this tenant" },
        },
      },
      AuditEntry: {
        type: "object",
        additionalProperties: false,
        required: ["ts", "tenantId", "clientId", "tool", "result", "durationMs"],
        properties: {
          ts: { type: "string", format: "date-time" },
          tenantId: { type: "string" },
          clientId: { type: "string" },
          tool: { type: "string" },
          account: { type: "string" },
          mailbox: { type: "string" },
          uid: { type: "integer" },
          recipients: { type: "integer" },
          result: { enum: ["ok", "denied", "error"] },
          reason: { type: "string" },
          durationMs: { type: "integer" },
        },
      },
      AuditPage: {
        type: "object",
        additionalProperties: false,
        required: ["entries"],
        properties: {
          entries: { type: "array", items: ref("AuditEntry") },
          nextCursor: { type: "string" },
        },
      },
      Usage: {
        type: "object",
        additionalProperties: false,
        required: ["today", "limit", "days"],
        properties: {
          today: { type: "integer" },
          limit: { type: "integer" },
          days: {
            type: "object",
            additionalProperties: {
              type: "object",
              required: ["total", "byClient"],
              properties: {
                total: { type: "integer" },
                byClient: { type: "object", additionalProperties: { type: "integer" } },
              },
            },
          },
        },
      },
    },
  },
};

// LimitsPatch = every Limits property, all optional.
spec.components.schemas.LimitsPatch.properties = spec.components.schemas.Limits.properties;

writeFileSync("openapi/admin-v1.json", JSON.stringify(spec, null, 2) + "\n");
console.log("wrote openapi/admin-v1.json");
