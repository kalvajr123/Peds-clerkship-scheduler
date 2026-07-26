// The balancing algorithm described in the spec's "Balancing Algorithm"
// section. Runs entirely client-side.
//
// Term-structure assumption (confirmed with the coordinator): every
// student spends 2 weeks in PHM (one contiguous block, one site), 1 week
// in PEM (one site), 2 individual weeks in Community (each week can be a
// different site), and 1 leftover week in Newborn (filler, distance 0).
// The algorithm itself chooses BOTH which absolute weeks (1-6) each
// rotation type falls on for a given student, AND which site fills each
// slot.

const ALL_WEEKS = [1, 2, 3, 4, 5, 6];

// ---------------------------------------------------------------------
// Week-timing templates
// ---------------------------------------------------------------------

function combinations2(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      out.push([arr[i], arr[j]]);
    }
  }
  return out;
}

/** All valid (phmWeeks, pemWeek, communityWeeks, newbornWeek) templates. */
export function buildWeekTemplates() {
  const templates = [];
  for (let s = 1; s <= 5; s++) {
    const phmWeeks = [s, s + 1];
    const afterPhm = ALL_WEEKS.filter((w) => !phmWeeks.includes(w));
    for (const p of afterPhm) {
      const afterPem = afterPhm.filter((w) => w !== p);
      for (const combo of combinations2(afterPem)) {
        const communityWeeks = [...combo].sort((a, b) => a - b);
        const newbornWeek = afterPem.find((w) => !communityWeeks.includes(w));
        templates.push({ phmWeeks, pemWeek: p, communityWeeks, newbornWeek });
      }
    }
  }
  return templates;
}

const WEEK_TEMPLATES = buildWeekTemplates();

function shuffle(array, rng) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function assignWeekTemplates(studentIds, rng) {
  const templates = shuffle(WEEK_TEMPLATES, rng);
  const order = shuffle(studentIds, rng);
  const byStudent = {};
  order.forEach((id, i) => {
    byStudent[id] = templates[i % templates.length];
  });
  return byStudent;
}

// ---------------------------------------------------------------------
// Site pool normalization
// ---------------------------------------------------------------------

function weeklyDistancePHM(site) {
  return (site.distancePerDay || 0) * (site.daysPerWeek || 0);
}

function weeklyDistancePEM(site) {
  if (site.daysAtSite != null) {
    return (site.distancePerDay || 0) * site.daysAtSite;
  }
  return (site.distancePerDay || 0) * (site.daysPerWeek || 0);
}

function capacityOf(site, week, rotationType) {
  if (rotationType === 'community') {
    if (!site.available) return 0;
    if (!site.weeksOpen || !site.weeksOpen.includes(week)) return 0;
    return site.capacityByWeek?.[week] ?? 0;
  }
  return site.capacity == null ? Infinity : site.capacity;
}

function normalizeSites(sitesState) {
  const phm = sitesState.phm.map((s) => ({ ...s, weeklyDistance: weeklyDistancePHM(s) }));
  const pem = sitesState.pem.map((s) => ({ ...s, weeklyDistance: weeklyDistancePEM(s) }));
  const newborn = sitesState.newborn.map((s) => ({ ...s, weeklyDistance: 0 }));
  const community = sitesState.community
    .filter((s) => s.available)
    .map((s) => ({ ...s, weeklyDistance: s.distance || 0 }));
  return { phm, pem, newborn, community };
}

// ---------------------------------------------------------------------
// Occupancy tracking
// ---------------------------------------------------------------------

class Occupancy {
  constructor() {
    this.counts = new Map();
  }
  key(rotationType, siteId, week) {
    return `${rotationType}:${siteId}:${week}`;
  }
  get(rotationType, siteId, week) {
    return this.counts.get(this.key(rotationType, siteId, week)) || 0;
  }
  inc(rotationType, siteId, week, by = 1) {
    const k = this.key(rotationType, siteId, week);
    this.counts.set(k, (this.counts.get(k) || 0) + by);
  }
  dec(rotationType, siteId, week) {
    this.inc(rotationType, siteId, week, -1);
  }
}

