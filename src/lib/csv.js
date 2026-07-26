import Papa from 'papaparse';

/**
 * Parses a roster CSV (one column of names, optional header) into a plain
 * array of name strings, in file order. Blank lines are skipped.
 */
export function parseRosterCSV(fileText) {
  const result = Papa.parse(fileText.trim(), { skipEmptyLines: true });
  const rows = result.data;
  if (!rows.length) return [];

  // If the first cell looks like a header (e.g. "name", "student"), drop it.
  const names = rows.map((row) => (Array.isArray(row) ? row[0] : row)).filter(Boolean);
  const first = (names[0] || '').trim().toLowerCase();
  if (['name', 'names', 'student', 'student name', 'roster'].includes(first)) {
    names.shift();
  }
  return names.map((n) => n.trim()).filter(Boolean);
}

/** Parses a textarea of one name per line into a plain array of names. */
export function parseRosterTextarea(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Assigns anonymized sequential IDs (S1, S2, ...) in upload order. */
export function assignStudentIds(names) {
  return names.map((name, i) => ({ id: `S${i + 1}`, name }));
}
