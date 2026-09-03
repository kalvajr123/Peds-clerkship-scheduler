"""
Balancing algorithm for the Pediatric Clerkship Scheduler, ported from the
original client-side implementation at ``src/lib/scheduler.js`` in the
peds-clerkship-scheduler React app, so it can run as a standalone Python
Azure Function (e.g. behind a PowerApps custom connector).

The porting goal was line-for-line behavioral parity with the JS version,
not just "produces a reasonable schedule" — same step ordering, same
tie-break rules, same random-restart search. See the JS file's own comments
for the domain rationale; they're preserved here next to each ported piece.

Term-structure recap: the 6-week term is three fixed 2-week blocks —
[1,2], [3,4], [5,6]. Every student is assigned one block to PHM (one site,
both weeks), a different block to Community (2 individual weeks, e.g. a
1-week subspecialty followed immediately by a regular community week —
different site allowed per week), and the third block splits into 1 week
PEM (one site) + 1 week Newborn (filler, distance 0), in either order. PHM
therefore only ever starts on week 1, 3, or 5 — never a mid-block week like
4. The algorithm chooses which block goes to which rotation type per
student, AND which site fills each slot.
"""

from __future__ import annotations

import math
import time
from typing import Any, Callable, Dict, List, Optional

# ---------------------------------------------------------------------
# Week-timing templates
# ---------------------------------------------------------------------

WEEK_BLOCKS: List[List[int]] = [[1, 2], [3, 4], [5, 6]]


def build_week_templates() -> List[Dict[str, Any]]:
    """All valid (phmWeeks, communityWeeks, pemWeek, newbornWeek) templates:
    PHM gets one of the 3 fixed blocks, Community gets a different block,
    and the remaining block's 2 weeks split between PEM and Newborn (both
    orderings, since neither has an adjacency requirement)."""
    templates = []
    for phm_idx in range(len(WEEK_BLOCKS)):
        for comm_idx in range(len(WEEK_BLOCKS)):
            if comm_idx == phm_idx:
                continue
            remaining_idx = next(i for i in (0, 1, 2) if i != phm_idx and i != comm_idx)
            phm_weeks = WEEK_BLOCKS[phm_idx]
            community_weeks = WEEK_BLOCKS[comm_idx]
            remaining_block = WEEK_BLOCKS[remaining_idx]
            templates.append(
                {
                    "phmWeeks": phm_weeks,
                    "communityWeeks": community_weeks,
                    "pemWeek": remaining_block[0],
                    "newbornWeek": remaining_block[1],
                }
            )
            templates.append(
                {
                    "phmWeeks": phm_weeks,
                    "communityWeeks": community_weeks,
                    "pemWeek": remaining_block[1],
                    "newbornWeek": remaining_block[0],
                }
            )
    return templates


WEEK_TEMPLATES = build_week_templates()


def shuffle(items: List[Any], rng: Callable[[], float]) -> List[Any]:
    a = list(items)
    for i in range(len(a) - 1, 0, -1):
        j = int(rng() * (i + 1))
        a[i], a[j] = a[j], a[i]
    return a


# ---------------------------------------------------------------------
# mulberry32 PRNG — ported bit-for-bit from the JS implementation so
# behavior (tie-break randomization, restart diversity) matches exactly.
# ---------------------------------------------------------------------

_MASK32 = 0xFFFFFFFF


def _to_int32(x: int) -> int:
    x &= _MASK32
    return x - 0x100000000 if x & 0x80000000 else x


def _imul(a: int, b: int) -> int:
    a = _to_int32(a)
    b = _to_int32(b)
    return _to_int32((a * b) & _MASK32)


def mulberry32(seed: int) -> Callable[[], float]:
    state = {"a": _to_int32(seed)}

    def rng() -> float:
        a = _to_int32(state["a"] + 0x6D2B79F5)
        state["a"] = a
        t = _imul(a ^ ((a & _MASK32) >> 15), a | 1)
        t = _to_int32((t + _imul(t ^ ((t & _MASK32) >> 7), t | 61)) ^ t)
        return ((t ^ ((t & _MASK32) >> 14)) & _MASK32) / 4294967296

    return rng


# ---------------------------------------------------------------------
# Manual-lock timing constraints
# ---------------------------------------------------------------------


def derive_timing_constraints(locks: List[Dict[str, Any]]) -> Dict[str, Dict[str, int]]:
    """Manual locks can pin timing (which block/week a rotation falls on)
    independently of site. Derives, per student, the combined timing
    constraint from all of their locks: {phmBlock, communityBlock, pemWeek,
    newbornWeek} (block indices 0-2 into WEEK_BLOCKS, weeks are 1-6)."""
    by_student: Dict[str, Dict[str, int]] = {}
    for lock in locks:
        if lock.get("timing") is None:
            continue
        c = by_student.setdefault(lock["studentId"], {})
        key = lock.get("rotationKey")
        if key == "PHM":
            c["phmBlock"] = lock["timing"]
        elif key in ("Community1", "Community2"):
            c["communityBlock"] = lock["timing"]
        elif key == "PEM":
            c["pemWeek"] = lock["timing"]
        elif key == "Newborn":
            c["newbornWeek"] = lock["timing"]
    return by_student


def template_matches_constraints(template: Dict[str, Any], constraints: Optional[Dict[str, int]]) -> bool:
    if not constraints:
        return True
    if constraints.get("phmBlock") is not None and template["phmWeeks"][0] != WEEK_BLOCKS[constraints["phmBlock"]][0]:
        return False
    if (
        constraints.get("communityBlock") is not None
        and template["communityWeeks"][0] != WEEK_BLOCKS[constraints["communityBlock"]][0]
    ):
        return False
    if constraints.get("pemWeek") is not None and template["pemWeek"] != constraints["pemWeek"]:
        return False
    if constraints.get("newbornWeek") is not None and template["newbornWeek"] != constraints["newbornWeek"]:
        return False
    return True


