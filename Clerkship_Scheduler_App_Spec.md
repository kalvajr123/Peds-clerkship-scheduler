# Pediatric Clerkship Scheduler — Build Spec for Claude Code

## Overview
A single-page web app (client-side only, no backend, no database) that helps a
pediatric clerkship coordinator assign ~30 students to a 6-week term across
four rotation types — PHM, Community Pediatrics, PEM, and Newborn — while
balancing total driving mileage as evenly as possible across students.

**Tech stack:** React + Vite, single-page app, everything runs in the browser.
No server, no persistence between sessions beyond an optional "save/load
project as JSON" file so the coordinator can pause and resume.

**Libraries:**
- `papaparse` — CSV import
- `xlsx` (SheetJS) — Excel export
- A small local string-similarity function for fuzzy name matching (no need
  for an external dependency — Levenshtein distance is ~20 lines)

**Data privacy note:** since this may contain student names, nothing should
be sent to any server or third-party API. Everything stays in the browser.

---

## Step-by-step wizard flow

### Step 1 — Term Setup & Roster
- Input: term start date (date picker).
  - Validate it's a Monday. If not, show a warning: "Term start date is not a
    Monday — please confirm this is correct" but allow proceeding if the
    coordinator confirms.
  - Auto-generate 6 sequential week date ranges (Mon–Sun, except week 6 may
    be shorter, e.g. Mon–Fri, matching the pattern in the sample data) and
    display them for confirmation: "Week 1: 07/06–07/12", etc.
- Input: student roster — CSV upload (one column of names) or a textarea to
  paste one name per line.
- Output: assign each student an anonymized ID (S1, S2, ... in upload order).
  Store a Student Key (ID ↔ Name) that is never shown on the same screen as
  the schedule/mileage views — keep it on its own tab/screen.

### Step 2 — Site Directory

**Fixed rotation structures (pre-loaded defaults, editable):**
- **PHM:** Main Campus (distance 0, capacity editable, 6 days/week), West
  Campus/Katy (distance per day editable, default 25, capacity editable,
  5 days/week), Christus Children's (distance 0, capacity editable, opt-in).
- **PEM:** TCH Main Campus (distance 0, capacity editable, groups/slots per
  week), West Campus/Katy (distance per day editable, default 25, 4 days at
  WC + 1 day at Main, so weekly distance = 4×25 + 1×0), Woodlands (distance
  per day editable, default 39, same 4+1 day split), Christus (distance 0).
- **Newborn:** TCH Newborn, Ben Taub Newborn, Ben Taub NICU — all distance 0,
  capacity in pairs, purely used to fill schedule gaps (never affects
  mileage balance).

**Community sites (fully coordinator-configured per term):**
- Load the full master list of community sites + preceptors + one-way
  distance (pre-populated from historical data, editable/addable).
- For each site, the coordinator:
  1. Checks "available this term?"
  2. Selects which of the 6 individual weeks it's open (not locked to
     2-week blocks — a site can be open in week 3 only, or weeks 2 and 5,
     etc.)
  3. Sets capacity (# students) **per week** (a site might take 1 student in
     week 1 and 2 in week 2).
  4. Flags "subspecialty / 1-week-max" sites (e.g. TCH Rheum, GI, Pulm
     consult services). A student assigned here can only use it for ONE of
     their two community weeks — the algorithm must assign their other
     community week to a different, non-subspecialty site.
- Christus (community) and Austin sites get the same weekly capacity
  treatment, since those slots are also limited.

### Step 3 — Preferences (coordinator-entered, open text)
Free-text boxes mirroring the actual intake email, one per question:
1. "Which students speak Spanish?"
2. "Which students want Christus, and for which sub-rotation(s)? (PHM /
   Community / PEM — list all that apply per student)"
3. "Which students want Austin (community only)?"
4. "Which students want Katy for PHM?"
5. "Which students want Katy for PEM?"
6. "Which students want Woodlands for PEM?"

For each box: parse comma/newline-separated names, fuzzy-match against the
roster (Levenshtein or similar), and show a confirmation screen listing any
names that didn't match cleanly so the coordinator can fix typos before
continuing. Store the **order names were entered** — this is the
first-come-first-served priority order used later if a special site's
capacity is oversubscribed.