function hasCapacity(site, week, rotationType, occupancy) {
  return occupancy.get(rotationType, site.id, week) < capacityOf(site, week, rotationType);
}

// ---------------------------------------------------------------------
// Assignment record helpers
// ---------------------------------------------------------------------

function emptyAssignment() {
  return { phm: null, pem: null, community: [null, null], newborn: null };
}

// ---------------------------------------------------------------------
// Step A — hard preferences (FCFS by entry order)
// ---------------------------------------------------------------------

const SPECIAL_SITE_IDS = {
  katyPHM: 'phm-wc',
  katyPEM: 'pem-wc',
  woodlandsPEM: 'pem-woodlands',
  christusPHM: 'phm-christus',
  christusPEM: 'pem-christus',
};

function findSite(pool, id) {
  return pool.find((s) => s.id === id) || null;
}

function applyHardPreferences({
  preferences,
  templates,
  sitePools,
  occupancy,
  assignments,
  locks,
  overflow,
}) {
  const isLocked = (studentId, rotationKey) =>
    locks.some((l) => l.studentId === studentId && l.rotationKey === rotationKey);

  // Katy / Woodlands (single-rotation categories)
  const simpleCategories = [
    { key: 'katyPHM', rotationKey: 'PHM', siteId: SPECIAL_SITE_IDS.katyPHM, pool: 'phm' },
    { key: 'katyPEM', rotationKey: 'PEM', siteId: SPECIAL_SITE_IDS.katyPEM, pool: 'pem' },
    {
      key: 'woodlandsPEM',
      rotationKey: 'PEM',
      siteId: SPECIAL_SITE_IDS.woodlandsPEM,
      pool: 'pem',
    },
  ];

  for (const cat of simpleCategories) {
    const order = preferences[cat.key]?.order || [];
    const site = findSite(sitePools[cat.pool], cat.siteId);
    if (!site) continue;
    order.forEach((studentId, idx) => {
      if (isLocked(studentId, cat.rotationKey)) return;
      const a = assignments[studentId];
      if (cat.rotationKey === 'PHM') {
        if (a.phm) return;
        const weeks = templates[studentId].phmWeeks;
        const ok = weeks.every((w) => hasCapacity(site, w, 'phm', occupancy));
        if (ok) {
          weeks.forEach((w) => occupancy.inc('phm', site.id, w));
          a.phm = { weeks, siteId: site.id, locked: true };
        } else {
          overflow.push({ category: cat.key, studentId, order: idx });
        }
      } else {
        if (a.pem) return;
        const week = templates[studentId].pemWeek;
        if (hasCapacity(site, week, 'pem', occupancy)) {
          occupancy.inc('pem', site.id, week);
          a.pem = { week, siteId: site.id, locked: true };
        } else {
          overflow.push({ category: cat.key, studentId, order: idx });
        }
      }
    });
  }

  // Austin (community, both weeks, any Austin site)
  const austinOrder = preferences.austin?.order || [];
  const austinSites = sitePools.community.filter((s) => s.isAustin);
  austinOrder.forEach((studentId, idx) => {
    const a = assignments[studentId];
    if (a.community[0] && a.community[1]) return;
    const weeks = templates[studentId].communityWeeks;
    const site = austinSites.find((s) => weeks.every((w) => hasCapacity(s, w, 'community', occupancy)));
    if (site) {
      weeks.forEach((w, ordinal) => {
        if (isLocked(studentId, `Community${ordinal + 1}`)) return;
        occupancy.inc('community', site.id, w);
        a.community[ordinal] = { week: w, siteId: site.id, ordinal, locked: true };
      });
    } else {
      overflow.push({ category: 'austin', studentId, order: idx });
    }
  });

  // Christus — PHM / Community / PEM sub-rotations from one preference box
  const christus = preferences.christus;
  const christusCommunitySite = findSite(sitePools.community, 'christus-community');
  if (christus) {
    const wantsPHM = christus.order.filter((id) => christus.entries[id]?.includes('PHM'));
    const wantsCommunity = christus.order.filter((id) =>
      christus.entries[id]?.includes('Community')
    );
    const wantsPEM = christus.order.filter((id) => christus.entries[id]?.includes('PEM'));

    const phmSite = findSite(sitePools.phm, SPECIAL_SITE_IDS.christusPHM);
    wantsPHM.forEach((studentId, idx) => {
      if (isLocked(studentId, 'PHM')) return;
      const a = assignments[studentId];
      if (a.phm || !phmSite) return;
      const weeks = templates[studentId].phmWeeks;
      const ok = weeks.every((w) => hasCapacity(phmSite, w, 'phm', occupancy));
      if (ok) {
        weeks.forEach((w) => occupancy.inc('phm', phmSite.id, w));
        a.phm = { weeks, siteId: phmSite.id, locked: true };
      } else {
        overflow.push({ category: 'christusPHM', studentId, order: idx });
      }
    });

    const pemSite = findSite(sitePools.pem, SPECIAL_SITE_IDS.christusPEM);
    wantsPEM.forEach((studentId, idx) => {
      if (isLocked(studentId, 'PEM')) return;
      const a = assignments[studentId];
      if (a.pem || !pemSite) return;
      const week = templates[studentId].pemWeek;
      if (hasCapacity(pemSite, week, 'pem', occupancy)) {
        occupancy.inc('pem', pemSite.id, week);
        a.pem = { week, siteId: pemSite.id, locked: true };
      } else {
        overflow.push({ category: 'christusPEM', studentId, order: idx });
      }
    });

    wantsCommunity.forEach((studentId, idx) => {
      const a = assignments[studentId];
      if (!christusCommunitySite || (a.community[0] && a.community[1])) return;
      const weeks = templates[studentId].communityWeeks;
      const ok = weeks.every((w) => hasCapacity(christusCommunitySite, w, 'community', occupancy));
      if (ok) {
        weeks.forEach((w, ordinal) => {
          if (isLocked(studentId, `Community${ordinal + 1}`)) return;
          occupancy.inc('community', christusCommunitySite.id, w);
          a.community[ordinal] = { week: w, siteId: christusCommunitySite.id, ordinal, locked: true };
        });
      } else {
        overflow.push({ category: 'christusCommunity', studentId, order: idx });
      }
    });
  }
}

