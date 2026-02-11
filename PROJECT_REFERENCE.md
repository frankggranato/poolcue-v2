# Pool Cue v2 — Complete Project Reference
## Last Updated: Feb 11, 2026

---

## WHAT THIS IS

Digital pool queue system for bars. Touchscreen board sits by the table, players join from their phones via QR code. Real-time WebSocket updates. Confirmation system for "are you still here?" when you're next up. Shot caller (king of the table) controls game type and reports wins/losses.

**Built for:** Beta testing at a real bar
**Stack:** Node.js + Express + WebSocket + PostgreSQL (Render)
**Hardware:** D5 Stick PC (Windows compute stick) + CF15T 15" portable touchscreen
**Live at:** https://pool-cue.onrender.com
**Repo:** github.com/frankggranato/poolcue-v2 (private, auto-deploys to Render)
**Local code:** /Users/frankgranato/Desktop/claude projects/PoolCue-v2/

---

## DEPLOYMENT (LIVE ON RENDER)

- Render service: pool_cue (srv-d6502a7pm1nc738njrcg), Oregon region, free tier
- Database: PostgreSQL 18 (dpg-d650ot94tr6s738sr0qg-a)
- Auto-deploy on push to main branch
- Environment vars: DATABASE_URL, BASE_URL (https://pool-cue.onrender.com), SESSION_PIN, NODE_ENV=production

---

## FILE STRUCTURE

```
PoolCue-v2/
├── server.js           — Express + WebSocket server, all API routes
├── db.js               — Database layer, Postgres + in-memory fallback
├── nicknames.js        — Pool pun name generator for random names
├── package.json
├── .env                — Environment config
├── public/
│   ├── board.html      — Touchscreen board display (wood frame aesthetic)
│   ├── status.html     — Player phone: position, confirm, shot caller controls
│   ├── join.html       — Player phone: join queue, see preview
│   ├── setup.html      — Bartender: PIN-gated session management
│   ├── kiosk.html      — One-tap kiosk setup page for stick PC
│   ├── kiosk-setup.bat — Legacy Windows kiosk script
│   ├── style.css       — Shared phone page styles (yellow/black)
│   └── favicon.svg     — 8-ball icon
└── transcripts/        — Archived session transcripts
```

---

## DESIGN SYSTEM

- **Board (board.html):** Black background, wood frame border, minimal dark aesthetic. 3-column CSS layout for queue. Shot caller name big at top left, QR code top right. Swipe-to-remove on king and challenger. Footer with "Pool Cue" branding, Undo button (left), Fullscreen button (right).
- **Phone pages:** Yellow (#f5c518) and black. Inter font. Cards, rounded inputs, toast notifications.
- **Welcome screen:** "Got Next?" + large QR (180x180) + pulsing gold CTA. Shows when no session active.
- **Empty queue state:** "First Up?" + QR code. Shows when session active but nobody signed up.
- **No emojis in queue names** — XSS-safe via `esc()` function on all user input display.

---

## KEY ARCHITECTURE DECISIONS

1. **Cookie-based phone ID** (not accounts) — `poolcue_phone` UUID cookie, 1 year expiry, httpOnly. One entry per device.
2. **No SMS** — v1 used Twilio. v2 does in-app confirmation via WebSocket push + phone tap.
3. **Position-based queue** — Integer positions, shift up/down on join/leave/result. Positions 1=king, 2=challenger, 3-4=on deck (get confirmation requests).
4. **Confirmation system:** Pos 3-4 get asked "are you here?" → 3 min to confirm → ghosted → 2 more min → removed. Checked every 30 seconds + on every queue-changing event.
5. **In-memory fallback** — No Postgres needed for local dev. `useMemory` flag in db.js, parallel code paths.
6. **Single broadcast model** — Every queue change triggers `broadcastQueueUpdate(tableCode)` which sends full queue state to all connected clients.
7. **Swipe-only game results** — No buttons on phone. Swipe king or challenger on the board to record wins/losses.
8. **Board undo without PIN** — Board sends `source: 'board'` to skip PIN check (it's physically at the table). Setup page still requires PIN.

---

## API ROUTES

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/queue/:tableCode` | None | Full queue state + my_entry |
| POST | `/api/join` | Rate limit (10/min) | Join queue |
| POST | `/api/leave` | Cookie phone ID | Leave queue |
| POST | `/api/result` | Rate limit (6/min) | Record game result |
| POST | `/api/confirm` | Cookie phone ID | Confirm presence |
| POST | `/api/undo` | PIN or source=board | Undo last elimination |
| POST | `/api/rules` | Shot caller only (pos 1) | Change game type/rules |
| POST | `/api/remove` | PIN required | Bartender removes player |
| POST | `/api/partner` | Cookie phone ID | Update partner name |
| POST | `/api/session/start` | PIN required | Start new session |
| POST | `/api/session/close` | PIN required | Close session |
| POST | `/api/debug/add-fake` | None | Add fake player for testing |
| GET | `/api/suggest-name` | None | Random pool nickname |
| GET | `/qr/:tableCode` | None | QR code PNG |

---

## BOARD FEATURES

### Welcome / Empty States
- **No session:** "Got Next?" splash with large QR code, pulsing CTA
- **Session active, empty queue:** "First Up?" with QR code, same inviting style
- **Session active, players:** Full board with queue

### Win Streak Flair (shot caller display)
- 1-2 wins: standard gold counter
- 3-4 wins: 🔥 orange, "heating up"
- 5-6 wins: 🔥 red glow + text-shadow, "ON FIRE"
- 7+ wins: 👑 gold pulse animation, "LEGENDARY"

### Animations
- Queue items: slideIn animation (0.3s ease-out) on render
- Shot caller name: flash animation when king changes
- Challenger cards: slideIn on render

### Kiosk Mode
- `/board/table1?kiosk` — shows "Tap anywhere to start" overlay, goes fullscreen on tap
- `/kiosk.html` — setup page with one big "Start Board" button
- Fullscreen button in footer (⛶ Fullscreen / ✕ Exit)
- Hidden exit: tap top-left corner 5x within 2 seconds

### Debug Panel (hidden)
- Tap "Pool Cue" footer text 5x to toggle
- Buttons: + Player, + 3 Players, King Wins, Challenger Wins, Reset Queue
- Uses `/api/debug/add-fake` endpoint with random nicknames
- For testing/demo only — invisible unless you know the tap trick

---

## PHONE FEATURES

### Join Page (join.html)
- Name input with random nickname suggestion
- Partner name field (shown in doubles mode)
- Queue preview showing current players
- Auto-creates session if none exists

### Status Page (status.html)
- Position display with role label (Shot Caller / Challenger / In Queue)
- Estimated wait time
- Confirmation button (green pulse → red urgent when ghosted)
- Ghost countdown timer
- Game Type toggle (Singles/Doubles) — shot caller only
- Rules toggle (Bar Rules/APA/BCA) — shot caller only
- Leave Queue button
- **Position change alerts:** vibration + toast when becoming:
  - #3: single buzz, "Almost up"
  - #2 (Challenger): triple buzz, "You're up next — get to the table!"
  - #1 (Shot Caller): double buzz, "You're the Shot Caller!"

---

## CONFIRMATION SYSTEM

`db.checkConfirmationTimeouts(sessionId)` runs 3 steps:
1. **RESET** — Anyone at pos 1-2 who has confirmation state gets cleaned
2. **SEND** — Pos 3-4 with no `confirmation_sent_at` get marked for confirmation
3. **TIMEOUT** — 3 min → ghost, 2 more min → remove (5 min total)

Called from: `/api/result`, `/api/join`, `/api/leave`, `/api/undo`, `/api/remove`, and every 30 seconds via `setInterval`.

---

## UNDO SYSTEM

- 60-second window after elimination
- Detects result type: `entry.position === 1` = king lost, `entry.position === 2` = challenger lost
- King-wins undo: Restore challenger to pos 2, decrement king's streak
- Challenger-wins undo: Swap back — former king to pos 1 with streak intact, former challenger to pos 2 with streak 0
- Deletes game_log entry
- Board can undo without PIN (physically at table)

---

## SECURITY

- **XSS:** `esc()` function on all pages. Server strips HTML tags on join.
- **Rate limiting:** 10 joins/min per device, 6 results/min per table
- **PIN auth:** session start/close, remove player. Setup page requires PIN for undo.
- **Shot caller auth:** `/api/rules` checks phone_id matches position 1
- **Name limits:** 24 chars max, HTML stripped

---

## HARDWARE SETUP

- **D5 Stick PC** — Windows compute stick, plugs into monitor HDMI
- **CF15T** — 15" FHD (1920x1080) touchscreen, USB-C power
- **Kiosk flow:** Open Chrome → go to pool-cue.onrender.com/kiosk.html → tap Start Board → tap screen to go fullscreen
- **Exit:** Tap top-left corner 5x, or tap ✕ Exit in footer

---

## COMPLETE BUG FIX HISTORY

### Sessions 1-6 (Feb 10, 2026)
- Full build from spec to deployment
- Board redesign to centered wood frame
- XSS protection, rate limiting, leave queue
- Confirmation system overhaul (5 interconnected bugs)
- Full audit (8 bugs found, all resolved)
- Critical undo bug: challenger-wins left king at pos 2 — complete rewrite
- Deployed to Render with PostgreSQL

### Session 7 (Feb 10-11, 2026)
- Welcome splash screen replacing dead "Table Closed" state
- Removed I Won/They Won phone buttons (swipe-only)
- Kiosk mode: fullscreen overlay, exit mechanism, setup page
- Polish: touchscreen undo (no PIN), phone alerts, animations, favicon, footer branding
- Win streak flair (3 tiers)
- Debug panel (hidden behind footer 5-tap)

---

## WHAT'S NOT BUILT YET

- Multiple tables per venue (code supports it, no UI to browse)
- Stats at end of night ("23 games, longest streak: Side Pocket x7")
- Bartender admin view (simpler than setup.html)
- Player accounts / lifetime stats / leaderboards
- Push notifications (PWA)
- Tournament mode
