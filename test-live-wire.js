/**
 * LIVE WIRE TEST — End-to-End HTTP + WebSocket
 * 
 * Spins up the actual server and hits every endpoint like real
 * phones and browsers would. Tests things db-only tests can't:
 * rate limiting, input sanitization, cookie handling, WebSocket
 * broadcasts, error responses, and adversarial inputs.
 * 
 * Run: node test-live-wire.js
 */

const http = require('http');
const WebSocket = require('ws');

const BASE = 'http://localhost:4999';
let serverProcess;
let passed = 0, failed = 0, sections = 0;

function assert(condition, label) {
  if (condition) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ FAIL: ${label}`); }
}
function section(title) {
  sections++;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${sections}. ${title}`);
  console.log('='.repeat(60));
}

// --- HTTP helper ---
async function api(path, opts = {}) {
  const url = BASE + path;
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.stringify(opts.body) : null;
  const headers = { 'Content-Type': 'application/json' };
  if (opts.cookie) headers['Cookie'] = opts.cookie;

  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch { json = data; }
        // Capture set-cookie
        const setCookie = res.headers['set-cookie'];
        resolve({ status: res.statusCode, body: json, setCookie });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// --- WebSocket helper ---
function connectWS(tableCode) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:4999/ws?table=${tableCode}`);
    const messages = [];
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('message', data => messages.push(JSON.parse(data.toString())));
    ws.on('error', reject);
  });
}

function waitForMessage(messages, type, timeout = 2000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const found = messages.find(m => m.type === type);
      if (found) return resolve(found);
      if (Date.now() - start > timeout) return resolve(null);
      setTimeout(check, 50);
    };
    check();
  });
}

async function startServer() {
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    serverProcess = spawn('node', ['server.js'], {
      env: { ...process.env, PORT: '4999', NODE_ENV: 'test' },
      cwd: __dirname,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    serverProcess.stdout.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('listening') || msg.includes('Server') || msg.includes('4999')) {
        setTimeout(resolve, 500); // give it a beat
      }
    });
    serverProcess.stderr.on('data', (data) => {
      // Ignore normal stderr output
    });
    // Fallback: resolve after 3s regardless
    setTimeout(resolve, 3000);
  });
}

async function run() {
  console.log('🔌 Starting server on port 4999...');
  await startServer();
  console.log('✅ Server ready\n');

  try {
    await runTests();
  } finally {
    if (serverProcess) serverProcess.kill();
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  🔌 LIVE WIRE TEST COMPLETE`);
  console.log('='.repeat(60));
  console.log(`\n  ✅ Passed: ${passed}`);
  console.log(`  ❌ Failed: ${failed}`);
  console.log(`  📋 Sections: ${sections}`);
  console.log(`  📊 Total: ${passed + failed}\n`);
  if (failed > 0) {
    console.log('  ⚠️  ISSUES FOUND');
    process.exit(1);
  } else {
    console.log('  🎱 ALL LIVE WIRE TESTS PASS');
    process.exit(0);
  }
}

async function runTests() {

  // =============================================
  section('STATIC PAGES — Do They Even Load?');
  // =============================================
  const board = await api('/board/testbar');
  assert(board.status === 200, 'Board page loads (200)');

  const join = await api('/join/testbar');
  assert(join.status === 200, 'Join page loads (200)');

  const admin = await api('/admin');
  assert(admin.status === 200, 'Admin page loads (200)');

  const qr = await api('/qr/testbar');
  assert(qr.status === 200, 'QR code generates (200)');

  const missing = await api('/board/nonexistent-table-xyz');
  assert(missing.status === 200, 'Board with unknown table still loads (client-side routing)');

  // =============================================
  section('PHONE COOKIE — First Contact');
  // =============================================
  // First request should set the poolcue_phone cookie
  const firstVisit = await api('/join/testbar');
  const cookie = firstVisit.setCookie?.find(c => c.includes('poolcue_phone'));
  assert(cookie, 'Join page sets poolcue_phone cookie');
  const phoneId = cookie ? cookie.split('=')[1].split(';')[0] : null;
  assert(phoneId && phoneId.length > 10, 'Phone ID is a UUID');

  // =============================================
  section('FULL USER JOURNEY — Scan to Play');
  // =============================================
  // Simulate: 3 people scan QR, join, play a game, check status
  const phone1 = `poolcue_phone=test-phone-1`;
  const phone2 = `poolcue_phone=test-phone-2`;
  const phone3 = `poolcue_phone=test-phone-3`;

  // Player 1 joins
  const j1 = await api('/api/join', {
    method: 'POST',
    body: { tableCode: 'livetest', playerName: 'Alice' },
    cookie: phone1
  });
  assert(j1.status === 200, 'Alice joins (200)');
  assert(j1.body.position === 1, 'Alice is king (pos 1)');

  // Player 2 joins  
  const j2 = await api('/api/join', {
    method: 'POST',
    body: { tableCode: 'livetest', playerName: 'Bob' },
    cookie: phone2
  });
  assert(j2.status === 200, 'Bob joins (200)');
  assert(j2.body.position === 2, 'Bob is challenger (pos 2)');

  // Player 3 joins
  const j3 = await api('/api/join', {
    method: 'POST',
    body: { tableCode: 'livetest', playerName: 'Charlie' },
    cookie: phone3
  });
  assert(j3.status === 200, 'Charlie joins (200)');
  assert(j3.body.position === 3, 'Charlie waiting (pos 3)');

  // Check queue state
  const qState = await api('/api/queue/livetest');
  assert(qState.status === 200, 'Queue endpoint works');
  assert(qState.body.queue.length === 3, 'Queue has 3 players');
  assert(qState.body.session.status === 'active', 'Session auto-created and active');

  // Check status endpoint
  const status1 = await api('/api/status/livetest', { cookie: phone1 });
  assert(status1.status === 200, 'Status endpoint works');
  assert(status1.body.position === 1, 'Alice sees herself at pos 1');

  // Game result: king wins
  const result = await api('/api/result', {
    method: 'POST',
    body: { tableCode: 'livetest', result: 'king-wins' }
  });
  assert(result.status === 200, 'Result recorded (200)');
  assert(result.body.winner === 'Alice', 'Alice won');
  assert(result.body.loser === 'Bob', 'Bob lost');

  // Check Bob is gone
  const qAfter = await api('/api/queue/livetest');
  assert(qAfter.body.queue.length === 2, 'Bob eliminated, 2 remain');

