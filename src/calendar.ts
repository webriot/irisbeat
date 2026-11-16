// SPDX-License-Identifier: AGPL-3.0-only
export type Schedule = { scheduleMode?: 'interval' | 'calendar'; cron?: string; timezone?: string };
const DAY = 86_400_000;
const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;

function field(source: string, min: number, max: number) {
  const values = new Set<number>();
  for (const part of source.split(',')) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error('Use numeric five-field cron with wildcards, lists, ranges and steps');
    const step = match[2] === undefined ? 1 : Number(match[2]);
    const range = match[1] === '*' ? [min, max] : match[1].split('-').map(Number);
    const start = range[0];
    const end = range[1] ?? (match[2] === undefined ? start : max);
    if (start < min || end > max || start > end || !Number.isSafeInteger(step) || step < 1 || step > max - min + 1)
      throw new Error('Cron field is out of range');
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

export function calendar(cron: unknown, timezone: unknown = 'UTC') {
  if (typeof cron !== 'string' || cron.length > 256 || typeof timezone !== 'string' || timezone.length > 100 || /^[+-]/.test(timezone))
    throw new Error('Enter a cron expression and a named timezone');
  const sources = cron.trim().split(/\s+/);
  if (sources.length !== 5) throw new Error('Use five cron fields: minute hour day-of-month month day-of-week');
  const fields = sources.map((source, i) => field(source, bounds[i][0], bounds[i][1]));
  fields[4] = [...new Set(fields[4].map(value => value % 7))];
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const local = (at: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  };
  const dayOr = !sources[2].includes('*') && !sources[4].includes('*');
  const matchesDay = (date: Date) => {
    if (!fields[3].includes(date.getUTCMonth() + 1)) return false;
    const dom = fields[2].includes(date.getUTCDate());
    const dow = fields[4].includes(date.getUTCDay());
    return dayOr ? dom || dow : dom && dow;
  };
  // A Gregorian cycle covers every month/date/weekday combination, including wildcard steps.
  let possible = false;
  for (let day = Date.UTC(2000, 0, 1); day < Date.UTC(2400, 0, 1); day += DAY) {
    if (matchesDay(new Date(day))) { possible = true; break; }
  }
  if (!possible) throw new Error('Cron expression has no possible calendar date');
  const next = (after: number, count = 1) => {
    const result: number[] = [];
    const localAfter = local(after);
    const start = Math.floor(localAfter / DAY) * DAY;
    // Wildcard day steps can filter leap days by weekday; search a full Gregorian cycle per occurrence.
    for (let day = start; day <= start + count * 400 * 366 * DAY; day += DAY) {
      if (!matchesDay(new Date(day))) continue;
      const offsets = new Set<number>();
      for (const delta of [-2, -1, 0, 1, 2]) {
        const sample = day + delta * DAY + DAY / 2;
        offsets.add(local(sample) - sample);
      }
      for (const hour of fields[1]) for (const minute of fields[0]) {
        const wall = day + (hour * 60 + minute) * 60_000;
        if (day === start && wall <= localAfter) continue;
        const instants = [...offsets].map(offset => wall - offset).filter(at => local(at) === wall);
        // No instant means a spring gap. The earliest instant alone owns a repeated wall time.
        const at = Math.min(...instants);
        if (Number.isFinite(at) && at > after) {
          result.push(at);
          if (result.length === count) return result;
        }
      }
    }
    throw new Error('No future calendar occurrence');
  };
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const list = (index: number) => fields[index].join(', ');
  const time = fields[0].length === 1 && fields[1].length === 1
    ? `At ${String(fields[1][0]).padStart(2, '0')}:${String(fields[0][0]).padStart(2, '0')}`
    : `${sources[0] === '*' ? 'Every minute' : 'At minutes ' + list(0)}; ${sources[1] === '*' ? 'every hour' : 'hours ' + list(1)}`;
  const dom = 'day-of-month ' + list(2);
  const dow = fields[4].map(value => names[value]).join(', ');
  const allDom = fields[2].length === 31;
  const allDow = fields[4].length === 7;
  const days = dayOr ? dom + ' OR ' + dow
    : allDom && allDow ? 'every day' : allDom ? dow : allDow ? dom : dom + ' AND ' + dow;
  return { cron: sources.join(' '), timezone, next, explanation: `${time}; ${days}; ${sources[3] === '*' ? 'every month' : 'months ' + list(3)} (${timezone}).` };
}
