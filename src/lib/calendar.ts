/** Lore Studio calendars. Author: ElpisHeart. World time never uses JS Date. */
export type CalendarDefinition = {
  name: string;
  months: { name: string; days: number }[];
  leap: {
    every: number;
    exceptEvery: number | null;
    includeEvery: number | null;
    month: number;
    days: number;
    offset: number;
  } | null;
  /** Absolute ordinal of year 0, month 1, day 1. */
  epochOffset: string;
  era: string;
};

export type WorldDate = { year: number; month: number; day: number };
export const MIN_YEAR = -1_000_000_000;
export const MAX_YEAR = 1_000_000_000;
export const MAX_ORDINAL = 1_000_000_000_000_000n;

const months = [
  { name: "января", days: 31 }, { name: "февраля", days: 28 },
  { name: "марта", days: 31 }, { name: "апреля", days: 30 },
  { name: "мая", days: 31 }, { name: "июня", days: 30 },
  { name: "июля", days: 31 }, { name: "августа", days: 31 },
  { name: "сентября", days: 30 }, { name: "октября", days: 31 },
  { name: "ноября", days: 30 }, { name: "декабря", days: 31 },
];
months.forEach(Object.freeze);
Object.freeze(months);
export const GREGORIAN: CalendarDefinition = Object.freeze({
  name: "Григорианский", months,
  leap: Object.freeze({ every: 4, exceptEvery: 100, includeEvery: 400, month: 2, days: 1, offset: 0 }),
  epochOffset: "0", era: "г.",
});

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function name(value: unknown, max: number, empty = false): value is string {
  return typeof value === "string" && value.length <= max && (empty || value.trim().length > 0);
}

export function validateCalendar(def: CalendarDefinition): void {
  if (!def || typeof def !== "object" || !name(def.name, 160) || !name(def.era, 80, true)) {
    throw new Error("Укажите название календаря и корректное название эры");
  }
  if (!Array.isArray(def.months) || def.months.length < 1 || def.months.length > 36) {
    throw new Error("Календарь должен содержать от 1 до 36 месяцев");
  }
  const names = new Set<string>();
  for (const month of def.months) {
    if (!month || !name(month.name, 80) || !integer(month.days, 1, 1000)) {
      throw new Error("У каждого месяца должны быть название и от 1 до 1000 дней");
    }
    const normalized = month.name.trim().toLocaleLowerCase("ru-RU");
    if (names.has(normalized)) throw new Error("Названия месяцев не должны повторяться");
    names.add(normalized);
  }
  if (typeof def.epochOffset !== "string" || def.epochOffset.length > 17 ||
      !/^(?:0|-?[1-9]\d*)$/.test(def.epochOffset)) {
    throw new Error("Смещение эпохи должно быть целым числом дней");
  }
  const epoch = BigInt(def.epochOffset);
  if (epoch < -MAX_ORDINAL || epoch > MAX_ORDINAL) throw new Error("Смещение эпохи выходит за допустимый диапазон");
  if (def.leap !== null) {
    const leap = def.leap;
    if (!leap || typeof leap !== "object" || !integer(leap.every, 1, 10000) ||
        !integer(leap.month, 1, def.months.length) || !integer(leap.days, 1, 1000) ||
        !integer(leap.offset, MIN_YEAR, MAX_YEAR)) {
      throw new Error("Некорректное правило високосного цикла");
    }
    if (leap.exceptEvery !== null && (!integer(leap.exceptEvery, 1, 10000) || leap.exceptEvery % leap.every !== 0)) {
      throw new Error("Цикл исключения должен быть кратен основному високосному циклу");
    }
    if (leap.includeEvery !== null && (leap.exceptEvery === null || !integer(leap.includeEvery, 1, 10000) || leap.includeEvery % leap.exceptEvery !== 0)) {
      throw new Error("Восстанавливающий цикл должен быть кратен циклу исключения");
    }
  }
}

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b < 0n ? q - 1n : q;
}