// ---------------------------------------------------------------------
// Step B — manual locks
// ---------------------------------------------------------------------

function applyManualLocks({ locks, templates, sitePools, occupancy, assignments }) {
  for (const lock of locks) {
    const a = assignments[lock.studentId];
    if (!a) continue;
    const tmpl = templates[lock.studentId];
    if (lock.rotationKey === 'PHM') {
      const site = findSite(sitePools.phm, lock.siteId);
      if (!site || a.phm) continue;
      tmpl.phmWeeks.forEach((w) => occupancy.inc('phm', site.id, w));
      a.phm = { weeks: tmpl.phmWeeks, siteId: site.id, locked: true };
    } else if (lock.rotationKey === 'PEM') {
      const site = findSite(sitePools.pem, lock.siteId);
      if (!site || a.pem) continue;
      occupancy.inc('pem', site.id, tmpl.pemWeek);
      a.pem = { week: tmpl.pemWeek, siteId: site.id, locked: true };
    } else if (lock.rotationKey === 'Community1' || lock.rotationKey === 'Community2') {
      const ordinal = lock.rotationKey === 'Community1' ? 0 : 1;
      const site = findSite(sitePools.community, lock.siteId);
      if (!site || a.community[ordinal]) continue;
      const week = tmpl.communityWeeks[ordinal];
      occupancy.inc('community', site.id, week);
      a.community[ordinal] = { week, siteId: site.id, ordinal, locked: true };
    }
  }
}

// ---------------------------------------------------------------------
// Step C — greedy fill
// ---------------------------------------------------------------------

function currentTotal(mileage, studentId) {
  return mileage[studentId] || 0;
}

function studentUsedSubspecialty(a) {
  return a.community.some((c) => c && c.isSubspecialty);
}

