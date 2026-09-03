# Clerkship Scheduler Balancer — Azure Function

A standalone Python Azure Function that ports the mileage-balancing
algorithm from `src/lib/scheduler.js` (the React app's client-side
scheduler) into a backend HTTP service. It exists so a PowerApps rebuild
of the coordinator tool has somewhere to send the actual optimization
work — Power Fx isn't a realistic place to implement a random-restart
local-search algorithm, but PowerApps can call an HTTP function.

The port aims for **behavioral parity** with the original: same step
order (manual locks → hard preferences → greedy fill → local-search
swaps → random restart), same tie-break rules, same PRNG (`mulberry32`,
ported bit-for-bit). See `scheduler.py` — every function is commented with
a pointer back to the JS it was ported from. `Clerkship_Scheduler_App_Spec.md`
at the repo root is the original design spec and is still the best plain-English
description of *why* the algorithm works this way.

## What's here

```
azure-function/
  function_app.py        HTTP-triggered endpoints (Azure Functions Python v2 model)
  scheduler.py            The ported algorithm — pure Python, no Azure dependency
  host.json               Function host config
  requirements.txt        Just azure-functions
  local.settings.json.sample   Copy to local.settings.json for local dev
  sample_request.json     A small (6-student) example payload for GenerateSchedule
  openapi.yaml             OpenAPI 3 spec — import this into PowerApps to build the custom connector
  tests/test_scheduler.py  Smoke tests (invariants: capacity respected, locks honored, etc.)
```

`scheduler.py` has no Azure imports at all — it's a plain module, so it's
also usable directly from a script or a different host if PowerApps
ends up not being the final home.

## Endpoints

| Method | Route               | Auth       | Purpose |
|--------|---------------------|------------|---------|
| POST   | `/api/GenerateSchedule` | function key | Run the full balancing algorithm, return the schedule |
| POST   | `/api/RecomputeStats`   | function key | Recompute rank/z-score after a manual grid edit |
| POST   | `/api/ValidateCapacity` | function key | Step-2-style capacity sanity-check warnings |
| GET    | `/api/Health`           | anonymous    | Liveness check |

### `POST /api/GenerateSchedule`

Request body:

```jsonc
{
  "roster": [{ "id": "S1", "name": "Jane Doe" }, ...],
  "sitesState": {
    "christusHousingCap": 3,
    "phm": [ /* PHM site objects */ ],
    "pem": [ /* PEM site objects */ ],
    "newborn": [ /* Newborn site objects */ ],
    "community": [ /* Community site objects */ ]
  },
  "preferences": {
    "spanish": { "order": ["S1", "S3"] },
    "christus": { "order": ["S6"], "entries": { "S6": ["PHM", "Community"] } },
    "austin": { "order": ["S2"] },
    "katyPHM": { "order": [] },
    "katyPEM": { "order": [] },
    "woodlandsPEM": { "order": [] }
  },
  "locks": [
    { "studentId": "S1", "rotationKey": "PHM", "siteId": "phm-wc", "timing": null }
  ],
  "restarts": 200
}
```

See `sample_request.json` for a complete, runnable example, and
`src/data/defaultSites.json` at the repo root for the full production site
directory shape (that's exactly what should go in `sitesState.phm` /
`.pem` / `.newborn` / `.community`).

**Site fields, per rotation type** (unrecognized/extra fields are ignored):

