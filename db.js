/**
 * db.js — Database layer for Pool Cue v2
 * 
 * Uses PostgreSQL in production (Render).
 * Falls back to in-memory storage for local dev (no Postgres needed).
 */

const { Pool } = require('pg');

let pool = null;
let useMemory = false;

// In-memory storage (local dev fallback)
const mem = {
  sessions: [],
  queue_entries: [],
  game_log: [],
  _idCounters: { sessions: 0, queue_entries: 0, game_log: 0 }
};

function nextId(table) {
  return ++mem._idCounters[table];
}

// ============================================
// Initialize
// ============================================

async function init() {
  if (process.env.DATABASE_URL) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });

    // Test connection
    try {
      await pool.query('SELECT NOW()');
      console.log('✅ PostgreSQL connected');
      await createTables();
    } catch (err) {
      console.error('❌ PostgreSQL failed, falling back to memory:', err.message);
      pool = null;
      useMemory = true;
    }
  } else {
    console.log('📦 No DATABASE_URL — using in-memory storage');
    useMemory = true;
  }
}

async function createTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      table_code VARCHAR(10) NOT NULL,
      pin VARCHAR(10) NOT NULL DEFAULT '0000',
      game_type VARCHAR(10) NOT NULL DEFAULT 'singles',
      rule_type VARCHAR(20) NOT NULL DEFAULT 'bar_rules',
      status VARCHAR(10) NOT NULL DEFAULT 'active',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS queue_entries (
      id SERIAL PRIMARY KEY,
      session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
      player_name VARCHAR(24) NOT NULL,
      partner_name VARCHAR(24),
      position INTEGER NOT NULL,
      phone_id VARCHAR(64),
      status VARCHAR(20) NOT NULL DEFAULT 'waiting',
      win_streak INTEGER DEFAULT 0,
      confirmation_sent_at TIMESTAMP,
      confirmed_at TIMESTAMP,
      mia_at TIMESTAMP,
      ghosted_at TIMESTAMP,
      joined_at TIMESTAMP DEFAULT NOW(),
      removed_at TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS game_log (
      id SERIAL PRIMARY KEY,
      session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
      winner_name VARCHAR(24),
      loser_name VARCHAR(24),
      winner_streak INTEGER,
      duration_seconds INTEGER,
      counted_for_avg BOOLEAN DEFAULT true,
      ended_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // Migration: add mia_at column if missing (added after initial deploy)
  const colCheck = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'queue_entries' AND column_name = 'mia_at'
  `);
  if (colCheck.rows.length === 0) {
    await pool.query('ALTER TABLE queue_entries ADD COLUMN mia_at TIMESTAMP');
    console.log('✅ Migration: added mia_at column');
  }

  // Migration: drop UNIQUE on table_code (allows multiple sessions per table)
  // Replace with partial unique index (only one ACTIVE session per table)
  const uniqueCheck = await pool.query(`
    SELECT constraint_name FROM information_schema.table_constraints
    WHERE table_name = 'sessions' AND constraint_type = 'UNIQUE'
      AND constraint_name = 'sessions_table_code_key'
  `);
  if (uniqueCheck.rows.length > 0) {
    await pool.query('ALTER TABLE sessions DROP CONSTRAINT sessions_table_code_key');
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS sessions_active_table_code
      ON sessions (table_code) WHERE status = 'active'
    `);
    // Clean up old closed sessions that were blocking
    await pool.query("DELETE FROM sessions WHERE status = 'closed'");
    console.log('✅ Migration: fixed table_code unique constraint');
  }

  // Migration: add queue_snapshot column to game_log (for true undo)
  const snapCheck = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'game_log' AND column_name = 'queue_snapshot'
  `);
  if (snapCheck.rows.length === 0) {
    await pool.query('ALTER TABLE game_log ADD COLUMN queue_snapshot JSONB');
    console.log('✅ Migration: added queue_snapshot column to game_log');
  }

  console.log('✅ Tables ready');
}

// ============================================
// Session queries
// ============================================

async function getSession(tableCode) {
  if (useMemory) {
    return mem.sessions.find(s => s.table_code === tableCode && s.status === 'active') || null;
  }
  const res = await pool.query(
    'SELECT * FROM sessions WHERE table_code = $1 AND status = $2',
    [tableCode, 'active']
  );
  return res.rows[0] || null;
}

async function createSession(tableCode, pin, gameType, ruleType) {
  // Close any existing active session for this table
  if (useMemory) {
    mem.sessions.forEach(s => {
      if (s.table_code === tableCode && s.status === 'active') s.status = 'closed';
    });
    const session = {
      id: nextId('sessions'), table_code: tableCode, pin,
      game_type: gameType || 'singles', rule_type: ruleType || 'bar_rules',
      status: 'active', created_at: new Date()
    };
    mem.sessions.push(session);
    return session;
  }
  await pool.query(
    'UPDATE sessions SET status = $1 WHERE table_code = $2 AND status = $3',
    ['closed', tableCode, 'active']
  );
  const res = await pool.query(
    `INSERT INTO sessions (table_code, pin, game_type, rule_type)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [tableCode, pin, gameType || 'singles', ruleType || 'bar_rules']
  );
  return res.rows[0];
}

