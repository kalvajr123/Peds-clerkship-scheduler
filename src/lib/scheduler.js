// The balancing algorithm described in the spec's "Balancing Algorithm"
// section. Runs entirely client-side.
//
// Term-structure (confirmed with the coordinator): the 6-week term is
// three fixed 2-week blocks — [1,2], [3,4], [5,6]. Every student is
// assigned one block to PHM (one site, both weeks), a different block to
// Community (2 individual weeks, e.g. a 1-week subspecialty followed
// immediately by a regular community week — different site allowed per
// week), and the third block splits into 1 week PEM (one site) + 1 week
// Newborn (filler, distance 0), in either order. PHM therefore only ever
// starts on week 1, 3, or 5 — never a mid-block week like 4. The
// algorithm chooses which block goes to which rotation type per student,
// AND which site fills each slot.

export const WEEK_BLOCKS = [
  [1, 2],
  [3, 4],
  [5, 6],
];
const BLOCKS = WEEK_BLOCKS;

// ---------------------------------------------------------------------
// Week-timing templates
// ---------------------------------------------------------------------

/**
 * All valid (phmWeeks, communityWeeks, pemWeek, newbornWeek) templates:
 * PHM gets one of the 3 fixed blocks, Community gets a different block,
 * and the remaining block's 2 weeks split between PEM and Newborn (both
 * orderings, since neither has an adjacency requirement).
 */
