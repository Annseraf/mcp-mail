/**
 * Capability tags and permission presets (docs/PLATFORM.md). Policies grant
 * capabilities, not tool names, so new tools are governed automatically.
 */
import type { Preset } from "../platform/tenants.js";

export type Capability =
  "read" | "organize" | "draft" | "send" | "destructive" | "calendar-read" | "calendar-write";

/** Every tool declares exactly one capability. Unknown tools are treated as destructive. */
export const TOOL_CAPABILITY: Record<string, Capability> = {
  list_accounts: "read",
  list_folders: "read",
  list_messages: "read",
  search_messages: "read",
  get_message: "read",
  create_draft: "draft",
  send_message: "send",
  mark_read: "organize",
  move_message: "organize",
  // Moves to Trash; `permanent: true` additionally needs "destructive" (capabilityOf).
  delete_message: "organize",
  list_calendars: "calendar-read",
  list_events: "calendar-read",
  find_free_slot: "calendar-read",
  create_event: "calendar-write",
};

export const PRESETS: Record<Preset, Capability[]> = {
  "read-only": ["read", "calendar-read"],
  "read-draft": ["read", "calendar-read", "draft"],
  organize: ["read", "calendar-read", "draft", "organize"],
  "full-no-delete": ["read", "calendar-read", "draft", "organize", "calendar-write", "send"],
  full: ["read", "calendar-read", "draft", "organize", "calendar-write", "send", "destructive"],
};

/** Capability a call needs. Unknown tools are treated as destructive. */
export function capabilityOf(tool: string, args?: Record<string, unknown>): Capability {
  if (tool === "delete_message" && args?.permanent === true) return "destructive";
  return TOOL_CAPABILITY[tool] ?? "destructive";
}

export function presetAllows(
  preset: Preset,
  tool: string,
  args?: Record<string, unknown>,
): boolean {
  return PRESETS[preset].includes(capabilityOf(tool, args));
}
