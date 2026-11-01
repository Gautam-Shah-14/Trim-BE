/**
 * Pure slot / time helpers. No DB access: the availability module loads rows and feeds them in,
 * which keeps this file easy to unit test across timezones, closures and time off.
 * All instants are epoch milliseconds (UTC); "local" always means the salon's IANA timezone.
 */

export interface Interval {
  start: number;
  end: number;
}

const MIN = 60_000;
export const SLOT_STEP_MIN = 15;

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export function isValidTimezone(tz: string): boolean {
  try {
    dtf(tz);
    return true;
  } catch {
    return false;
  }
}

function localParts(utcMs: number, tz: string) {
  const out: Record<string, number> = {};
  for (const p of dtf(tz).formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** offset (local - UTC) in ms at the given instant */
export function tzOffsetMs(utcMs: number, tz: string): number {
  const p = localParts(utcMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Convert a local wall-clock date + time (HH:MM[:SS]) in tz to a UTC instant. */
export function zonedToUtc(date: string, time: string, tz: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  const off1 = tzOffsetMs(guess, tz);
  let utc = guess - off1;
  const off2 = tzOffsetMs(utc, tz);
  if (off2 !== off1) utc = guess - off2;
  return utc;
}

export function localDateOf(utcMs: number, tz: string): string {
  const p = localParts(utcMs, tz);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function localHourOf(utcMs: number, tz: string): number {
  return localParts(utcMs, tz).hour;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 0 = Sunday .. 6 = Saturday for a calendar date string */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function localDayRange(date: string, tz: string): Interval {
  return { start: zonedToUtc(date, '00:00', tz), end: zonedToUtc(addDays(date, 1), '00:00', tz) };
}

export function isValidDateString(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export interface HoursRow {
  opens: string;
  closes: string;
  isClosed: boolean;
}

/**
 * Working window for a staff member on a local date. Staff hours (if provided for that weekday)
 * override salon hours; a closed salon day or a closure date always wins.
 */
export function workingWindows(args: {
  date: string;
  tz: string;
  salonHours: HoursRow | null;
  closed: boolean;
  staffHours?: { start: string; end: string } | null;
}): Interval[] {
  const { date, tz, salonHours, closed, staffHours } = args;
  if (closed || !salonHours || salonHours.isClosed) return [];
  const open = staffHours?.start ?? salonHours.opens;
  const close = staffHours?.end ?? salonHours.closes;
  const start = zonedToUtc(date, open, tz);
  const end = zonedToUtc(date, close, tz);
  return end > start ? [{ start, end }] : [];
}

/** Remove `cuts` from `base`. Inputs need not be sorted. */
export function subtractIntervals(base: Interval[], cuts: Interval[]): Interval[] {
  const sortedCuts = [...cuts].sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const b of base) {
    let cursor = b.start;
    for (const c of sortedCuts) {
      if (c.end <= cursor) continue;
      if (c.start >= b.end) break;
      if (c.start > cursor) out.push({ start: cursor, end: Math.min(c.start, b.end) });
      cursor = Math.max(cursor, c.end);
      if (cursor >= b.end) break;
    }
    if (cursor < b.end) out.push({ start: cursor, end: b.end });
  }
  return out;
}

export function contains(windows: Interval[], i: Interval): boolean {
  return windows.some((w) => w.start <= i.start && i.end <= w.end);
}

/** ceil(base * speed) rounded up to a multiple of 5 minutes */
export function effectiveDuration(baseMin: number, speed: number): number {
  const raw = baseMin * speed;
  return Math.ceil(raw / 5 - 1e-9) * 5;
}

/** Σ effective durations + Σ buffers */
export function totalDuration(services: { durationMin: number; bufferMin: number }[], speed: number): number {
  return services.reduce((acc, s) => acc + effectiveDuration(s.durationMin, speed) + s.bufferMin, 0);
}

export interface SlotArgs {
  windows: Interval[];
  /** time off and existing bookings, anything that blocks the staff member */
  blocked: Interval[];
  durationMin: number;
  now: number;
  stepMin?: number;
}

/** Candidate start times on the absolute step grid that fit entirely inside a free gap and are not in the past. */
export function computeSlots(a: SlotArgs): Interval[] {
  const step = (a.stepMin ?? SLOT_STEP_MIN) * MIN;
  const dur = a.durationMin * MIN;
  const free = subtractIntervals(a.windows, a.blocked);
  const out: Interval[] = [];
  for (const g of free) {
    let t = Math.ceil(Math.max(g.start, a.now) / step) * step;
    while (t + dur <= g.end) {
      out.push({ start: t, end: t + dur });
      t += step;
    }
  }
  return out;
}