def assign_week_templates(
    student_ids: List[str], rng: Callable[[], float], timing_constraints: Dict[str, Dict[str, int]]
) -> Dict[str, Dict[str, Any]]:
    shuffled_templates = shuffle(WEEK_TEMPLATES, rng)
    order = shuffle(student_ids, rng)
    by_student: Dict[str, Dict[str, Any]] = {}
    for i, sid in enumerate(order):
        constraints = timing_constraints.get(sid)
        if constraints:
            valid = [t for t in shuffled_templates if template_matches_constraints(t, constraints)]
            # If a coordinator locked two contradictory timings (e.g. the same
            # block for both PHM and Community) no template can satisfy both;
            # fall back to an unconstrained pick rather than crash.
            by_student[sid] = valid[i % len(valid)] if valid else shuffled_templates[i % len(shuffled_templates)]
        else:
            by_student[sid] = shuffled_templates[i % len(shuffled_templates)]
    return by_student


# ---------------------------------------------------------------------
# Site pool normalization
# ---------------------------------------------------------------------


def _weekly_distance_phm(site: Dict[str, Any]) -> float:
    return (site.get("distancePerDay") or 0) * (site.get("daysPerWeek") or 0)


def _weekly_distance_pem(site: Dict[str, Any]) -> float:
    if site.get("daysAtSite") is not None:
        return (site.get("distancePerDay") or 0) * site["daysAtSite"]
    return (site.get("distancePerDay") or 0) * (site.get("daysPerWeek") or 0)


def capacity_of(site: Dict[str, Any], week: int, rotation_type: str, use_primary: bool = False) -> float:
    # Newborn sites use a flat weekly capacity (same every week).
    if rotation_type == "newborn":
        cap = site.get("capacity")
        return math.inf if cap is None else cap
    # PHM, PEM, and community sites all use per-week open/closed + capacity.
    if rotation_type == "community" and not site.get("available"):
        return 0
    weeks_open = site.get("weeksOpen")
    if not weeks_open or week not in weeks_open:
        return 0
    # Some sites (e.g. PHM Main/West Campus) have a lower "primary" capacity
    # that should fill first, with the gap up to the full capacity used only
    # as overflow once every site's primary capacity is exhausted.
    if use_primary and site.get("primaryCapacityByWeek"):
        return site["primaryCapacityByWeek"].get(str(week), 0)
    return (site.get("capacityByWeek") or {}).get(str(week), 0)


# Christus and Austin sites are opt-in only: reachable exclusively via an
# explicit hard-preference request (Step A) or a manual lock (Step B),
# never picked automatically by greedy-fill or touched by local search.
def is_opt_in_only(site: Dict[str, Any]) -> bool:
    return site.get("id") in ("phm-christus", "pem-christus", "christus-community") or bool(site.get("isAustin"))


def auto_fill_pools(site_pools: Dict[str, List[Dict[str, Any]]]) -> Dict[str, List[Dict[str, Any]]]:
    return {
        "phm": [s for s in site_pools["phm"] if not is_opt_in_only(s)],
        "pem": [s for s in site_pools["pem"] if not is_opt_in_only(s)],
        "community": [s for s in site_pools["community"] if not is_opt_in_only(s)],
        "newborn": site_pools["newborn"],
    }


def normalize_sites(sites_state: Dict[str, Any]) -> Dict[str, List[Dict[str, Any]]]:
    phm = [{**s, "weeklyDistance": _weekly_distance_phm(s)} for s in sites_state.get("phm", [])]
    pem = [{**s, "weeklyDistance": _weekly_distance_pem(s)} for s in sites_state.get("pem", [])]
    newborn = [{**s, "weeklyDistance": 0} for s in sites_state.get("newborn", [])]
    community = [
        {**s, "weeklyDistance": s.get("distance") or 0}
        for s in sites_state.get("community", [])
        if s.get("available")
    ]
    return {"phm": phm, "pem": pem, "newborn": newborn, "community": community}


# ---------------------------------------------------------------------
# Occupancy tracking
# ---------------------------------------------------------------------


class Occupancy:
    def __init__(self) -> None:
        self.counts: Dict[tuple, int] = {}

    def get(self, rotation_type: str, site_id: Optional[str], week: int) -> int:
        return self.counts.get((rotation_type, site_id, week), 0)

    def inc(self, rotation_type: str, site_id: Optional[str], week: int, by: int = 1) -> None:
        k = (rotation_type, site_id, week)
        self.counts[k] = self.counts.get(k, 0) + by

    def dec(self, rotation_type: str, site_id: Optional[str], week: int) -> None:
        self.inc(rotation_type, site_id, week, -1)


def has_capacity(
    site: Dict[str, Any], week: int, rotation_type: str, occupancy: Occupancy, use_primary: bool = False
) -> bool:
    return occupancy.get(rotation_type, site["id"], week) < capacity_of(site, week, rotation_type, use_primary)


# ---------------------------------------------------------------------
# Assignment record helpers
# ---------------------------------------------------------------------


def empty_assignment() -> Dict[str, Any]:
    return {"phm": None, "pem": None, "community": [None, None], "newborn": None}


def find_site(pool: List[Dict[str, Any]], site_id: Optional[str]) -> Optional[Dict[str, Any]]:
    if site_id is None:
        return None
    for s in pool:
        if s.get("id") == site_id:
            return s
    return None


# ---------------------------------------------------------------------
# Step A — hard preferences (FCFS by entry order)
# ---------------------------------------------------------------------

SPECIAL_SITE_IDS = {
    "katyPHM": "phm-wc",
    "katyPEM": "pem-wc",
    "woodlandsPEM": "pem-woodlands",
    "christusPHM": "phm-christus",
    "christusPEM": "pem-christus",
}

# San Antonio (Christus) housing is shared across PHM/Community/PEM — only
# a limited number of housing spots exist per week regardless of each
# rotation's own site capacity, so it needs a cross-site check.
SAN_ANTONIO_SITE_IDS = {"phm": "phm-christus", "pem": "pem-christus", "community": "christus-community"}