/** Signed count of periodic years in [0, year); negative years work symmetrically. */
function countBefore(year: number, period: number, offset: number): bigint {
  const p = BigInt(period), o = BigInt(offset);
  return floorDiv(BigInt(year) - 1n - o, p) - floorDiv(-1n - o, p);
}

function leapYear(year: number, def: CalendarDefinition): boolean {
  const rule = def.leap;
  if (!rule) return false;
  const shifted = year - rule.offset;
  return shifted % rule.every === 0 && (rule.exceptEvery === null || shifted % rule.exceptEvery !== 0 ||
    (rule.includeEvery !== null && shifted % rule.includeEvery === 0));
}

function yearStart(year: number, def: CalendarDefinition): bigint {
  let days = BigInt(year) * BigInt(def.months.reduce((total, month) => total + month.days, 0));
  const leap = def.leap;
  if (leap) {
    let count = countBefore(year, leap.every, leap.offset);
    if (leap.exceptEvery !== null) count -= countBefore(year, leap.exceptEvery, leap.offset);
    if (leap.includeEvery !== null) count += countBefore(year, leap.includeEvery, leap.offset);
    days += count * BigInt(leap.days);
  }
  return BigInt(def.epochOffset) + days;
}

export function isLeapYear(year: number, def: CalendarDefinition): boolean {
  validateCalendar(def);
  if (!integer(year, MIN_YEAR, MAX_YEAR)) throw new Error("Год должен быть целым числом в диапазоне ±1 000 000 000");
  return leapYear(year, def);
}

function monthLength(year: number, month: number, def: CalendarDefinition): number {
  return def.months[month - 1].days + (def.leap?.month === month && leapYear(year, def) ? def.leap.days : 0);
}

export function daysInMonth(year: number, month: number, def: CalendarDefinition): number {
  validateCalendar(def);
  if (!integer(year, MIN_YEAR, MAX_YEAR) || !integer(month, 1, def.months.length)) throw new Error("Некорректный год или месяц");
  return monthLength(year, month, def);
}

export function toOrdinal(date: WorldDate, def: CalendarDefinition): bigint {
  validateCalendar(def);
  if (!date || !integer(date.year, MIN_YEAR, MAX_YEAR) || !integer(date.month, 1, def.months.length) ||
      !integer(date.day, 1, monthLength(date.year, date.month, def))) {
    throw new Error("Такой даты нет в выбранном календаре");
  }
  let day = yearStart(date.year, def) + BigInt(date.day - 1);
  for (let month = 1; month < date.month; month++) day += BigInt(monthLength(date.year, month, def));
  if (day < -MAX_ORDINAL || day > MAX_ORDINAL) throw new Error("Дата выходит за допустимый диапазон мирового времени");
  return day;
}

export function fromOrdinal(day: bigint, def: CalendarDefinition): WorldDate {
  validateCalendar(def);
  if (typeof day !== "bigint" || day < -MAX_ORDINAL || day > MAX_ORDINAL ||
      day < yearStart(MIN_YEAR, def) || day >= yearStart(MAX_YEAR + 1, def)) {
    throw new Error("Дата выходит за поддерживаемый календарём диапазон лет");
  }
  let lower = MIN_YEAR, upper = MAX_YEAR + 1;
  while (lower + 1 < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (yearStart(middle, def) <= day) lower = middle; else upper = middle;
  }
  let remaining = day - yearStart(lower, def);
  for (let month = 1; month <= def.months.length; month++) {
    const length = BigInt(monthLength(lower, month, def));
    if (remaining < length) return { year: lower, month, day: Number(remaining) + 1 };
    remaining -= length;
  }
  throw new Error("Не удалось определить дату");
}

export function formatDate(date: WorldDate, def: CalendarDefinition): string {
  // Formatting does not accept impossible dates silently.
  toOrdinal(date, def);
  return `${date.day} ${def.months[date.month - 1].name} ${date.year}${def.era ? ` ${def.era}` : ""}`;
}

export function gregorianYearDay(year: number): bigint {
  return toOrdinal({ year, month: 1, day: 1 }, GREGORIAN);
}