async function closeSession(tableCode) {
  if (useMemory) {
    const s = mem.sessions.find(s => s.table_code === tableCode && s.status === 'active');
    if (s) s.status = 'closed';
    // Clear queue entries and game log for this session
    if (s) {
      mem.queue_entries = mem.queue_entries.filter(e => e.session_id !== s.id);
      mem.game_log = mem.game_log.filter(g => g.session_id !== s.id);
    }
    return s;
  }
  const session = await getSession(tableCode);
  if (!session) return null;
  await pool.query('DELETE FROM game_log WHERE session_id = $1', [session.id]);
  await pool.query('DELETE FROM queue_entries WHERE session_id = $1', [session.id]);
  await pool.query('UPDATE sessions SET status = $1 WHERE id = $2', ['closed', session.id]);
  return session;
}

async function updateRules(tableCode, gameType, ruleType) {
  const session = await getSession(tableCode);
  if (!session) return null;
  if (useMemory) {
    if (gameType) session.game_type = gameType;
    if (ruleType) session.rule_type = ruleType;
    return session;
  }
  const res = await pool.query(
    `UPDATE sessions SET game_type = COALESCE($1, game_type), rule_type = COALESCE($2, rule_type)
     WHERE id = $3 RETURNING *`,
    [gameType, ruleType, session.id]
  );
  return res.rows[0];
}

// ============================================
// Queue queries
// ============================================

async function getQueue(sessionId) {
  if (useMemory) {
    return mem.queue_entries
      .filter(e => e.session_id === sessionId && !['eliminated', 'removed'].includes(e.status))
      .sort((a, b) => a.position - b.position);
  }
  const res = await pool.query(
    `SELECT * FROM queue_entries
     WHERE session_id = $1 AND status NOT IN ('eliminated', 'removed')
     ORDER BY position ASC`,
    [sessionId]
  );
  return res.rows;
}

