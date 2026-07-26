// Small local Levenshtein-distance based fuzzy string matcher.
// Avoids pulling in an external dependency for name matching.

export function levenshteinDistance(a, b) {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  const m = s.length;
  const n = t.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prevRow = new Array(n + 1);
  let currRow = new Array(n + 1);
  for (let j = 0; j <= n; j++) prevRow[j] = j;

  for (let i = 1; i <= m; i++) {
    currRow[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        prevRow[j] + 1, // deletion
        currRow[j - 1] + 1, // insertion
        prevRow[j - 1] + cost // substitution
      );
    }
    [prevRow, currRow] = [currRow, prevRow];
  }
  return prevRow[n];
}

/** Similarity in [0, 1], 1 = identical (case-insensitive). */
export function similarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

/**
 * Finds the best-matching candidate for `name` among `candidates`
 * (array of {id, name}). Returns { candidate, score } or null if candidates
 * is empty.
 */
export function bestMatch(name, candidates) {
  let best = null;
  let bestScore = -1;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = levenshteinDistance(name.trim(), candidate.name.trim());
    const score = similarity(name.trim(), candidate.name.trim());
    if (score > bestScore) {
      bestScore = score;
      bestDistance = distance;
      best = candidate;
    }
  }
  if (!best) return null;
  return { candidate: best, score: bestScore, distance: bestDistance };
}

/**
 * Practical "clean enough" match heuristic: exact (case-insensitive) match
 * always passes; otherwise allow more absolute edit-distance slack for
 * longer names (typos) while staying strict for short names.
 */
export function isCleanMatch(raw, candidateName) {
  const a = raw.trim().toLowerCase();
  const b = candidateName.trim().toLowerCase();
  if (a === b) return true;
  const distance = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen <= 4) return distance <= 1;
  if (maxLen <= 8) return distance <= 2;
  return distance <= 3 || distance / maxLen <= 0.2;
}
