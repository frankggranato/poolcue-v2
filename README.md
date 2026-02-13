# Pool Cue v2

Digital pool queue for bars. Touchscreen board sits by the table, players join from their phones via QR code. Real-time WebSocket updates keep everyone in sync.

**Live:** https://pool-cue.onrender.com
**Stack:** Node.js · Express · WebSocket · PostgreSQL (Render)

---

## Quick Start

```bash
# Clone and install
git clone <repo-url> && cd PoolCue-v2
npm install

# Run locally (uses in-memory storage, no Postgres needed)
npm start
# → http://localhost:3000/board/table1

# Run tests
npm test
```

Copy `.env.example` to `.env` for local config. No env vars required for dev — everything has sensible defaults.

---

## File Structure

```
PoolCue-v2/
├── server.js           Express + WebSocket server, all API routes
├── db.js               Database layer (Postgres prod / in-memory dev)
├── nicknames.js        Pool pun name generator (80+ names)
├── test-queue.js       Test suite (57 tests, 431 assertions)
├── package.json
├── .env.example        Environment variable template
├── public/
│   ├── board.html      Touchscreen board (wood frame, 2-column chalkboard layout)
│   ├── status.html     Player phone: position, confirm button, controls
│   ├── join.html       Player phone: join queue, see preview
│   ├── setup.html      Bartender: PIN-gated session management
│   ├── kiosk.html      One-tap fullscreen launcher for bar hardware
│   ├── style.css       Shared phone page design system (yellow/black)
│   └── favicon.svg     8-ball icon
└── README.md           This file
```

---

## Architecture

### Pages

| URL | Purpose | Used By |
|-----|---------|---------|
| `/board/:tableCode` | Live queue display | Touchscreen at the table |
| `/join/:tableCode` | Join queue form | Player's phone (via QR) |
| `/status/:tableCode` | Position, confirm, controls | Player's phone (after join) |
| `/setup/:tableCode` | Start/close sessions | Bartender's phone |
| `/kiosk.html` | Fullscreen launcher | Bar hardware setup |

### API Routes

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/api/queue/:tableCode` | — | Full queue state + caller's entry |
| `POST` | `/api/join` | Rate limit | Join queue |
| `POST` | `/api/leave` | Phone cookie | Leave queue |
| `POST` | `/api/result` | Rate limit | Record game result (swipe) |
| `POST` | `/api/confirm` | Phone cookie | Confirm presence |
| `POST` | `/api/undo` | PIN or board | Undo last elimination (60s) |
| `POST` | `/api/rules` | Shot caller | Change game type / rules |
| `POST` | `/api/remove` | PIN | Bartender removes player |
| `POST` | `/api/partner` | Phone cookie | Update doubles partner |
| `POST` | `/api/session/start` | PIN | Start new session |
| `POST` | `/api/session/close` | PIN | Close session, clear queue |
| `POST` | `/api/debug/add-fake` | — | Add fake player (testing) |
| `GET` | `/api/suggest-name` | — | Random pool nickname |
| `GET` | `/qr/:tableCode` | — | QR code PNG image |

### Real-Time Updates

WebSocket at `/ws?table=<tableCode>`. Server broadcasts:
- `queue_update` — full queue state (on any change)
- `confirm_request` — targeted to specific phone
- `player_mia` — player went orange (5 min no response)
- `player_ghosted` — player went red (10+ min no response)
- `session_closed` — session ended

---

## Queue Logic

### Positions
- **Position 1 = King** — Shot caller, currently at the table
- **Position 2 = Challenger** — Playing next, should be at the table
- **Position 3+ = Queue** — Waiting, asked to confirm if in pos 2-5

### Pure FIFO Promotion
When a game ends or someone leaves, `compactPositions()` fires:
1. King slot empty → existing challenger auto-promotes (already at table)
2. Challenger slot empty → next in line by queue order
3. Remaining renumbered 3, 4, 5... preserving join order

Confirmation status is **informational only** — it never changes queue order. The bartender and players at the table decide who to swipe off based on the color.

### Confirmation Heat Map
Visual status system so everyone can see who's actually at the bar:

| Color | Status | Meaning | Timer |
|-------|--------|---------|-------|
| 🟢 Green | `confirmed` | Tapped "I'm here" | — |
| 🟡 Yellow | `waiting` | Just asked, give them a sec | 0–5 min |
| 🟠 Orange | `mia` | Haven't heard back | 5–10 min |
| 🔴 Red | `ghosted` | Probably left | 10+ min |

**Key behaviors:**
- Pos 2–5 are asked to confirm
- Pos 1 (king) state always reset — they're at the table
- Pos 2 (challenger) state **preserved** on promotion from pos 3+
- **No auto-removal** at any threshold — manual swipe only
- Confirming from MIA/ghosted clears the flag instantly

### Game Results
Swipe king or challenger off the board to record a result:
- **King wins** → challenger eliminated, king streak increments
- **Challenger wins** → king eliminated, challenger becomes new king with streak 1
- `compactPositions()` promotes next player to challenger
- Game logged with duration (used for wait time estimates)

### Undo
60-second window after any elimination. Reverses the game result, restores positions, decrements streaks, deletes the game log entry.

---

## Security

- **XSS:** `esc()` on all client-side renders. Server strips HTML tags, 24-char name limit.
- **Rate limiting:** 10 joins/min per device, 6 results/min per table. In-memory, cleaned every 5 min.
- **PIN auth:** Session start/close, player removal, phone undo. Board undo skips PIN (physically at the table).
- **Shot caller auth:** `/api/rules` verifies phone cookie matches position 1.
- **Phone identity:** `poolcue_phone` UUID cookie, httpOnly, 1-year expiry. One queue entry per device.

---

## Deployment (Render)

- **Service:** Web Service, Starter tier ($7/mo)
- **Database:** PostgreSQL (Render managed)
- **Auto-deploy:** Push to `main` branch
- **Env vars:** `DATABASE_URL`, `BASE_URL`, `SESSION_PIN`, `NODE_ENV`

The app auto-detects its environment:
- `DATABASE_URL` set → PostgreSQL mode (production)
- No `DATABASE_URL` → in-memory mode (local dev)
- Stale queues auto-clear after 6 hours of inactivity

---

## Hardware Setup

For bar deployment with a touchscreen:
1. Navigate to `/kiosk.html` on the bar's device
2. Enter table code, tap "Start Board"
3. Board goes fullscreen with wake lock (screen stays on)
4. Exit: tap top-left corner 5× within 2 seconds

### Debug Panel
Tap "Pool Cue" footer text 5× to toggle. Adds test buttons: +Player, +3 Players, King Wins, Challenger Wins, Reset.

---

## Testing

```bash
npm test
```

57 tests, 431 assertions. Covers:
- Join / leave / duplicate prevention
- Game results (king wins, challenger wins)
- Position compaction and FIFO ordering
- Undo system (both result types, expiry)
- Confirmation heat map (send, confirm, MIA, ghosted, recovery)
- Win streaks, avg game time, stale queue cleanup
- Edge cases (single player, empty queue, rapid operations)

Tests use the in-memory backend directly — no server needed.

---

## Future Ideas

- Multiple tables per venue (code supports it, no browse UI yet)
- End-of-night stats screen
- Bartender admin dashboard
- Player accounts / lifetime stats / leaderboards
- Push notifications (PWA)
- Tournament bracket mode