### Step 4 — Manual Locks (optional)
A searchable table: pick a student, pick a rotation (PHM/Community
week 1/Community week 2/PEM), pick a specific site, and lock it. These
assignments are treated as fixed inputs and excluded from all optimization.

### Step 5 — Generate Schedule
One button. Runs the balancing algorithm (below). Show a progress
indicator since it does hundreds of restarts.

### Step 6 — Results
- **Schedule tab:** full grid, student (by ID) × week, showing assigned
  site per week.
- **Mileage Summary tab:** rank (1 = lowest), total mileage, z-score,
  flag if |z| > 1.5 (adjustable threshold).
- **Student Key tab:** ID ↔ name (kept separate so the other two tabs are
  safe to share/screen-share without exposing names).
- Inline manual override: click any cell to reassign; mileage/rank/z-score
  recalculate live.
- "Export to Excel" button — produces a `.xlsx` with exactly these three
  tabs, matching the format already in use:
  - `Term Distances` (or similar): Student ID, then Site/Distance pairs per
    week (W1 Site, W1 Distance, W2 Site, W2 Distance, ... W6 Site, W6
    Distance), then Total Distance (as a formula summing the distance
    columns, not a hardcoded value).
  - `Student Key`: Student ID, Student Name.
  - `Mileage Summary`: Student ID, Total Distance, Rank, Z-Score, Flag —
    with the same conditional formatting (red = high outlier, yellow = low
    outlier).
- "Save Project as JSON" / "Load Project from JSON" — lets the coordinator
  pause and resume without losing roster/site/preference data, since there's
  no backend persistence.

---

## Balancing Algorithm

**Inputs:** roster, site directory (with weekly capacity), hard preference
list (in FCFS entry order), manual locks.

**Step A — Assign hard preferences, honoring capacity + FCFS order.**
For each special request category (Christus-PHM, Christus-Community,
Christus-PEM, Austin-Community, Katy-PHM, Katy-PEM, Woodlands-PEM), go
through requesting students **in the order their names were entered** and
assign them the site until capacity for that week/block is full. Anyone who
requested but didn't get a slot (overflow) should be clearly listed in the
output as "requested but not assigned — needs coordinator follow-up,"
sorted by request order so it's obvious who was next in line.

**Step B — Apply manual locks** as additional fixed assignments.

**Step C — Greedy fill of everything still open**, rotation type by
rotation type, in this order: PHM blocks → PEM weeks → Community weeks
(Community last, since it has the most site options and gives the
algorithm the finest resolution to smooth out whatever imbalance PHM/PEM
already created).
- For each open slot, sort still-unassigned-for-that-slot students by
  their *running mileage total so far* (ascending).
- Assign the highest-mileage remaining open site to whoever currently has
  the lowest running total.
- Respect the subspecialty 1-week-max rule: if a student's first community
  week lands on a subspecialty site, their second community week must be
  drawn from non-subspecialty options only.
- Respect Spanish-language requirements if any site is marked as requiring
  a Spanish speaker (only assign Spanish-speaking students there).

**Step D — Local-search cleanup.** Repeatedly scan all pairs of *unlocked*
assignments within the same rotation type (so capacity/eligibility stays
valid) and swap any two if it reduces overall variance in total mileage
across all students. Continue until no swap improves variance.

**Step E — Random restart.** Repeat Steps C–D a few hundred times with
shuffled tie-breaking order among equal-mileage students, and keep the
lowest-variance result found. This is computationally trivial at ~30
students and avoids getting stuck in a mediocre local optimum.

**Output:** final assignment grid + mileage totals + list of any
FCFS-overflow requests that need manual follow-up.

---

## UI/UX notes
- Keep it simple and utilitarian — this is an internal tool for one
  coordinator, not a polished consumer product. Clear tables, clear buttons,
  no unnecessary flourish.
- Every step should be revisitable — a "back" option to edit site
  availability or preferences without losing later work, recalculating
  downstream steps as needed.
- Validate as you go: flag obviously impossible states early (e.g. total
  community capacity across all weeks less than needed for the roster
  size) rather than failing silently at generation time.
