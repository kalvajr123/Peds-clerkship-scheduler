"""
Standalone Azure Function App exposing the clerkship scheduler's balancing
algorithm over HTTP, so a rebuild of the coordinator tool (e.g. in
PowerApps) can call it as a backend instead of re-implementing the
algorithm in Power Fx.

Endpoints:
  POST /api/GenerateSchedule   Runs the full random-restart balancing
                                algorithm and returns the assignment grid,
                                mileage totals, rank/z-score, and any
                                FCFS-overflow requests.
  POST /api/RecomputeStats     Recomputes rank/z-score from a mileage map —
                                used after a coordinator manually overrides
                                a cell in the results grid.
  POST /api/ValidateCapacity   Aggregate capacity sanity checks (same as the
                                original app's Step 2 validation warnings).
  GET  /api/Health             Anonymous liveness check.

See README.md in this folder for request/response JSON shapes and how to
wire this up as a PowerApps custom connector.
"""

import json
import logging

import azure.functions as func

from scheduler import recompute_stats, run_scheduler, validate_site_capacity

app = func.FunctionApp()

MAX_RESTARTS = 2000
DEFAULT_RESTARTS = 200


def _json_response(payload, status_code: int = 200) -> func.HttpResponse:
    return func.HttpResponse(json.dumps(payload), mimetype="application/json", status_code=status_code)


def _json_error(message: str, status_code: int = 400) -> func.HttpResponse:
    return _json_response({"error": message}, status_code)


def _parse_body(req: func.HttpRequest):
    try:
        body = req.get_json()
    except ValueError:
        return None, _json_error("Request body must be valid JSON.")
    if not isinstance(body, dict):
        return None, _json_error("Request body must be a JSON object.")
    return body, None


@app.route(route="GenerateSchedule", methods=["POST"], auth_level=func.AuthLevel.FUNCTION)
def GenerateSchedule(req: func.HttpRequest) -> func.HttpResponse:
    body, err = _parse_body(req)
    if err:
        return err

    roster = body.get("roster")
    sites_state = body.get("sitesState")
    preferences = body.get("preferences") or {}
    locks = body.get("locks") or []
    restarts = body.get("restarts", DEFAULT_RESTARTS)

    if not isinstance(roster, list) or not roster:
        return _json_error("`roster` must be a non-empty array of {id, name} objects.")
    if not all(isinstance(s, dict) and s.get("id") for s in roster):
        return _json_error("Every roster entry needs a string `id`.")
    if not isinstance(sites_state, dict):
        return _json_error("`sitesState` must be an object with phm/pem/newborn/community site arrays.")
    if not isinstance(preferences, dict):
        return _json_error("`preferences` must be an object keyed by preference category.")
    if not isinstance(locks, list):
        return _json_error("`locks` must be an array of lock objects.")
    try:
        restarts = int(restarts)
    except (TypeError, ValueError):
        return _json_error("`restarts` must be an integer.")
    restarts = max(1, min(restarts, MAX_RESTARTS))

    try:
        result = run_scheduler(
            roster=roster,
            sites_state=sites_state,
            preferences=preferences,
            locks=locks,
            restarts=restarts,
        )
    except Exception:
        logging.exception("GenerateSchedule failed")
        return _json_error(
            "Scheduler failed while running — check the request body shape against README.md.", 500
        )

    return _json_response(result)


@app.route(route="RecomputeStats", methods=["POST"], auth_level=func.AuthLevel.FUNCTION)
def RecomputeStats(req: func.HttpRequest) -> func.HttpResponse:
    body, err = _parse_body(req)
    if err:
        return err

    mileage = body.get("mileage")
    if not isinstance(mileage, dict) or not mileage:
        return _json_error("`mileage` must be a non-empty object mapping studentId -> total mileage.")

    student_ids = body.get("studentIds") or list(mileage.keys())
    if not isinstance(student_ids, list):
        return _json_error("`studentIds`, if provided, must be an array of student ids.")

    try:
        mileage_numeric = {sid: float(mileage[sid]) for sid in student_ids}
    except (KeyError, TypeError, ValueError):
        return _json_error("`mileage` must contain a numeric value for every id in `studentIds`.")

    result = recompute_stats(student_ids, mileage_numeric)
    return _json_response(result)


@app.route(route="ValidateCapacity", methods=["POST"], auth_level=func.AuthLevel.FUNCTION)
def ValidateCapacity(req: func.HttpRequest) -> func.HttpResponse:
    body, err = _parse_body(req)
    if err:
        return err

    sites_state = body.get("sitesState")
    roster_size = body.get("rosterSize")
    if not isinstance(sites_state, dict):
        return _json_error("`sitesState` must be an object with phm/pem/community site arrays.")
    try:
        roster_size = int(roster_size)
    except (TypeError, ValueError):
        return _json_error("`rosterSize` must be an integer.")

    warnings = validate_site_capacity(sites_state, roster_size)
    return _json_response({"warnings": warnings})


@app.route(route="Health", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def Health(req: func.HttpRequest) -> func.HttpResponse:
    return _json_response({"status": "ok"})