def san_antonio_occupancy(occupancy: Occupancy, week: int) -> int:
    return (
        occupancy.get("phm", SAN_ANTONIO_SITE_IDS["phm"], week)
        + occupancy.get("pem", SAN_ANTONIO_SITE_IDS["pem"], week)
        + occupancy.get("community", SAN_ANTONIO_SITE_IDS["community"], week)
    )


def san_antonio_has_room(occupancy: Occupancy, week: int, housing_cap: float) -> bool:
    return san_antonio_occupancy(occupancy, week) < housing_cap


def apply_hard_preferences(
    preferences: Dict[str, Any],
    templates: Dict[str, Dict[str, Any]],
    site_pools: Dict[str, List[Dict[str, Any]]],
    occupancy: Occupancy,
    assignments: Dict[str, Dict[str, Any]],
    overflow: List[Dict[str, Any]],
    housing_cap: float,
) -> None:
    # Katy / Woodlands (single-rotation categories)
    simple_categories = [
        {"key": "katyPHM", "rotationKey": "PHM", "siteId": SPECIAL_SITE_IDS["katyPHM"], "pool": "phm"},
        {"key": "katyPEM", "rotationKey": "PEM", "siteId": SPECIAL_SITE_IDS["katyPEM"], "pool": "pem"},
        {"key": "woodlandsPEM", "rotationKey": "PEM", "siteId": SPECIAL_SITE_IDS["woodlandsPEM"], "pool": "pem"},
    ]

    for cat in simple_categories:
        order = (preferences.get(cat["key"]) or {}).get("order", [])
        site = find_site(site_pools[cat["pool"]], cat["siteId"])
        if not site:
            continue
        for idx, student_id in enumerate(order):
            a = assignments[student_id]
            if cat["rotationKey"] == "PHM":
                if a["phm"]:
                    continue
                weeks = templates[student_id]["phmWeeks"]
                ok = all(has_capacity(site, w, "phm", occupancy) for w in weeks)
                if ok:
                    for w in weeks:
                        occupancy.inc("phm", site["id"], w)
                    a["phm"] = {"weeks": weeks, "siteId": site["id"], "locked": True}
                else:
                    overflow.append({"category": cat["key"], "studentId": student_id, "order": idx})
            else:
                if a["pem"]:
                    continue
                week = templates[student_id]["pemWeek"]
                if has_capacity(site, week, "pem", occupancy):
                    occupancy.inc("pem", site["id"], week)
                    a["pem"] = {"week": week, "siteId": site["id"], "locked": True}
                else:
                    overflow.append({"category": cat["key"], "studentId": student_id, "order": idx})

    # Austin (community, both weeks, any Austin site)
    austin_order = (preferences.get("austin") or {}).get("order", [])
    austin_sites = [s for s in site_pools["community"] if s.get("isAustin")]
    for idx, student_id in enumerate(austin_order):
        a = assignments[student_id]
        # Austin wants both community weeks at the same site; if either week
        # is already fixed (e.g. by a manual lock), this student can't cleanly
        # get the both-weeks Austin placement.
        if a["community"][0] or a["community"][1]:
            continue
        weeks = templates[student_id]["communityWeeks"]
        site = next((s for s in austin_sites if all(has_capacity(s, w, "community", occupancy) for w in weeks)), None)
        if site:
            for ordinal, w in enumerate(weeks):
                occupancy.inc("community", site["id"], w)
                a["community"][ordinal] = {"week": w, "siteId": site["id"], "ordinal": ordinal, "locked": True}
        else:
            overflow.append({"category": "austin", "studentId": student_id, "order": idx})

    # Christus — PHM / Community / PEM sub-rotations from one preference box
    christus = preferences.get("christus")
    christus_community_site = find_site(site_pools["community"], "christus-community")
    if christus:
        entries = christus.get("entries", {})
        order = christus.get("order", [])
        wants_phm = [sid for sid in order if "PHM" in (entries.get(sid) or [])]
        wants_community = [sid for sid in order if "Community" in (entries.get(sid) or [])]
        wants_pem = [sid for sid in order if "PEM" in (entries.get(sid) or [])]

        phm_site = find_site(site_pools["phm"], SPECIAL_SITE_IDS["christusPHM"])
        for idx, student_id in enumerate(wants_phm):
            a = assignments[student_id]
            if a["phm"] or not phm_site:
                continue
            weeks = templates[student_id]["phmWeeks"]
            ok = all(has_capacity(phm_site, w, "phm", occupancy) and san_antonio_has_room(occupancy, w, housing_cap) for w in weeks)
            if ok:
                for w in weeks:
                    occupancy.inc("phm", phm_site["id"], w)
                a["phm"] = {"weeks": weeks, "siteId": phm_site["id"], "locked": True}
            else:
                overflow.append({"category": "christusPHM", "studentId": student_id, "order": idx})

        pem_site = find_site(site_pools["pem"], SPECIAL_SITE_IDS["christusPEM"])
        for idx, student_id in enumerate(wants_pem):
            a = assignments[student_id]
            if a["pem"] or not pem_site:
                continue
            week = templates[student_id]["pemWeek"]
            if has_capacity(pem_site, week, "pem", occupancy) and san_antonio_has_room(occupancy, week, housing_cap):
                occupancy.inc("pem", pem_site["id"], week)
                a["pem"] = {"week": week, "siteId": pem_site["id"], "locked": True}
            else:
                overflow.append({"category": "christusPEM", "studentId": student_id, "order": idx})

        for idx, student_id in enumerate(wants_community):
            a = assignments[student_id]
            if not christus_community_site or a["community"][0] or a["community"][1]:
                continue
            weeks = templates[student_id]["communityWeeks"]
            ok = all(
                has_capacity(christus_community_site, w, "community", occupancy)
                and san_antonio_has_room(occupancy, w, housing_cap)
                for w in weeks
            )
            if ok:
                for ordinal, w in enumerate(weeks):
                    occupancy.inc("community", christus_community_site["id"], w)
                    a["community"][ordinal] = {
                        "week": w,
                        "siteId": christus_community_site["id"],
                        "ordinal": ordinal,
                        "locked": True,
                    }
            else:
                overflow.append({"category": "christusCommunity", "studentId": student_id, "order": idx})


