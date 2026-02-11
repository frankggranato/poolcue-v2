# Pool Cue v2 — Build Plan

## Project Overview
Digital pool queue for bars. Touchscreen on the wall shows the board. Players scan a QR code with their phone to join. King-of-the-hill format — winner stays, loser gets swiped off, next person steps up.

## Tech Stack
- **Backend:** Node.js + Express + WebSocket (ws)
- **Database:** PostgreSQL (Render free tier)
- **Frontend:** Vanilla HTML/CSS/JS (no framework)
- **Hosting:** Render.com (free tier)
- **Display:** Windows touchscreen running Chrome in kiosk mode

## File Structure
```
PoolCue-v2/
├── server.js              ← Express + WebSocket + API routes (~400 lines)
├── db.js                  ← PostgreSQL setup & queries (~150 lines)
├── nicknames.js           ← Pool pun name generator (~80 lines)
├── package.json
├── .env                   ← DATABASE_URL, PORT, SESSION_PIN
├── .gitignore
├── public/
│   ├── board.html         ← Touchscreen display (wood frame design)
│   ├── join.html          ← Phone: scan QR → enter name → join
│   ├── status.html        ← Phone: live position, confirm, shot caller controls
│   ├── setup.html         ← PIN-protected session start/reset
│   └── style.css          ← Yellow/black phone design system
├── BUILD_PLAN.md          ← This file
└── README.md
```

Total: ~8 real files, target ~1200 lines of code.

---

## Build Phases

### Phase 1: Foundation (server + database + basic board)
**Goal:** Server runs, database connected, board shows on screen.

1. `package.json` — dependencies (express, ws, pg, dotenv, qrcode)
2. `.env` — local dev config
3. `db.js` — database connection + table creation + core queries
4. `server.js` — Express setup, WebSocket, static files, health check
5. `public/board.html` — board display with hardcoded test data (layout only)
6. `public/style.css` — yellow/black phone design tokens

**Test:** `npm start` → browser shows the board at localhost:3000

### Phase 2: Join Flow (QR code + phone join page)
**Goal:** QR code on board works. Phone can join the queue.

1. QR code generation endpoint (dynamic, points to /join/{table_code})
2. `public/join.html` — name input, partner input (if doubles), join button
3. API: `POST /api/join` — adds player to queue
4. API: `GET /api/queue/:tableCode` — returns current queue data
5. Nickname generator — "suggest a name" button
6. localStorage name pre-fill
7. One-per-phone enforcement (cookie)
8. Board auto-updates via WebSocket when someone joins

**Test:** Scan QR with phone → enter name → board updates in real time

### Phase 3: Game Flow (swipe, results, queue advancement)
**Goal:** Games can be played and recorded.

1. Swipe gesture on board (positions 1-2 only)
2. Confirm tap after swipe ("Confirm?")
3. API: `POST /api/result` — king-wins or challenger-wins
4. Queue advancement logic (everyone shifts up)
5. Win streak counter (increment on king win, reset on new king)
6. Game log recording (for avg timer)
7. Average game timer display (filters <90s swipes)
8. Undo functionality (hidden, long-press corner)
9. Shot caller phone controls: "I Won" / "Challenger Won"
10. WebSocket broadcast on every state change

**Test:** Full game cycle — join, play, swipe, next person up

### Phase 4: Confirmation System
**Goal:** Positions 3-4 must confirm they're present.

1. Trigger confirmation when someone enters position 3 or 4
2. Phone status page shows big "I'M HERE" button + vibration
3. Board shows ✓ Ready / ⏳ Waiting next to positions 3-4
4. Ghost state: 3 min no response → grey+red border, skipped in queue
5. Ghost recovery: confirm within 5 min total → back to position
6. Full removal: 5 min no response → removed from board, phone notified
7. When ghosted player is skipped, next confirmed person plays
8. Server-side timeout checker (runs every 30 seconds)

**Test:** Join as #3, ignore confirmation → get ghosted → confirm late → recover

### Phase 5: Session Management + Rules
**Goal:** Bar can start/close sessions, shot caller sets rules.

1. `public/setup.html` — PIN entry → start session (pick singles/doubles + rule type)
2. API: `POST /api/session/start` — creates session with PIN
3. API: `POST /api/session/close` — closes session, clears board
4. Shot caller phone: game type selector (singles/doubles)
5. Shot caller phone: rule type selector (bar rules/APA/BCA)
6. API: `POST /api/rules` — updates session rules
7. Board displays current rules as tags
8. Doubles mode: partner name input appears on join page
9. Mode switch notification to all phones in queue
10. "Table Closed" display state
11. Long-press any name + PIN to remove (bartender tool)

**Test:** Start session → play games → switch to doubles → close session

### Phase 6: Deploy to Render
**Goal:** Live on the internet, accessible from any phone.

1. Create Render account (render.com)
2. Create PostgreSQL database (free tier)
3. Create Web Service (free tier, Node.js)
4. Connect to Git repo
5. Set environment variables (DATABASE_URL, SESSION_PIN)
6. Deploy and test with real URL
7. Set up custom domain (optional, later)