async function addToQueue(sessionId, playerName, partnerName, phoneId) {
  // Check duplicate phone
  if (phoneId) {
    const existing = useMemory
      ? mem.queue_entries.find(e => e.session_id === sessionId && e.phone_id === phoneId
          && !['eliminated', 'removed'].includes(e.status))
      : (await pool.query(
          `SELECT id FROM queue_entries WHERE session_id = $1 AND phone_id = $2
           AND status NOT IN ('eliminated', 'removed')`,
          [sessionId, phoneId]
        )).rows[0];
    if (existing) return { error: 'already_in_queue' };
  }

  // Get next position
  const queue = await getQueue(sessionId);
  const nextPos = queue.length > 0 ? Math.max(...queue.map(e => e.position)) + 1 : 1;

  if (useMemory) {
    const entry = {
      id: nextId('queue_entries'), session_id: sessionId,
      player_name: playerName, partner_name: partnerName || null,
      position: nextPos, phone_id: phoneId || null,
      status: 'waiting', win_streak: 0,
      confirmation_sent_at: null, confirmed_at: null, mia_at: null, ghosted_at: null,
      joined_at: new Date(), removed_at: null
    };
    mem.queue_entries.push(entry);
    return entry;
  }

  const res = await pool.query(
    `INSERT INTO queue_entries (session_id, player_name, partner_name, position, phone_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [sessionId, playerName, partnerName || null, nextPos, phoneId || null]
  );
  return res.rows[0];
}

// ============================================
// Position compaction — ensures positions are always 1, 2, 3, ...
// Pure FIFO: next in line gets promoted, confirmation doesn't affect order
// ============================================

async function compactPositions(sessionId) {
  const queue = await getQueue(sessionId);
  if (queue.length === 0) return;

  // Sort by current position, then by join time to break ties (concurrent adds get same position)
  const sorted = [...queue].sort((a, b) => a.position - b.position || new Date(a.joined_at) - new Date(b.joined_at) || a.id - b.id);

  // === PURE FIFO PROMOTION ===
  // Queue order is king. Confirmation is informational only (helps bartender
  // see who's here). It never changes who gets promoted.

  // STEP 1: Ensure king at position 1
  let king = sorted.find(e => e.position === 1);
  let newKing = false;
  if (!king) {
    // Existing challenger auto-promotes, otherwise first in line
    const existingPos2 = sorted.find(e => e.position === 2);
    king = existingPos2 || sorted[0];
    newKing = true;
  }
  await setPosition(king.id, 1);
  if (newKing) await resetConfirmationState(king.id);

  const others = sorted.filter(e => e !== king);
  if (others.length === 0) return;

  // STEP 2: Ensure challenger at position 2
  const existingChallenger = others.find(e => e.position === 2);
  let challenger;
  if (existingChallenger) {
    challenger = existingChallenger;
  } else {
    challenger = others[0]; // Pure FIFO — next in line
    // DON'T reset confirmation state — king needs to see the challenger's status color
  }
  await setPosition(challenger.id, 2);

  // STEP 3: Renumber remaining 3, 4, 5...
  const remaining = others.filter(e => e !== challenger);
  let pos = 3;
  for (const entry of remaining) {
    await setPosition(entry.id, pos);
    pos++;
  }
}

async function setPosition(entryId, position) {
  if (useMemory) {
    const entry = mem.queue_entries.find(e => e.id === entryId);
    if (entry) entry.position = position;
  } else {
    await pool.query('UPDATE queue_entries SET position = $1 WHERE id = $2', [position, entryId]);
  }
}

async function resetConfirmationState(entryId) {
  if (useMemory) {
    const entry = mem.queue_entries.find(e => e.id === entryId);
    if (entry) {
      entry.status = 'waiting';
      entry.confirmation_sent_at = null;
      entry.confirmed_at = null;
      entry.mia_at = null;
      entry.ghosted_at = null;
    }
  } else {
    await pool.query(
      `UPDATE queue_entries SET status = 'waiting', confirmation_sent_at = NULL,
       confirmed_at = NULL, mia_at = NULL, ghosted_at = NULL WHERE id = $1`,
      [entryId]
    );
  }
}

async function recordResult(sessionId, result) {
  // result: 'king-wins' or 'challenger-wins'
  const queue = await getQueue(sessionId);
  if (queue.length < 2) return { error: 'need_two_players' };

  const king = queue.find(e => e.position === 1);
  const challenger = queue.find(e => e.position === 2);
  if (!king || !challenger) return { error: 'need_two_players' };

  // Snapshot the FULL queue state before making any changes.
  // This enables true undo — restore to exact previous state.
  const queueSnapshot = queue.map(e => ({
    id: e.id,
    position: e.position,
    status: e.status,
    win_streak: e.win_streak || 0,
    confirmation_sent_at: e.confirmation_sent_at || null,
    confirmed_at: e.confirmed_at || null,
    mia_at: e.mia_at || null,
    ghosted_at: e.ghosted_at || null,
  }));

  // Calculate game duration for avg timer
  const lastGame = useMemory
    ? [...mem.game_log].filter(g => g.session_id === sessionId).pop()
    : (await pool.query(
        'SELECT ended_at FROM game_log WHERE session_id = $1 ORDER BY ended_at DESC LIMIT 1',
        [sessionId]
      )).rows[0];

  const now = new Date();
  const duration = lastGame
    ? Math.floor((now - new Date(lastGame.ended_at)) / 1000)
    : 0;
  const countForAvg = duration >= 90; // Filter cleanup swipes

  let winnerName, loserName, winnerStreak;

  if (result === 'king-wins') {
    winnerName = king.player_name;
    loserName = challenger.player_name;
    winnerStreak = (king.win_streak || 0) + 1;

    // King stays at pos 1 with incremented streak, challenger eliminated
    if (useMemory) {
      king.win_streak = winnerStreak;
      challenger.status = 'eliminated';
      challenger.removed_at = now;
    } else {
      await pool.query('UPDATE queue_entries SET win_streak = $1 WHERE id = $2', [winnerStreak, king.id]);
      await pool.query(
        `UPDATE queue_entries SET status = 'eliminated', removed_at = NOW() WHERE id = $1`,
        [challenger.id]
      );
    }
  } else {
    // Challenger wins — king eliminated, challenger becomes new king
    winnerName = challenger.player_name;
    loserName = king.player_name;
    winnerStreak = 1;

    if (useMemory) {
      king.status = 'eliminated';
      king.removed_at = now;
      challenger.position = 1;
      challenger.win_streak = winnerStreak;
      challenger.status = 'waiting';
    } else {
      await pool.query(
        `UPDATE queue_entries SET status = 'eliminated', removed_at = NOW() WHERE id = $1`,
        [king.id]
      );
      await pool.query(
        'UPDATE queue_entries SET position = 1, win_streak = $1, status = $2 WHERE id = $3',
        [winnerStreak, 'waiting', challenger.id]
      );
    }
  }

  // Compact positions — this handles promotion of next ready player to challenger
  // and renumbers everyone sequentially
  await compactPositions(sessionId);

  // Log the game (with snapshot for undo)
  if (useMemory) {
    mem.game_log.push({
      id: nextId('game_log'), session_id: sessionId,
      winner_name: winnerName, loser_name: loserName,
      winner_streak: winnerStreak, duration_seconds: duration,
      counted_for_avg: countForAvg, ended_at: now,
      queue_snapshot: queueSnapshot
    });
  } else {
    await pool.query(
      `INSERT INTO game_log (session_id, winner_name, loser_name, winner_streak, duration_seconds, counted_for_avg, queue_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [sessionId, winnerName, loserName, winnerStreak, duration, countForAvg, JSON.stringify(queueSnapshot)]
    );
  }

  return { success: true, winner: winnerName, loser: loserName, streak: winnerStreak };
}

