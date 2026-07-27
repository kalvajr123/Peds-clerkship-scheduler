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

/**
 * Assigns internal sequential IDs (S1, S2, ...) in upload order. These are
 * used only as stable internal keys (state/lock references) — the UI and
 * exports show the student's real name, not this ID.
 */
export function assignStudentIds(names) {
  return names.map((name, i) => ({ id: `S${i + 1}`, name }));
}

/**
 * Builds a collision-safe display-name map ({studentId: displayName}). Two
 * students with the same name get " (1)" / " (2)" suffixes; everyone else
 * just gets their plain name.
 */
export function buildDisplayNames(roster) {
  const counts = {};
  roster.forEach((s) => {
    counts[s.name] = (counts[s.name] || 0) + 1;
  });
  const seen = {};
  const map = {};
  roster.forEach((s) => {
    if (counts[s.name] > 1) {
      seen[s.name] = (seen[s.name] || 0) + 1;
      map[s.id] = `${s.name} (${seen[s.name]})`;
    } else {
      map[s.id] = s.name;
    }
  });
  return map;
}
