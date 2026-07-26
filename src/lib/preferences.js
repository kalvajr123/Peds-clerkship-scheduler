import { bestMatch, isCleanMatch } from './levenshtein';

export const PREFERENCE_CATEGORIES = [
  { key: 'spanish', label: 'Which students speak Spanish?' },
  {
    key: 'christus',
    label:
      'Which students want Christus, and for which sub-rotation(s)? (PHM / Community / PEM)',
    isChristus: true,
  },
  { key: 'austin', label: 'Which students want Austin (community only)?' },
  { key: 'katyPHM', label: 'Which students want Katy for PHM?' },
  { key: 'katyPEM', label: 'Which students want Katy for PEM?' },
  { key: 'woodlandsPEM', label: 'Which students want Woodlands for PEM?' },
];

function splitNames(text) {
  return text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parses a simple comma/newline-separated name list against the roster.
 * Returns { order: [studentId,...] (first-entry order, deduped),
 *           unmatched: [{raw, suggestionId, suggestionName}] }
 */
export function parseSimplePreferenceList(text, roster) {
  const rawNames = splitNames(text || '');
  const order = [];
  const unmatched = [];
  const seen = new Set();

  for (const raw of rawNames) {
    const match = bestMatch(raw, roster);
    if (match && isCleanMatch(raw, match.candidate.name)) {
      if (!seen.has(match.candidate.id)) {
        seen.add(match.candidate.id);
        order.push(match.candidate.id);
      }
    } else {
      unmatched.push({
        raw,
        suggestionId: match ? match.candidate.id : null,
        suggestionName: match ? match.candidate.name : null,
      });
    }
  }
  return { order, unmatched };
}

const ROTATION_KEYWORD_RE = /\b(PHM|PEM|Community)\b/gi;

function parseChristusLine(line) {
  const rotations = new Set();
  let m;
  ROTATION_KEYWORD_RE.lastIndex = 0;
  while ((m = ROTATION_KEYWORD_RE.exec(line))) {
    const val = m[1].toLowerCase();
    if (val === 'phm') rotations.add('PHM');
    else if (val === 'pem') rotations.add('PEM');
    else rotations.add('Community');
  }
  let namePart = line.replace(ROTATION_KEYWORD_RE, ' ');
  namePart = namePart.replace(/[:\-–—]+/g, ' ');
  namePart = namePart.replace(/\b(and|for|wants?|only|,)\b/gi, ' ');
  namePart = namePart.replace(/\s+/g, ' ').trim();
  return { name: namePart, rotations: Array.from(rotations) };
}

/**
 * Parses the Christus free-text box: one entry per line, e.g.
 * "Jane Doe - PHM and Community". Returns
 * { order: [studentId,...], entries: {studentId: ['PHM','Community']},
 *   unmatched: [{raw, reason, suggestionId, suggestionName}] }
 */
export function parseChristusPreferences(text, roster) {
  const lines = (text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const order = [];
  const entrySets = {};
  const unmatched = [];

  for (const line of lines) {
    const { name, rotations } = parseChristusLine(line);
    if (!name) continue;
    const match = bestMatch(name, roster);
    if (match && isCleanMatch(name, match.candidate.name)) {
      const id = match.candidate.id;
      if (!entrySets[id]) {
        entrySets[id] = new Set();
        order.push(id);
      }
      rotations.forEach((r) => entrySets[id].add(r));
      if (rotations.length === 0) {
        unmatched.push({
          raw: line,
          reason: 'No sub-rotation (PHM/Community/PEM) detected — please specify.',
          studentId: id,
          suggestionName: match.candidate.name,
        });
      }
    } else {
      unmatched.push({
        raw: line,
        reason: 'Name did not match roster cleanly.',
        suggestionId: match ? match.candidate.id : null,
        suggestionName: match ? match.candidate.name : null,
      });
    }
  }

  const entries = {};
  for (const id of order) entries[id] = Array.from(entrySets[id]);
  return { order, entries, unmatched };
}

/** Parses all 6 preference boxes from raw text keyed by category. */
export function parseAllPreferences(rawTextByCategory, roster) {
  const parsed = {};
  for (const { key, isChristus } of PREFERENCE_CATEGORIES) {
    const text = rawTextByCategory[key] || '';
    parsed[key] = isChristus
      ? parseChristusPreferences(text, roster)
      : parseSimplePreferenceList(text, roster);
  }
  return parsed;
}