**Test:** QR code points to live URL → phone joins from cell data

### Phase 7: Touchscreen Setup
**Goal:** Windows touchscreen shows the board permanently.

1. Install Chrome on Windows device
2. Create shortcut: `chrome.exe --kiosk https://your-app.onrender.com/board/{table_code}`
3. Set to auto-start on boot
4. Disable Windows sleep/screensaver
5. Test touch gestures (swipe, tap)

---

## Database Schema

```sql
-- A "night" on one table
CREATE TABLE sessions (
    id SERIAL PRIMARY KEY,
    table_code VARCHAR(10) UNIQUE NOT NULL,    -- permanent per physical table, used in QR URL
    pin VARCHAR(10) NOT NULL DEFAULT '0000',
    game_type VARCHAR(10) NOT NULL DEFAULT 'singles',  -- singles/doubles
    rule_type VARCHAR(20) NOT NULL DEFAULT 'bar_rules', -- bar_rules/apa/bca
    status VARCHAR(10) NOT NULL DEFAULT 'active',       -- active/closed
    created_at TIMESTAMP DEFAULT NOW()
);

-- Everyone in the queue
CREATE TABLE queue_entries (
    id SERIAL PRIMARY KEY,
    session_id INTEGER REFERENCES sessions(id),
    player_name VARCHAR(24) NOT NULL,
    partner_name VARCHAR(24),              -- null if singles or solo signup
    position INTEGER NOT NULL,
    phone_id VARCHAR(64),                  -- browser fingerprint for duplicate prevention
    status VARCHAR(20) NOT NULL DEFAULT 'waiting',
        -- waiting: in queue
        -- confirmed: tapped "I'M HERE"
        -- on_table: currently playing (position 1 or 2)
        -- ghosted: missed confirmation window
        -- eliminated: swiped off after losing
        -- removed: left voluntarily or timed out
    win_streak INTEGER DEFAULT 0,
    confirmation_sent_at TIMESTAMP,        -- when we pinged their phone
    confirmed_at TIMESTAMP,
    ghosted_at TIMESTAMP,                  -- when they went grey
    joined_at TIMESTAMP DEFAULT NOW(),
    removed_at TIMESTAMP
);

-- Every completed game (for avg timer + future stats)
CREATE TABLE game_log (
    id SERIAL PRIMARY KEY,
    session_id INTEGER REFERENCES sessions(id),
    winner_name VARCHAR(24),
    loser_name VARCHAR(24),
    winner_streak INTEGER,                 -- streak at time of win
    duration_seconds INTEGER,              -- time since last game ended
    counted_for_avg BOOLEAN DEFAULT true,  -- false if <90 seconds
    ended_at TIMESTAMP DEFAULT NOW()
);
```

## API Endpoints

### Queue
- `GET  /api/queue/:tableCode` — full queue state (board + phones poll this)
- `POST /api/join` — join the queue { tableCode, playerName, partnerName?, phoneId }
- `POST /api/leave` — leave queue { tableCode, phoneId }
- `POST /api/confirm` — confirm presence { tableCode, phoneId }

### Game Results
- `POST /api/result` — record game outcome { tableCode, result: 'king-wins'|'challenger-wins' }
- `POST /api/undo` — undo last removal { tableCode, pin }

### Session
- `POST /api/session/start` — start new session { tableCode, pin, gameType, ruleType }
- `POST /api/session/close` — close session { tableCode, pin }
- `POST /api/rules` — update rules { tableCode, gameType?, ruleType? }
- `POST /api/remove` — remove any player by name { tableCode, pin, entryId }

### Utility
- `GET  /api/suggest-name` — random pool pun nickname
- `GET  /qr/:tableCode` — generates QR code image

## Design System (Phone Pages)

```css
/* Yellow/Black — used on ALL phone-facing pages */
--bg-primary: #111111;
--bg-secondary: #1a1a1a;
--bg-tertiary: #222222;
--text-primary: #f2f2f2;
--text-secondary: #888888;
--text-muted: #555555;
--accent: #f5c518;        /* Pool Cue yellow */
--success: #22c55e;
--warning: #f97316;
--danger: #ef4444;
--border: rgba(255,255,255,0.08);
--font: 'Inter', -apple-system, sans-serif;
```

## Anti-Cheat Summary
1. Swipe only on positions 1-2 (can't mess with the queue)
2. Confirm tap after every swipe (no accidental removes)
3. One entry per phone (cookie-based)
4. Undo button (hidden, for mistakes)
5. PIN required for: reset board, close session, remove any player
6. Confirmation system auto-cleans AFK players
7. <90 second games filtered from avg timer (cleanup swipes)

## Future (NOT in beta)
- Player accounts + login
- Stats, leaderboards, ELO ranking
- Ranked matches
- Ad system in board footer
- Multiple bars management
- Native iOS/Android app
- Push notifications
- Social features (friends, challenges)
- Tournament mode
- Bar owner dashboard + analytics
