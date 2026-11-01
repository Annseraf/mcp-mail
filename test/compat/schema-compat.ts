/**
 * Compatibility rules for tool input schemas and tool outputs.
 *
 * Inputs: every argument object that the baseline server accepted must still
 * be accepted. Concretely we flag a removed tool, a newly required parameter,
 * a removed parameter (when the schema forbids unknown properties), and any
 * narrowing of a parameter's type, enum, bounds, pattern or format.
 *
 * Outputs: every field path (with its JSON type) that the baseline produced
 * for a scenario step must still be produced. New fields are fine.
 *
 * This is a conservative checker for the JSON Schema subset that zod emits;
 * anything it cannot prove compatible is reported, never silently passed.
 */

type Schema = Record<string, unknown> | boolean;
type Obj = Record<string, unknown>;

export interface Tool {
  name: string;
  inputSchema: Obj;
}

export interface Violation {
  tool: string;
  path: string;
  kind:
    | "tool-removed"
    | "required-added"
    | "param-removed"
    | "type-narrowed"
    | "enum-narrowed"
    | "bound-narrowed"
    | "constraint-added"
    | "output-field-removed"
    | "output-type-changed"
    | "output-error-changed";
  detail: string;
}

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function resolve(schema: Schema, root: Obj): Schema {
  let s = schema;
  for (let i = 0; i < 32 && isObj(s) && typeof s.$ref === "string"; i++) {
    const ref = s.$ref as string;
    if (!ref.startsWith("#")) throw new Error(`external $ref not supported: ${ref}`);
    let target: unknown = root;
    for (const part of ref.slice(1).split("/").filter(Boolean)) {
      const key = decodeURIComponent(part.replace(/~1/g, "/").replace(/~0/g, "~"));
      target =
        isObj(target) || Array.isArray(target)
          ? (target as Record<string, unknown>)[key]
          : undefined;
    }
    if (target === undefined) throw new Error(`unresolvable $ref: ${ref}`);
    s = target as Schema;
  }
  return s;
}

const ALL_TYPES = ["string", "number", "integer", "boolean", "object", "array", "null"];

function branches(s: Obj): Schema[] | undefined {
  const u = (s.anyOf ?? s.oneOf) as Schema[] | undefined;
  return Array.isArray(u) ? u : undefined;
}

function typesOf(s: Obj): Set<string> {
  if (Array.isArray(s.type)) return new Set(s.type as string[]);
  if (typeof s.type === "string") return new Set([s.type]);
  const values = Array.isArray(s.enum) ? s.enum : "const" in s ? [s.const] : undefined;
  if (values) {
    return new Set(
      values.map((v) =>
        v === null
          ? "null"
          : Array.isArray(v)
            ? "array"
            : Number.isInteger(v)
              ? "integer"
              : typeof v,
      ),
    );
  }
  return new Set(ALL_TYPES);
}

function accepts(cur: Set<string>, t: string): boolean {
  return cur.has(t) || (t === "integer" && cur.has("number"));
}

function isAnything(s: Schema): boolean {
  return (
    s === true ||
    (isObj(s) && Object.keys(s).filter((k) => k !== "description" && k !== "title").length === 0)
  );
}

