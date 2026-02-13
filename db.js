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
  bars: [],
  ads: [],
  ad_bar_targets: [],
  ad_impressions: [],
  _idCounters: { sessions: 0, queue_entries: 0, game_log: 0, bars: 0, ads: 0, ad_bar_targets: 0, ad_impressions: 0 }
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

    CREATE TABLE IF NOT EXISTS bars (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      slug VARCHAR(50) NOT NULL UNIQUE,
      address VARCHAR(200),
      contact_name VARCHAR(100),
      contact_phone VARCHAR(30),
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ads (
      id SERIAL PRIMARY KEY,
      advertiser_name VARCHAR(100) NOT NULL,
      image_data TEXT NOT NULL,
      image_type VARCHAR(50) NOT NULL DEFAULT 'image/png',
      start_date DATE,
      end_date DATE,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ad_bar_targets (
      id SERIAL PRIMARY KEY,
      ad_id INTEGER REFERENCES ads(id) ON DELETE CASCADE,
      bar_id INTEGER REFERENCES bars(id) ON DELETE CASCADE,
      UNIQUE(ad_id, bar_id)
    );

    CREATE TABLE IF NOT EXISTS ad_impressions (
      id SERIAL PRIMARY KEY,
      ad_id INTEGER REFERENCES ads(id) ON DELETE CASCADE,
      bar_id INTEGER REFERENCES bars(id) ON DELETE CASCADE,
      shown_at TIMESTAMP DEFAULT NOW()
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

  // Log the game
  if (useMemory) {
    mem.game_log.push({
      id: nextId('game_log'), session_id: sessionId,
      winner_name: winnerName, loser_name: loserName,
      winner_streak: winnerStreak, duration_seconds: duration,
      counted_for_avg: countForAvg, ended_at: now
    });
  } else {
    await pool.query(
      `INSERT INTO game_log (session_id, winner_name, loser_name, winner_streak, duration_seconds, counted_for_avg)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sessionId, winnerName, loserName, winnerStreak, duration, countForAvg]
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
  // Find the most recently eliminated player
  let entry;
  if (useMemory) {
    const eliminated = mem.queue_entries
      .filter(e => e.session_id === sessionId && e.status === 'eliminated')
      .sort((a, b) => new Date(b.removed_at) - new Date(a.removed_at));
    entry = eliminated[0];
  } else {
    const res = await pool.query(
      `SELECT * FROM queue_entries
       WHERE session_id = $1 AND status = 'eliminated'
       ORDER BY removed_at DESC LIMIT 1`,
      [sessionId]
    );
    entry = res.rows[0];
  }

  if (!entry) return { error: 'nothing_to_undo' };

  // Only allow undo within 60 seconds
  const elapsed = (Date.now() - new Date(entry.removed_at).getTime()) / 1000;
  if (elapsed > 60) return { error: 'undo_expired' };

  const queue = await getQueue(sessionId);

  // Read game log before deleting to reverse streak
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

  // Detect which result type occurred:
  // entry.position === 1 means they were king who lost (challenger-wins)
  // entry.position === 2 means they were challenger who lost (king-wins)
  const wasKingWhoLost = entry.position === 1;
  const currentKing = queue.find(e => e.position === 1);

  // The person who was promoted to pos 2 after the result needs to be
  // displaced — the original player is being restored to that slot.
  const promotedPlayer = queue.find(e => e.position === 2);
  if (promotedPlayer) {
    if (useMemory) {
      promotedPlayer.position = 999; // temp — compactPositions will fix
    } else {
      await pool.query('UPDATE queue_entries SET position = 999 WHERE id = $1', [promotedPlayer.id]);
    }
  }

  if (useMemory) {
    if (wasKingWhoLost && currentKing) {
      // Challenger-wins undo: former king gets restored to pos 1
      currentKing.position = 2;
      currentKing.win_streak = 0;
      entry.status = 'waiting';
      entry.position = 1;
    } else {
      // King-wins undo: restore challenger to pos 2
      entry.status = 'waiting';
      entry.position = 2;
      if (currentKing && lastLog) {
        currentKing.win_streak = Math.max(0, (currentKing.win_streak || 0) - 1);
      }
    }
    entry.removed_at = null;
    entry.confirmation_sent_at = null;
    entry.confirmed_at = null;
    entry.mia_at = null;
    entry.ghosted_at = null;
  } else {
    // Restore the eliminated player first
    await pool.query(
      `UPDATE queue_entries SET status = 'waiting', removed_at = NULL,
       confirmation_sent_at = NULL, confirmed_at = NULL, mia_at = NULL, ghosted_at = NULL WHERE id = $1`,
      [entry.id]
    );

    if (wasKingWhoLost && currentKing) {
      // Former challenger (current king) → pos 2 with streak 0
      await pool.query(
        'UPDATE queue_entries SET position = 2, win_streak = 0 WHERE id = $1',
        [currentKing.id]
      );
      // Restored king → pos 1
      await pool.query('UPDATE queue_entries SET position = 1 WHERE id = $1', [entry.id]);
    } else {
      // Restored challenger → pos 2
      await pool.query('UPDATE queue_entries SET position = 2 WHERE id = $1', [entry.id]);
      // Decrement king's streak
      if (currentKing && lastLog) {
        await pool.query(
          'UPDATE queue_entries SET win_streak = GREATEST(0, win_streak - 1) WHERE id = $1',
          [currentKing.id]
        );
      }
    }
  }

  // Recompact all positions after the restored entry
  await compactPositions(sessionId);

  // Remove the game log entry too
  if (useMemory) {
    const logEntry = mem.game_log.filter(g => g.session_id === sessionId).pop();
    if (logEntry) mem.game_log = mem.game_log.filter(g => g.id !== logEntry.id);
  } else {
    await pool.query(
      'DELETE FROM game_log WHERE id = (SELECT id FROM game_log WHERE session_id = $1 ORDER BY ended_at DESC LIMIT 1)',
      [sessionId]
    );
  }

  return { success: true, restored: entry.player_name };
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

  // STEP 1: Reset confirmation state for pos 1 ONLY (king is at the table)
  // Pos 2 (challenger) KEEPS their status — king needs to see the color
  for (const entry of queue) {
    if (entry.position === 1 && (entry.status === 'confirmed' || entry.status === 'mia' || entry.status === 'ghosted' || entry.confirmation_sent_at)) {
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

  // STEP 2: Status escalation for pos 2+ who were asked
  for (const entry of queue) {
    if (entry.position < 2) continue;
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

  // STEP 3: Ask positions 2-5 to confirm (if not already asked)
  const toAsk = queue.filter(e =>
    e.position >= 2 && e.position <= 5
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
// Bar management
// ============================================

async function getBars() {
  if (useMemory) return mem.bars.filter(b => b.active);
  const res = await pool.query('SELECT * FROM bars WHERE active = true ORDER BY name');
  return res.rows;
}

async function getAllBars() {
  if (useMemory) return [...mem.bars];
  const res = await pool.query('SELECT * FROM bars ORDER BY name');
  return res.rows;
}

async function getBar(barId) {
  if (useMemory) return mem.bars.find(b => b.id === barId) || null;
  const res = await pool.query('SELECT * FROM bars WHERE id = $1', [barId]);
  return res.rows[0] || null;
}

async function getBarBySlug(slug) {
  if (useMemory) return mem.bars.find(b => b.slug === slug) || null;
  const res = await pool.query('SELECT * FROM bars WHERE slug = $1', [slug]);
  return res.rows[0] || null;
}

async function createBar(name, slug, address, contactName, contactPhone) {
  if (useMemory) {
    const bar = {
      id: nextId('bars'), name, slug, address: address || null,
      contact_name: contactName || null, contact_phone: contactPhone || null,
      active: true, created_at: new Date()
    };
    mem.bars.push(bar);
    return bar;
  }
  const res = await pool.query(
    `INSERT INTO bars (name, slug, address, contact_name, contact_phone)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [name, slug, address || null, contactName || null, contactPhone || null]
  );
  return res.rows[0];
}

async function updateBar(barId, fields) {
  const bar = await getBar(barId);
  if (!bar) return null;
  if (useMemory) {
    Object.assign(bar, fields);
    return bar;
  }
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [key, val] of Object.entries(fields)) {
    sets.push(`${key} = $${i}`);
    vals.push(val);
    i++;
  }
  vals.push(barId);
  const res = await pool.query(
    `UPDATE bars SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals
  );
  return res.rows[0];
}

// ============================================
// Ad management
// ============================================

async function getAds() {
  if (useMemory) return [...mem.ads];
  const res = await pool.query('SELECT * FROM ads ORDER BY created_at DESC');
  return res.rows;
}

async function getAd(adId) {
  if (useMemory) return mem.ads.find(a => a.id === adId) || null;
  const res = await pool.query('SELECT * FROM ads WHERE id = $1', [adId]);
  return res.rows[0] || null;
}

async function createAd(advertiserName, imageData, imageType, startDate, endDate) {
  if (useMemory) {
    const ad = {
      id: nextId('ads'), advertiser_name: advertiserName,
      image_data: imageData, image_type: imageType || 'image/png',
      start_date: startDate || null, end_date: endDate || null,
      active: true, created_at: new Date()
    };
    mem.ads.push(ad);
    return ad;
  }
  const res = await pool.query(
    `INSERT INTO ads (advertiser_name, image_data, image_type, start_date, end_date)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [advertiserName, imageData, imageType || 'image/png', startDate || null, endDate || null]
  );
  return res.rows[0];
}

async function updateAd(adId, fields) {
  const ad = await getAd(adId);
  if (!ad) return null;
  if (useMemory) {
    Object.assign(ad, fields);
    return ad;
  }
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [key, val] of Object.entries(fields)) {
    sets.push(`${key} = $${i}`);
    vals.push(val);
    i++;
  }
  vals.push(adId);
  const res = await pool.query(
    `UPDATE ads SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals
  );
  return res.rows[0];
}

async function deleteAd(adId) {
  if (useMemory) {
    mem.ads = mem.ads.filter(a => a.id !== adId);
    mem.ad_bar_targets = mem.ad_bar_targets.filter(t => t.ad_id !== adId);
    mem.ad_impressions = mem.ad_impressions.filter(i => i.ad_id !== adId);
    return true;
  }
  await pool.query('DELETE FROM ads WHERE id = $1', [adId]);
  return true;
}

// ============================================
// Ad targeting (which ads show at which bars)
// ============================================

async function setAdTargets(adId, barIds) {
  if (useMemory) {
    mem.ad_bar_targets = mem.ad_bar_targets.filter(t => t.ad_id !== adId);
    for (const barId of barIds) {
      mem.ad_bar_targets.push({ id: nextId('ad_bar_targets'), ad_id: adId, bar_id: barId });
    }
    return true;
  }
  await pool.query('DELETE FROM ad_bar_targets WHERE ad_id = $1', [adId]);
  for (const barId of barIds) {
    await pool.query('INSERT INTO ad_bar_targets (ad_id, bar_id) VALUES ($1, $2)', [adId, barId]);
  }
  return true;
}

async function getAdTargets(adId) {
  if (useMemory) return mem.ad_bar_targets.filter(t => t.ad_id === adId).map(t => t.bar_id);
  const res = await pool.query('SELECT bar_id FROM ad_bar_targets WHERE ad_id = $1', [adId]);
  return res.rows.map(r => r.bar_id);
}

async function getAdsForBar(barId) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (useMemory) {
    const targetAdIds = mem.ad_bar_targets.filter(t => t.bar_id === barId).map(t => t.ad_id);
    return mem.ads.filter(a =>
      a.active && targetAdIds.includes(a.id)
      && (!a.start_date || a.start_date <= today)
      && (!a.end_date || a.end_date >= today)
    );
  }
  const res = await pool.query(
    `SELECT a.* FROM ads a
     JOIN ad_bar_targets t ON t.ad_id = a.id
     WHERE t.bar_id = $1 AND a.active = true
       AND (a.start_date IS NULL OR a.start_date <= $2)
       AND (a.end_date IS NULL OR a.end_date >= $2)
     ORDER BY a.created_at DESC`,
    [barId, today]
  );
  return res.rows;
}

// ============================================
// Ad impressions
// ============================================

async function logImpression(adId, barId) {
  if (useMemory) {
    mem.ad_impressions.push({
      id: nextId('ad_impressions'), ad_id: adId, bar_id: barId, shown_at: new Date()
    });
    return true;
  }
  await pool.query(
    'INSERT INTO ad_impressions (ad_id, bar_id) VALUES ($1, $2)',
    [adId, barId]
  );
  return true;
}

async function getImpressionReport() {
  if (useMemory) {
    const report = {};
    for (const imp of mem.ad_impressions) {
      const key = `${imp.ad_id}-${imp.bar_id}`;
      if (!report[key]) {
        const ad = mem.ads.find(a => a.id === imp.ad_id);
        const bar = mem.bars.find(b => b.id === imp.bar_id);
        report[key] = {
          ad_id: imp.ad_id, advertiser_name: ad?.advertiser_name || 'Unknown',
          bar_id: imp.bar_id, bar_name: bar?.name || 'Unknown',
          total: 0, today: 0, this_week: 0, this_month: 0
        };
      }
      report[key].total++;
      const age = Date.now() - new Date(imp.shown_at).getTime();
      if (age < 86400000) report[key].today++;
      if (age < 604800000) report[key].this_week++;
      if (age < 2592000000) report[key].this_month++;
    }
    return Object.values(report);
  }
  const res = await pool.query(`
    SELECT a.id as ad_id, a.advertiser_name, b.id as bar_id, b.name as bar_name,
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE i.shown_at > NOW() - INTERVAL '1 day') as today,
      COUNT(*) FILTER (WHERE i.shown_at > NOW() - INTERVAL '7 days') as this_week,
      COUNT(*) FILTER (WHERE i.shown_at > NOW() - INTERVAL '30 days') as this_month
    FROM ad_impressions i
    JOIN ads a ON a.id = i.ad_id
    JOIN bars b ON b.id = i.bar_id
    GROUP BY a.id, a.advertiser_name, b.id, b.name
    ORDER BY this_week DESC
  `);
  return res.rows;
}

// ============================================
// Link bars to sessions
// ============================================

async function getBarForTableCode(tableCode) {
  // Look up bar by matching session's table_code to a bar slug
  // Convention: tableCode starts with bar slug (e.g. "flanagans" or "flanagans-2")
  if (useMemory) {
    for (const bar of mem.bars) {
      if (tableCode === bar.slug || tableCode.startsWith(bar.slug + '-')) return bar;
    }
    return null;
  }
  const res = await pool.query(
    `SELECT * FROM bars WHERE $1 = slug OR $1 LIKE slug || '-%' LIMIT 1`,
    [tableCode]
  );
  return res.rows[0] || null;
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
  // Bar management
  getBars, getAllBars, getBar, getBarBySlug, createBar, updateBar,
  // Ad management
  getAds, getAd, createAd, updateAd, deleteAd,
  // Ad targeting
  setAdTargets, getAdTargets, getAdsForBar,
  // Ad impressions
  logImpression, getImpressionReport,
  // Bar-session link
  getBarForTableCode,
  _resetMemory() {
    mem.sessions = [];
    mem.queue_entries = [];
    mem.game_log = [];
    mem.bars = [];
    mem.ads = [];
    mem.ad_bar_targets = [];
    mem.ad_impressions = [];
    mem._idCounters = { sessions: 0, queue_entries: 0, game_log: 0, bars: 0, ads: 0, ad_bar_targets: 0, ad_impressions: 0 };
  }
};
