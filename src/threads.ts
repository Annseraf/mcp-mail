/**
 * Conversation threading across folders. Groups by Message-ID, In-Reply-To
 * and References first; falls back to normalized subject plus overlapping
 * participants for mail without those headers.
 */
import type { ImapClient, ThreadMember } from "./imap-client.js";

const PREFIX = /^\s*((re|fw|fwd|aw|wg|sv|vs|antw|tr|rif)(\[\d+\])?\s*:\s*|\[[^\]]{1,40}\]\s*)+/i;

export function normalizeSubject(s: string | null | undefined): string {
  return (s ?? "").replace(PREFIX, "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function addresses(...fields: (string | null | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const f of fields)
    for (const m of (f ?? "").matchAll(/[^\s<>,;"']+@[^\s<>,;"']+/g)) out.add(m[0].toLowerCase());
  return out;
}

const participants = (m: ThreadMember) => addresses(m.from, m.to, m.cc);
const overlaps = (a: Set<string>, b: Set<string>) => [...a].some((x) => b.has(x));
const idsOf = (m: ThreadMember) =>
  [m.messageId, m.inReplyTo, ...m.references].filter((x): x is string => Boolean(x));
const key = (m: ThreadMember) => m.messageId ?? `${m.mailbox}#${m.uid}`;
const byDate = (a: ThreadMember, b: ThreadMember) => (a.date ?? "").localeCompare(b.date ?? "");

/** Every message in the conversation containing the seed, oldest first. */
export async function findThread(
  imap: ImapClient,
  seed: ThreadMember,
  folders: string[],
  maxMessages = 50,
): Promise<ThreadMember[]> {
  const found = new Map<string, ThreadMember>([[key(seed), seed]]);
  let ids = new Set(idsOf(seed));
  const searched = new Set<string>();
  for (let round = 0; round < 3 && ids.size; round++) {
    const fresh = [...ids].filter((id) => !searched.has(id)).slice(0, 25);
    if (!fresh.length) break;
    fresh.forEach((id) => searched.add(id));
    for (const folder of folders) {
      const uids = new Set<number>();
      for (const id of fresh) {
        for (const header of ["Message-ID", "In-Reply-To", "References"]) {
          for (const uid of await imap.searchHeader(folder, header, id).catch(() => []))
            uids.add(uid);
        }
      }
      if (!uids.size) continue;
      for (const m of await imap.threadMembers(folder, [...uids])) {
        if (!found.has(key(m))) found.set(key(m), m);
      }
    }
    ids = new Set([...found.values()].flatMap(idsOf));
    if (found.size >= maxMessages) break;
  }

  if (found.size === 1) {
    // No header links: same normalized subject and at least one shared participant.
    const subject = normalizeSubject(seed.subject);
    if (subject.length >= 3) {
      const who = participants(seed);
      for (const folder of folders) {
        const uids = await imap.searchSubject(folder, subject).catch(() => []);
        if (!uids.length) continue;
        for (const m of await imap.threadMembers(folder, uids)) {
          if (
            normalizeSubject(m.subject) === subject &&
            overlaps(who, participants(m)) &&
            !found.has(key(m))
          ) {
            found.set(key(m), m);
          }
        }
      }
    }
  }
  return [...found.values()].sort(byDate).slice(-maxMessages);
}

export interface ThreadGroup {
  subject: string | null;
  count: number;
  last_date: string | null;
  participants: string[];
  messages: ThreadMember[];
}

/** Group a list of messages (e.g. the newest N in a folder) into conversations. */
export function groupThreads(members: ThreadMember[]): ThreadGroup[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  };
  const union = (a: string, b: string) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  };
  for (const m of members) {
    const k = key(m);
    if (!parent.has(k)) parent.set(k, k);
    for (const id of idsOf(m)) union(k, id);
  }
  // Header-less mail: merge with an existing group of the same subject and participants.
  const bySubject = new Map<string, ThreadMember[]>();
  for (const m of members) {
    const s = normalizeSubject(m.subject);
    if (!s) continue;
    const list = bySubject.get(s) ?? [];
    for (const other of list)
      if (overlaps(participants(m), participants(other))) union(key(m), key(other));
    list.push(m);
    bySubject.set(s, list);
  }
  const groups = new Map<string, ThreadMember[]>();
  for (const m of members) {
    const root = find(key(m));
    groups.set(root, [...(groups.get(root) ?? []), m]);
  }
  return [...groups.values()]
    .map((ms) => {
      ms.sort(byDate);
      const all = new Set<string>();
      ms.forEach((m) => participants(m).forEach((p) => all.add(p)));
      return {
        subject: ms[0].subject,
        count: ms.length,
        last_date: ms[ms.length - 1].date,
        participants: [...all],
        messages: ms,
      };
    })
    .sort((a, b) => (b.last_date ?? "").localeCompare(a.last_date ?? ""));
}
