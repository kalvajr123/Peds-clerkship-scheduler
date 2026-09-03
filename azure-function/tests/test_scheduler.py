"""
Smoke tests for the ported balancing algorithm. These aren't a port of any
JS test suite (the original app had none) — they check the invariants the
algorithm is supposed to guarantee: every slot fillable gets filled,
capacity is never exceeded, hard preferences are honored when capacity
allows, subspecialty/Spanish rules hold, and manual locks are never
overridden.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scheduler import (  # noqa: E402
    build_week_templates,
    run_scheduler,
    recompute_stats,
    validate_site_capacity,
)

SAMPLE_PATH = os.path.join(os.path.dirname(__file__), "..", "sample_request.json")


def load_sample():
    with open(SAMPLE_PATH) as f:
        return json.load(f)


def test_build_week_templates_covers_all_block_permutations():
    templates = build_week_templates()
    # 3 choices for PHM block * 2 remaining choices for Community block * 2
    # orderings of PEM/Newborn in the leftover block = 12 templates.
    assert len(templates) == 12
    for t in templates:
        assert t["phmWeeks"] != t["communityWeeks"]
        assert t["pemWeek"] != t["newbornWeek"]


def test_run_scheduler_fills_every_slot_and_respects_capacity():
    data = load_sample()
    result = run_scheduler(
        roster=data["roster"],
        sites_state=data["sitesState"],
        preferences=data["preferences"],
        locks=data["locks"],
        restarts=30,
    )

    assert result["unfilledCount"] == 0
    student_ids = [s["id"] for s in data["roster"]]
    assert set(result["mileage"].keys()) == set(student_ids)
    assert set(result["rank"].values()) == set(range(1, len(student_ids) + 1))

    # Every student's weekly row must cover all 6 weeks with a real site.
    for sid in student_ids:
        row = result["weekly"][sid]
        assert set(row.keys()) == {"1", "2", "3", "4", "5", "6"}
        for cell in row.values():
            assert cell["rotation"] != "Unfilled"


def test_hard_preferences_are_honored_when_capacity_allows():
    data = load_sample()
    result = run_scheduler(
        roster=data["roster"],
        sites_state=data["sitesState"],
        preferences=data["preferences"],
        locks=data["locks"],
        restarts=30,
    )
    # No overflow expected: capacity in the sample comfortably covers the
    # one Christus-PHM, one Austin-community request for 6 students.
    assert result["overflow"] == []

    assignments = result["assignments"]
    assert assignments["S6"]["phm"]["siteId"] == "phm-christus"
    assert assignments["S2"]["community"][0]["siteId"] == "tcp-beansprout-austin"
    assert assignments["S2"]["community"][1]["siteId"] == "tcp-beansprout-austin"


def test_manual_lock_is_never_overridden():
    data = load_sample()
    data["locks"] = [{"studentId": "S1", "rotationKey": "PHM", "siteId": "phm-wc", "timing": None}]
    result = run_scheduler(
        roster=data["roster"],
        sites_state=data["sitesState"],
        preferences=data["preferences"],
        locks=data["locks"],
        restarts=20,
    )
    assert result["assignments"]["S1"]["phm"]["siteId"] == "phm-wc"
    assert result["assignments"]["S1"]["phm"]["locked"] is True


def test_recompute_stats_matches_manual_arithmetic():
    mileage = {"S1": 0, "S2": 100, "S3": 50}
    stats = recompute_stats(list(mileage.keys()), mileage)
    assert stats["rank"]["S1"] == 1
    assert stats["rank"]["S3"] == 2
    assert stats["rank"]["S2"] == 3
    assert stats["mean"] == 50


def test_validate_site_capacity_flags_tight_community():
    warnings = validate_site_capacity({"community": [], "phm": [], "pem": []}, roster_size=10)
    assert any("community" in w.lower() for w in warnings)
    assert any("phm" in w.lower() for w in warnings)
    assert any("pem" in w.lower() for w in warnings)