function greedyFillPHM({ studentIds, templates, sitePools, occupancy, assignments, mileage, rng }) {
  let open = studentIds.filter((id) => !assignments[id].phm);
  while (open.length) {
    open = shuffle(open, rng).sort((a, b) => currentTotal(mileage, a) - currentTotal(mileage, b));
    const studentId = open[0];
    const weeks = templates[studentId].phmWeeks;
    const eligible = sitePools.phm.filter((site) => weeks.every((w) => hasCapacity(site, w, 'phm', occupancy)));
    if (!eligible.length) {
      open = open.slice(1);
      continue;
    }
    eligible.sort((a, b) => b.weeklyDistance - a.weeklyDistance);
    const site = eligible[0];
    weeks.forEach((w) => occupancy.inc('phm', site.id, w));
    assignments[studentId].phm = { weeks, siteId: site.id, locked: false };
    mileage[studentId] = currentTotal(mileage, studentId) + site.weeklyDistance * weeks.length;
    open = open.slice(1);
  }
}

function greedyFillPEM({ studentIds, templates, sitePools, occupancy, assignments, mileage, rng }) {
  let open = studentIds.filter((id) => !assignments[id].pem);
  while (open.length) {
    open = shuffle(open, rng).sort((a, b) => currentTotal(mileage, a) - currentTotal(mileage, b));
    const studentId = open[0];
    const week = templates[studentId].pemWeek;
    const eligible = sitePools.pem.filter((site) => hasCapacity(site, week, 'pem', occupancy));
    if (!eligible.length) {
      open = open.slice(1);
      continue;
    }
    eligible.sort((a, b) => b.weeklyDistance - a.weeklyDistance);
    const site = eligible[0];
    occupancy.inc('pem', site.id, week);
    assignments[studentId].pem = { week, siteId: site.id, locked: false };
    mileage[studentId] = currentTotal(mileage, studentId) + site.weeklyDistance;
    open = open.slice(1);
  }
}

function greedyFillCommunity({
  studentIds,
  templates,
  sitePools,
  occupancy,
  assignments,
  mileage,
  preferences,
  rng,
}) {
  const spanishSpeakers = new Set(preferences.spanish?.order || []);
  let open = [];
  studentIds.forEach((id) => {
    assignments[id].community.forEach((slot, ordinal) => {
      if (!slot) open.push({ studentId: id, ordinal });
    });
  });

  while (open.length) {
    open = shuffle(open, rng).sort(
      (a, b) => currentTotal(mileage, a.studentId) - currentTotal(mileage, b.studentId)
    );
    const { studentId, ordinal } = open[0];
    const week = templates[studentId].communityWeeks[ordinal];
    const a = assignments[studentId];
    const usedSubspecialty = studentUsedSubspecialty(a);

    const eligible = sitePools.community.filter((site) => {
      if (!hasCapacity(site, week, 'community', occupancy)) return false;
      if (usedSubspecialty && site.isSubspecialty) return false;
      if (site.requiresSpanish && !spanishSpeakers.has(studentId)) return false;
      return true;
    });

    if (!eligible.length) {
      open = open.slice(1);
      continue;
    }
    eligible.sort((x, y) => y.weeklyDistance - x.weeklyDistance);
    const site = eligible[0];
    occupancy.inc('community', site.id, week);
    a.community[ordinal] = {
      week,
      siteId: site.id,
      ordinal,
      locked: false,
      isSubspecialty: !!site.isSubspecialty,
    };
    mileage[studentId] = currentTotal(mileage, studentId) + site.weeklyDistance;
    open = open.slice(1);
  }
}

// ---------------------------------------------------------------------
// Step D — local-search cleanup (incremental variance-based swaps)
// ---------------------------------------------------------------------