/** Collect violations of `cur` relative to `base` (both already resolved against their roots). */
function compareSchema(
  base: Schema,
  cur: Schema,
  baseRoot: Obj,
  curRoot: Obj,
  tool: string,
  path: string,
  out: Violation[],
): void {
  base = resolve(base, baseRoot);
  cur = resolve(cur, curRoot);
  if (isAnything(cur)) return;
  if (base === false) return;
  if (base === true || !isObj(base)) {
    out.push({ tool, path, kind: "type-narrowed", detail: "previously accepted anything" });
    return;
  }
  if (!isObj(cur)) {
    out.push({ tool, path, kind: "type-narrowed", detail: "now rejects everything" });
    return;
  }

  // Unions: every baseline branch must be fully accepted by some current branch.
  const bBranches = branches(base);
  const cBranches = branches(cur);
  if (bBranches || cBranches) {
    for (const [i, b] of (bBranches ?? [base]).entries()) {
      const candidates = cBranches ?? [cur];
      const ok = candidates.some((c) => {
        const tmp: Violation[] = [];
        compareSchema(b, c, baseRoot, curRoot, tool, path, tmp);
        return tmp.length === 0;
      });
      if (!ok) {
        out.push({
          tool,
          path,
          kind: "type-narrowed",
          detail: `union branch ${i} no longer accepted`,
        });
      }
    }
    return;
  }

  const bTypes = typesOf(base);
  const cTypes = typesOf(cur);
  for (const t of bTypes) {
    if (!accepts(cTypes, t))
      out.push({ tool, path, kind: "type-narrowed", detail: `no longer accepts ${t}` });
  }

  // enum / const
  const bEnum = Array.isArray(base.enum) ? base.enum : "const" in base ? [base.const] : undefined;
  const cEnum = Array.isArray(cur.enum) ? cur.enum : "const" in cur ? [cur.const] : undefined;
  if (cEnum) {
    if (!bEnum) out.push({ tool, path, kind: "enum-narrowed", detail: "enum added" });
    else {
      const missing = bEnum.filter(
        (v) => !cEnum.some((c) => JSON.stringify(c) === JSON.stringify(v)),
      );
      if (missing.length) {
        out.push({
          tool,
          path,
          kind: "enum-narrowed",
          detail: `removed values ${JSON.stringify(missing)}`,
        });
      }
    }
  }

  // Lower bounds may only go down, upper bounds may only go up.
  for (const k of ["minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties"]) {
    if (
      typeof cur[k] === "number" &&
      !(typeof base[k] === "number" && (cur[k] as number) <= (base[k] as number))
    ) {
      out.push({
        tool,
        path,
        kind: "bound-narrowed",
        detail: `${k} ${base[k] ?? "unset"} -> ${cur[k]}`,
      });
    }
  }
  for (const k of ["maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties"]) {
    if (
      typeof cur[k] === "number" &&
      !(typeof base[k] === "number" && (cur[k] as number) >= (base[k] as number))
    ) {
      out.push({
        tool,
        path,
        kind: "bound-narrowed",
        detail: `${k} ${base[k] ?? "unset"} -> ${cur[k]}`,
      });
    }
  }
  for (const k of ["pattern", "format", "multipleOf"]) {
    if (k in cur && JSON.stringify(cur[k]) !== JSON.stringify(base[k])) {
      out.push({
        tool,
        path,
        kind: "constraint-added",
        detail: `${k} ${JSON.stringify(base[k])} -> ${JSON.stringify(cur[k])}`,
      });
    }
  }
  if (cur.uniqueItems === true && base.uniqueItems !== true) {
    out.push({ tool, path, kind: "constraint-added", detail: "uniqueItems added" });
  }

  // Objects
  if (bTypes.has("object") || isObj(base.properties)) {
    const bProps = (isObj(base.properties) ? base.properties : {}) as Obj;
    const cProps = (isObj(cur.properties) ? cur.properties : {}) as Obj;
    const bReq = new Set((base.required as string[] | undefined) ?? []);
    for (const r of (cur.required as string[] | undefined) ?? []) {
      if (!bReq.has(r))
        out.push({
          tool,
          path: `${path}.${r}`,
          kind: "required-added",
          detail: `"${r}" is now required`,
        });
    }
    const curClosed = cur.additionalProperties === false;
    for (const [name, bSchema] of Object.entries(bProps)) {
      if (name in cProps) {
        compareSchema(
          bSchema as Schema,
          cProps[name] as Schema,
          baseRoot,
          curRoot,
          tool,
          `${path}.${name}`,
          out,
        );
      } else if (curClosed) {
        out.push({
          tool,
          path: `${path}.${name}`,
          kind: "param-removed",
          detail: `"${name}" removed and unknown properties are rejected`,
        });
      } else if (isObj(cur.additionalProperties)) {
        compareSchema(
          bSchema as Schema,
          cur.additionalProperties,
          baseRoot,
          curRoot,
          tool,
          `${path}.${name}`,
          out,
        );
      }
    }
    if (curClosed && base.additionalProperties !== false) {
      out.push({ tool, path, kind: "constraint-added", detail: "unknown properties now rejected" });
    } else if (isObj(base.additionalProperties) && isObj(cur.additionalProperties)) {
      compareSchema(
        base.additionalProperties,
        cur.additionalProperties,
        baseRoot,
        curRoot,
        tool,
        `${path}.*`,
        out,
      );
    }
  }

  // Arrays
  if (
    (bTypes.has("array") || base.items !== undefined) &&
    base.items !== undefined &&
    cur.items !== undefined
  ) {
    compareSchema(
      base.items as Schema,
      cur.items as Schema,
      baseRoot,
      curRoot,
      tool,
      `${path}[]`,
      out,
    );
  }
}

export function compareToolLists(baseline: Tool[], current: Tool[]): Violation[] {
  const out: Violation[] = [];
  const byName = new Map(current.map((t) => [t.name, t]));
  for (const b of baseline) {
    const c = byName.get(b.name);
    if (!c) {
      out.push({ tool: b.name, path: "", kind: "tool-removed", detail: "tool no longer listed" });
      continue;
    }
    compareSchema(b.inputSchema, c.inputSchema, b.inputSchema, c.inputSchema, b.name, "$", out);
  }
  return out;
}

/** Flatten a JSON value into `path -> sorted JSON types` (arrays collapse to `[]`). */
export function shapeOf(value: unknown): Record<string, string[]> {
  const acc = new Map<string, Set<string>>();
  const visit = (v: unknown, p: string) => {
    const t = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
    if (!acc.has(p)) acc.set(p, new Set());
    acc.get(p)!.add(t);
    if (Array.isArray(v)) v.forEach((x) => visit(x, `${p}[]`));
    else if (isObj(v)) for (const [k, x] of Object.entries(v)) visit(x, `${p}.${k}`);
  };
  visit(value, "$");
  return Object.fromEntries(
    [...acc.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, s]) => [k, [...s].sort()]),
  );
}

export interface OutputRecord {
  step: string;
  tool: string;
  isError: boolean;
  shape: Record<string, string[]>;
}

export function compareOutputs(baseline: OutputRecord[], current: OutputRecord[]): Violation[] {
  const out: Violation[] = [];
  const byStep = new Map(current.map((r) => [r.step, r]));
  for (const b of baseline) {
    const c = byStep.get(b.step);
    if (!c) {
      out.push({
        tool: b.tool,
        path: b.step,
        kind: "output-field-removed",
        detail: "scenario step produced no output",
      });
      continue;
    }
    if (b.isError !== c.isError) {
      out.push({
        tool: b.tool,
        path: b.step,
        kind: "output-error-changed",
        detail: `isError ${b.isError} -> ${c.isError}`,
      });
      continue;
    }
    for (const [p, types] of Object.entries(b.shape)) {
      const cTypes = c.shape[p];
      if (!cTypes) {
        out.push({
          tool: b.tool,
          path: `${b.step} ${p}`,
          kind: "output-field-removed",
          detail: "field missing",
        });
      } else if (types.some((t) => !cTypes.includes(t))) {
        out.push({
          tool: b.tool,
          path: `${b.step} ${p}`,
          kind: "output-type-changed",
          detail: `${types} -> ${cTypes}`,
        });
      }
    }
  }
  return out;
}
