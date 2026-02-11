# Pool Cue v2 — Complete Project Reference
## Last Updated: Feb 10, 2026

---

## WHAT THIS IS

Digital pool queue system for bars. Touchscreen board sits by the table, players join from their phones via QR code. Real-time WebSocket updates. Confirmation system for "are you still here?" when you're next up. Shot caller (king of the table) controls game type and reports wins/losses.

**Built for:** Beta testing at a real bar
**Stack:** Node.js + Express + WebSocket + PostgreSQL (in-memory fallback for dev)
**Hardware:** D5 Stick PC (Windows compute stick) + CF15T 15" portable touchscreen

---

## FILE STRUCTURE (8 files)

```
PoolCue-v2/
├── server.js          (487 lines) — Express + WebSocket server, all API routes
├── db.js              (732 lines) — Database layer, Postgres + in-memory fallback
├── nicknames.js       (60 lines)  — Pool pun name generator for random names
├── package.json
├── .env               — Environment config (BASE_URL, DATABASE_URL, SESSION_PIN)
└── public/
    ├── board.html      (593 lines) — Touchscreen board display (wood frame aesthetic)
    ├── status.html     (580 lines) — Player phone: position, confirm, shot caller controls
    ├── join.html       (296 lines) — Player phone: join queue, see preview
    ├── setup.html      (165 lines) — Bartender: PIN-gated session management
    └── style.css       (278 lines) — Shared phone page styles (yellow/black)
```

---

## DESIGN SYSTEM

