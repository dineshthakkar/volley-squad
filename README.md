# 🏐 Volleyball Coach

A simple, free web app for coaching a volleyball team (14–18 players):

- **Roster** — add players (name + jersey #)
- **Positions** — set each player's preferred position
- **Drill Library** — position-specific drills (editable)
- **Assign drills** — tap to assign drills to each player
- **Team Overview** — see everyone at a glance; filter by position; export / print

**Phase 1 (this version):** coach-entered, data stored in your browser (localStorage) — no server, no account, nothing leaves your device.
**Phase 2 (planned):** players self-select their own position from a shared link, synced via a free cloud database (Supabase), with change-anytime.

## Run locally
Just open `index.html` in a browser. Or serve it:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Positions
Setter · Outside Hitter · Opposite / Right Side · Middle Blocker · Libero · Defensive Specialist

## Tech
Plain HTML + CSS + JavaScript. No build step, no dependencies. Installable as a PWA.

## Hosting (free)
Deploys as a static site to **GitHub Pages** (Settings → Pages → deploy from `main` / root).

---
Personal project. Keeps only first names + jersey numbers by default — avoid storing other personal data.
