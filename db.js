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
      table_code VARCHAR(10) UNIQUE NOT NULL,
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
    // Clear queue entries for this session
    mem.queue_entries = mem.queue_entries.filter(e => !s || e.session_id !== s.id);
    return s;
  }
  const session = await getSession(tableCode);
  if (!session) return null;
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
      confirmation_sent_at: null, confirmed_at: null, ghosted_at: null,
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

    // King stays, challenger eliminated, everyone shifts up
    if (useMemory) {
      king.win_streak = winnerStreak;
      challenger.status = 'eliminated';
      challenger.removed_at = now;
      // Shift everyone up
      mem.queue_entries.filter(e =>
        e.session_id === sessionId && e.position > 2
        && !['eliminated', 'removed'].includes(e.status)
      ).forEach(e => { e.position -= 1; });
    } else {
      await pool.query('UPDATE queue_entries SET win_streak = $1 WHERE id = $2', [winnerStreak, king.id]);
      await pool.query(
        `UPDATE queue_entries SET status = 'eliminated', removed_at = NOW() WHERE id = $1`,
        [challenger.id]
      );
      await pool.query(
        `UPDATE queue_entries SET position = position - 1
         WHERE session_id = $1 AND position > 2 AND status NOT IN ('eliminated', 'removed')`,
        [sessionId]
      );
    }
  } else {
    // Challenger wins — king eliminated, challenger becomes king
    winnerName = challenger.player_name;
    loserName = king.player_name;
    winnerStreak = 1; // New king starts at 1

    if (useMemory) {
      king.status = 'eliminated';
      king.removed_at = now;
      challenger.position = 1;
      challenger.win_streak = winnerStreak;
      challenger.status = 'waiting';
      // Shift everyone up
      mem.queue_entries.filter(e =>
        e.session_id === sessionId && e.position > 2
        && !['eliminated', 'removed'].includes(e.status)
      ).forEach(e => { e.position -= 1; });
    } else {
      await pool.query(
        `UPDATE queue_entries SET status = 'eliminated', removed_at = NOW() WHERE id = $1`,
        [king.id]
      );
      await pool.query(
        'UPDATE queue_entries SET position = 1, win_streak = $1 WHERE id = $2',
        [winnerStreak, challenger.id]
      );
      await pool.query(
        `UPDATE queue_entries SET position = position - 1
         WHERE session_id = $1 AND position > 2 AND status NOT IN ('eliminated', 'removed')`,
        [sessionId]
      );
    }
  }

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

  // Put them back at position 2 (challenger), shift everyone else down
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

  if (useMemory) {
    const currentKing = queue.find(e => e.position === 1);

    if (wasKingWhoLost && currentKing) {
      // Challenger-wins undo: swap positions back
      // Shift pos >= 2 down to make room
      queue.filter(e => e.position >= 2).forEach(e => { e.position += 1; });
      // Former challenger (current king) goes back to pos 2
      currentKing.position = 2;
      currentKing.win_streak = 0;
      // Restored king goes back to pos 1 (win_streak still intact from before elimination)
      entry.status = 'waiting';
      entry.position = 1;
    } else {
      // King-wins undo: restore challenger to pos 2
      queue.filter(e => e.position >= 2).forEach(e => { e.position += 1; });
      entry.status = 'waiting';
      entry.position = 2;
      // Decrement king's streak
      if (currentKing && lastLog) {
        currentKing.win_streak = Math.max(0, (currentKing.win_streak || 0) - 1);
      }
    }
    entry.removed_at = null;
    entry.confirmation_sent_at = null;
    entry.confirmed_at = null;
    entry.ghosted_at = null;
  } else {
    // Shift everyone at pos >= 2 down
    await pool.query(
      `UPDATE queue_entries SET position = position + 1
       WHERE session_id = $1 AND position >= 2 AND status NOT IN ('eliminated', 'removed')`,
      [sessionId]
    );

    if (wasKingWhoLost) {
      // Challenger-wins undo: swap back
      // Current king (former challenger) → pos 2 with streak 0
      await pool.query(
        `UPDATE queue_entries SET position = 2, win_streak = 0
         WHERE session_id = $1 AND position = 1 AND status NOT IN ('eliminated', 'removed')`,
        [sessionId]
      );
      // Restored king → pos 1 (win_streak still intact from before elimination)
      await pool.query(
        `UPDATE queue_entries SET status = 'waiting', position = 1, removed_at = NULL,
         confirmation_sent_at = NULL, confirmed_at = NULL, ghosted_at = NULL WHERE id = $1`,
        [entry.id]
      );
    } else {
      // King-wins undo: restore challenger to pos 2
      await pool.query(
        `UPDATE queue_entries SET status = 'waiting', position = 2, removed_at = NULL,
         confirmation_sent_at = NULL, confirmed_at = NULL, ghosted_at = NULL WHERE id = $1`,
        [entry.id]
      );
      // Decrement king's streak
      if (lastLog) {
        await pool.query(
          `UPDATE queue_entries SET win_streak = GREATEST(0, win_streak - 1)
           WHERE session_id = $1 AND position = 1 AND status NOT IN ('eliminated', 'removed')`,
          [sessionId]
        );
      }
    }
  }

  // Remove the game log entry too
  if (useMemory) {
    const lastLog = mem.game_log.filter(g => g.session_id === sessionId).pop();
    if (lastLog) mem.game_log = mem.game_log.filter(g => g.id !== lastLog.id);
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
    const pos = entry.position;
    entry.status = 'removed';
    entry.removed_at = new Date();
    // Shift everyone above them down
    mem.queue_entries.filter(e =>
      e.session_id === sessionId && e.position > pos
      && !['eliminated', 'removed'].includes(e.status)
    ).forEach(e => { e.position -= 1; });
    return { success: true, name: entry.player_name };
  }

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
  await pool.query(
    `UPDATE queue_entries SET position = position - 1
     WHERE session_id = $1 AND position > $2 AND status NOT IN ('eliminated', 'removed')`,
    [sessionId, entry.position]
  );
  return { success: true, name: entry.player_name };
}