- **PHM / PEM**: `id`, `name`, `distancePerDay`, `daysPerWeek` (PHM) or
  `daysAtSite` (PEM, when the weekly distance isn't just `distancePerDay
  * daysPerWeek` — e.g. 4 days at a satellite campus + 1 at Main),
  `weeksOpen` (array of week numbers 1–6 the site is open), `capacityByWeek`
  (object, **string** week keys → integer capacity), optionally
  `primaryCapacityByWeek` (PHM only — a lower "fill first" capacity before
  overflowing into the full `capacityByWeek`).
- **Newborn**: `id`, `name`, flat `capacity` (same every week, no
  `weeksOpen`/`capacityByWeek` — newborn never affects mileage).
- **Community**: `id`, `name`, `distance`, `available` (bool — unavailable
  sites are dropped entirely), `weeksOpen`, `capacityByWeek`,
  `isSubspecialty` (bool — a student can only use ONE of their two
  community weeks at a subspecialty site), `isAustin` (bool — opt-in only,
  see below), `requiresSpanish` (bool — only Spanish-speaking students,
  per the `spanish` preference list, can be placed there).
- Three site ids are treated as **opt-in only** and are never touched by
  greedy-fill or local-search — reachable only via an explicit hard
  preference or manual lock: `phm-christus`, `pem-christus`,
  `christus-community`. Any community site with `isAustin: true` gets the
  same opt-in treatment. Keep these ids as-is if you're using the
  production site directory; if you rename them, update
  `SPECIAL_SITE_IDS` / `SAN_ANTONIO_SITE_IDS` / `is_opt_in_only` in
  `scheduler.py` to match.

**`preferences`** mirrors the original app's free-text intake boxes,
already parsed into student-id order (fuzzy name matching against the
roster is a client-side/PowerApps-side concern — this function only sees
ids). Order matters: within each category, requests are granted
first-come-first-served against capacity; anyone who doesn't fit shows up
in the response's `overflow` list, in request order, for coordinator
follow-up. The `christus` category is special — one request box covering
three sub-rotations — so it carries an `entries` map of which
sub-rotation(s) (`"PHM"`, `"Community"`, `"PEM"`) each student asked for,
in addition to `order`.

**`locks`** are fixed assignments applied before optimization and never
touched afterward. `rotationKey` is one of `PHM`, `PEM`, `Community1`,
`Community2`, `Newborn`. `timing` optionally pins *when* the rotation
happens, independent of site — for `PHM`/`Community1`/`Community2` it's a
**block index 0–2** (into the three fixed 2-week blocks `[1,2]`, `[3,4]`,
`[5,6]`); for `PEM`/`Newborn` it's a **raw week number 1–6**. Leave it
`null`/omit it to let the algorithm pick timing freely.

Response body (see `build_result` in `scheduler.py`):

```jsonc
{
  "templates": { "S1": { "phmWeeks": [1,2], "communityWeeks": [3,4], "pemWeek": 5, "newbornWeek": 6 }, ... },
  "assignments": { "S1": { "phm": {...}, "pem": {...}, "community": [{...}, {...}], "newborn": {...} }, ... },
  "weekly": { "S1": { "1": { "rotation": "PHM", "siteId": "phm-main", "siteName": "PHM Main Campus", "distance": 0 }, "2": {...}, ... }, ... },
  "mileage": { "S1": 87.5, ... },
  "rank": { "S1": 4, ... },
  "zScore": { "S1": -0.32, ... },
  "mean": 92.1,
  "std": 41.7,
  "overflow": [ { "category": "austin", "studentId": "S9", "order": 2 } ],
  "variance": 1738.9,
  "unfilledCount": 0
}
```

`weekly` is exactly what a schedule-grid screen wants: student → week
number (as a string key, 1–6) → the site/rotation/distance for that week.
`unfilledCount` should be 0 in any term where site capacity actually
covers the roster; if it isn't, run `/api/ValidateCapacity` first to see
why (usually community capacity is short).

### `POST /api/RecomputeStats`

For the "click a cell, override it, mileage/rank/z-score update live"
interaction from the original app's results screen. Send the full,
possibly-edited mileage map; get back mean/std/rank/zScore. This is O(n
log n), essentially instant.

### `POST /api/ValidateCapacity`

Body: `{ "sitesState": {...}, "rosterSize": 30 }`. Returns `{ "warnings":
[...] }` — plain-English strings, or an empty array if capacity looks
fine. Same three checks as the original Step 2 UI: total community
capacity vs. `rosterSize * 2`, PHM seat-weeks vs. `rosterSize * 2`, PEM
seat-weeks vs. `rosterSize`.

## Running locally

Requires [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local)
and Python 3.10+ (matches the Azure Functions Python worker's supported
range).

```bash
cd azure-function
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp local.settings.json.sample local.settings.json
func start
```

Then, in another terminal:

```bash
curl -s -X POST http://localhost:7071/api/GenerateSchedule \
  -H "Content-Type: application/json" \
  -d @sample_request.json | python3 -m json.tool
```

(Local runs skip the function-key check, so no `?code=` is needed.)

Run the smoke tests any time without starting the function host at all —
`scheduler.py` is plain Python:

```bash
pip install pytest
python3 -m pytest tests/ -v
```

## Deploying to Azure

Simplest path, once you have an Azure subscription and the [Azure CLI](https://learn.microsoft.com/cli/azure/):

```bash
az login
az group create -n clerkship-scheduler-rg -l centralus
az storage account create -n clerkschedstorage -g clerkship-scheduler-rg -l centralus --sku Standard_LRS
az functionapp create \
  -g clerkship-scheduler-rg \
  --consumption-plan-location centralus \
  --runtime python --runtime-version 3.11 \
  --functions-version 4 \
  -n <globally-unique-function-app-name> \
  -s clerkschedstorage

cd azure-function
func azure functionapp publish <globally-unique-function-app-name>
```

Or use the [Azure Functions extension for VS Code](https://marketplace.visualstudio.com/items?itemName=ms-azuretools.vscode-azurefunctions)
("Deploy to Function App…" on this folder) if you'd rather click than
type. Either way, grab the function key afterward from the portal
(Function App → Functions → *FunctionName* → Function Keys) — PowerApps
needs it.

## Wiring this into PowerApps

1. Deploy the function (above) and copy its base URL, e.g.
   `https://clerkship-scheduler.azurewebsites.net/api`.
2. In `openapi.yaml`, replace the placeholder `servers.url` with your real
   base URL.
3. In Power Apps (make.powerapps.com) → **Custom connectors** → **New
   custom connector** → **Import an OpenAPI file** → upload `openapi.yaml`.
4. On the **Security** step, choose **API Key**, parameter name `code`,
   location **Query** — that's the function key. (Function-key auth is the
   default here; switch to Azure AD/Easy Auth instead if your org requires
   it — that's a Function App setting, not a code change.)
5. Create the connector, then create a **connection** using the actual key
   value from the portal.
6. In your PowerApp: **Data** → add the connection → call it from Power Fx,
   e.g.:
   ```
   Set(
     varResult,
     ClerkshipSchedulerBalancer.GenerateSchedule(
       {
         roster: rosterCollection,
         sitesState: sitesStateRecord,
         preferences: preferencesRecord,
         locks: locksCollection,
         restarts: 200
       }
     )
   )
   ```
   Power Apps' generated connector call returns the JSON body as a
   dynamic/untyped object — use `ParseJSON` or the connector's own response
   schema (edit it in the custom connector's **Definition** tab if you want
   typed columns instead of `additionalProperties: true`) to project into a
   gallery.

### A note on data privacy

The original app's design spec calls out that student data should never
leave the browser. Running the algorithm server-side changes that — the
roster now transits the network and is processed on an Azure VM (yours,
but still a server). To keep the same privacy posture as the original app:

- Send only anonymized ids (`S1`, `S2`, …) in `roster` — the function never
  needs real names to compute anything, they're accepted purely for
  pass-through convenience. Keep the ID ↔ name key in a separate Dataverse
  table / PowerApps screen, exactly like the original app's separate
  "Student Key" tab.
- Restrict the Function App's network access (e.g. IP restrictions, or put
  it behind a VNet/Private Endpoint) if BCM's policies require it for
  anything touching student records, even de-identified ones.
