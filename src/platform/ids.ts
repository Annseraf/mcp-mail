/** Identifier rules shared by the platform layer. They double as path-traversal guards. */

const TENANT_ID = /^[a-z0-9][a-z0-9-]{2,62}$/;
const OBJECT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SECRET_NAME = /^[a-z0-9][a-z0-9:_.-]{0,127}$/;

export class InvalidIdError extends Error {
  constructor(kind: string, value: string) {
    super(`Invalid ${kind}: ${JSON.stringify(value).slice(0, 80)}`);
    this.name = "InvalidIdError";
  }
}

export function assertTenantId(id: string): string {
  if (!TENANT_ID.test(id)) throw new InvalidIdError("tenant id", id);
  return id;
}

/** Mailbox and client ids (same shape as accounts.json account ids). */
export function assertObjectId(id: string, kind = "id"): string {
  if (!OBJECT_ID.test(id)) throw new InvalidIdError(kind, id);
  return id;
}

export function assertSecretName(name: string): string {
  if (!SECRET_NAME.test(name)) throw new InvalidIdError("secret name", name);
  return name;
}

export const isTenantId = (id: string) => TENANT_ID.test(id);