async function confirmPresence(sessionId, phoneId) {
  if (useMemory) {
    const entry = mem.queue_entries.find(e =>
      e.session_id === sessionId && e.phone_id === phoneId
      && !['eliminated', 'removed'].includes(e.status)
    );
    if (!entry) return { error: 'not_in_queue' };

    // If ghosted, recover them — slide back to their original spot
    if (entry.status === 'ghosted') {
      entry.status = 'confirmed';
      entry.confirmed_at = new Date();
      entry.ghosted_at = null;
    } else {
      entry.status = 'confirmed';
      entry.confirmed_at = new Date();
    }
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
    `UPDATE queue_entries SET status = 'confirmed', confirmed_at = NOW(), ghosted_at = NULL WHERE id = $1`,
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
    const pos = entry.position;
    entry.status = 'removed';
    entry.removed_at = new Date();
    mem.queue_entries.filter(e =>
      e.session_id === sessionId && e.position > pos
      && !['eliminated', 'removed'].includes(e.status)
    ).forEach(e => { e.position -= 1; });
    return { success: true, name: entry.player_name };
  }

  const res = await pool.query('SELECT * FROM queue_entries WHERE id = $1', [entryId]);
  const entry = res.rows[0];
  if (!entry) return { error: 'not_found' };

  await pool.query(
    `UPDATE queue_entries SET status = 'removed', removed_at = NOW() WHERE id = $1`,
    [entry.id]
  );
  await pool.query(
    `UPDATE queue_entries SET position = position - 1
     WHERE session_id = $1 AND position > $2 AND status NOT IN ('eliminated', 'removed')`,
    [sessionId, entry.position]
  );
  return { success: true, name: entry.player_name };
}

async function checkConfirmationTimeouts(sessionId) {
  // Called every 30 seconds by server
  // Position 3-4 with confirmation_sent_at but no confirmed_at:
  //   3 min → ghost
  //   2 min after ghost → remove
  const queue = await getQueue(sessionId);
  const now = Date.now();
  const actions = [];

  // STEP 1: Reset confirmation state for anyone who shifted to pos 1-2
  // (they confirmed when they were at 3/4, but now they're up front — clean slate)
  for (const entry of queue) {
    if (entry.position <= 2 && (entry.status === 'confirmed' || entry.status === 'ghosted' || entry.confirmation_sent_at)) {
      if (useMemory) {
        entry.status = 'waiting';
        entry.confirmation_sent_at = null;
        entry.confirmed_at = null;
        entry.ghosted_at = null;
      } else {
        await pool.query(
          `UPDATE queue_entries SET status = 'waiting', confirmation_sent_at = NULL, confirmed_at = NULL, ghosted_at = NULL WHERE id = $1`,
          [entry.id]
        );
      }
    }
  }

  // STEP 2: Send confirmations to pos 3-4 who haven't been asked yet
  for (const entry of queue) {
    if ((entry.position === 3 || entry.position === 4)
        && entry.status === 'waiting'
        && !entry.confirmation_sent_at) {
      await sendConfirmation(sessionId, entry.id);
      actions.push({ action: 'confirmation_sent', name: entry.player_name, id: entry.id, phone_id: entry.phone_id, position: entry.position });
    }
  }

  // STEP 3: Check timeouts for pos 3-4 who HAVE been asked
  for (const entry of queue) {
    if (entry.position < 3 || entry.position > 4) continue;
    if (entry.status === 'confirmed') continue;
    if (!entry.confirmation_sent_at) continue;

    const elapsed = (now - new Date(entry.confirmation_sent_at).getTime()) / 1000;

    if (entry.status === 'ghosted') {
      // Already ghosted — check for full removal (2 min after ghost)
      const ghostElapsed = (now - new Date(entry.ghosted_at).getTime()) / 1000;
      if (ghostElapsed >= 120) {
        await removePlayer(sessionId, entry.id);
        actions.push({ action: 'removed', name: entry.player_name, id: entry.id });
      }
    } else if (elapsed >= 180) {
      // 3 min — ghost them
      await ghostPlayer(sessionId, entry.id);
      actions.push({ action: 'ghosted', name: entry.player_name, id: entry.id });
    }
  }
  return actions;
}

async function getEntryByPhone(sessionId, phoneId) {
  if (useMemory) {
    return mem.queue_entries.find(e =>
      e.session_id === sessionId && e.phone_id === phoneId
      && !['eliminated', 'removed'].includes(e.status)
    ) || null;
  }
  const res = await pool.query(
    `SELECT * FROM queue_entries WHERE session_id = $1 AND phone_id = $2
     AND status NOT IN ('eliminated', 'removed') LIMIT 1`,
    [sessionId, phoneId]
  );
  return res.rows[0] || null;
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
  sendConfirmation,
  ghostPlayer,
  removePlayer,
  checkConfirmationTimeouts,
  getEntryByPhone,
  updatePartnerName,
  ensureSession
};