async function getAvgGameTime(sessionId) {
  if (useMemory) {
    const games = mem.game_log.filter(g => g.session_id === sessionId && g.counted_for_avg && g.duration_seconds > 0);
    if (games.length === 0) return null;
    const recent = games.slice(-5);
    const avg = recent.reduce((sum, g) => sum + g.duration_seconds, 0) / recent.length;
    return Math.round(avg);
  }
  const res = await pool.query(
    `SELECT AVG(duration_seconds)::integer as avg_seconds
     FROM (SELECT duration_seconds FROM game_log
           WHERE session_id = $1 AND counted_for_avg = true AND duration_seconds > 0
           ORDER BY ended_at DESC LIMIT 5) recent`,
    [sessionId]
  );
  return res.rows[0]?.avg_seconds || null;
}

async function undoLastRemoval(sessionId) {
  // TRUE UNDO: Restore the queue to the exact state before the last game result.
  // Uses the snapshot saved in the game log — no reverse-engineering needed.

  // 1. Get the last game log entry (has the snapshot)
  let lastLog;
  if (useMemory) {
    lastLog = [...mem.game_log].filter(g => g.session_id === sessionId).pop();
  } else {
    const logRes = await pool.query(
      'SELECT * FROM game_log WHERE session_id = $1 ORDER BY ended_at DESC LIMIT 1',
      [sessionId]
    );
    lastLog = logRes.rows[0];
  }

  if (!lastLog) return { error: 'nothing_to_undo' };

  // Snapshots kept for 12 hours — if no snapshot, it's been cleaned up
  const snapshot = lastLog.queue_snapshot;
  if (!snapshot || snapshot.length === 0) return { error: 'nothing_to_undo' };

  const snapshotIds = new Set(snapshot.map(e => e.id));
  const maxSnapshotPos = Math.max(...snapshot.map(e => e.position));

  // 4. Restore every entry in the snapshot to its exact previous state
  for (const snap of snapshot) {
    if (useMemory) {
      // Find the entry (could be active or eliminated — search ALL entries)
      const entry = mem.queue_entries.find(e => e.id === snap.id && e.session_id === sessionId);
      if (entry) {
        entry.position = snap.position;
        entry.status = snap.status;
        entry.win_streak = snap.win_streak;
        entry.confirmation_sent_at = snap.confirmation_sent_at;
        entry.confirmed_at = snap.confirmed_at;
        entry.mia_at = snap.mia_at;
        entry.ghosted_at = snap.ghosted_at;
        entry.removed_at = null; // all snapshot entries were active
      }
    } else {
      await pool.query(
        `UPDATE queue_entries SET position = $1, status = $2, win_streak = $3,
         confirmation_sent_at = $4, confirmed_at = $5, mia_at = $6, ghosted_at = $7,
         removed_at = NULL
         WHERE id = $8 AND session_id = $9`,
        [snap.position, snap.status, snap.win_streak,
         snap.confirmation_sent_at, snap.confirmed_at, snap.mia_at, snap.ghosted_at,
         snap.id, sessionId]
      );
    }
  }

  // 5. Handle players who joined AFTER the game result (not in snapshot).
  //    Keep them but place after the restored queue.
  let nextPos = maxSnapshotPos + 1;
  if (useMemory) {
    const newJoins = mem.queue_entries.filter(e =>
      e.session_id === sessionId && !snapshotIds.has(e.id)
      && !['eliminated', 'removed'].includes(e.status)
    ).sort((a, b) => a.position - b.position);
    for (const entry of newJoins) {
      entry.position = nextPos++;
    }
  } else {
    const newRes = await pool.query(
      `SELECT id FROM queue_entries WHERE session_id = $1
       AND id != ALL($2) AND status NOT IN ('eliminated', 'removed')
       ORDER BY position ASC`,
      [sessionId, Array.from(snapshotIds)]
    );
    for (const row of newRes.rows) {
      await pool.query('UPDATE queue_entries SET position = $1 WHERE id = $2', [nextPos++, row.id]);
    }
  }

  // 6. Delete the game log entry
  if (useMemory) {
    mem.game_log = mem.game_log.filter(g => g.id !== lastLog.id);
  } else {
    await pool.query('DELETE FROM game_log WHERE id = $1', [lastLog.id]);
  }

  return { success: true, restored: lastLog.loser_name };
}