function variance(sum, sumSq, n) {
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

function localSearchPHM({ studentIds, sitePools, occupancy, assignments, mileage }) {
  const n = studentIds.length;
  let sum = studentIds.reduce((s, id) => s + mileage[id], 0);
  let sumSq = studentIds.reduce((s, id) => s + mileage[id] ** 2, 0);
  const unlocked = studentIds.filter((id) => assignments[id].phm && !assignments[id].phm.locked);

  let improved = true;
  let guard = 0;
  while (improved && guard < 40) {
    improved = false;
    guard++;
    for (let i = 0; i < unlocked.length; i++) {
      for (let j = i + 1; j < unlocked.length; j++) {
        const id1 = unlocked[i];
        const id2 = unlocked[j];
        const a1 = assignments[id1].phm;
        const a2 = assignments[id2].phm;
        if (a1.siteId === a2.siteId) continue;
        const site1 = findSite(sitePools.phm, a1.siteId);
        const site2 = findSite(sitePools.phm, a2.siteId);

        const ok1 = a2.weeks.every(
          (w) => occupancy.get('phm', site1.id, w) - (a1.weeks.includes(w) ? 1 : 0) < capacityOf(site1, w, 'phm')
        );
        const ok2 = a1.weeks.every(
          (w) => occupancy.get('phm', site2.id, w) - (a2.weeks.includes(w) ? 1 : 0) < capacityOf(site2, w, 'phm')
        );
        if (!ok1 || !ok2) continue;

        const m1 = mileage[id1];
        const m2 = mileage[id2];
        const newM1 = mileage[id1] - site1.weeklyDistance * a1.weeks.length + site2.weeklyDistance * a1.weeks.length;
        const newM2 = mileage[id2] - site2.weeklyDistance * a2.weeks.length + site1.weeklyDistance * a2.weeks.length;
        const newSumSq = sumSq - m1 ** 2 - m2 ** 2 + newM1 ** 2 + newM2 ** 2;
        const newSum = sum - m1 - m2 + newM1 + newM2;
        if (variance(newSum, newSumSq, n) < variance(sum, sumSq, n) - 1e-9) {
          a1.weeks.forEach((w) => {
            occupancy.dec('phm', site1.id, w);
            occupancy.inc('phm', site2.id, w);
          });
          a2.weeks.forEach((w) => {
            occupancy.dec('phm', site2.id, w);
            occupancy.inc('phm', site1.id, w);
          });
          const tmp = a1.siteId;
          a1.siteId = a2.siteId;
          a2.siteId = tmp;
          mileage[id1] = newM1;
          mileage[id2] = newM2;
          sum = newSum;
          sumSq = newSumSq;
          improved = true;
        }
      }
    }
  }
}

function localSearchPEM({ studentIds, sitePools, occupancy, assignments, mileage }) {
  const n = studentIds.length;
  let sum = studentIds.reduce((s, id) => s + mileage[id], 0);
  let sumSq = studentIds.reduce((s, id) => s + mileage[id] ** 2, 0);
  const unlocked = studentIds.filter((id) => assignments[id].pem && !assignments[id].pem.locked);

  let improved = true;
  let guard = 0;
  while (improved && guard < 40) {
    improved = false;
    guard++;
    for (let i = 0; i < unlocked.length; i++) {
      for (let j = i + 1; j < unlocked.length; j++) {
        const id1 = unlocked[i];
        const id2 = unlocked[j];
        const a1 = assignments[id1].pem;
        const a2 = assignments[id2].pem;
        if (a1.siteId === a2.siteId) continue;
        const site1 = findSite(sitePools.pem, a1.siteId);
        const site2 = findSite(sitePools.pem, a2.siteId);

        const ok1 =
          occupancy.get('pem', site1.id, a2.week) - (a1.week === a2.week ? 1 : 0) < capacityOf(site1, a2.week, 'pem');
        const ok2 =
          occupancy.get('pem', site2.id, a1.week) - (a2.week === a1.week ? 1 : 0) < capacityOf(site2, a1.week, 'pem');
        if (!ok1 || !ok2) continue;

        const m1 = mileage[id1];
        const m2 = mileage[id2];
        const newM1 = m1 - site1.weeklyDistance + site2.weeklyDistance;
        const newM2 = m2 - site2.weeklyDistance + site1.weeklyDistance;
        const newSumSq = sumSq - m1 ** 2 - m2 ** 2 + newM1 ** 2 + newM2 ** 2;
        const newSum = sum - m1 - m2 + newM1 + newM2;
        if (variance(newSum, newSumSq, n) < variance(sum, sumSq, n) - 1e-9) {
          occupancy.dec('pem', site1.id, a1.week);
          occupancy.inc('pem', site2.id, a1.week);
          occupancy.dec('pem', site2.id, a2.week);
          occupancy.inc('pem', site1.id, a2.week);
          const tmp = a1.siteId;
          a1.siteId = a2.siteId;
          a2.siteId = tmp;
          mileage[id1] = newM1;
          mileage[id2] = newM2;
          sum = newSum;
          sumSq = newSumSq;
          improved = true;
        }
      }
    }
  }
}

function localSearchCommunity({ studentIds, sitePools, occupancy, assignments, mileage, preferences }) {
  const spanishSpeakers = new Set(preferences.spanish?.order || []);
  const n = studentIds.length;
  let sum = studentIds.reduce((s, id) => s + mileage[id], 0);
  let sumSq = studentIds.reduce((s, id) => s + mileage[id] ** 2, 0);

  const slots = [];
  studentIds.forEach((id) => {
    assignments[id].community.forEach((slot) => {
      if (slot && !slot.locked) slots.push({ studentId: id, slot });
    });
  });

  function otherOrdinalIsSubspecialty(studentId, ordinal, excludeSiteId) {
    const a = assignments[studentId];
    return a.community.some((c, idx) => idx !== ordinal && c && c.isSubspecialty && c.siteId !== excludeSiteId);
  }

  let improved = true;
  let guard = 0;
  while (improved && guard < 40) {
    improved = false;
    guard++;
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        const s1 = slots[i];
        const s2 = slots[j];
        if (s1.slot.siteId === s2.slot.siteId) continue;
        const site1 = findSite(sitePools.community, s1.slot.siteId);
        const site2 = findSite(sitePools.community, s2.slot.siteId);

        if (site1.requiresSpanish && !spanishSpeakers.has(s2.studentId)) continue;
        if (site2.requiresSpanish && !spanishSpeakers.has(s1.studentId)) continue;
        if (site2.isSubspecialty && otherOrdinalIsSubspecialty(s1.studentId, s1.slot.ordinal, site1.id)) continue;
        if (site1.isSubspecialty && otherOrdinalIsSubspecialty(s2.studentId, s2.slot.ordinal, site2.id)) continue;

        const sameWeek = s1.slot.week === s2.slot.week;
        const occ1 = occupancy.get('community', site1.id, s2.slot.week) - (sameWeek ? 1 : 0);
        const occ2 = occupancy.get('community', site2.id, s1.slot.week) - (sameWeek ? 1 : 0);
        if (occ1 >= capacityOf(site1, s2.slot.week, 'community')) continue;
        if (occ2 >= capacityOf(site2, s1.slot.week, 'community')) continue;

        const m1 = mileage[s1.studentId];
        const m2 = mileage[s2.studentId];
        const newM1 = m1 - site1.weeklyDistance + site2.weeklyDistance;
        const newM2 = m2 - site2.weeklyDistance + site1.weeklyDistance;
        const newSumSq = sumSq - m1 ** 2 - m2 ** 2 + newM1 ** 2 + newM2 ** 2;
        const newSum = sum - m1 - m2 + newM1 + newM2;
        if (variance(newSum, newSumSq, n) < variance(sum, sumSq, n) - 1e-9) {
          occupancy.dec('community', site1.id, s1.slot.week);
          occupancy.inc('community', site2.id, s1.slot.week);
          occupancy.dec('community', site2.id, s2.slot.week);
          occupancy.inc('community', site1.id, s2.slot.week);

          const tmpSite = s1.slot.siteId;
          s1.slot.siteId = s2.slot.siteId;
          s2.slot.siteId = tmpSite;
          const tmpSub = s1.slot.isSubspecialty;
          s1.slot.isSubspecialty = s2.slot.isSubspecialty;
          s2.slot.isSubspecialty = tmpSub;

          mileage[s1.studentId] = newM1;
          mileage[s2.studentId] = newM2;
          sum = newSum;
          sumSq = newSumSq;
          improved = true;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------
// Single restart
// ---------------------------------------------------------------------

function runOneAttempt({ studentIds, preferences, locks, sitePools, rng }) {
  const templates = assignWeekTemplates(studentIds, rng);
  const occupancy = new Occupancy();
  const assignments = {};
  const mileage = {};
  studentIds.forEach((id) => {
    assignments[id] = emptyAssignment();
    mileage[id] = 0;
  });
  const overflow = [];

  applyManualLocks({ locks, templates, sitePools, occupancy, assignments });
  applyHardPreferences({ preferences, templates, sitePools, occupancy, assignments, locks, overflow });

  // Seed mileage totals from locked/hard-pref assignments already made.
  studentIds.forEach((id) => {
    const a = assignments[id];
    let total = 0;
    if (a.phm) {
      const site = findSite(sitePools.phm, a.phm.siteId);
      total += site.weeklyDistance * a.phm.weeks.length;
    }
    if (a.pem) {
      const site = findSite(sitePools.pem, a.pem.siteId);
      total += site.weeklyDistance;
    }
    a.community.forEach((c) => {
      if (c) {
        const site = findSite(sitePools.community, c.siteId);
        c.isSubspecialty = !!site.isSubspecialty;
        total += site.weeklyDistance;
      }
    });
    mileage[id] = total;
  });

  greedyFillPHM({ studentIds, templates, sitePools, occupancy, assignments, mileage, rng });
  greedyFillPEM({ studentIds, templates, sitePools, occupancy, assignments, mileage, rng });
  greedyFillCommunity({ studentIds, templates, sitePools, occupancy, assignments, mileage, preferences, rng });

  localSearchPHM({ studentIds, sitePools, occupancy, assignments, mileage });
  localSearchPEM({ studentIds, sitePools, occupancy, assignments, mileage });
  localSearchCommunity({ studentIds, sitePools, occupancy, assignments, mileage, preferences });

  // Newborn: whatever week is left, assign lowest-loaded available newborn site.
  studentIds.forEach((id) => {
    const week = templates[id].newbornWeek;
    const eligible = sitePools.newborn.filter((site) => hasCapacity(site, week, 'newborn', occupancy));
    const site = eligible[0] || sitePools.newborn[0];
    if (site) {
      occupancy.inc('newborn', site.id, week);
      assignments[id].newborn = { week, siteId: site.id, locked: false };
    }
  });

  const n = studentIds.length;
  const sum = studentIds.reduce((s, id) => s + mileage[id], 0);
  const sumSq = studentIds.reduce((s, id) => s + mileage[id] ** 2, 0);
  const varianceValue = n ? variance(sum, sumSq, n) : 0;

  return { templates, assignments, mileage, overflow, variance: varianceValue };
}

// ---------------------------------------------------------------------
// Public entry point: random-restart search with progress reporting
// ---------------------------------------------------------------------

export async function runScheduler({
  roster,
  sitesState,
  preferences,
  locks,
  restarts = 200,
  onProgress,
}) {
  const studentIds = roster.map((s) => s.id);
  const sitePools = normalizeSites(sitesState);

  let best = null;
  const chunkSize = 10;

  for (let i = 0; i < restarts; i++) {
    const rng = mulberry32(Date.now() % 1e9 + i * 7919);
    const attempt = runOneAttempt({ studentIds, preferences, locks, sitePools, rng });
    if (!best || attempt.variance < best.variance) {
      best = attempt;
    }
    if (i % chunkSize === 0) {
      onProgress?.({ completed: i + 1, total: restarts });
      // Yield to the browser so the progress bar can repaint.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  onProgress?.({ completed: restarts, total: restarts });

  return buildResult(best, studentIds, sitePools);
}

function buildResult(best, studentIds, sitePools) {
  const { templates, assignments, mileage, overflow } = best;

  // Per-absolute-week (1-6) site + distance, for the results grid / export.
  const weekly = {};
  studentIds.forEach((id) => {
    const tmpl = templates[id];
    const a = assignments[id];
    const row = {};
    tmpl.phmWeeks.forEach((w) => {
      const site = findSite(sitePools.phm, a.phm.siteId);
      row[w] = { rotation: 'PHM', siteId: site.id, siteName: site.name, distance: site.weeklyDistance };
    });
    row[tmpl.pemWeek] = (() => {
      const site = findSite(sitePools.pem, a.pem.siteId);
      return { rotation: 'PEM', siteId: site.id, siteName: site.name, distance: site.weeklyDistance };
    })();
    a.community.forEach((c) => {
      const site = findSite(sitePools.community, c.siteId);
      row[c.week] = { rotation: 'Community', siteId: site.id, siteName: site.name, distance: site.weeklyDistance };
    });
    row[tmpl.newbornWeek] = (() => {
      const site = findSite(sitePools.newborn, a.newborn.siteId);
      return { rotation: 'Newborn', siteId: site.id, siteName: site.name, distance: 0 };
    })();
    weekly[id] = row;
  });

  const n = studentIds.length;
  const totals = studentIds.map((id) => mileage[id]);
  const mean = totals.reduce((s, v) => s + v, 0) / (n || 1);
  const std = Math.sqrt(totals.reduce((s, v) => s + (v - mean) ** 2, 0) / (n || 1)) || 1;

  const ranked = [...studentIds].sort((a, b) => mileage[a] - mileage[b]);
  const rank = {};
  ranked.forEach((id, i) => {
    rank[id] = i + 1;
  });

  const zScore = {};
  studentIds.forEach((id) => {
    zScore[id] = (mileage[id] - mean) / std;
  });

  return {
    templates,
    assignments,
    weekly,
    mileage,
    rank,
    zScore,
    mean,
    std,
    overflow,
    variance: best.variance,
  };
}

export function recomputeStats(studentIds, mileage) {
  const n = studentIds.length;
  const totals = studentIds.map((id) => mileage[id]);
  const mean = totals.reduce((s, v) => s + v, 0) / (n || 1);
  const std = Math.sqrt(totals.reduce((s, v) => s + (v - mean) ** 2, 0) / (n || 1)) || 1;
  const ranked = [...studentIds].sort((a, b) => mileage[a] - mileage[b]);
  const rank = {};
  ranked.forEach((id, i) => {
    rank[id] = i + 1;
  });
  const zScore = {};
  studentIds.forEach((id) => {
    zScore[id] = (mileage[id] - mean) / std;
  });
  return { mean, std, rank, zScore };
}

/** Simple aggregate sanity checks per spec's Step 2 validation note. */
export function validateSiteCapacity(sitesState, rosterSize) {
  const warnings = [];
  const totalCommunity = sitesState.community
    .filter((s) => s.available)
    .reduce((sum, s) => sum + (s.weeksOpen || []).reduce((ws, w) => ws + (s.capacityByWeek?.[w] || 0), 0), 0);
  const neededCommunity = rosterSize * 2;
  if (totalCommunity < neededCommunity) {
    warnings.push(
      `Total community capacity across all weeks (${totalCommunity}) is less than needed for the roster (${neededCommunity} student-weeks). Add sites/weeks/capacity or the schedule will have unfilled community slots.`
    );
  }

  const phmSeatWeeks = sitesState.phm
    .filter((s) => s.capacity != null)
    .reduce((sum, s) => sum + s.capacity * 6, 0);
  if (phmSeatWeeks < rosterSize * 2) {
    warnings.push(
      `PHM capacity looks tight: only ~${phmSeatWeeks} seat-weeks available across the term for ${rosterSize} students needing 2 weeks each.`
    );
  }

  const pemSeatWeeks = sitesState.pem
    .filter((s) => s.capacity != null)
    .reduce((sum, s) => sum + s.capacity * 6, 0);
  if (pemSeatWeeks < rosterSize) {
    warnings.push(
      `PEM capacity looks tight: only ~${pemSeatWeeks} seat-weeks available across the term for ${rosterSize} students needing 1 week each.`
    );
  }

  return warnings;
}
