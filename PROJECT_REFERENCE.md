# Pool Cue v2 — Complete Project Reference
## Last Updated: Feb 11, 2026

---

## WHAT THIS IS

Digital pool queue system for bars. Touchscreen board sits by the table, players join from their phones via QR code. Real-time WebSocket updates. Confirmation system proves you're still at the bar. Shot caller (king of the table) controls game type and reports wins/losses via swipe.

**Built for:** Beta testing at a real bar
**Stack:** Node.js + Express + WebSocket + PostgreSQL (Render)
**Hardware:** D5 Stick PC (Windows compute stick) + CF15T 15" portable touchscreen
**Live at:** https://pool-cue.onrender.com
**Repo:** github.com/frankggranato/poolcue-v2 (private, auto-deploys to Render)
**Local code:** /Users/frankgranato/Desktop/claude projects/PoolCue-v2/

---

## DEPLOYMENT

- Render service: pool_cue (srv-d6502a7pm1nc738njrcg), Oregon region, free tier
- Database: PostgreSQL 18 (dpg-d650ot94tr6s738sr0qg-a)
- Auto-deploy on push to main branch
- Environment vars: DATABASE_URL, BASE_URL, SESSION_PIN, NODE_ENV

---

## FILE STRUCTURE

```
PoolCue-v2/
├── server.js           — Express + WebSocket server, all API routes
├── db.js               — Database layer (Postgres + in-memory fallback)
├── nicknames.js        — Pool pun name generator
├── package.json
├── .env                — Local environment config
├── .env.example        — Template for env vars
├── .gitignore
├── kiosk-setup.bat     — Windows kiosk auto-start script
├── BUILD_PLAN.md       — Original build phases (historical)
├── PROJECT_REFERENCE.md — This file
├── public/
│   ├── board.html      — Touchscreen board display (wood frame aesthetic)
│   ├── status.html     — Player phone: position, confirm, shot caller controls
│   ├── join.html       — Player phone: join queue, see preview
│   ├── setup.html      — Bartender: PIN-gated session management
│   ├── kiosk.html      — One-tap kiosk launcher for stick PC
│   ├── style.css       — Shared phone page styles (yellow/black)
│   └── favicon.svg     — 8-ball icon
└── transcripts/        — Archived dev session transcripts
```

---

## QUEUE LOGIC (core algorithm)

### Position model
- Position 1 = **King** (shot caller, on the table)
- Position 2 = **Challenger** (playing next)
- Position 3+ = **Queue** (waiting, may be asked to confirm)

### Fair promotion (`compactPositions` in db.js)
When a game ends or someone leaves, positions compact:

1. **King (pos 1):** If empty, promote best candidate (see priority below).
2. **Challenger (pos 2):** If someone already there, keep them. If empty, promote best candidate.
3. **Remaining:** Renumber sequentially (3, 4, 5...) preserving relative order.

**Promotion priority** (when king or challenger slot opens):
1. **Confirmed** — tapped "I'm here", proven present (first in queue order)
2. **Never asked** — just joined or far back, benefit of the doubt (first in queue order)
3. **Asked but waiting** — confirmation sent, no response yet (first in queue order)
4. **Ghosted** — 3+ min unresponsive, last resort (table never sits empty)

**Key properties:**
- Confirming earns you priority over unresponsive players ahead of you
- Queue order is preserved within each priority tier
- Ghosted players keep their spot but get skipped for promotion
- If a ghosted player confirms (un-ghosts), they resume at their position
- Table never sits empty (fallback to first person if all ghosted)

### Confirmation cascade
`checkConfirmationTimeouts` keeps up to 4 people in the "asked or confirmed" pipeline:

1. **Reset** pos 1-2 confirmation state (they're already playing)
2. **Timeout check** for pos 3+: 3 min no response → ghosted, 2 more min → removed
3. **Cascade** — always ask enough people to keep 4 slots filled (asked + confirmed)

Called every 30 seconds + on every queue-changing event (join, leave, result, undo, remove).

---

## API ROUTES

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/queue/:tableCode` | None | Full queue state + my_entry |
| POST | `/api/join` | Rate limit (10/min) | Join queue |
| POST | `/api/leave` | Cookie phone ID | Leave queue |
| POST | `/api/result` | Rate limit (6/min) | Record game result (swipe) |
| POST | `/api/confirm` | Cookie phone ID | Confirm presence |
| POST | `/api/undo` | PIN or source=board | Undo last elimination (60s window) |
| POST | `/api/rules` | Shot caller (pos 1) | Change game type / rules |
| POST | `/api/remove` | PIN required | Bartender removes player |
| POST | `/api/partner` | Cookie phone ID | Update partner name |
| POST | `/api/session/start` | PIN required | Start new session |
| POST | `/api/session/close` | PIN required | Close session, clear queue |
| POST | `/api/debug/add-fake` | None | Add fake player (testing) |
| GET | `/api/suggest-name` | None | Random pool nickname |
| GET | `/qr/:tableCode` | None | QR code PNG |

---

## DESIGN

- **Board:** Black background, wood frame border, 3-column CSS layout. Shot caller name big top-left, QR code top-right. Swipe-to-remove on king/challenger.
- **Phone pages:** Yellow (#f5c518) / black. Inter font. Cards, rounded inputs, toast notifications.
- **Welcome screen:** "Got Next?" + large QR + pulsing gold CTA (no session active).
- **Empty queue:** "First Up?" + QR code (session active, nobody joined).

### Win streak flair
- 1–2 wins: gold counter
- 3–4: 🔥 orange, "heating up"
- 5–6: 🔥 red glow, "ON FIRE"
- 7+: 👑 gold pulse, "LEGENDARY"

---

## SECURITY

- **XSS:** `esc()` on all client-side display. Server strips HTML tags on join. 24-char name limit.
- **Rate limiting:** 10 joins/min per device, 6 results/min per table.
- **PIN auth:** session start/close, remove player, phone undo.
- **Board undo without PIN:** sends `source: 'board'` (physically at the table).
- **Shot caller auth:** `/api/rules` verifies phone_id matches position 1.
- **Cookie-based phone ID:** `poolcue_phone` UUID, 1-year expiry, httpOnly. One entry per device.

---

## UNDO SYSTEM

- 60-second window after elimination
- Detects result type by eliminated player's position (1 = king lost, 2 = challenger lost)
- King-wins undo: restore challenger to pos 2, decrement king streak
- Challenger-wins undo: former king back to pos 1, former challenger back to pos 2 with streak 0
- Deletes corresponding game_log entry

---

## HARDWARE

- **D5 Stick PC** — Windows compute stick, HDMI into monitor
- **CF15T** — 15" FHD (1920×1080) touchscreen, USB-C power
- **Kiosk flow:** Chrome → pool-cue.onrender.com/kiosk.html → Start Board → fullscreen
- **Exit:** Tap top-left corner 5× within 2s, or ✕ Exit in footer

### Debug panel (hidden)
Tap "Pool Cue" footer text 5× to toggle. Buttons: + Player, + 3 Players, King Wins, Challenger Wins, Reset Queue.

---

## WHAT'S NOT BUILT YET

- Multiple tables per venue (code supports it, no browse UI)
- End-of-night stats ("23 games, longest streak: Side Pocket ×7")
- Bartender admin view
- Player accounts / lifetime stats / leaderboards
- Push notifications (PWA)
- Tournament mode
