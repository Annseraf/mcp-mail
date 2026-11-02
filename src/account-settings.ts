/**
 * Per-account sender name and signature, editable by agents through the
 * update_account_settings tool.
 */
import type { AccountSource, AccountsStore } from "./accounts.js";
import { readOverlay } from "./accounts.js";
import { writeFileAtomic } from "./platform/fsutil.js";

export interface AccountSettingsPatch {
  fromName?: string | null;
  signature?: string | null;
}

export interface AccountSettingsWriter {
  /** Apply a patch to an account (default when omitted). Returns the account id updated. */
  update(accountId: string | undefined, patch: AccountSettingsPatch): Promise<string>;
}

/** Single-tenant: writes account-settings.json next to accounts.json, then reloads. */
export class OverlayAccountSettings implements AccountSettingsWriter {
  constructor(private readonly store: AccountsStore) {}

  async update(accountId: string | undefined, patch: AccountSettingsPatch): Promise<string> {
    const file = this.store.overlayFile;
    if (!file)
      throw new Error("Account settings are read-only on this server (no ACCOUNT_SETTINGS_FILE).");
    const id = this.store.resolve(accountId).id;
    const doc = await readOverlay(file);
    doc.accounts[id] = { ...doc.accounts[id], ...patch };
    await writeFileAtomic(file, JSON.stringify(doc, null, 2) + "\n");
    await this.store.reload(); // fires onChange -> client pool reset
    return id;
  }
}

/** Resolve an id against what the caller may see before writing anything. */
export function scopedWriter(
  writer: AccountSettingsWriter,
  visible: AccountSource,
): AccountSettingsWriter {
  return {
    update: (accountId, patch) => writer.update(visible.resolve(accountId).id, patch),
  };
}

/** Append the signature using the standard "-- " delimiter. */
export function withSignature(
  body: { text?: string; html?: string },
  signature: string | undefined,
): { text?: string; html?: string } {
  if (!signature) return body;
  const esc = signature.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
  return {
    text:
      body.text !== undefined || body.html === undefined
        ? `${body.text ?? ""}\n\n-- \n${signature}`
        : undefined,
    html:
      body.html !== undefined
        ? `${body.html}<br><br>-- <br>${esc.replace(/\n/g, "<br>")}`
        : undefined,
  };
}
