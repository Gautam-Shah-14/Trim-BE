import { describe, expect, it } from 'vitest';
import {
  addDays, computeSlots, contains, effectiveDuration, isValidDateString, localDateOf, localDayRange, subtractIntervals, totalDuration,
  weekdayOf, workingWindows, zonedToUtc,
} from '../src/lib/slots.js';

const iso = (ms: number) => new Date(ms).toISOString();
const H = 3_600_000;

describe('timezone conversion', () => {
  it('Asia/Kolkata is UTC+5:30', () => {
    expect(iso(zonedToUtc('2026-11-02', '10:00', 'Asia/Kolkata'))).toBe('2026-11-02T04:30:00.000Z');
  });
  it('handles US DST spring-forward (23 hour day) and fall-back (25 hour day)', () => {
    expect(iso(zonedToUtc('2026-03-07', '12:00', 'America/New_York'))).toBe('2026-03-07T17:00:00.000Z');
    expect(iso(zonedToUtc('2026-03-08', '12:00', 'America/New_York'))).toBe('2026-03-08T16:00:00.000Z');
    const spring = localDayRange('2026-03-08', 'America/New_York');
    expect((spring.end - spring.start) / H).toBe(23);
    const fall = localDayRange('2026-11-01', 'America/New_York');
    expect((fall.end - fall.start) / H).toBe(25);
  });
  it('handles a +13 zone and a date-line crossing', () => {
    expect(iso(zonedToUtc('2026-07-01', '09:00', 'Pacific/Auckland'))).toBe('2026-06-30T21:00:00.000Z');
    expect(localDateOf(Date.parse('2026-06-30T21:00:00Z'), 'Pacific/Auckland')).toBe('2026-07-01');
    expect(localDateOf(Date.parse('2026-06-30T21:00:00Z'), 'Asia/Kolkata')).toBe('2026-07-01');
    expect(localDateOf(Date.parse('2026-06-30T17:00:00Z'), 'Asia/Kolkata')).toBe('2026-06-30');
  });
  it('date helpers', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(weekdayOf('2026-11-01')).toBe(0); // Sunday
    expect(isValidDateString('2026-02-30')).toBe(false);
    expect(isValidDateString('2026-02-28')).toBe(true);
  });
});

describe('working windows', () => {
  const tz = 'Asia/Kolkata';
  const hours = { opens: '10:00', closes: '12:00', isClosed: false };
  it('uses salon hours', () => {
    const w = workingWindows({ date: '2026-11-02', tz, salonHours: hours, closed: false });
    expect(w).toHaveLength(1);
    expect((w[0]!.end - w[0]!.start) / H).toBe(2);
  });
  it('closed weekday, closure date and missing hours give no window', () => {
    expect(workingWindows({ date: '2026-11-02', tz, salonHours: { ...hours, isClosed: true }, closed: false })).toEqual([]);
    expect(workingWindows({ date: '2026-11-02', tz, salonHours: hours, closed: true })).toEqual([]);
    expect(workingWindows({ date: '2026-11-02', tz, salonHours: null, closed: false })).toEqual([]);
  });
  it('staff hours override salon hours but a closure still wins', () => {
    const w = workingWindows({ date: '2026-11-02', tz, salonHours: hours, closed: false, staffHours: { start: '11:00', end: '11:30' } });
    expect(iso(w[0]!.start)).toBe('2026-11-02T05:30:00.000Z');
    expect(workingWindows({ date: '2026-11-02', tz, salonHours: hours, closed: true, staffHours: { start: '11:00', end: '11:30' } })).toEqual([]);
  });
});

describe('interval math and slot computation', () => {
  const tz = 'Asia/Kolkata';
  const win = workingWindows({ date: '2026-11-02', tz, salonHours: { opens: '10:00', closes: '12:00', isClosed: false }, closed: false });
  const at = (hhmm: string) => zonedToUtc('2026-11-02', hhmm, tz);
  const starts = (s: { start: number }[]) => s.map((x) => iso(x.start).slice(11, 16));
  const early = at('00:00');

  it('subtractIntervals splits and merges correctly', () => {
    const r = subtractIntervals([{ start: 0, end: 100 }], [{ start: 10, end: 20 }, { start: 15, end: 30 }, { start: 90, end: 120 }]);
    expect(r).toEqual([{ start: 0, end: 10 }, { start: 30, end: 90 }]);
  });
  it('lists every 15-minute start that fits', () => {
    expect(starts(computeSlots({ windows: win, blocked: [], durationMin: 30, now: early }))).toEqual(['04:30', '04:45', '05:00', '05:15', '05:30', '05:45', '06:00']);
  });
  it('excludes booked time and time off', () => {
    const booked = [{ start: at('10:30'), end: at('11:00') }];
    expect(starts(computeSlots({ windows: win, blocked: booked, durationMin: 30, now: early }))).toEqual(['04:30', '05:30', '05:45', '06:00']);
    const off = [{ start: at('11:00'), end: at('11:30') }];
    expect(starts(computeSlots({ windows: win, blocked: [...booked, ...off], durationMin: 30, now: early }))).toEqual(['04:30', '06:00']);
  });
  it('does not offer slots in the past', () => {
    expect(starts(computeSlots({ windows: win, blocked: [], durationMin: 30, now: at('11:05') }))).toEqual(['05:45', '06:00']);
    expect(starts(computeSlots({ windows: win, blocked: [], durationMin: 15, now: at('11:05') }))).toEqual(['05:45', '06:00', '06:15']);
  });
  it('a service longer than the gap yields nothing', () => {
    expect(computeSlots({ windows: win, blocked: [], durationMin: 150, now: early })).toEqual([]);
  });
  it('contains() checks full containment', () => {
    expect(contains(win, { start: at('10:00'), end: at('12:00') })).toBe(true);
    expect(contains(win, { start: at('11:45'), end: at('12:15') })).toBe(false);
  });
});

describe('duration math', () => {
  it('applies staff speed and rounds up to 5 minutes', () => {
    expect(effectiveDuration(30, 1)).toBe(30);
    expect(effectiveDuration(30, 1.2)).toBe(40);
    expect(effectiveDuration(20, 0.5)).toBe(10);
    expect(effectiveDuration(25, 0.9)).toBe(25);
    expect(effectiveDuration(33, 1)).toBe(35);
  });
  it('sums services plus buffers', () => {
    expect(totalDuration([{ durationMin: 30, bufferMin: 5 }, { durationMin: 20, bufferMin: 0 }], 1)).toBe(55);
  });
});