# ---------------------------------------------------------------------
# Step B — manual locks
# ---------------------------------------------------------------------


def apply_manual_locks(
    locks: List[Dict[str, Any]],
    templates: Dict[str, Dict[str, Any]],
    site_pools: Dict[str, List[Dict[str, Any]]],
    occupancy: Occupancy,
    assignments: Dict[str, Dict[str, Any]],
) -> None:
    for lock in locks:
        a = assignments.get(lock["studentId"])
        if a is None:
            continue
        tmpl = templates[lock["studentId"]]
        key = lock.get("rotationKey")
        if key == "PHM":
            site = find_site(site_pools["phm"], lock.get("siteId"))
            if not site or a["phm"]:
                continue
            for w in tmpl["phmWeeks"]:
                occupancy.inc("phm", site["id"], w)
            a["phm"] = {"weeks": tmpl["phmWeeks"], "siteId": site["id"], "locked": True}
        elif key == "PEM":
            site = find_site(site_pools["pem"], lock.get("siteId"))
            if not site or a["pem"]:
                continue
            occupancy.inc("pem", site["id"], tmpl["pemWeek"])
            a["pem"] = {"week": tmpl["pemWeek"], "siteId": site["id"], "locked": True}
        elif key in ("Community1", "Community2"):
            ordinal = 0 if key == "Community1" else 1
            site = find_site(site_pools["community"], lock.get("siteId"))
            if not site or a["community"][ordinal]:
                continue
            week = tmpl["communityWeeks"][ordinal]
            occupancy.inc("community", site["id"], week)
            a["community"][ordinal] = {"week": week, "siteId": site["id"], "ordinal": ordinal, "locked": True}
        elif key == "Newborn":
            site = find_site(site_pools["newborn"], lock.get("siteId"))
            if not site or a["newborn"]:
                continue
            occupancy.inc("newborn", site["id"], tmpl["newbornWeek"])
            a["newborn"] = {"week": tmpl["newbornWeek"], "siteId": site["id"], "locked": True}


# ---------------------------------------------------------------------
# Step C — greedy fill
# ---------------------------------------------------------------------


def current_total(mileage: Dict[str, float], student_id: str) -> float:
    return mileage.get(student_id, 0)


def student_used_subspecialty(a: Dict[str, Any]) -> bool:
    return any(c and c.get("isSubspecialty") for c in a["community"])


def greedy_fill_phm_pass(
    open_ids: List[str],
    templates: Dict[str, Dict[str, Any]],
    site_pools: Dict[str, List[Dict[str, Any]]],
    occupancy: Occupancy,
    assignments: Dict[str, Dict[str, Any]],
    mileage: Dict[str, float],
    rng: Callable[[], float],
    use_primary: bool,
) -> List[str]:
    open_ = list(open_ids)
    still_open: List[str] = []
    while open_:
        open_ = sorted(shuffle(open_, rng), key=lambda sid: current_total(mileage, sid))
        student_id = open_[0]
        weeks = templates[student_id]["phmWeeks"]
        eligible = [site for site in site_pools["phm"] if all(has_capacity(site, w, "phm", occupancy, use_primary) for w in weeks)]
        if not eligible:
            still_open.append(student_id)
            open_ = open_[1:]
            continue
        eligible.sort(key=lambda s: s["weeklyDistance"])
        site = eligible[0]
        for w in weeks:
            occupancy.inc("phm", site["id"], w)
        assignments[student_id]["phm"] = {"weeks": weeks, "siteId": site["id"], "locked": False}
        mileage[student_id] = current_total(mileage, student_id) + site["weeklyDistance"] * len(weeks)
        open_ = open_[1:]
    return still_open


def greedy_fill_phm(
    student_ids: List[str],
    templates: Dict[str, Dict[str, Any]],
    site_pools: Dict[str, List[Dict[str, Any]]],
    occupancy: Occupancy,
    assignments: Dict[str, Dict[str, Any]],
    mileage: Dict[str, float],
    rng: Callable[[], float],
) -> None:
    """Two-pass fill: first up to each site's "primary" capacity (e.g.
    Main=8, West Campus=2), cheapest-first as usual; only students that
    still can't be placed move on to a second pass using each site's full
    capacity (e.g. Main up to 10, WC up to 3) — so overflow capacity is only
    used once every site's preferred capacity is exhausted."""
    open_ = [sid for sid in student_ids if not assignments[sid]["phm"]]
    still_open = greedy_fill_phm_pass(open_, templates, site_pools, occupancy, assignments, mileage, rng, True)
    if still_open:
        greedy_fill_phm_pass(still_open, templates, site_pools, occupancy, assignments, mileage, rng, False)