- Turn off Application Insights request-body logging (it's off by default
  in `host.json` here for `Request` telemetry) so payloads don't linger in
  Log Analytics.

## Differences from the original JS version (intentional)

- No `onProgress` callback / incremental UI updates — a single HTTP call
  runs all restarts synchronously and returns the final result. At ~30
  students and 200 restarts this takes a few seconds (verified locally);
  keep `restarts` under a few hundred if you're on a very large roster, to
  stay well inside your Function plan's request timeout (Consumption
  plan's HTTP gateway caps a single call around 230s regardless of
  `host.json`'s `functionTimeout`).
- `restarts` is clamped server-side to `[1, 2000]` (`MAX_RESTARTS` in
  `function_app.py`) so a stray typo in a PowerApps flow can't trigger an
  unbounded run.
- `RecomputeStats` and `ValidateCapacity` are new endpoints, not present in
  the original — they expose `recomputeStats`/`validateSiteCapacity` from
  `scheduler.js`, which existed as internal helpers, as their own callable
  functions since PowerApps needs *something* to call for those two
  interactions (live mileage recompute after a manual override; Step 2
  capacity warnings) instead of running JS in the browser.

Everything else — template assignment, hard-preference FCFS ordering,
greedy-fill order and tie-breaking, the PHM/community local-search swaps
(and PEM's deliberate *exclusion* from local search), the opt-in-only
Christus/Austin handling, San Antonio shared-housing capacity — is a
direct port.
