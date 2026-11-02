/**
 * CalDAV client wrapper around tsdav + ical.js.
 *
 * Discovers calendars on demand, lists events in a window, creates new
 * events, and computes free slots between existing busy intervals.
 *
 * v0.1 trade-off: we discover calendars on each call rather than caching,
 * because tsdav's discovery is cheap (one PROPFIND) and stale caches are
 * worse than a small extra request. v0.2 will introduce a short TTL cache.
 */

import { createDAVClient, DAVCalendar, DAVCalendarObject } from "tsdav";
import ICAL from "ical.js";
import { randomUUID } from "node:crypto";

// createDAVClient returns a logged-in client whose type omits the login
// methods. Capture that shape for our field types.
type AuthedDAVClient = Awaited<ReturnType<typeof createDAVClient>>;

export interface CalDavAuth {
  url: string;
  user: string;
  pass: string;
}

export interface CalendarSummary {
  url: string;
  displayName: string;
  description: string | null;
  ctag: string | null;
  timezone: string | null;
  components: string[];
}

export interface CalendarEvent {
  uid: string;
  url: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  start: string; // ISO
  end: string; // ISO
  allDay: boolean;
  organizer: string | null;
  attendees: string[];
  status: string | null;
  recurrenceId: string | null;
}

export interface NewEventInput {
  calendarUrl: string;
  summary: string;
  description?: string;
  location?: string;
  start: string; // ISO 8601, with timezone offset
  end: string;
  allDay?: boolean;
  attendees?: string[];
}

export interface FreeSlot {
  start: string;
  end: string;
}

export class CalDavClient {
  private client: AuthedDAVClient | null = null;
  private connecting: Promise<AuthedDAVClient> | null = null;
  private readonly auth: CalDavAuth;

  constructor(auth: CalDavAuth) {
    this.auth = auth;
  }

  private async ensureClient(): Promise<AuthedDAVClient> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async (): Promise<AuthedDAVClient> => {
      const client = await createDAVClient({
        serverUrl: this.auth.url,
        credentials: {
          username: this.auth.user,
          password: this.auth.pass,
        },
        authMethod: "Basic",
        defaultAccountType: "caldav",
      });
      this.client = client;
      this.connecting = null;
      return client;
    })();
    return this.connecting;
  }

  async listCalendars(): Promise<CalendarSummary[]> {
    const client = await this.ensureClient();
    const calendars: DAVCalendar[] = await client.fetchCalendars();
    return calendars.map((cal) => ({
      url: cal.url,
      displayName:
        typeof cal.displayName === "string"
          ? cal.displayName
          : (cal.url.split("/").filter(Boolean).pop() ?? cal.url),
      description: (cal as { description?: string }).description ?? null,
      ctag: cal.ctag ?? null,
      timezone: typeof cal.timezone === "string" ? cal.timezone : null,
      components: Array.isArray(cal.components) ? cal.components.map(String) : [],
    }));
  }

  async listEvents(
    calendarUrl: string,
    rangeStart: string,
    rangeEnd: string,
  ): Promise<CalendarEvent[]> {
    const calendar = await this.findCalendar(calendarUrl);
    const client = await this.ensureClient();
    const objects: DAVCalendarObject[] = await client.fetchCalendarObjects({
      calendar,
      timeRange: {
        start: rangeStart,
        end: rangeEnd,
      },
      expand: true,
    });
    const events: CalendarEvent[] = [];
    for (const obj of objects) {
      if (!obj.data) continue;
      const parsed = parseICalEvents(obj.data, obj.url);
      events.push(...parsed);
    }
    events.sort((a, b) => a.start.localeCompare(b.start));
    return events;
  }

  async createEvent(input: NewEventInput): Promise<{ url: string; uid: string }> {
    const calendar = await this.findCalendar(input.calendarUrl);
    const client = await this.ensureClient();
    const uid = `${randomUUID()}@claude-mail-mcp`;
    const ics = buildIcs({ ...input, uid });
    const filename = `${uid}.ics`;
    await client.createCalendarObject({
      calendar,
      filename,
      iCalString: ics,
    });
    const base = calendar.url.endsWith("/") ? calendar.url : `${calendar.url}/`;
    return { url: `${base}${filename}`, uid };
  }

  async findFreeSlots(
    calendarUrls: string[],
    rangeStart: string,
    rangeEnd: string,
    durationMinutes: number,
    workingHours?: { startHour: number; endHour: number },
  ): Promise<FreeSlot[]> {
    const busy: Array<{ start: number; end: number }> = [];
    for (const url of calendarUrls) {
      const events = await this.listEvents(url, rangeStart, rangeEnd);
      for (const e of events) {
        busy.push({
          start: new Date(e.start).getTime(),
          end: new Date(e.end).getTime(),
        });
      }
    }
    busy.sort((a, b) => a.start - b.start);
    const merged: Array<{ start: number; end: number }> = [];
    for (const slot of busy) {
      const last = merged[merged.length - 1];
      if (last && slot.start <= last.end) {
        last.end = Math.max(last.end, slot.end);
      } else {
        merged.push({ ...slot });
      }
    }

    const rangeStartMs = new Date(rangeStart).getTime();
    const rangeEndMs = new Date(rangeEnd).getTime();
    const durationMs = durationMinutes * 60 * 1000;
    const free: FreeSlot[] = [];
    let cursor = rangeStartMs;

    const clampToWork = (start: number, end: number): { s: number; e: number } | null => {
      if (!workingHours) return { s: start, e: end };
      // Anchor to the day of `start` in UTC; users pass ISO with offset, so
      // working hours are interpreted in UTC. v0.2 will accept a timezone.
      const d = new Date(start);
      const dayStart = Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate(),
        workingHours.startHour,
      );
      const dayEnd = Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate(),
        workingHours.endHour,
      );
      const s = Math.max(start, dayStart);
      const e = Math.min(end, dayEnd);
      if (e - s < durationMs) return null;
      return { s, e };
    };

    for (const slot of merged) {
      if (cursor + durationMs <= slot.start) {
        const clamped = clampToWork(cursor, slot.start);
        if (clamped) {
          free.push({
            start: new Date(clamped.s).toISOString(),
            end: new Date(clamped.e).toISOString(),
          });
        }
      }
      cursor = Math.max(cursor, slot.end);
    }
    if (cursor + durationMs <= rangeEndMs) {
      const clamped = clampToWork(cursor, rangeEndMs);
      if (clamped) {
        free.push({
          start: new Date(clamped.s).toISOString(),
          end: new Date(clamped.e).toISOString(),
        });
      }
    }
    return free;
  }

  private async findCalendar(url: string): Promise<DAVCalendar> {
    const calendars = await (await this.ensureClient()).fetchCalendars();
    const match = calendars.find(
      (c) => c.url === url || c.url.replace(/\/$/, "") === url.replace(/\/$/, ""),
    );
    if (!match) {
      throw new Error(`Calendar not found: ${url}. Use list_calendars to discover available URLs.`);
    }
    return match;
  }
}

