/**
 * server.js — Pool Cue v2
 *
 * Express + WebSocket server. All API routes live here.
 * One file, no router splitting — keeps it simple for beta.
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const db = require('./db');
const nicknames = require('./nicknames');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const SESSION_PIN = process.env.SESSION_PIN || '0000';

// Simple rate limiter (in-memory)
const rateLimits = new Map(); // key -> { count, resetAt }
function rateLimit(key, maxPerMinute) {
  const now = Date.now();
  const entry = rateLimits.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimits.set(key, { count: 1, resetAt: now + 60000 });
    return false; // not limited
  }
  entry.count++;
  if (entry.count > maxPerMinute) return true; // limited
  return false;
}
// Clean up stale entries every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimits) {
    if (now > entry.resetAt) rateLimits.delete(key);
  }
}, 300000);

// Middleware
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

// ============================================
// WebSocket — broadcast queue updates to all connected clients
// ============================================

// Track which table_code each WebSocket is watching
const clients = new Map(); // ws -> { tableCode }

wss.on('connection', (ws, req) => {
  // Parse table code from URL: /ws?table=abc123
  const url = new URL(req.url, `http://${req.headers.host}`);
  const tableCode = url.searchParams.get('table');
  // Parse phone_id from cookie header so targeted WS messages work
  let phoneId = null;
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/poolcue_phone=([^;]+)/);
  if (match) phoneId = match[1];
  if (tableCode) {
    clients.set(ws, { tableCode, phoneId });
  }

  ws.on('close', () => {
    clients.delete(ws);
  });

  ws.on('error', () => {
    clients.delete(ws);
  });
});

function broadcast(tableCode, data) {
  const message = JSON.stringify(data);
  for (const [ws, info] of clients) {
    if (info.tableCode === tableCode && ws.readyState === 1) {
      ws.send(message);
    }
  }
}

// Helper: send full queue state to all watchers of a table
async function broadcastQueueUpdate(tableCode) {
  const session = await db.getSession(tableCode);
  if (!session) return;
  const queue = await db.getQueue(session.id);
  const avgTime = await db.getAvgGameTime(session.id);
  broadcast(tableCode, {
    type: 'queue_update',
    queue,
    session: {
      game_type: session.game_type,
      rule_type: session.rule_type,
      status: session.status
    },
    avg_game_seconds: avgTime
  });
}

// ============================================
// Phone ID — cookie-based, one entry per device
// ============================================

function getPhoneId(req, res) {
  let phoneId = req.cookies?.poolcue_phone;
  if (!phoneId) {
    phoneId = uuidv4();
    res.cookie('poolcue_phone', phoneId, {
      maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production'
    });
  }
  return phoneId;
}

// ============================================
// Page routes
// ============================================

// Board display (touchscreen)
app.get('/board/:tableCode', (req, res) => {
  res.sendFile(__dirname + '/public/board.html');
});

// Phone join page
app.get('/join/:tableCode', (req, res) => {
  res.sendFile(__dirname + '/public/join.html');
});

// Phone status page (after joining)
app.get('/status/:tableCode', (req, res) => {
  res.sendFile(__dirname + '/public/status.html');
});

// Session setup page (PIN protected in JS)
app.get('/setup/:tableCode', (req, res) => {
  res.sendFile(__dirname + '/public/setup.html');
});

// ============================================
// API routes
// ============================================

// Get queue state
app.get('/api/queue/:tableCode', async (req, res) => {
  try {
    const session = await db.getSession(req.params.tableCode);
    if (!session) return res.json({ queue: [], session: null });
    await db.clearStaleQueue(session.id);
    const queue = await db.getQueue(session.id);
    const avgTime = await db.getAvgGameTime(session.id);
    const phoneId = getPhoneId(req, res);
    const myEntry = queue.find(e => e.phone_id === phoneId);
    res.json({
      queue,
      session: {
        game_type: session.game_type,
        rule_type: session.rule_type,
        status: session.status
      },
      avg_game_seconds: avgTime,
      my_entry: myEntry || null
    });
  } catch (err) {
    console.error('GET /api/queue error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Join queue
app.post('/api/join', async (req, res) => {
  try {
    const { tableCode, playerName, partnerName } = req.body;
    if (!tableCode || !playerName?.trim()) {
      return res.status(400).json({ error: 'missing_fields' });
    }
    const phoneId = getPhoneId(req, res);

    // Rate limit: 10 joins per minute per device
    if (rateLimit(`join:${phoneId}`, 10)) {
      return res.status(429).json({ error: 'too_many_requests' });
    }

    // Sanitize: strip HTML tags, zero-width chars, trim, limit length
    const name = playerName.replace(/<[^>]*>/g, '').replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, '').trim().substring(0, 24);
    const partner = partnerName ? partnerName.replace(/<[^>]*>/g, '').replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, '').trim().substring(0, 24) || null : null;
    if (!name) return res.status(400).json({ error: 'missing_fields' });

    // Auto-create session if needed
    const session = await db.ensureSession(tableCode);
    if (session.status !== 'active') {
      return res.status(400).json({ error: 'table_closed' });
    }

    const result = await db.addToQueue(session.id, name, partner, phoneId);
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    await triggerConfirmations(tableCode);
    await broadcastQueueUpdate(tableCode);
    res.json({ success: true, entry: result });
  } catch (err) {
    console.error('POST /api/join error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Leave queue
app.post('/api/leave', async (req, res) => {
  try {
    const { tableCode } = req.body;
    const phoneId = getPhoneId(req, res);
    const session = await db.getSession(tableCode);
    if (!session) return res.status(404).json({ error: 'no_session' });
    const result = await db.leaveQueue(session.id, phoneId);
    if (result.error) return res.status(400).json(result);
    await triggerConfirmations(tableCode);
    await broadcastQueueUpdate(tableCode);
    res.json(result);
  } catch (err) {
    console.error('POST /api/leave error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Record game result (from board swipe or shot caller phone)
app.post('/api/result', async (req, res) => {
  try {
    const { tableCode, result } = req.body;
    if (!['king-wins', 'challenger-wins'].includes(result)) {
      return res.status(400).json({ error: 'invalid_result' });
    }
    // Rate limit: 6 results per minute per table (prevents accidental double-taps)
    if (rateLimit(`result:${tableCode}`, 6)) {
      return res.status(429).json({ error: 'too_fast' });
    }
    const session = await db.getSession(tableCode);
    if (!session) return res.status(404).json({ error: 'no_session' });
    const outcome = await db.recordResult(session.id, result);
    if (outcome.error) return res.status(400).json(outcome);

    // Broadcast queue update FIRST so board updates instantly
    await broadcastQueueUpdate(tableCode);
    res.json(outcome);

    // Then trigger confirmations in the background (non-blocking)
    triggerConfirmations(tableCode).catch(() => {});
  } catch (err) {
    console.error('POST /api/result error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Confirm presence (phone taps "I'M HERE")
app.post('/api/confirm', async (req, res) => {
  try {
    const { tableCode } = req.body;
    const phoneId = getPhoneId(req, res);
    const session = await db.getSession(tableCode);
    if (!session) return res.status(404).json({ error: 'no_session' });
    const result = await db.confirmPresence(session.id, phoneId);
    if (result.error) return res.status(400).json(result);
    await broadcastQueueUpdate(tableCode);
    res.json(result);
  } catch (err) {
    console.error('POST /api/confirm error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Undo last removal
app.post('/api/undo', async (req, res) => {
  try {
    const { tableCode, pin, source } = req.body;
    // Board can undo without PIN (it's physically at the table)
    if (source !== 'board' && pin !== SESSION_PIN) return res.status(403).json({ error: 'bad_pin' });
    const session = await db.getSession(tableCode);
    if (!session) return res.status(404).json({ error: 'no_session' });
    const result = await db.undoLastRemoval(session.id);
    if (result.error) return res.status(400).json(result);
    await broadcastQueueUpdate(tableCode);
    res.json(result);
    // NO triggerConfirmations here — undo is a clean revert.
    // The regular 30s timer will re-ask the right positions.
  } catch (err) {
    console.error('POST /api/undo error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Start session
app.post('/api/session/start', async (req, res) => {
  try {
    const { tableCode, pin, gameType, ruleType } = req.body;
    if (pin !== SESSION_PIN) return res.status(403).json({ error: 'bad_pin' });
    const session = await db.createSession(tableCode, pin, gameType, ruleType);
    await broadcastQueueUpdate(tableCode);
    res.json({ success: true, session });
  } catch (err) {
    console.error('POST /api/session/start error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Close session
app.post('/api/session/close', async (req, res) => {
  try {
    const { tableCode, pin } = req.body;
    if (pin !== SESSION_PIN) return res.status(403).json({ error: 'bad_pin' });
    await db.closeSession(tableCode);
    broadcast(tableCode, { type: 'session_closed' });
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/session/close error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Update rules (shot caller phone — must be position 1)
app.post('/api/rules', async (req, res) => {
  try {
    const { tableCode, gameType, ruleType } = req.body;
    const phoneId = getPhoneId(req, res);
    const session = await db.getSession(tableCode);
    if (!session) return res.status(404).json({ error: 'no_session' });
    // Verify caller is the shot caller (position 1)
    const queue = await db.getQueue(session.id);
    const king = queue.find(e => e.position === 1);
    if (!king || king.phone_id !== phoneId) {
      return res.status(403).json({ error: 'not_shot_caller' });
    }
    const updated = await db.updateRules(tableCode, gameType, ruleType);
    if (!updated) return res.status(404).json({ error: 'no_session' });
    await broadcastQueueUpdate(tableCode);
    res.json({ success: true, session: updated });
  } catch (err) {
    console.error('POST /api/rules error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Remove any player (bartender tool — PIN required)
app.post('/api/remove', async (req, res) => {
  try {
    const { tableCode, pin, entryId } = req.body;
    if (pin !== SESSION_PIN) return res.status(403).json({ error: 'bad_pin' });
    const session = await db.getSession(tableCode);
    if (!session) return res.status(404).json({ error: 'no_session' });
    const result = await db.removePlayer(session.id, entryId);
    if (result.error) return res.status(400).json(result);
    await triggerConfirmations(tableCode);
    await broadcastQueueUpdate(tableCode);
    res.json(result);
  } catch (err) {
    console.error('POST /api/remove error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Update partner name (when mode switches to doubles)
app.post('/api/partner', async (req, res) => {
  try {
    const { tableCode, partnerName } = req.body;
    const phoneId = getPhoneId(req, res);
    const session = await db.getSession(tableCode);
    if (!session) return res.status(404).json({ error: 'no_session' });
    // Sanitize: strip HTML tags, zero-width chars, trim, limit length (same as /api/join)
    const partner = partnerName ? partnerName.replace(/<[^>]*>/g, '').replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, '').trim().substring(0, 24) || null : null;
    const entry = await db.updatePartnerName(session.id, phoneId, partner);
    if (!entry) return res.status(404).json({ error: 'not_in_queue' });
    await broadcastQueueUpdate(tableCode);
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/partner error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Suggest nickname
app.get('/api/suggest-name', (req, res) => {
  res.json({ name: nicknames.suggest() });
});

// Debug: add a fake player (for testing queue flow — disabled in production)
app.post('/api/debug/add-fake', async (req, res) => {
  try {
    const { tableCode } = req.body;
    const session = await db.ensureSession(tableCode);
    if (session.status !== 'active') {
      return res.status(400).json({ error: 'table_closed' });
    }
    const name = nicknames.suggest();
    const fakePhoneId = 'debug-' + uuidv4();
    const result = await db.addToQueue(session.id, name, null, fakePhoneId);
    if (result.error) return res.status(400).json(result);
    await triggerConfirmations(tableCode);
    await broadcastQueueUpdate(tableCode);
    res.json({ success: true, name });
  } catch (err) {
    console.error('Debug add-fake error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// QR code image (PNG)
app.get('/qr/:tableCode', async (req, res) => {
  try {
    const url = `${BASE_URL}/join/${req.params.tableCode}`;
    const qr = await QRCode.toBuffer(url, {
      width: 300, margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    });
    res.type('image/png').send(qr);
  } catch (err) {
    console.error('QR generation error:', err);
    res.status(500).send('QR error');
  }
});

// ============================================
// Confirmation system — runs on a timer
// ============================================

async function triggerConfirmations(tableCode) {
  // Delegates to checkConfirmationTimeouts which handles:
  // 1. Reset confirmation state for pos 1 (king is at the table)
  // 2. Escalate unresponsive players: waiting → MIA (5m) → ghosted (10m)
  // 3. Send new confirmation requests to pos 2-5
  // No auto-removal — bartender/players swipe manually.
  const session = await db.getSession(tableCode);
  if (!session) return false;
  const actions = await db.checkConfirmationTimeouts(session.id);
  if (actions.length > 0) {
    // Send targeted WebSocket messages for each action type
    for (const action of actions) {
      if (action.action === 'confirmation_sent') {
        // Notify the specific phone that was asked to confirm
        for (const [ws, info] of clients) {
          if (info.tableCode === tableCode && info.phoneId === action.phone_id) {
            ws.send(JSON.stringify({
              type: 'confirm_request',
              entry_id: action.id,
              phone_id: action.phone_id,
              position: action.position,
              player_name: action.name
            }));
          }
        }
      } else if (action.action === 'mia') {
        // Player went orange (5 min no response) — notify their phone
        for (const [ws, info] of clients) {
          if (info.tableCode === tableCode) {
            ws.send(JSON.stringify({
              type: 'player_mia',
              name: action.name,
              entry_id: action.id
            }));
          }
        }
      } else if (action.action === 'ghosted' || action.action === 'removed') {
        // Player went red (10 min) or was removed — notify all watchers
        for (const [ws, info] of clients) {
          if (info.tableCode === tableCode) {
            ws.send(JSON.stringify({
              type: action.action === 'ghosted' ? 'player_ghosted' : 'player_removed',
              name: action.name,
              entry_id: action.id
            }));
          }
        }
      }
    }
    return true;
  }
  return false;
}

// Periodic confirmation checker — runs every 30 seconds
setInterval(async () => {
  try {
    const activeTables = new Set();
    for (const [, info] of clients) {
      if (info.tableCode) activeTables.add(info.tableCode);
    }
    for (const tableCode of activeTables) {
      const changed = await triggerConfirmations(tableCode);
      if (changed) await broadcastQueueUpdate(tableCode);
    }
  } catch (err) {
    console.error('Confirmation timer error:', err);
  }
}, 30000);

// ============================================
// Health check + startup
// ============================================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
async function start() {
  await db.init();
  server.listen(PORT, () => {
    console.log(`\n🎱 Pool Cue v2 running on port ${PORT}`);
    console.log(`   Board:  ${BASE_URL}/board/table1`);
    console.log(`   Join:   ${BASE_URL}/join/table1`);
    console.log(`   Setup:  ${BASE_URL}/setup/table1`);
    console.log(`   QR:     ${BASE_URL}/qr/table1`);
    console.log('');
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
