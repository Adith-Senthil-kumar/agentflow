/**
 * Minimal 5-field cron matcher: minute hour day-of-month month day-of-week.
 *
 * Supports wildcards, `a-b` ranges, comma-separated lists, and a `/n` step
 * suffix on any of those.
 * Deliberately not a dependency: the dispatcher only ever asks "is this
 * expression due in the current minute?", and a parser for that is small enough
 * to read in full and test directly.
 */

const FIELD_RANGES: [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week, 0 = Sunday
];

export class InvalidCron extends Error {}

function parseField(field: string, [min, max]: [number, number]): Set<number> {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) {
      throw new InvalidCron(`Invalid step in "${part}"`);
    }

    let from: number;
    let to: number;

    if (rangePart === '*') {
      from = min;
      to = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) {
        throw new InvalidCron(`Invalid range in "${part}"`);
      }
      from = a;
      to = b;
    } else {
      const n = Number(rangePart);
      if (!Number.isInteger(n)) throw new InvalidCron(`Invalid value "${rangePart}"`);
      from = n;
      to = n;
    }

    if (from < min || to > max || from > to) {
      throw new InvalidCron(`"${part}" is outside ${min}-${max}`);
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }

  return values;
}

export function parseCron(expression: string): Set<number>[] {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new InvalidCron(`Expected 5 fields, got ${fields.length}: "${expression}"`);
  }
  return fields.map((f, i) => parseField(f, FIELD_RANGES[i]));
}

/**
 * True when `date` (UTC) falls in a minute the expression selects.
 *
 * Follows the standard cron quirk: when both day-of-month and day-of-week are
 * restricted, either matching is enough.
 */
export function cronMatches(expression: string, date: Date): boolean {
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = parseCron(expression);

  if (!minutes.has(date.getUTCMinutes())) return false;
  if (!hours.has(date.getUTCHours())) return false;
  if (!months.has(date.getUTCMonth() + 1)) return false;

  const domRestricted = daysOfMonth.size < 31;
  const dowRestricted = daysOfWeek.size < 7;
  const domMatch = daysOfMonth.has(date.getUTCDate());
  const dowMatch = daysOfWeek.has(date.getUTCDay());

  if (domRestricted && dowRestricted) return domMatch || dowMatch;
  if (domRestricted) return domMatch;
  if (dowRestricted) return dowMatch;
  return true;
}
