import { describe, expect, it } from "vitest";
import { GREGORIAN, MAX_ORDINAL, MAX_YEAR, MIN_YEAR, daysInMonth, formatDate, fromOrdinal, gregorianYearDay, isLeapYear, toOrdinal, validateCalendar, type CalendarDefinition } from "../../src/lib/calendar";

const fantasy = (): CalendarDefinition => ({
  name: "Календарь двух лун", era: "эры Рассвета", epochOffset: "-42",
  months: [{ name: "Листа", days: 20 }, { name: "Солнца", days: 15 }, { name: "Снега", days: 25 }],
  leap: { every: 3, exceptEvery: 9, includeEvery: 18, offset: 1, month: 2, days: 2 },
});

describe("calendar ordinal arithmetic", () => {
  it("defines the epoch and year-zero leap day without JS Date", () => {
    expect(toOrdinal({ year: 0, month: 1, day: 1 }, GREGORIAN)).toBe(0n);
    expect(toOrdinal({ year: -1, month: 12, day: 31 }, GREGORIAN)).toBe(-1n);
    expect(gregorianYearDay(1)).toBe(366n);
    expect(gregorianYearDay(1970)).toBe(719528n);
    expect(toOrdinal({ year: 0, month: 2, day: 29 }, GREGORIAN)).toBe(59n);
    expect(fromOrdinal(-1n, GREGORIAN)).toEqual({ year: -1, month: 12, day: 31 });
  });
  it("applies Gregorian century exceptions and four-century restoration", () => {
    expect(isLeapYear(1900, GREGORIAN)).toBe(false);
    expect(isLeapYear(2000, GREGORIAN)).toBe(true);
    expect(isLeapYear(-100, GREGORIAN)).toBe(false);
    expect(isLeapYear(-400, GREGORIAN)).toBe(true);
    expect(daysInMonth(2000, 2, GREGORIAN)).toBe(29);
    expect(daysInMonth(1900, 2, GREGORIAN)).toBe(28);
    expect(() => toOrdinal({ year: 1900, month: 2, day: 29 }, GREGORIAN)).toThrow();
    expect(toOrdinal({ year: 2000, month: 3, day: 1 }, GREGORIAN) - toOrdinal({ year: 2000, month: 2, day: 28 }, GREGORIAN)).toBe(2n);
  });
  it.each([MIN_YEAR, -999999999, -401, -400, -100, -4, -1, 0, 1, 4, 99, 100, 400, 1900, 2000, 999999999, MAX_YEAR])("round-trips every month boundary for signed year %s", (year) => {
    for (let month = 1; month <= 12; month++) {
      for (const day of [1, daysInMonth(year, month, GREGORIAN)]) {
        const date = { year, month, day };
        expect(fromOrdinal(toOrdinal(date, GREGORIAN), GREGORIAN)).toEqual(date);
      }
    }
  });
  it("converts between fictional calendars through a shared absolute day", () => {
    const calendar = fantasy();
    expect(toOrdinal({ year: 0, month: 1, day: 1 }, calendar)).toBe(-42n);
    expect(fromOrdinal(-42n, calendar)).toEqual({ year: 0, month: 1, day: 1 });
    const original = { year: 1248, month: 6, day: 17 };
    const absolute = toOrdinal(original, GREGORIAN);
    const other = fromOrdinal(absolute, calendar);
    expect(toOrdinal(other, calendar)).toBe(absolute);
    expect(fromOrdinal(toOrdinal(other, calendar), GREGORIAN)).toEqual(original);
    expect(formatDate({ year: 1, month: 2, day: 17 }, calendar)).toBe("17 Солнца 1 эры Рассвета");
  });
  it("handles custom offset cycles, exclusions and negative cycle boundaries", () => {
    const calendar = fantasy();
    for (const year of [-35, -17, -5, 1, 19]) expect(isLeapYear(year, calendar)).toBe(true);
    for (const year of [-26, -8, -7, 0, 10]) expect(isLeapYear(year, calendar)).toBe(false);
    for (let year = -80; year <= 80; year++) {
      const next = toOrdinal({ year: year + 1, month: 1, day: 1 }, calendar);
      const current = toOrdinal({ year, month: 1, day: 1 }, calendar);
      expect(next - current).toBe(isLeapYear(year, calendar) ? 62n : 60n);
      for (let month = 1; month <= 3; month++) {
        const date = { year, month, day: daysInMonth(year, month, calendar) };
        expect(fromOrdinal(toOrdinal(date, calendar), calendar)).toEqual(date);
      }
    }
  });
  it("supports a calendar without leap years near the canonical ordinal boundary", () => {
    const calendar = fantasy(); calendar.leap = null; calendar.epochOffset = "999999999999000";
    expect(toOrdinal({ year: 0, month: 1, day: 2 }, calendar)).toBe(999999999999001n);
    expect(fromOrdinal(999999999999001n, calendar)).toEqual({ year: 0, month: 1, day: 2 });
    expect(toOrdinal({ year: -100, month: 1, day: 1 }, calendar)).toBe(999999999993000n);
    expect(() => toOrdinal({ year: 1000, month: 1, day: 1 }, calendar)).toThrow(/диапазон/);
  });
  it("validates impossible dates and bounded definition fields", () => {
    for (const date of [
      { year: 0, month: 0, day: 1 }, { year: 0, month: 13, day: 1 },
      { year: 0, month: 1, day: 0 }, { year: 0, month: 4, day: 31 },
      { year: 1.5, month: 1, day: 1 }, { year: MAX_YEAR + 1, month: 1, day: 1 },
    ]) expect(() => toOrdinal(date, GREGORIAN)).toThrow();
    for (const patch of [
      { name: "" }, { months: [] }, { epochOffset: "1.5" }, { epochOffset: "01" }, { epochOffset: "-0" },
      { epochOffset: (MAX_ORDINAL + 1n).toString() }, { months: [{ name: "Месяц", days: 0 }] },
      { months: Array.from({ length: 37 }, (_, i) => ({ name: `Месяц ${i}`, days: 1 })) },
      { months: [{ name: "Лист", days: 10 }, { name: " лист ", days: 12 }] },
    ]) expect(() => validateCalendar({ ...fantasy(), ...patch })).toThrow();
    const calendar = fantasy();
    expect(() => validateCalendar({ ...calendar, leap: { ...calendar.leap!, every: 0 } })).toThrow();
    expect(() => validateCalendar({ ...calendar, leap: { ...calendar.leap!, exceptEvery: 8 } })).toThrow();
    expect(() => validateCalendar({ ...calendar, leap: { ...calendar.leap!, includeEvery: 20 } })).toThrow();
    expect(() => validateCalendar({ ...calendar, leap: { ...calendar.leap!, month: 4 } })).toThrow();
    expect(() => fromOrdinal(MAX_ORDINAL, GREGORIAN)).toThrow();
    expect(() => fromOrdinal(MAX_ORDINAL + 1n, calendar)).toThrow();
  });
  it("does not mutate the immutable Gregorian definition", () => {
    const before = JSON.stringify(GREGORIAN);
    toOrdinal({ year: -1000, month: 2, day: 28 }, GREGORIAN);
    fromOrdinal(100000000n, GREGORIAN);
    expect(JSON.stringify(GREGORIAN)).toBe(before);
    expect(Object.isFrozen(GREGORIAN)).toBe(true);
    expect(Object.isFrozen(GREGORIAN.months)).toBe(true);
    expect(Object.isFrozen(GREGORIAN.months[0])).toBe(true);
    expect(Object.isFrozen(GREGORIAN.leap)).toBe(true);
  });
});
