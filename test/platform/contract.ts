/**
 * Validates admin API responses against openapi/admin-v1.json and records
 * which operations were exercised, so the contract suite can prove coverage.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

type Json = Record<string, unknown>;

const spec = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../../openapi/admin-v1.json"), "utf8"),
) as Json & { paths: Record<string, Record<string, Json>>; components: Json };

const ajv = new Ajv2020.default({ strict: false, allErrors: true });
addFormats.default(ajv);
ajv.addSchema({ $id: "spec", components: spec.components });

const METHODS = ["get", "post", "put", "patch", "delete"];

export const operations = Object.entries(spec.paths).flatMap(([p, item]) =>
  METHODS.filter((m) => item[m]).map((m) => ({
    key: `${m.toUpperCase()} ${p}`,
    id: (item[m] as Json).operationId as string,
  })),
);

export const covered = new Set<string>();

/** Find the spec template matching a concrete path, e.g. /tenants/abc -> /tenants/{tenantId}. */
function template(method: string, concrete: string): string {
  const parts = concrete.split("/");
  const match = Object.keys(spec.paths).find((t) => {
    const tp = t.split("/");
    return (
      tp.length === parts.length &&
      tp.every((s, i) => s.startsWith("{") || s === parts[i]) &&
      spec.paths[t][method]
    );
  });
  if (!match) throw new Error(`No spec operation for ${method.toUpperCase()} ${concrete}`);
  // Literal segments beat parameters (/mailboxes/test vs /mailboxes/{mailboxId}).
  const literal = Object.keys(spec.paths).find((t) => t === concrete && spec.paths[t][method]);
  return literal ?? match;
}

export function checkResponse(
  method: string,
  concrete: string,
  status: number,
  body: unknown,
): void {
  const m = method.toLowerCase();
  const t = template(m, concrete);
  covered.add(`${m.toUpperCase()} ${t}`);
  const responses = (spec.paths[t][m] as Json).responses as Record<string, Json>;
  const r = responses[String(status)];
  if (!r) throw new Error(`${method} ${t}: status ${status} is not documented`);
  const schema = (r.content as Json | undefined)?.["application/json"] as Json | undefined;
  if (!schema) {
    if (body !== undefined && body !== "")
      throw new Error(`${method} ${t} ${status}: undocumented body`);
    return;
  }
  const rewritten = JSON.parse(
    JSON.stringify(schema.schema).replaceAll('"#/components/', '"spec#/components/'),
  );
  const validate = ajv.compile(rewritten);
  if (!validate(body)) {
    throw new Error(
      `${method} ${t} ${status} does not match the spec: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(body)}`,
    );
  }
}