async function leaveQueue(sessionId, phoneId) {
  if (useMemory) {
    const entry = mem.queue_entries.find(e =>
      e.session_id === sessionId && e.phone_id === phoneId
      && !['eliminated', 'removed'].includes(e.status)
    );
    if (!entry) return { error: 'not_in_queue' };
    entry.status = 'removed';
    entry.removed_at = new Date();
  } else {
    const res = await pool.query(
      `SELECT * FROM queue_entries WHERE session_id = $1 AND phone_id = $2
       AND status NOT IN ('eliminated', 'removed') LIMIT 1`,
      [sessionId, phoneId]
    );
    const entry = res.rows[0];
    if (!entry) return { error: 'not_in_queue' };
    await pool.query(
      `UPDATE queue_entries SET status = 'removed', removed_at = NOW() WHERE id = $1`,
      [entry.id]
    );
  }
  // Recompact positions (handles promotion of next ready player)
  await compactPositions(sessionId);
  return { success: true };
}

async function confirmPresence(sessionId, phoneId) {
  if (useMemory) {
    const entry = mem.queue_entries.find(e =>
      e.session_id === sessionId && e.phone_id === phoneId
      && !['eliminated', 'removed'].includes(e.status)
    );
    if (!entry) return { error: 'not_in_queue' };

    entry.status = 'confirmed';
    entry.confirmed_at = new Date();
    entry.mia_at = null;
    entry.ghosted_at = null;
    return { success: true, name: entry.player_name, position: entry.position };
  }

  const res = await pool.query(
    `SELECT * FROM queue_entries WHERE session_id = $1 AND phone_id = $2
     AND status NOT IN ('eliminated', 'removed') LIMIT 1`,
    [sessionId, phoneId]
  );
  const entry = res.rows[0];
  if (!entry) return { error: 'not_in_queue' };

  await pool.query(
    `UPDATE queue_entries SET status = 'confirmed', confirmed_at = NOW(), mia_at = NULL, ghosted_at = NULL WHERE id = $1`,
    [entry.id]
  );
  return { success: true, name: entry.player_name, position: entry.position };
}

