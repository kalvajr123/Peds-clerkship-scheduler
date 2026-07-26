// Date/week utilities for the 6-week term.

const DAY_MS = 24 * 60 * 60 * 1000;

function parseISODate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toISODate(date) {
  return date.toISOString().slice(0, 10);
}

function formatMMDD(date) {
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${m}/${d}`;
}

export function isMonday(iso) {
  if (!iso) return false;
  const date = parseISODate(iso);
  return date.getUTCDay() === 1;
}

/**
 * Generates 6 sequential week date ranges (Mon-Sun), except week 6 is
 * shortened to Mon-Fri to match the historical sample-data pattern.
 */
export function generateTermWeeks(startISO) {
  if (!startISO) return [];
  const start = parseISODate(startISO);
  const weeks = [];
  for (let i = 0; i < 6; i++) {
    const weekStart = new Date(start.getTime() + i * 7 * DAY_MS);
    const isLastWeek = i === 5;
    const weekEnd = new Date(weekStart.getTime() + (isLastWeek ? 4 : 6) * DAY_MS);
    weeks.push({
      index: i + 1,
      start: toISODate(weekStart),
      end: toISODate(weekEnd),
      label: `Week ${i + 1}: ${formatMMDD(weekStart)}–${formatMMDD(weekEnd)}`,
    });
  }
  return weeks;
}

export const ALL_WEEK_INDICES = [1, 2, 3, 4, 5, 6];