def greedy_fill_pem(
    student_ids: List[str],
    templates: Dict[str, Dict[str, Any]],
    site_pools: Dict[str, List[Dict[str, Any]]],
    occupancy: Occupancy,
    assignments: Dict[str, Dict[str, Any]],
    mileage: Dict[str, float],
    rng: Callable[[], float],
) -> None:
    """PEM deliberately does NOT fill cheapest-first: the coordinator wants
    students spread round-robin across TCH-A -> TCH-B -> Katy -> Woodlands
    (one student per site per pass) to avoid crowding TCH, even though pure
    mileage-minimization would cluster everyone at TCH. The cycle resets
    per week (site_pools['pem'] is in that exact priority order after
    opt-in Christus is filtered out by auto_fill_pools)."""
    open_ = [sid for sid in student_ids if not assignments[sid]["pem"]]
    cycle_pos: Dict[int, int] = {}
    pem_sites = site_pools["pem"]
    n = len(pem_sites)
    while open_:
        open_ = sorted(shuffle(open_, rng), key=lambda sid: current_total(mileage, sid))
        student_id = open_[0]
        week = templates[student_id]["pemWeek"]
        start = cycle_pos.get(week, 0)
        found_idx = -1
        for i in range(n):
            idx = (start + i) % n
            if has_capacity(pem_sites[idx], week, "pem", occupancy):
                found_idx = idx
                break
        if found_idx == -1:
            open_ = open_[1:]
            continue
        site = pem_sites[found_idx]
        occupancy.inc("pem", site["id"], week)
        assignments[student_id]["pem"] = {"week": week, "siteId": site["id"], "locked": False}
        mileage[student_id] = current_total(mileage, student_id) + site["weeklyDistance"]
        cycle_pos[week] = (found_idx + 1) % n
        open_ = open_[1:]


def greedy_fill_community(
    student_ids: List[str],
    templates: Dict[str, Dict[str, Any]],
    site_pools: Dict[str, List[Dict[str, Any]]],
    occupancy: Occupancy,
    assignments: Dict[str, Dict[str, Any]],
    mileage: Dict[str, float],
    preferences: Dict[str, Any],
    rng: Callable[[], float],
) -> None:
    spanish_speakers = set((preferences.get("spanish") or {}).get("order", []))
    open_: List[Dict[str, Any]] = []
    for sid in student_ids:
        for ordinal, slot in enumerate(assignments[sid]["community"]):
            if not slot:
                open_.append({"studentId": sid, "ordinal": ordinal})

    while open_:
        open_ = sorted(shuffle(open_, rng), key=lambda o: current_total(mileage, o["studentId"]))
        entry = open_[0]
        student_id, ordinal = entry["studentId"], entry["ordinal"]
        week = templates[student_id]["communityWeeks"][ordinal]
        a = assignments[student_id]
        used_subspecialty = student_used_subspecialty(a)

        def eligible_site(site: Dict[str, Any]) -> bool:
            if not has_capacity(site, week, "community", occupancy):
                return False
            if used_subspecialty and site.get("isSubspecialty"):
                return False
            if site.get("requiresSpanish") and student_id not in spanish_speakers:
                return False
            return True

        eligible = [s for s in site_pools["community"] if eligible_site(s)]
        if not eligible:
            open_ = open_[1:]
            continue
        eligible.sort(key=lambda s: s["weeklyDistance"])
        site = eligible[0]
        occupancy.inc("community", site["id"], week)
        a["community"][ordinal] = {
            "week": week,
            "siteId": site["id"],
            "ordinal": ordinal,
            "locked": False,
            "isSubspecialty": bool(site.get("isSubspecialty")),
        }
        mileage[student_id] = current_total(mileage, student_id) + site["weeklyDistance"]
        open_ = open_[1:]


# ---------------------------------------------------------------------
# Step D — local-search cleanup (incremental variance-based swaps)
# ---------------------------------------------------------------------


def variance(sum_: float, sum_sq: float, n: int) -> float:
    mean = sum_ / n
    return sum_sq / n - mean * mean


def local_search_phm(
    student_ids: List[str],
    site_pools: Dict[str, List[Dict[str, Any]]],
    occupancy: Occupancy,
    assignments: Dict[str, Dict[str, Any]],
    mileage: Dict[str, float],
) -> None:
    n = len(student_ids)
    sum_ = sum(mileage[sid] for sid in student_ids)
    sum_sq = sum(mileage[sid] ** 2 for sid in student_ids)
    unlocked = [sid for sid in student_ids if assignments[sid]["phm"] and not assignments[sid]["phm"]["locked"]]

    improved = True
    guard = 0
    while improved and guard < 40:
        improved = False
        guard += 1
        for i in range(len(unlocked)):
            for j in range(i + 1, len(unlocked)):
                id1, id2 = unlocked[i], unlocked[j]
                a1, a2 = assignments[id1]["phm"], assignments[id2]["phm"]
                if a1["siteId"] == a2["siteId"]:
                    continue
                site1 = find_site(site_pools["phm"], a1["siteId"])
                site2 = find_site(site_pools["phm"], a2["siteId"])

                ok1 = all(
                    occupancy.get("phm", site1["id"], w) - (1 if w in a1["weeks"] else 0) < capacity_of(site1, w, "phm")
                    for w in a2["weeks"]
                )
                ok2 = all(
                    occupancy.get("phm", site2["id"], w) - (1 if w in a2["weeks"] else 0) < capacity_of(site2, w, "phm")
                    for w in a1["weeks"]
                )
                if not ok1 or not ok2:
                    continue

                m1, m2 = mileage[id1], mileage[id2]
                new_m1 = mileage[id1] - site1["weeklyDistance"] * len(a1["weeks"]) + site2["weeklyDistance"] * len(a1["weeks"])
                new_m2 = mileage[id2] - site2["weeklyDistance"] * len(a2["weeks"]) + site1["weeklyDistance"] * len(a2["weeks"])
                new_sum_sq = sum_sq - m1**2 - m2**2 + new_m1**2 + new_m2**2
                new_sum = sum_ - m1 - m2 + new_m1 + new_m2
                if variance(new_sum, new_sum_sq, n) < variance(sum_, sum_sq, n) - 1e-9:
                    for w in a1["weeks"]:
                        occupancy.dec("phm", site1["id"], w)
                        occupancy.inc("phm", site2["id"], w)
                    for w in a2["weeks"]:
                        occupancy.dec("phm", site2["id"], w)
                        occupancy.inc("phm", site1["id"], w)
                    a1["siteId"], a2["siteId"] = a2["siteId"], a1["siteId"]
                    mileage[id1], mileage[id2] = new_m1, new_m2
                    sum_, sum_sq = new_sum, new_sum_sq
                    improved = True