function parseICalEvents(icsData: string, objectUrl: string): CalendarEvent[] {
  const jcal = ICAL.parse(icsData);
  const vcal = new ICAL.Component(jcal);
  const vevents = vcal.getAllSubcomponents("vevent");
  return vevents.map((ve) => {
    const event = new ICAL.Event(ve);
    const start = event.startDate;
    const end = event.endDate;
    const attendeeProps = ve.getAllProperties("attendee");
    const organizerProp = ve.getFirstProperty("organizer");
    return {
      uid: event.uid ?? "",
      url: objectUrl,
      summary: event.summary ?? null,
      description: event.description ?? null,
      location: event.location ?? null,
      start: start.toJSDate().toISOString(),
      end: end.toJSDate().toISOString(),
      allDay: Boolean(start.isDate),
      organizer: organizerProp ? String(organizerProp.getFirstValue()) : null,
      attendees: attendeeProps.map((p) => String(p.getFirstValue())),
      status: (ve.getFirstPropertyValue("status") as string | null) ?? null,
      recurrenceId: event.recurrenceId ? event.recurrenceId.toJSDate().toISOString() : null,
    };
  });
}

function buildIcs(input: NewEventInput & { uid: string }): string {
  const cal = new ICAL.Component(["vcalendar", [], []]);
  cal.updatePropertyWithValue("prodid", "-//claude-mail-mcp//EN");
  cal.updatePropertyWithValue("version", "2.0");

  const vevent = new ICAL.Component("vevent");
  vevent.updatePropertyWithValue("uid", input.uid);
  vevent.updatePropertyWithValue("dtstamp", ICAL.Time.fromJSDate(new Date(), true));
  if (input.allDay) {
    const startDate = ICAL.Time.fromDateString(input.start.slice(0, 10));
    const endDate = ICAL.Time.fromDateString(input.end.slice(0, 10));
    vevent.updatePropertyWithValue("dtstart", startDate);
    vevent.updatePropertyWithValue("dtend", endDate);
  } else {
    vevent.updatePropertyWithValue("dtstart", ICAL.Time.fromJSDate(new Date(input.start), true));
    vevent.updatePropertyWithValue("dtend", ICAL.Time.fromJSDate(new Date(input.end), true));
  }
  vevent.updatePropertyWithValue("summary", input.summary);
  if (input.description) {
    vevent.updatePropertyWithValue("description", input.description);
  }
  if (input.location) {
    vevent.updatePropertyWithValue("location", input.location);
  }
  for (const a of input.attendees ?? []) {
    const prop = new ICAL.Property("attendee");
    prop.setValue(a.startsWith("mailto:") ? a : `mailto:${a}`);
    vevent.addProperty(prop);
  }
  cal.addSubcomponent(vevent);
  return cal.toString();
}
