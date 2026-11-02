import { describe, expect, it } from "vitest";
import { compareOutputs, compareToolLists, shapeOf, type Tool } from "./schema-compat.js";

const tool = (inputSchema: object, name = "t"): Tool => ({
  name,
  inputSchema: inputSchema as Tool["inputSchema"],
});

const base = tool({
  type: "object",
  properties: {
    mailbox: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 100 },
    to: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1 }] },
    cc: { $ref: "#/properties/to" },
    mode: { type: "string", enum: ["a", "b"] },
  },
  required: ["mailbox"],
});

const kinds = (cur: Tool) => compareToolLists([base], [cur]).map((v) => v.kind);

const withProps = (patch: Record<string, unknown>, extra: object = {}) =>
  tool({
    ...(base.inputSchema as object),
    properties: { ...(base.inputSchema.properties as object), ...patch },
    ...extra,
  });

describe("compareToolLists", () => {
  it("accepts an identical schema", () => {
    expect(kinds(base)).toEqual([]);
  });

  it("accepts additive and relaxing changes", () => {
    const cur = withProps(
      {
        mailbox: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
        limit: { type: "number", minimum: 0 },
        mode: { type: "string", enum: ["a", "b", "c"] },
        newOptional: { type: "boolean" },
      },
      { required: [] },
    );
    expect(kinds(cur)).toEqual([]);
  });

  it("flags a removed tool", () => {
    expect(compareToolLists([base], [tool(base.inputSchema, "other")]).map((v) => v.kind)).toEqual([
      "tool-removed",
    ]);
  });

  it("flags a newly required parameter", () => {
    expect(kinds(withProps({}, { required: ["mailbox", "limit"] }))).toEqual(["required-added"]);
  });

  it("flags a new required parameter that did not exist before", () => {
    expect(
      kinds(withProps({ extra: { type: "string" } }, { required: ["mailbox", "extra"] })),
    ).toEqual(["required-added"]);
  });

  it("flags a type narrowing", () => {
    expect(kinds(withProps({ limit: { type: "string" } }))).toContain("type-narrowed");
  });

  it("flags number -> integer as narrowing", () => {
    const b = tool({ type: "object", properties: { n: { type: "number" } } });
    const c = tool({ type: "object", properties: { n: { type: "integer" } } });
    expect(compareToolLists([b], [c]).map((v) => v.kind)).toEqual(["type-narrowed"]);
  });

  it("flags a dropped union branch, including through $ref", () => {
    expect(kinds(withProps({ cc: { type: "string" } }))).toEqual(["type-narrowed"]);
  });

  it("flags removed enum values and tightened bounds", () => {
    expect(kinds(withProps({ mode: { type: "string", enum: ["a"] } }))).toEqual(["enum-narrowed"]);
    expect(kinds(withProps({ limit: { type: "integer", minimum: 1, maximum: 50 } }))).toEqual([
      "bound-narrowed",
    ]);
    expect(kinds(withProps({ mailbox: { type: "string", maxLength: 10 } }))).toEqual([
      "bound-narrowed",
    ]);
  });

  it("resolves $ref paths through arrays", () => {
    const b = tool({
      type: "object",
      properties: { to: { anyOf: [{ type: "string" }] }, cc: { $ref: "#/properties/to/anyOf/0" } },
    });
    expect(compareToolLists([b], [b])).toEqual([]);
  });

  it("flags added patterns and formats", () => {
    expect(kinds(withProps({ mailbox: { type: "string", pattern: "^[A-Z]+$" } }))).toEqual([
      "constraint-added",
    ]);
  });

  it("flags a removed parameter only when unknown properties are rejected", () => {
    const props = { ...(base.inputSchema.properties as Record<string, unknown>) };
    delete props.mode;
    expect(kinds(tool({ ...base.inputSchema, properties: props }))).toEqual([]);
    expect(
      kinds(tool({ ...base.inputSchema, properties: props, additionalProperties: false })),
    ).toEqual(["param-removed", "constraint-added"]);
  });
});

describe("compareOutputs", () => {
  const rec = (value: unknown, isError = false) => [
    { step: "s", tool: "t", isError, shape: shapeOf(value) },
  ];

  it("accepts added fields", () => {
    expect(compareOutputs(rec({ a: 1 }), rec({ a: 2, b: "x" }))).toEqual([]);
  });

  it("flags a missing field, including inside arrays", () => {
    expect(
      compareOutputs(rec({ items: [{ id: 1, name: "x" }] }), rec({ items: [{ id: 1 }] })).map(
        (v) => v.kind,
      ),
    ).toEqual(["output-field-removed"]);
  });

  it("flags a changed field type", () => {
    expect(compareOutputs(rec({ a: 1 }), rec({ a: "1" })).map((v) => v.kind)).toEqual([
      "output-type-changed",
    ]);
  });

  it("flags a step that started or stopped erroring", () => {
    expect(compareOutputs(rec({ a: 1 }), rec({ a: 1 }, true)).map((v) => v.kind)).toEqual([
      "output-error-changed",
    ]);
  });
});