export function buildWeekTemplates() {
  const templates = [];
  for (let phmIdx = 0; phmIdx < BLOCKS.length; phmIdx++) {
    for (let commIdx = 0; commIdx < BLOCKS.length; commIdx++) {
      if (commIdx === phmIdx) continue;
      const remainingIdx = [0, 1, 2].find((i) => i !== phmIdx && i !== commIdx);
      const phmWeeks = BLOCKS[phmIdx];
      const communityWeeks = BLOCKS[commIdx];
      const remainingBlock = BLOCKS[remainingIdx];
      templates.push({ phmWeeks, communityWeeks, pemWeek: remainingBlock[0], newbornWeek: remainingBlock[1] });
      templates.push({ phmWeeks, communityWeeks, pemWeek: remainingBlock[1], newbornWeek: remainingBlock[0] });
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

/**
 * Manual locks can pin timing (which block/week a rotation falls on)
 * independently of site. Derives, per student, the combined timing
 * constraint from all of their locks: { phmBlock, communityBlock, pemWeek,
 * newbornWeek } (block indices 0-2 into WEEK_BLOCKS, weeks are 1-6).
 */
function deriveTimingConstraints(locks) {
  const byStudent = {};
  for (const lock of locks) {
    if (lock.timing == null) continue;
    const c = byStudent[lock.studentId] || {};
    if (lock.rotationKey === 'PHM') c.phmBlock = lock.timing;
    else if (lock.rotationKey === 'Community1' || lock.rotationKey === 'Community2') c.communityBlock = lock.timing;
    else if (lock.rotationKey === 'PEM') c.pemWeek = lock.timing;
    else if (lock.rotationKey === 'Newborn') c.newbornWeek = lock.timing;
    byStudent[lock.studentId] = c;
  }
  return byStudent;
}

function templateMatchesConstraints(template, constraints) {
  if (!constraints) return true;
  if (constraints.phmBlock != null && template.phmWeeks[0] !== WEEK_BLOCKS[constraints.phmBlock][0]) return false;
  if (
    constraints.communityBlock != null &&
    template.communityWeeks[0] !== WEEK_BLOCKS[constraints.communityBlock][0]
  ) {
    return false;
  }
  if (constraints.pemWeek != null && template.pemWeek !== constraints.pemWeek) return false;
  if (constraints.newbornWeek != null && template.newbornWeek !== constraints.newbornWeek) return false;
  return true;
}

function assignWeekTemplates(studentIds, rng, timingConstraints) {
  const shuffledTemplates = shuffle(WEEK_TEMPLATES, rng);
  const order = shuffle(studentIds, rng);
  const byStudent = {};
  order.forEach((id, i) => {
    const constraints = timingConstraints?.[id];
    if (constraints) {
      const valid = shuffledTemplates.filter((t) => templateMatchesConstraints(t, constraints));
      // If a coordinator locked two contradictory timings (e.g. the same
      // block for both PHM and Community) no template can satisfy both;
      // fall back to an unconstrained pick rather than crash. This should
      // be rare — the Manual Locks UI warns about same-block conflicts.
      byStudent[id] = valid.length ? valid[i % valid.length] : shuffledTemplates[i % shuffledTemplates.length];
    } else {
      byStudent[id] = shuffledTemplates[i % shuffledTemplates.length];
    }
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

function capacityOf(site, week, rotationType, usePrimary = false) {
  // Newborn sites use a flat weekly capacity (same every week).
  if (rotationType === 'newborn') {
    return site.capacity == null ? Infinity : site.capacity;
  }
  // PHM, PEM, and community sites all use per-week open/closed + capacity.
  // (Community also has a whole-site available toggle; PHM/PEM don't need
  // a separate one since an empty weeksOpen already means "closed".)
  if (rotationType === 'community' && !site.available) return 0;
  if (!site.weeksOpen || !site.weeksOpen.includes(week)) return 0;
  // Some sites (e.g. PHM Main/West Campus) have a lower "primary" capacity
  // that should fill first, with the gap up to the full capacity used only
  // as overflow once every site's primary capacity is exhausted.
  if (usePrimary && site.primaryCapacityByWeek) {
    return site.primaryCapacityByWeek[week] ?? 0;
  }
  return site.capacityByWeek?.[week] ?? 0;
}

// Christus and Austin sites are opt-in only: reachable exclusively via an
// explicit hard-preference request (Step A) or a manual lock (Step B),
// never picked automatically by greedy-fill or touched by local search.
function isOptInOnly(site) {
  return site.id === 'phm-christus' || site.id === 'pem-christus' || site.id === 'christus-community' || !!site.isAustin;
}

function autoFillPools(sitePools) {
  return {
    phm: sitePools.phm.filter((s) => !isOptInOnly(s)),
    pem: sitePools.pem.filter((s) => !isOptInOnly(s)),
    community: sitePools.community.filter((s) => !isOptInOnly(s)),
    newborn: sitePools.newborn,
  };
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

function hasCapacity(site, week, rotationType, occupancy, usePrimary = false) {
  return occupancy.get(rotationType, site.id, week) < capacityOf(site, week, rotationType, usePrimary);
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

// San Antonio (Christus) housing is shared across PHM/Community/PEM — only
// a limited number of housing spots exist per week regardless of each
// rotation's own site capacity, so it needs a cross-site check.
const SAN_ANTONIO_SITE_IDS = { phm: 'phm-christus', pem: 'pem-christus', community: 'christus-community' };

function sanAntonioOccupancy(occupancy, week) {
  return (
    occupancy.get('phm', SAN_ANTONIO_SITE_IDS.phm, week) +
    occupancy.get('pem', SAN_ANTONIO_SITE_IDS.pem, week) +
    occupancy.get('community', SAN_ANTONIO_SITE_IDS.community, week)
  );
}

function sanAntonioHasRoom(occupancy, week, housingCap) {
  return sanAntonioOccupancy(occupancy, week) < housingCap;
}

function applyHardPreferences({
  preferences,
  templates,
  sitePools,
  occupancy,
  assignments,
  overflow,
  housingCap,
}) {
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
    // Austin wants both community weeks at the same site; if either week
    // is already fixed (e.g. by a manual lock), this student can't cleanly
    // get the both-weeks Austin placement.
    if (a.community[0] || a.community[1]) return;
    const weeks = templates[studentId].communityWeeks;
    const site = austinSites.find((s) => weeks.every((w) => hasCapacity(s, w, 'community', occupancy)));
    if (site) {
      weeks.forEach((w, ordinal) => {
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
      const a = assignments[studentId];
      if (a.phm || !phmSite) return;
      const weeks = templates[studentId].phmWeeks;
      const ok = weeks.every(
        (w) => hasCapacity(phmSite, w, 'phm', occupancy) && sanAntonioHasRoom(occupancy, w, housingCap)
      );
      if (ok) {
        weeks.forEach((w) => occupancy.inc('phm', phmSite.id, w));
        a.phm = { weeks, siteId: phmSite.id, locked: true };
      } else {
        overflow.push({ category: 'christusPHM', studentId, order: idx });
      }
    });

    const pemSite = findSite(sitePools.pem, SPECIAL_SITE_IDS.christusPEM);
    wantsPEM.forEach((studentId, idx) => {
      const a = assignments[studentId];
      if (a.pem || !pemSite) return;
      const week = templates[studentId].pemWeek;
      if (hasCapacity(pemSite, week, 'pem', occupancy) && sanAntonioHasRoom(occupancy, week, housingCap)) {
        occupancy.inc('pem', pemSite.id, week);
        a.pem = { week, siteId: pemSite.id, locked: true };
      } else {
        overflow.push({ category: 'christusPEM', studentId, order: idx });
      }
    });

    wantsCommunity.forEach((studentId, idx) => {
      const a = assignments[studentId];
      if (!christusCommunitySite || a.community[0] || a.community[1]) return;
      const weeks = templates[studentId].communityWeeks;
      const ok = weeks.every(
        (w) =>
          hasCapacity(christusCommunitySite, w, 'community', occupancy) &&
          sanAntonioHasRoom(occupancy, w, housingCap)
      );
      if (ok) {
        weeks.forEach((w, ordinal) => {
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
    } else if (lock.rotationKey === 'Newborn') {
      const site = findSite(sitePools.newborn, lock.siteId);
      if (!site || a.newborn) continue;
      occupancy.inc('newborn', site.id, tmpl.newbornWeek);
      a.newborn = { week: tmpl.newbornWeek, siteId: site.id, locked: true };
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

function greedyFillPHMPass({ open, templates, sitePools, occupancy, assignments, mileage, rng, usePrimary }) {
  const stillOpen = [];
  while (open.length) {
    open = shuffle(open, rng).sort((a, b) => currentTotal(mileage, a) - currentTotal(mileage, b));
    const studentId = open[0];
    const weeks = templates[studentId].phmWeeks;
    const eligible = sitePools.phm.filter((site) =>
      weeks.every((w) => hasCapacity(site, w, 'phm', occupancy, usePrimary))
    );
    if (!eligible.length) {
      stillOpen.push(studentId);
      open = open.slice(1);
      continue;
    }
    eligible.sort((a, b) => a.weeklyDistance - b.weeklyDistance);
    const site = eligible[0];
    weeks.forEach((w) => occupancy.inc('phm', site.id, w));
    assignments[studentId].phm = { weeks, siteId: site.id, locked: false };
    mileage[studentId] = currentTotal(mileage, studentId) + site.weeklyDistance * weeks.length;
    open = open.slice(1);
  }
  return stillOpen;
}

/**
 * Two-pass fill: first up to each site's "primary" capacity (e.g. Main=8,
 * West Campus=2), cheapest-first as usual; only students that still can't
 * be placed move on to a second pass using each site's full capacity (e.g.
 * Main up to 10, WC up to 3) — so overflow capacity is only used once every
 * site's preferred capacity is exhausted.
 */
function greedyFillPHM({ studentIds, templates, sitePools, occupancy, assignments, mileage, rng }) {
  const open = studentIds.filter((id) => !assignments[id].phm);
  const stillOpen = greedyFillPHMPass({
    open,
    templates,
    sitePools,
    occupancy,
    assignments,
    mileage,
    rng,
    usePrimary: true,
  });
  if (stillOpen.length) {
    greedyFillPHMPass({
      open: stillOpen,
      templates,
      sitePools,
      occupancy,
      assignments,
      mileage,
      rng,
      usePrimary: false,
    });
  }
}

/**
 * PEM deliberately does NOT fill cheapest-first: the coordinator wants
 * students spread round-robin across TCH-A -> TCH-B -> Katy -> Woodlands
 * (one student per site per pass) to avoid crowding TCH, even though pure
 * mileage-minimization would cluster everyone at TCH. The cycle resets
 * per week (sitePools.pem is in that exact priority order after opt-in
 * Christus is filtered out by autoFillPools).
 */
function greedyFillPEM({ studentIds, templates, sitePools, occupancy, assignments, mileage, rng }) {
  let open = studentIds.filter((id) => !assignments[id].pem);
  const cyclePos = {}; // week -> next cycle index into sitePools.pem
  const n = sitePools.pem.length;
  while (open.length) {
    open = shuffle(open, rng).sort((a, b) => currentTotal(mileage, a) - currentTotal(mileage, b));
    const studentId = open[0];
    const week = templates[studentId].pemWeek;
    const start = cyclePos[week] ?? 0;
    let foundIdx = -1;
    for (let i = 0; i < n; i++) {
      const idx = (start + i) % n;
      if (hasCapacity(sitePools.pem[idx], week, 'pem', occupancy)) {
        foundIdx = idx;
        break;
      }
    }
    if (foundIdx === -1) {
      open = open.slice(1);
      continue;
    }
    const site = sitePools.pem[foundIdx];
    occupancy.inc('pem', site.id, week);
    assignments[studentId].pem = { week, siteId: site.id, locked: false };
    mileage[studentId] = currentTotal(mileage, studentId) + site.weeklyDistance;
    cyclePos[week] = (foundIdx + 1) % n;
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
    eligible.sort((x, y) => x.weeklyDistance - y.weeklyDistance);
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

function runOneAttempt({ studentIds, preferences, locks, sitePools, rng, housingCap }) {
  const timingConstraints = deriveTimingConstraints(locks);
  const templates = assignWeekTemplates(studentIds, rng, timingConstraints);
  const occupancy = new Occupancy();
  const assignments = {};
  const mileage = {};
  studentIds.forEach((id) => {
    assignments[id] = emptyAssignment();
    mileage[id] = 0;
  });
  const overflow = [];

  applyManualLocks({ locks, templates, sitePools, occupancy, assignments });
  applyHardPreferences({ preferences, templates, sitePools, occupancy, assignments, overflow, housingCap });

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

  const autoPools = autoFillPools(sitePools);
  greedyFillPHM({ studentIds, templates, sitePools: autoPools, occupancy, assignments, mileage, rng });
  greedyFillPEM({ studentIds, templates, sitePools: autoPools, occupancy, assignments, mileage, rng });
  greedyFillCommunity({ studentIds, templates, sitePools: autoPools, occupancy, assignments, mileage, preferences, rng });

  localSearchPHM({ studentIds, sitePools, occupancy, assignments, mileage });
  // PEM intentionally skips local-search balancing: swapping students
  // toward lower mileage would just re-cluster them at cheap sites (TCH),
  // undoing the round-robin spread greedyFillPEM was asked to produce.
  localSearchCommunity({ studentIds, sitePools, occupancy, assignments, mileage, preferences });

  // Newborn: whatever week is left, assign lowest-loaded available newborn
  // site (skip anyone already fixed by a manual lock with a site).
  studentIds.forEach((id) => {
    if (assignments[id].newborn) return;
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

  const unfilledCount = studentIds.reduce((count, id) => {
    const a = assignments[id];
    let missing = 0;
    if (!a.phm) missing++;
    if (!a.pem) missing++;
    if (!a.community[0]) missing++;
    if (!a.community[1]) missing++;
    if (!a.newborn) missing++;
    return count + missing;
  }, 0);

  return { templates, assignments, mileage, overflow, variance: varianceValue, sum, unfilledCount };
}

/** Fewer unfilled slots wins; then lower total miles; then lower variance. */
function isBetterAttempt(candidate, current) {
  if (!current) return true;
  if (candidate.unfilledCount !== current.unfilledCount) {
    return candidate.unfilledCount < current.unfilledCount;
  }
  // Satisfying explicit hard-preference requests (Christus/Austin/Katy/
  // Woodlands) matters more than shaving a bit off variance — a restart
  // where a student's random week-template just missed a site's open
  // block shouldn't beat one where the same request succeeded.
  if (candidate.overflow.length !== current.overflow.length) {
    return candidate.overflow.length < current.overflow.length;
  }
  if (candidate.sum !== current.sum) {
    return candidate.sum < current.sum;
  }
  return candidate.variance < current.variance;
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
  const housingCap = sitesState.christusHousingCap ?? 3;

  let best = null;
  const chunkSize = 10;

  for (let i = 0; i < restarts; i++) {
    const rng = mulberry32(Date.now() % 1e9 + i * 7919);
    const attempt = runOneAttempt({ studentIds, preferences, locks, sitePools, rng, housingCap });
    if (isBetterAttempt(attempt, best)) {
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

const UNFILLED_CELL = { rotation: 'Unfilled', siteId: null, siteName: 'UNFILLED — needs manual assignment', distance: 0 };

function buildResult(best, studentIds, sitePools) {
  const { templates, assignments, mileage, overflow } = best;

  // Per-absolute-week (1-6) site + distance, for the results grid / export.
  const weekly = {};
  studentIds.forEach((id) => {
    const tmpl = templates[id];
    const a = assignments[id];
    const row = {};
    tmpl.phmWeeks.forEach((w) => {
      const site = a.phm && findSite(sitePools.phm, a.phm.siteId);
      row[w] = site
        ? { rotation: 'PHM', siteId: site.id, siteName: site.name, distance: site.weeklyDistance }
        : UNFILLED_CELL;
    });
    row[tmpl.pemWeek] = (() => {
      const site = a.pem && findSite(sitePools.pem, a.pem.siteId);
      return site
        ? { rotation: 'PEM', siteId: site.id, siteName: site.name, distance: site.weeklyDistance }
        : UNFILLED_CELL;
    })();
    a.community.forEach((c) => {
      if (!c) return;
      const site = findSite(sitePools.community, c.siteId);
      row[c.week] = { rotation: 'Community', siteId: site.id, siteName: site.name, distance: site.weeklyDistance };
    });
    row[tmpl.newbornWeek] = (() => {
      const site = a.newborn && findSite(sitePools.newborn, a.newborn.siteId);
      return site
        ? { rotation: 'Newborn', siteId: site.id, siteName: site.name, distance: 0 }
        : UNFILLED_CELL;
    })();
    // Any community ordinal that never got assigned still needs a visible cell.
    tmpl.communityWeeks.forEach((w) => {
      if (!row[w]) row[w] = UNFILLED_CELL;
    });
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
    unfilledCount: best.unfilledCount,
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

  const seatWeeks = (sites) =>
    sites
      .filter((s) => !isOptInOnly(s)) // opt-in sites (Christus) aren't auto-filled, so don't count toward capacity
      .reduce((sum, s) => sum + (s.weeksOpen || []).reduce((ws, w) => ws + (s.capacityByWeek?.[w] || 0), 0), 0);

  const phmSeatWeeks = seatWeeks(sitesState.phm);
  if (phmSeatWeeks < rosterSize * 2) {
    warnings.push(
      `PHM capacity looks tight: only ~${phmSeatWeeks} seat-weeks available across the term for ${rosterSize} students needing 2 weeks each.`
    );
  }

  const pemSeatWeeks = seatWeeks(sitesState.pem);
  if (pemSeatWeeks < rosterSize) {
    warnings.push(
      `PEM capacity looks tight: only ~${pemSeatWeeks} seat-weeks available across the term for ${rosterSize} students needing 1 week each.`
    );
  }

  return warnings;
}
