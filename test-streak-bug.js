// Repro test: does anything break at 6+ wins?
// Tests both fast-pace (rate limit territory) and realistic-pace (real bar play)
const http = require('http');

const PORT = 3457;
process.env.PORT = PORT;
process.env.BASE_URL = `http://localhost:${PORT}`;
delete process.env.DATABASE_URL; // force in-memory mode

const server = require('./server.js');

const TABLE = 'streaktest';
const BASE = `http://localhost:${PORT}`;

function http_call(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(`${BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, res => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json;
        try { json = JSON.parse(text); } catch { json = { raw: text }; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function joinPlayer(name) {
  return http_call('POST', '/api/join', { tableCode: TABLE, playerName: name });
}

async function getQueue() {
  const r = await http_call('GET', `/api/queue/${TABLE}`);
  return r.body.queue || [];
}

async function recordWin() {
  return http_call('POST', '/api/result', { tableCode: TABLE, result: 'king-wins' });
}

async function run() {
  // Wait for server to listen
  await sleep(800);

  console.log('=== Setup: ensure session, fill queue with 10 players ===');

  const playerNames = ['King', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9'];
  for (const n of playerNames) {
    const r = await joinPlayer(n);
    if (r.status !== 200) console.log(`  join ${n} -> ${r.status}`, r.body);
  }
  const initial = await getQueue();
  console.log(`  queue: ${initial.length} players, king=${initial.find(e=>e.position===1)?.player_name}`);
  console.log();

  // ========== TEST 1: FAST PACE (was rate-limited at 6 with old cap) ==========
  console.log('=== Test 1: 8 wins back-to-back, no delay (fast pace) ===');
  const fastResults = [];
  for (let i = 1; i <= 8; i++) {
    const r = await recordWin();
    const q = await getQueue();
    const king = q.find(e => e.position === 1);
    fastResults.push({ win: i, status: r.status, body: r.body, streak: king?.win_streak, queueLen: q.length });
    console.log(`  win #${i}: status=${r.status} streak=${king?.win_streak} queue=${q.length} ${r.body.error ? '❌ '+r.body.error : '✓'}`);
  }
  const fastFails = fastResults.filter(r => r.status !== 200);
  console.log(`  result: ${fastResults.length - fastFails.length}/8 succeeded, ${fastFails.length} failed`);
  console.log();

  // Reset for test 2 — re-fill queue
  console.log('=== Reset: re-add players for test 2 ===');
  // King survived test 1 with streak 8; queue is depleted. Add fresh challengers.
  for (const n of ['D1','D2','D3','D4','D5','D6','D7','D8']) {
    await joinPlayer(n);
  }
  const t2start = await getQueue();
  console.log(`  queue: ${t2start.length} players, king=${t2start.find(e=>e.position===1)?.player_name} streak=${t2start.find(e=>e.position===1)?.win_streak}`);
  console.log();

  // ========== TEST 2: REALISTIC BAR PACE (15s between games) ==========
  console.log('=== Test 2: 7 wins with 15s between (simulates real pool games) ===');
  console.log('  (skipping the 15s wait — instead testing across rate-limit window reset)');
  // Wait 61s for rate limit window to fully reset, then try again
  console.log('  waiting 61s for rate-limit window reset...');
  await sleep(61000);

  const slowResults = [];
  for (let i = 1; i <= 7; i++) {
    const r = await recordWin();
    const q = await getQueue();
    const king = q.find(e => e.position === 1);
    slowResults.push({ win: i, status: r.status, streak: king?.win_streak });
    console.log(`  win #${i}: status=${r.status} streak=${king?.win_streak} ${r.body.error ? '❌ '+r.body.error : '✓'}`);
  }
  const slowFails = slowResults.filter(r => r.status !== 200);
  console.log(`  result: ${slowResults.length - slowFails.length}/7 succeeded, ${slowFails.length} failed`);
  console.log();

  // ========== SUMMARY ==========
  console.log('=== SUMMARY ===');
  console.log(`Fast-pace (8 wins):     ${8 - fastFails.length}/8 ok`);
  console.log(`Reset+slow (7 wins):    ${7 - slowFails.length}/7 ok`);
  if (fastFails.length === 0 && slowFails.length === 0) {
    console.log('✓ NO BUG REPRODUCED at any streak count or pace');
  } else {
    console.log('✗ FAILURES seen — bug exists');
    console.log('  Fast pace failures:', fastFails);
    console.log('  Slow pace failures:', slowFails);
  }

  process.exit(0);
}

run().catch(e => { console.error('Test crashed:', e); process.exit(1); });