def local_search_pem(
    student_ids: List[str],
    site_pools: Dict[str, List[Dict[str, Any]]],
    occupancy: Occupancy,
    assignments: Dict[str, Dict[str, Any]],
    mileage: Dict[str, float],
) -> None:
    n = len(student_ids)
    sum_ = sum(mileage[sid] for sid in student_ids)
    sum_sq = sum(mileage[sid] ** 2 for sid in student_ids)
    unlocked = [sid for sid in student_ids if assignments[sid]["pem"] and not assignments[sid]["pem"]["locked"]]

    improved = True
    guard = 0
    while improved and guard < 40:
        improved = False
        guard += 1
        for i in range(len(unlocked)):
            for j in range(i + 1, len(unlocked)):
                id1, id2 = unlocked[i], unlocked[j]
                a1, a2 = assignments[id1]["pem"], assignments[id2]["pem"]
                if a1["siteId"] == a2["siteId"]:
                    continue
                site1 = find_site(site_pools["pem"], a1["siteId"])
                site2 = find_site(site_pools["pem"], a2["siteId"])

                ok1 = occupancy.get("pem", site1["id"], a2["week"]) - (1 if a1["week"] == a2["week"] else 0) < capacity_of(
                    site1, a2["week"], "pem"
                )
                ok2 = occupancy.get("pem", site2["id"], a1["week"]) - (1 if a2["week"] == a1["week"] else 0) < capacity_of(
                    site2, a1["week"], "pem"
                )
                if not ok1 or not ok2:
                    continue

                m1, m2 = mileage[id1], mileage[id2]
                new_m1 = m1 - site1["weeklyDistance"] + site2["weeklyDistance"]
                new_m2 = m2 - site2["weeklyDistance"] + site1["weeklyDistance"]
                new_sum_sq = sum_sq - m1**2 - m2**2 + new_m1**2 + new_m2**2
                new_sum = sum_ - m1 - m2 + new_m1 + new_m2
                if variance(new_sum, new_sum_sq, n) < variance(sum_, sum_sq, n) - 1e-9:
                    occupancy.dec("pem", site1["id"], a1["week"])
                    occupancy.inc("pem", site2["id"], a1["week"])
                    occupancy.dec("pem", site2["id"], a2["week"])
                    occupancy.inc("pem", site1["id"], a2["week"])
                    a1["siteId"], a2["siteId"] = a2["siteId"], a1["siteId"]
                    mileage[id1], mileage[id2] = new_m1, new_m2
                    sum_, sum_sq = new_sum, new_sum_sq
                    improved = True
    # PEM intentionally skips local-search balancing in the *original* — see
    # note in run_one_attempt; this function is kept only for parity/reuse
    # but run_one_attempt does not call it, matching scheduler.js.


def local_search_community(
    student_ids: List[str],
    site_pools: Dict[str, List[Dict[str, Any]]],
    occupancy: Occupancy,
    assignments: Dict[str, Dict[str, Any]],
    mileage: Dict[str, float],
    preferences: Dict[str, Any],
) -> None:
    spanish_speakers = set((preferences.get("spanish") or {}).get("order", []))
    n = len(student_ids)
    sum_ = sum(mileage[sid] for sid in student_ids)
    sum_sq = sum(mileage[sid] ** 2 for sid in student_ids)

    slots: List[Dict[str, Any]] = []
    for sid in student_ids:
        for slot in assignments[sid]["community"]:
            if slot and not slot["locked"]:
                slots.append({"studentId": sid, "slot": slot})

    def other_ordinal_is_subspecialty(student_id: str, ordinal: int, exclude_site_id: Optional[str]) -> bool:
        a = assignments[student_id]
        return any(
            c and idx != ordinal and c.get("isSubspecialty") and c["siteId"] != exclude_site_id
            for idx, c in enumerate(a["community"])
        )

    improved = True
    guard = 0
    while improved and guard < 40:
        improved = False
        guard += 1
        for i in range(len(slots)):
            for j in range(i + 1, len(slots)):
                s1, s2 = slots[i], slots[j]
                if s1["slot"]["siteId"] == s2["slot"]["siteId"]:
                    continue
                site1 = find_site(site_pools["community"], s1["slot"]["siteId"])
                site2 = find_site(site_pools["community"], s2["slot"]["siteId"])

                if site1.get("requiresSpanish") and s2["studentId"] not in spanish_speakers:
                    continue
                if site2.get("requiresSpanish") and s1["studentId"] not in spanish_speakers:
                    continue
                if site2.get("isSubspecialty") and other_ordinal_is_subspecialty(s1["studentId"], s1["slot"]["ordinal"], site1["id"]):
                    continue
                if site1.get("isSubspecialty") and other_ordinal_is_subspecialty(s2["studentId"], s2["slot"]["ordinal"], site2["id"]):
                    continue

                same_week = s1["slot"]["week"] == s2["slot"]["week"]
                occ1 = occupancy.get("community", site1["id"], s2["slot"]["week"]) - (1 if same_week else 0)
                occ2 = occupancy.get("community", site2["id"], s1["slot"]["week"]) - (1 if same_week else 0)
                if occ1 >= capacity_of(site1, s2["slot"]["week"], "community"):
                    continue
                if occ2 >= capacity_of(site2, s1["slot"]["week"], "community"):
                    continue

                m1, m2 = mileage[s1["studentId"]], mileage[s2["studentId"]]
                new_m1 = m1 - site1["weeklyDistance"] + site2["weeklyDistance"]
                new_m2 = m2 - site2["weeklyDistance"] + site1["weeklyDistance"]
                new_sum_sq = sum_sq - m1**2 - m2**2 + new_m1**2 + new_m2**2
                new_sum = sum_ - m1 - m2 + new_m1 + new_m2
                if variance(new_sum, new_sum_sq, n) < variance(sum_, sum_sq, n) - 1e-9:
                    occupancy.dec("community", site1["id"], s1["slot"]["week"])
                    occupancy.inc("community", site2["id"], s1["slot"]["week"])
                    occupancy.dec("community", site2["id"], s2["slot"]["week"])
                    occupancy.inc("community", site1["id"], s2["slot"]["week"])

                    s1["slot"]["siteId"], s2["slot"]["siteId"] = s2["slot"]["siteId"], s1["slot"]["siteId"]
                    s1["slot"]["isSubspecialty"], s2["slot"]["isSubspecialty"] = (
                        s2["slot"]["isSubspecialty"],
                        s1["slot"]["isSubspecialty"],
                    )

                    mileage[s1["studentId"]], mileage[s2["studentId"]] = new_m1, new_m2
                    sum_, sum_sq = new_sum, new_sum_sq
                    improved = True