- **Board (board.html):** Black background, wood frame border, minimal dark aesthetic. 3-column CSS layout for queue. Shot caller name big at top left, QR code top right. Swipe-to-remove on king and challenger.
- **Phone pages:** Yellow (#f5c518) and black. Inter font. Cards, rounded inputs, toast notifications.
- **No emojis in queue names** — XSS-safe via `esc()` function on all user input display.

---

## KEY ARCHITECTURE DECISIONS

1. **Cookie-based phone ID** (not accounts) — `poolcue_phone` UUID cookie, 1 year expiry, httpOnly. One entry per device.
2. **No SMS** — v1 used Twilio. v2 does in-app confirmation via WebSocket push + phone tap. Saves cost, simpler.
3. **Position-based queue** — Integer positions, shift up/down on join/leave/result. Positions 1=king, 2=challenger, 3-4=on deck (get confirmation requests).
4. **Confirmation system:** Pos 3-4 get asked "are you here?" → 3 min to confirm → ghosted → 2 more min → removed. Checked every 30 seconds + on every queue-changing event.
5. **In-memory fallback** — No Postgres needed for local dev. `useMemory` flag in db.js, parallel code paths.
6. **Single broadcast model** — Every queue change triggers `broadcastQueueUpdate(tableCode)` which sends full queue state to all connected clients.

---

## API ROUTES

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/queue/:tableCode` | None | Full queue state + my_entry |
| POST | `/api/join` | Rate limit (10/min) | Join queue |
| POST | `/api/leave` | Cookie phone ID | Leave queue |
| POST | `/api/result` | Rate limit (6/min) | Record game result |
| POST | `/api/confirm` | Cookie phone ID | Confirm presence |
| POST | `/api/undo` | PIN required | Undo last elimination |
| POST | `/api/rules` | Shot caller only (pos 1) | Change game type/rules |
| POST | `/api/remove` | PIN required | Bartender removes player |
| POST | `/api/partner` | Cookie phone ID | Update partner name |
| POST | `/api/session/start` | PIN required | Start new session |
| POST | `/api/session/close` | PIN required | Close session |
| GET | `/api/suggest-name` | None | Random pool nickname |
| GET | `/qr/:tableCode` | None | QR code PNG |

---

## CONFIRMATION SYSTEM (the trickiest part)

`db.checkConfirmationTimeouts(sessionId)` runs 3 steps:
1. **RESET** — Anyone at pos 1-2 who has confirmation state gets cleaned (they've moved up)
2. **SEND** — Pos 3-4 with no `confirmation_sent_at` get marked for confirmation
3. **TIMEOUT** — Pos 3-4 who were sent but didn't confirm: 3min → ghost, 2min more → remove

`triggerConfirmations(tableCode)` in server.js wraps this and sends targeted WebSocket messages.

**Called from:** `/api/result`, `/api/join`, `/api/leave`, `/api/undo`, `/api/remove`, and every 30 seconds via `setInterval`.

---

## UNDO SYSTEM

- 60-second window after elimination
- Detects result type: `entry.position === 1` means king lost (challenger-wins), `entry.position === 2` means challenger lost (king-wins)
- **King-wins undo:** Restore challenger to pos 2, decrement king's streak
- **Challenger-wins undo:** Swap positions back — former king returns to pos 1 with their streak intact, former challenger goes back to pos 2 with streak 0
- Deletes the game_log entry too

---

## SECURITY

- **XSS:** `esc()` function on all 3 phone pages + board. Server strips HTML tags on join.
- **Rate limiting:** 10 joins/min per device, 6 results/min per table
- **PIN auth:** `/api/undo`, `/api/remove`, `/api/session/start`, `/api/session/close`
- **Shot caller auth:** `/api/rules` checks `phone_id` matches position 1
- **Result debounce:** `resultPending` flag on status.html prevents double-tap

---

## COMPLETE BUG FIX HISTORY

### Session 1: Initial Build
- Full implementation from spec to working server

### Session 2: Board Redesign + First Audit
- Redesigned board to centered wood frame layout
- Fixed 6 bugs:
  1. join.html missing closing `</div>` tag
  2. Challenger status not showing on status.html
  3. Undo restoring wrong streak count
  4. Board PIN prompt showing on every load
  5. Status page hash not accounting for confirmation state
  6. Ghost timer using wrong timestamp

### Session 3: Security + UI
- Added XSS protection (`esc()` function) to all pages
- Added server-side HTML tag stripping
- Added rate limiting (join + result)
- Added leave queue functionality
- Redesigned confirm button (green pulse / red urgent states)
- Fixed shot caller controls disabled until challenger joins

### Session 4: Confirmation System Overhaul
- Found 5 interconnected bugs: confirmations only triggered from `/api/result`
- Rewrote `checkConfirmationTimeouts` with 3-step logic
- Added `triggerConfirmations` calls to join/leave/undo endpoints
- Simplified periodic interval to call `triggerConfirmations` every 30 seconds

### Session 5: Full Audit (8 bugs found)
- Bug 1 (Critical): `/api/remove` missing `triggerConfirmations` — FIXED
- Bug 2 (Critical): WebSocket phoneId storage — ALREADY FIXED (cookie parsing)
- Bug 3 (Medium): `/api/rules` no auth — ALREADY FIXED (shot caller check)
- Bug 4 (Medium): Double broadcast — NOT A BUG (triggerConfirmations returns bool)
- Bug 5 (Medium): WS reconnect stale state — Partially fixed (board was missing onopen)
- Bug 6 (Low): Undo dirty confirmation state — FIXED (in-memory path)
- Bug 7 (Low): Result double-tap — ALREADY FIXED (resultPending flag)
- Bug 8 (Low): Undo state lost on refresh — ACCEPTED (server validates, not critical)

### Session 6: Final Audit (this session)
- Bug 1 (Critical): **Undo after challenger-wins left king at pos 2** — FIXED. Complete rewrite of undo logic to detect result type and swap positions correctly.
- Bug 2 (Low): Duplicate `ws.onopen` handler in board.html — FIXED
- Bug 3 (Low): Duplicate confirmation field clearing in undo — FIXED (in rewrite)

---

## HARDWARE SETUP

- **D5 Stick PC** — Windows compute stick, plugs into monitor HDMI
- **CF15T** — 15" FHD (1920x1080) 60Hz portable touchscreen, 5V/3A USB-C power
- **Connectivity:** Stick PC connects to phone hotspot for internet. ngrok tunnels to public URL. Players use their own cell data.

---

## DEPLOYMENT PLAN (BAR BETA)

### One-time setup on Stick PC:
1. Install Node.js (LTS, Windows x64) from nodejs.org
2. Install ngrok from ngrok.com, create free account, add auth token
3. Copy PoolCue-v2 folder onto stick PC
4. Create launch batch script (TODO)

### At the bar:
1. Phone hotspot ON
2. Connect stick PC to hotspot
3. Run launch script → starts server + ngrok + Chrome kiosk
4. Players scan QR code on their own cell data

### Before going live:
- [ ] Set real PIN in `.env` (not 0000)
- [ ] Set `BASE_URL` to ngrok URL for QR codes
- [ ] Test touch swipe on actual hardware
- [ ] Test on multiple phone browsers (Safari, Chrome)
- [ ] Consider: what happens if ngrok disconnects mid-session?

---

## WHAT'S NOT BUILT YET (future)

- Player accounts / login
- Lifetime stats / leaderboards
- Multiple tables per venue
- Bar owner dashboard
- Postgres deployment (Render)
- Custom domains
- Push notifications (PWA)
- Spectator view
- Tournament mode