async function sendConfirmation(sessionId, entryId) {
  // Mark that we've asked this player to confirm
  if (useMemory) {
    const entry = mem.queue_entries.find(e => e.id === entryId);
    if (entry) entry.confirmation_sent_at = new Date();
    return;
  }
  await pool.query(
    'UPDATE queue_entries SET confirmation_sent_at = NOW() WHERE id = $1',
    [entryId]
  );
}

async function miaPlayer(sessionId, entryId) {
  if (useMemory) {
    const entry = mem.queue_entries.find(e => e.id === entryId);
    if (entry) {
      entry.status = 'mia';
      entry.mia_at = new Date();
    }
    return;
  }
  await pool.query(
    `UPDATE queue_entries SET status = 'mia', mia_at = NOW() WHERE id = $1`,
    [entryId]
  );
}

async function ghostPlayer(sessionId, entryId) {
  if (useMemory) {
    const entry = mem.queue_entries.find(e => e.id === entryId);
    if (entry) {
      entry.status = 'ghosted';
      entry.ghosted_at = new Date();
    }
    return;
  }
  await pool.query(
    `UPDATE queue_entries SET status = 'ghosted', ghosted_at = NOW() WHERE id = $1`,
    [entryId]
  );
}

async function removePlayer(sessionId, entryId) {
  // Hard remove (timeout or PIN-based bartender removal)
  if (useMemory) {
    const entry = mem.queue_entries.find(e => e.id === entryId);
    if (!entry) return { error: 'not_found' };
    entry.status = 'removed';
    entry.removed_at = new Date();
  } else {
    const res = await pool.query('SELECT * FROM queue_entries WHERE id = $1', [entryId]);
    const entry = res.rows[0];
    if (!entry) return { error: 'not_found' };
    await pool.query(
      `UPDATE queue_entries SET status = 'removed', removed_at = NOW() WHERE id = $1`,
      [entry.id]
    );
  }
  // Recompact positions
  await compactPositions(sessionId);
  return { success: true };
}

async function checkConfirmationTimeouts(sessionId) {
  // === CONFIRMATION HEAT MAP ===
  // Visual status system — everyone can see who's here at a glance.
  // 🟢 Confirmed — "I'm here" (tapped confirm)
  // 🟡 Waiting — just asked, give them a sec (0-5 min)
  // 🟠 MIA — haven't heard back (5-10 min)
  // 🔴 Probably left — likely gone (10+ min)
  // No auto-removal. Players at the table swipe when someone's red.
  const queue = await getQueue(sessionId);
  const now = Date.now();
  const actions = [];

  // STEP 1: Reset confirmation state for pos 1-2 (they're at the table playing)
  for (const entry of queue) {
    if (entry.position <= 2 && (entry.status === 'confirmed' || entry.status === 'mia' || entry.status === 'ghosted' || entry.confirmation_sent_at)) {
      if (useMemory) {
        entry.status = 'waiting';
        entry.confirmation_sent_at = null;
        entry.confirmed_at = null;
        entry.mia_at = null;
        entry.ghosted_at = null;
      } else {
        await pool.query(
          `UPDATE queue_entries SET status = 'waiting', confirmation_sent_at = NULL, confirmed_at = NULL, mia_at = NULL, ghosted_at = NULL WHERE id = $1`,
          [entry.id]
        );
      }
    }
  }

  // STEP 2: Status escalation for pos 3+ who were asked (pos 1-2 at table)
  for (const entry of queue) {
    if (entry.position < 3) continue;
    if (entry.status === 'confirmed' || entry.status === 'ghosted') continue;
    if (!entry.confirmation_sent_at) continue;

    const elapsed = (now - new Date(entry.confirmation_sent_at).getTime()) / 1000;

    if (entry.status === 'mia' && elapsed >= 600) {
      // 10 min total → probably left (red)
      await ghostPlayer(sessionId, entry.id);
      actions.push({ action: 'ghosted', name: entry.player_name, id: entry.id });
    } else if (entry.status === 'waiting' && elapsed >= 300) {
      // 5 min → MIA (orange)
      await miaPlayer(sessionId, entry.id);
      actions.push({ action: 'mia', name: entry.player_name, id: entry.id });
    }
  }

  // STEP 3: Ask positions 3-5 to confirm (if not already asked)
  // Pos 1-2 are at the table, no need to ask them
  const toAsk = queue.filter(e =>
    e.position >= 3 && e.position <= 5
    && e.status === 'waiting' && !e.confirmation_sent_at
  ).sort((a, b) => a.position - b.position);

  for (const entry of toAsk) {
    await sendConfirmation(sessionId, entry.id);
    actions.push({
      action: 'confirmation_sent',
      name: entry.player_name,
      id: entry.id,
      phone_id: entry.phone_id,
      position: entry.position
    });
  }

  // Cleanup: null out snapshots older than 12 hours
  // Keeps game_log for stats but frees the JSONB storage
  if (useMemory) {
    const cutoff = new Date(Date.now() - 12 * 60 * 60 * 1000);
    for (const g of mem.game_log) {
      if (g.queue_snapshot && new Date(g.ended_at) < cutoff) g.queue_snapshot = null;
    }
  } else {
    await pool.query(
      `UPDATE game_log SET queue_snapshot = NULL
       WHERE session_id = $1 AND queue_snapshot IS NOT NULL AND ended_at < NOW() - INTERVAL '12 hours'`,
      [sessionId]
    );
  }

  return actions;
}

