/**
 * Schema helpers that keep the advertised JSON Schema identical to v0.2.x
 * (docs/COMPATIBILITY.md). zod 4 adds a safe-integer `maximum` to `.int()`
 * and a `pattern` to `.email()`; both would narrow what clients see, so these
 * validate at runtime and advertise exactly what v0.2.x advertised.
 */
import { z } from "zod";

/** A positive integer, advertised as `{ type: "integer", exclusiveMinimum: 0 }`. */
export function positiveInt() {
  return z
    .number()
    .refine((n) => Number.isInteger(n) && n > 0, { message: "Expected a positive integer" })
    .meta({ type: "integer", exclusiveMinimum: 0 });
}

// The address check zod 3's `.email()` applied, so accepted input is unchanged.
const ZOD3_EMAIL =
  /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9-]*\.)+[A-Z]{2,}$/i;

/** An email address, advertised as `{ type: "string", format: "email" }`. */
export function email() {
  return z
    .string()
    .refine((s) => ZOD3_EMAIL.test(s), { message: "Invalid email" })
    .meta({ format: "email" });
}
