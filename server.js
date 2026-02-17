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
const SESSION_PIN = process.env.SESSION_PIN || '134679';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'poolcue2026';

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
app.use(express.json({ limit: '5mb' }));
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
    clients.set(ws, { tableCode, phoneId, alive: true });
  }

  ws.on('pong', () => {
    const info = clients.get(ws);
    if (info) info.alive = true;
  });

  ws.on('close', () => {
    clients.delete(ws);
  });

  ws.on('error', () => {
    clients.delete(ws);
  });
});

// WebSocket heartbeat — ping every 30s, kill dead connections
setInterval(() => {
  for (const [ws, info] of clients) {
    if (!info.alive) {
      clients.delete(ws);
      ws.terminate();
      continue;
    }
    info.alive = false;
    ws.ping();
  }
}, 30000);

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

// Idle clear — board auto-wipes after inactivity (no PIN needed, board-only)
app.post('/api/idle-clear', async (req, res) => {
  try {
    const { tableCode } = req.body;
    const session = await db.getSession(tableCode);
    if (!session) return res.status(404).json({ error: 'no_session' });
    const result = await db.idleClearQueue(session.id);
    if (result.error) return res.status(400).json(result);
    await broadcastQueueUpdate(tableCode);
    res.json(result);
  } catch (err) {
    console.error('POST /api/idle-clear error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Idle restore — undo the auto-wipe (no PIN needed, board-only)
app.post('/api/idle-restore', async (req, res) => {
  try {
    const { tableCode } = req.body;
    const session = await db.getSession(tableCode);
    if (!session) return res.status(404).json({ error: 'no_session' });
    const result = await db.idleRestoreQueue(session.id);
    if (result.error) return res.status(400).json(result);
    await broadcastQueueUpdate(tableCode);
    res.json(result);
  } catch (err) {
    console.error('POST /api/idle-restore error:', err);
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
    const { tableCode, pin, entryId, source } = req.body;
    // Board-initiated removals (touchscreen at the table) skip PIN check
    if (source !== 'board' && pin !== SESSION_PIN) return res.status(403).json({ error: 'bad_pin' });
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

// Debug: add a fake player (PIN or board source required)
app.post('/api/debug/add-fake', async (req, res) => {
  try {
    const { tableCode, pin, source } = req.body;
    if (source !== 'board' && pin !== SESSION_PIN) return res.status(403).json({ error: 'bad_pin' });
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
// Admin panel
// ============================================

app.get('/admin', (req, res) => {
  res.sendFile(__dirname + '/public/admin.html');
});

// Admin auth check middleware
function adminAuth(req, res, next) {
  const pw = req.headers['x-admin-password'] || req.body?.adminPassword;
  if (pw !== ADMIN_PASSWORD) return res.status(403).json({ error: 'bad_password' });
  next();
}

// --- Bars ---
app.get('/api/admin/bars', adminAuth, async (req, res) => {
  try {
    res.json({ bars: await db.getAllBars() });
  } catch (err) { console.error(err); res.status(500).json({ error: 'server_error' }); }
});

app.post('/api/admin/bars', adminAuth, async (req, res) => {
  try {
    const { name, slug, address, contactName, contactPhone } = req.body;
    if (!name?.trim() || !slug?.trim()) return res.status(400).json({ error: 'name_and_slug_required' });
    const clean = slug.toLowerCase().replace(/[^a-z0-9-]/g, '');
    const existing = await db.getBarBySlug(clean);
    if (existing) return res.status(400).json({ error: 'slug_taken' });
    const bar = await db.createBar(name.trim(), clean, address, contactName, contactPhone);
    res.json({ success: true, bar });
  } catch (err) { console.error(err); res.status(500).json({ error: 'server_error' }); }
});

app.put('/api/admin/bars/:id', adminAuth, async (req, res) => {
  try {
    const bar = await db.updateBar(parseInt(req.params.id), req.body);
    if (!bar) return res.status(404).json({ error: 'not_found' });
    res.json({ success: true, bar });
  } catch (err) { console.error(err); res.status(500).json({ error: 'server_error' }); }
});

// --- Ads ---
app.get('/api/admin/ads', adminAuth, async (req, res) => {
  try {
    const ads = await db.getAds();
    // Include targets for each ad
    const adsWithTargets = [];
    for (const ad of ads) {
      const targets = await db.getAdTargets(ad.id);
      adsWithTargets.push({ ...ad, target_bar_ids: targets });
    }
    res.json({ ads: adsWithTargets });
  } catch (err) { console.error(err); res.status(500).json({ error: 'server_error' }); }
});

app.post('/api/admin/ads', adminAuth, async (req, res) => {
  try {
    const { advertiserName, imageData, imageType, startDate, endDate, targetBarIds } = req.body;
    if (!advertiserName?.trim() || !imageData) return res.status(400).json({ error: 'name_and_image_required' });
    const ad = await db.createAd(advertiserName.trim(), imageData, imageType, startDate, endDate);
    if (targetBarIds?.length) await db.setAdTargets(ad.id, targetBarIds);
    res.json({ success: true, ad });
  } catch (err) { console.error(err); res.status(500).json({ error: 'server_error' }); }
});

app.put('/api/admin/ads/:id', adminAuth, async (req, res) => {
  try {
    const adId = parseInt(req.params.id);
    const { targetBarIds, ...fields } = req.body;
    const ad = await db.updateAd(adId, fields);
    if (!ad) return res.status(404).json({ error: 'not_found' });
    if (targetBarIds) await db.setAdTargets(adId, targetBarIds);
    res.json({ success: true, ad });
  } catch (err) { console.error(err); res.status(500).json({ error: 'server_error' }); }
});

app.delete('/api/admin/ads/:id', adminAuth, async (req, res) => {
  try {
    await db.deleteAd(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'server_error' }); }
});

// --- Impressions report ---
app.get('/api/admin/impressions', adminAuth, async (req, res) => {
  try {
    res.json({ report: await db.getImpressionReport() });
  } catch (err) { console.error(err); res.status(500).json({ error: 'server_error' }); }
});

// --- Session stats ---
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const stats = await db.getAllStats();
    res.json(stats);
  } catch (err) { console.error(err); res.status(500).json({ error: 'server_error' }); }
});

app.get('/api/admin/stats/:tableCode', adminAuth, async (req, res) => {
  try {
    const stats = await db.getSessionStats(req.params.tableCode);
    res.json({ stats });
  } catch (err) { console.error(err); res.status(500).json({ error: 'server_error' }); }
});

// ============================================
// Ad serving (public — called by board)
// ============================================

app.get('/api/ads/:tableCode', async (req, res) => {
  try {
    const bar = await db.getBarForTableCode(req.params.tableCode);
    if (!bar) return res.json({ ads: [] });
    const ads = await db.getAdsForBar(bar.id);
    // Send ads without full base64 data — just metadata + image URL
    const adList = ads.map(a => ({
      id: a.id, advertiser_name: a.advertiser_name,
      image_url: `/api/ads/image/${a.id}`
    }));
    res.json({ ads: adList, bar_id: bar.id });
  } catch (err) { console.error(err); res.status(500).json({ error: 'server_error' }); }
});

// Serve ad image (avoids sending base64 over WS)
app.get('/api/ads/image/:id', async (req, res) => {
  try {
    const ad = await db.getAd(parseInt(req.params.id));
    if (!ad || !ad.image_data) return res.status(404).send('Not found');
    const buf = Buffer.from(ad.image_data, 'base64');
    res.type(ad.image_type).send(buf);
  } catch (err) { res.status(500).send('Error'); }
});

// Log impression
app.post('/api/ads/impression', async (req, res) => {
  try {
    const { adId, barId } = req.body;
    if (!adId || !barId) return res.status(400).json({ error: 'missing_fields' });
    await db.logImpression(adId, barId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'server_error' }); }
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

// Periodic confirmation checker — runs every 10 seconds
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
}, 10000);

// ============================================
// Daily reset — 8:00 AM Eastern Time, every day
// Closes all active sessions (wipes queues + game logs)
// ============================================

let lastResetDate = null; // tracks which date we last reset on

function checkDailyReset() {
  // Get current time in New York
  const now = new Date();
  const nyTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const hour = nyTime.getHours();
  const dateStr = nyTime.toISOString().slice(0, 10); // YYYY-MM-DD

  // Fire once per day, at or after 8:00 AM ET
  if (hour >= 8 && lastResetDate !== dateStr) {
    lastResetDate = dateStr;
    performDailyReset(dateStr);
  }
}

async function performDailyReset(dateStr) {
  try {
    const count = await db.closeAllSessions();
    console.log(`🔄 Daily reset (${dateStr} 8am ET): closed ${count} active session(s)`);

    // Notify all connected boards to reload fresh (daily reset)
    for (const [ws, info] of clients) {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'daily_reset' }));
      }
    }
  } catch (err) {
    console.error('Daily reset error:', err);
  }
}

// Check every 60 seconds
setInterval(checkDailyReset, 60000);
// Also check on startup (in case server restarts after 8am)
setTimeout(checkDailyReset, 5000);

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