# ---------------------------------------------------------------------
# Single restart
# ---------------------------------------------------------------------


def run_one_attempt(
    student_ids: List[str],
    preferences: Dict[str, Any],
    locks: List[Dict[str, Any]],
    site_pools: Dict[str, List[Dict[str, Any]]],
    rng: Callable[[], float],
    housing_cap: float,
) -> Dict[str, Any]:
    timing_constraints = derive_timing_constraints(locks)
    templates = assign_week_templates(student_ids, rng, timing_constraints)
    occupancy = Occupancy()
    assignments = {sid: empty_assignment() for sid in student_ids}
    mileage = {sid: 0.0 for sid in student_ids}
    overflow: List[Dict[str, Any]] = []

    apply_manual_locks(locks, templates, site_pools, occupancy, assignments)
    apply_hard_preferences(preferences, templates, site_pools, occupancy, assignments, overflow, housing_cap)

    # Seed mileage totals from locked/hard-pref assignments already made.
    for sid in student_ids:
        a = assignments[sid]
        total = 0.0
        if a["phm"]:
            site = find_site(site_pools["phm"], a["phm"]["siteId"])
            total += site["weeklyDistance"] * len(a["phm"]["weeks"])
        if a["pem"]:
            site = find_site(site_pools["pem"], a["pem"]["siteId"])
            total += site["weeklyDistance"]
        for c in a["community"]:
            if c:
                site = find_site(site_pools["community"], c["siteId"])
                c["isSubspecialty"] = bool(site.get("isSubspecialty"))
                total += site["weeklyDistance"]
        mileage[sid] = total

    auto_pools = auto_fill_pools(site_pools)
    greedy_fill_phm(student_ids, templates, auto_pools, occupancy, assignments, mileage, rng)
    greedy_fill_pem(student_ids, templates, auto_pools, occupancy, assignments, mileage, rng)
    greedy_fill_community(student_ids, templates, auto_pools, occupancy, assignments, mileage, preferences, rng)

    local_search_phm(student_ids, site_pools, occupancy, assignments, mileage)
    # PEM intentionally skips local-search balancing: swapping students
    # toward lower mileage would just re-cluster them at cheap sites (TCH),
    # undoing the round-robin spread greedy_fill_pem was asked to produce.
    local_search_community(student_ids, site_pools, occupancy, assignments, mileage, preferences)

    # Newborn: whatever week is left, assign lowest-loaded available newborn
    # site (skip anyone already fixed by a manual lock with a site).
    for sid in student_ids:
        if assignments[sid]["newborn"]:
            continue
        week = templates[sid]["newbornWeek"]
        eligible = [s for s in site_pools["newborn"] if has_capacity(s, week, "newborn", occupancy)]
        site = eligible[0] if eligible else (site_pools["newborn"][0] if site_pools["newborn"] else None)
        if site:
            occupancy.inc("newborn", site["id"], week)
            assignments[sid]["newborn"] = {"week": week, "siteId": site["id"], "locked": False}

    n = len(student_ids)
    sum_ = sum(mileage[sid] for sid in student_ids)
    sum_sq = sum(mileage[sid] ** 2 for sid in student_ids)
    variance_value = variance(sum_, sum_sq, n) if n else 0

    unfilled_count = 0
    for sid in student_ids:
        a = assignments[sid]
        if not a["phm"]:
            unfilled_count += 1
        if not a["pem"]:
            unfilled_count += 1
        if not a["community"][0]:
            unfilled_count += 1
        if not a["community"][1]:
            unfilled_count += 1
        if not a["newborn"]:
            unfilled_count += 1

    return {
        "templates": templates,
        "assignments": assignments,
        "mileage": mileage,
        "overflow": overflow,
        "variance": variance_value,
        "sum": sum_,
        "unfilledCount": unfilled_count,
    }


def is_better_attempt(candidate: Dict[str, Any], current: Optional[Dict[str, Any]]) -> bool:
    """Fewer unfilled slots wins; then fewer FCFS overflow requests; then
    lower total miles; then lower variance."""
    if current is None:
        return True
    if candidate["unfilledCount"] != current["unfilledCount"]:
        return candidate["unfilledCount"] < current["unfilledCount"]
    # Satisfying explicit hard-preference requests (Christus/Austin/Katy/
    # Woodlands) matters more than shaving a bit off variance — a restart
    # where a student's random week-template just missed a site's open
    # block shouldn't beat one where the same request succeeded.
    if len(candidate["overflow"]) != len(current["overflow"]):
        return len(candidate["overflow"]) < len(current["overflow"])
    if candidate["sum"] != current["sum"]:
        return candidate["sum"] < current["sum"]
    return candidate["variance"] < current["variance"]


# ---------------------------------------------------------------------
# Public entry point: random-restart search
# ---------------------------------------------------------------------