async function updatePartnerName(sessionId, phoneId, partnerName) {
  if (useMemory) {
    const entry = mem.queue_entries.find(e =>
      e.session_id === sessionId && e.phone_id === phoneId
      && !['eliminated', 'removed'].includes(e.status)
    );
    if (entry) entry.partner_name = partnerName || null;
    return entry;
  }
  const res = await pool.query(
    `UPDATE queue_entries SET partner_name = $1
     WHERE session_id = $2 AND phone_id = $3 AND status NOT IN ('eliminated', 'removed')
     RETURNING *`,
    [partnerName || null, sessionId, phoneId]
  );
  return res.rows[0];
}

// Auto-create a default session if one doesn't exist for this table
async function ensureSession(tableCode, pin) {
  let session = await getSession(tableCode);
  if (!session) {
    session = await createSession(tableCode, pin || process.env.SESSION_PIN || '0000', 'singles', 'bar_rules');
  }
  return session;
}

// Auto-clear queue if no activity in 6+ hours
const STALE_THRESHOLD = 6 * 60 * 60 * 1000; // 6 hours in ms
async function clearStaleQueue(sessionId) {
  const queue = await getQueue(sessionId);
  if (queue.length === 0) return false;

  // Find most recent activity: latest join or latest game
  let lastActivity = 0;
  for (const entry of queue) {
    const joined = new Date(entry.joined_at).getTime();
    if (joined > lastActivity) lastActivity = joined;
  }

  // Check game log too
  let lastGame;
  if (useMemory) {
    lastGame = [...mem.game_log].filter(g => g.session_id === sessionId).pop();
  } else {
    const res = await pool.query(
      'SELECT ended_at FROM game_log WHERE session_id = $1 ORDER BY ended_at DESC LIMIT 1',
      [sessionId]
    );
    lastGame = res.rows[0];
  }
  if (lastGame) {
    const ended = new Date(lastGame.ended_at).getTime();
    if (ended > lastActivity) lastActivity = ended;
  }

  if (Date.now() - lastActivity < STALE_THRESHOLD) return false;

  // Stale — clear all entries
  if (useMemory) {
    mem.queue_entries = mem.queue_entries.filter(e => e.session_id !== sessionId);
  } else {
    await pool.query('DELETE FROM queue_entries WHERE session_id = $1', [sessionId]);
  }
  return true;
}

// ============================================
// Exports
// ============================================

module.exports = {
  init,
  getSession,
  createSession,
  closeSession,
  updateRules,
  getQueue,
  addToQueue,
  recordResult,
  getAvgGameTime,
  undoLastRemoval,
  leaveQueue,
  confirmPresence,
  removePlayer,
  checkConfirmationTimeouts,
  updatePartnerName,
  ensureSession,
  clearStaleQueue,
  _resetMemory() {
    mem.sessions = [];
    mem.queue_entries = [];
    mem.game_log = [];
    mem._idCounters = { sessions: 0, queue_entries: 0, game_log: 0 };
  }
};
