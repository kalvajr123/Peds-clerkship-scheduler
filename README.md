# Pediatric Clerkship Scheduler

A client-side-only web app that helps a pediatric clerkship coordinator assign
students to a 6-week term across PHM, Community Pediatrics, PEM, and Newborn
rotations while balancing total driving mileage as evenly as possible.

Everything runs in the browser — there is no backend and no database.
Student data never leaves the browser except when you explicitly export an
Excel file or save a project JSON file.

See `Clerkship_Scheduler_App_Spec.md` for the full functional spec this app
implements.

## Getting started

```bash
npm install
npm run dev
```

Then open the printed local URL in your browser.

## Wizard flow

1. **Term Setup & Roster** — pick the term start date and load the student
   roster (CSV upload or paste).
2. **Site Directory** — PHM/PEM/Newborn structure and the full community site
   list are pre-loaded from `src/data/defaultSites.json`. Each term, just
   toggle availability, weeks open, and per-week capacity for community
   sites.
3. **Preferences** — free-text boxes for Spanish speakers, Christus,
   Austin, and Katy/Woodlands requests, fuzzy-matched against the roster.
4. **Manual Locks** — pin specific student/rotation/site combinations before
   generating.
5. **Generate** — runs the balancing algorithm (hard preferences → manual
   locks → greedy fill → local-search cleanup → random restarts).
6. **Results** — Schedule, Mileage Summary, and Student Key tabs, with
   inline manual overrides and an "Export to Excel" button that produces a
   `.xlsx` with Term Distances / Student Key / Mileage Summary sheets
   (including red/yellow outlier highlighting).

## Building

```bash
npm run build
```