def run_scheduler(
    roster: List[Dict[str, Any]],
    sites_state: Dict[str, Any],
    preferences: Dict[str, Any],
    locks: List[Dict[str, Any]],
    restarts: int = 200,
) -> Dict[str, Any]:
    student_ids = [s["id"] for s in roster]
    site_pools = normalize_sites(sites_state)
    housing_cap = sites_state.get("christusHousingCap", 3)

    best: Optional[Dict[str, Any]] = None
    base_seed = int(time.time() * 1000) % 1_000_000_000

    for i in range(restarts):
        seed = base_seed + i * 7919
        rng = mulberry32(seed)
        attempt = run_one_attempt(student_ids, preferences, locks, site_pools, rng, housing_cap)
        if is_better_attempt(attempt, best):
            best = attempt

    return build_result(best, student_ids, site_pools)


UNFILLED_CELL = {"rotation": "Unfilled", "siteId": None, "siteName": "UNFILLED — needs manual assignment", "distance": 0}


def build_result(best: Dict[str, Any], student_ids: List[str], site_pools: Dict[str, List[Dict[str, Any]]]) -> Dict[str, Any]:
    templates, assignments, mileage, overflow = best["templates"], best["assignments"], best["mileage"], best["overflow"]

    # Per-absolute-week (1-6) site + distance, for the results grid / export.
    weekly: Dict[str, Dict[str, Any]] = {}
    for sid in student_ids:
        tmpl = templates[sid]
        a = assignments[sid]
        row: Dict[int, Any] = {}
        for w in tmpl["phmWeeks"]:
            site = find_site(site_pools["phm"], a["phm"]["siteId"]) if a["phm"] else None
            row[w] = (
                {"rotation": "PHM", "siteId": site["id"], "siteName": site.get("name"), "distance": site["weeklyDistance"]}
                if site
                else UNFILLED_CELL
            )
        pem_site = find_site(site_pools["pem"], a["pem"]["siteId"]) if a["pem"] else None
        row[tmpl["pemWeek"]] = (
            {"rotation": "PEM", "siteId": pem_site["id"], "siteName": pem_site.get("name"), "distance": pem_site["weeklyDistance"]}
            if pem_site
            else UNFILLED_CELL
        )
        for c in a["community"]:
            if not c:
                continue
            site = find_site(site_pools["community"], c["siteId"])
            row[c["week"]] = {"rotation": "Community", "siteId": site["id"], "siteName": site.get("name"), "distance": site["weeklyDistance"]}
        newborn_site = find_site(site_pools["newborn"], a["newborn"]["siteId"]) if a["newborn"] else None
        row[tmpl["newbornWeek"]] = (
            {"rotation": "Newborn", "siteId": newborn_site["id"], "siteName": newborn_site.get("name"), "distance": 0}
            if newborn_site
            else UNFILLED_CELL
        )
        # Any community ordinal that never got assigned still needs a visible cell.
        for w in tmpl["communityWeeks"]:
            if w not in row:
                row[w] = UNFILLED_CELL
        # JSON object keys must be strings.
        weekly[sid] = {str(w): row[w] for w in sorted(row)}

    n = len(student_ids)
    totals = [mileage[sid] for sid in student_ids]
    mean = sum(totals) / n if n else 0
    std = math.sqrt(sum((v - mean) ** 2 for v in totals) / n) if n else 0
    std = std or 1

    ranked = sorted(student_ids, key=lambda sid: mileage[sid])
    rank = {sid: i + 1 for i, sid in enumerate(ranked)}

    z_score = {sid: (mileage[sid] - mean) / std for sid in student_ids}

    return {
        "templates": templates,
        "assignments": assignments,
        "weekly": weekly,
        "mileage": mileage,
        "rank": rank,
        "zScore": z_score,
        "mean": mean,
        "std": std,
        "overflow": overflow,
        "variance": best["variance"],
        "unfilledCount": best["unfilledCount"],
    }


def recompute_stats(student_ids: List[str], mileage: Dict[str, float]) -> Dict[str, Any]:
    n = len(student_ids)
    totals = [mileage[sid] for sid in student_ids]
    mean = sum(totals) / n if n else 0
    std = math.sqrt(sum((v - mean) ** 2 for v in totals) / n) if n else 0
    std = std or 1
    ranked = sorted(student_ids, key=lambda sid: mileage[sid])
    rank = {sid: i + 1 for i, sid in enumerate(ranked)}
    z_score = {sid: (mileage[sid] - mean) / std for sid in student_ids}
    return {"mean": mean, "std": std, "rank": rank, "zScore": z_score}


def validate_site_capacity(sites_state: Dict[str, Any], roster_size: int) -> List[str]:
    """Simple aggregate sanity checks per the spec's Step 2 validation note."""
    warnings: List[str] = []

    community = [s for s in sites_state.get("community", []) if s.get("available")]
    total_community = sum(
        sum((s.get("capacityByWeek") or {}).get(str(w), 0) for w in (s.get("weeksOpen") or [])) for s in community
    )
    needed_community = roster_size * 2
    if total_community < needed_community:
        warnings.append(
            f"Total community capacity across all weeks ({total_community}) is less than needed for the "
            f"roster ({needed_community} student-weeks). Add sites/weeks/capacity or the schedule will have "
            "unfilled community slots."
        )

    def seat_weeks(sites: List[Dict[str, Any]]) -> int:
        return sum(
            sum((s.get("capacityByWeek") or {}).get(str(w), 0) for w in (s.get("weeksOpen") or []))
            for s in sites
            if not is_opt_in_only(s)
        )

    phm_seat_weeks = seat_weeks(sites_state.get("phm", []))
    if phm_seat_weeks < roster_size * 2:
        warnings.append(
            f"PHM capacity looks tight: only ~{phm_seat_weeks} seat-weeks available across the term for "
            f"{roster_size} students needing 2 weeks each."
        )

    pem_seat_weeks = seat_weeks(sites_state.get("pem", []))
    if pem_seat_weeks < roster_size:
        warnings.append(
            f"PEM capacity looks tight: only ~{pem_seat_weeks} seat-weeks available across the term for "
            f"{roster_size} students needing 1 week each."
        )

    return warnings
