// Queue logic stress test — SIMPLIFIED FIFO
delete process.env.DATABASE_URL;
const db = require('./db');

let testNum = 0, passed = 0, failed = 0;
const failures = [];

function assert(condition, msg) {
  if (!condition) { failures.push(`  ❌ T${testNum}: ${msg}`); failed++; }
  else passed++;
}

async function getQ(sid) {
  return (await db.getQueue(sid)).sort((a,b) => a.position - b.position);
}
function names(q) {
  return q.map(e => `${e.position}:${e.player_name}(${e.status}${e.confirmation_sent_at ? ',asked' : ''})`).join(' | ');
}
async function test(name, fn) {
  testNum++;
  db._resetMemory();
  console.log(`\n--- TEST ${testNum}: ${name} ---`);
  try { await fn(); } catch(e) { failures.push(`  💥 T${testNum}: ${name}: ${e.message}`); failed++; }
}
async function setup(n) {
  const sid = await db.createSession('table1', '0000');
  for (let i = 0; i < n; i++) {
    await db.addToQueue(sid, String.fromCharCode(65+i), null, `phone_${String.fromCharCode(65+i)}`);
  }
  return sid;
}

async function run() {
await db.init();

// === BASIC FLOW ===
await test('King wins', async () => {
  const sid = await setup(5);
  await db.recordResult(sid, 'king-wins');
  const q = await getQ(sid);
  console.log(' ', names(q));
  assert(q[0].player_name === 'A', 'A stays king');
  assert(q[1].player_name === 'C', 'C promoted to challenger (FIFO)');
  assert(q.length === 4, 'B eliminated');
});

await test('Challenger wins', async () => {
  const sid = await setup(4);
  await db.recordResult(sid, 'challenger-wins');
  const q = await getQ(sid);
  console.log(' ', names(q));
  assert(q[0].player_name === 'B', 'B becomes king');
  assert(q[1].player_name === 'C', 'C promoted');
});

await test('2 players king wins', async () => {
  const sid = await setup(2);
  await db.recordResult(sid, 'king-wins');
  const q = await getQ(sid);
  assert(q.length === 1 && q[0].player_name === 'A', 'Only king');
});

await test('2 players challenger wins', async () => {
  const sid = await setup(2);
  await db.recordResult(sid, 'challenger-wins');
  const q = await getQ(sid);
  assert(q.length === 1 && q[0].player_name === 'B', 'B new king');
});

// === LEAVING ===
await test('King leaves', async () => {
  const sid = await setup(4);
  await db.leaveQueue(sid, 'phone_A');
  const q = await getQ(sid);
  console.log(' ', names(q));
  assert(q[0].player_name === 'B', 'B auto-king');
  assert(q[1].player_name === 'C', 'C challenger');
});

await test('Challenger leaves', async () => {
  const sid = await setup(4);
  await db.leaveQueue(sid, 'phone_B');
  const q = await getQ(sid);
  assert(q[1].player_name === 'C', 'C promoted');
});

await test('Middle leaves, compacts', async () => {
  const sid = await setup(6);
  await db.leaveQueue(sid, 'phone_C');
  await db.leaveQueue(sid, 'phone_E');
  const q = await getQ(sid);
  console.log(' ', names(q));
  assert(q.map(e=>e.player_name).join('') === 'ABDF', 'Correct order');
  assert(q[3].position === 4, 'F at pos 4');
});

// === CONFIRMATION (informational only) ===
await test('Pos 3-5 asked to confirm', async () => {
  const sid = await setup(7);
  await db.checkConfirmationTimeouts(sid);
  const q = await getQ(sid);
  assert(!!q.find(e => e.position === 3)?.confirmation_sent_at, 'Pos 3 asked');
  assert(!!q.find(e => e.position === 4)?.confirmation_sent_at, 'Pos 4 asked');
  assert(!!q.find(e => e.position === 5)?.confirmation_sent_at, 'Pos 5 asked');
  assert(!q.find(e => e.position === 6)?.confirmation_sent_at, 'Pos 6 NOT asked');
  assert(!q.find(e => e.position === 7)?.confirmation_sent_at, 'Pos 7 NOT asked');
});

await test('Ghosted after 3 min (visual only)', async () => {
  const sid = await setup(5);
  await db.checkConfirmationTimeouts(sid);
  const q = await getQ(sid);
  const pos3 = q.find(e => e.position === 3);
  pos3.confirmation_sent_at = new Date(Date.now() - 200000);
  await db.checkConfirmationTimeouts(sid);
  const q2 = await getQ(sid);
  const c = q2.find(e => e.player_name === 'C');
  assert(c?.status === 'ghosted', 'C ghosted after 3 min');
  assert(c?.position === 3, 'C still at pos 3 (not removed)');
});

await test('No auto-removal — ghosted stays forever', async () => {
  const sid = await setup(5);
  await db.checkConfirmationTimeouts(sid);
  const q = await getQ(sid);
  const pos3 = q.find(e => e.position === 3);
  pos3.confirmation_sent_at = new Date(Date.now() - 600000); // 10 min
  pos3.status = 'ghosted';
  pos3.ghosted_at = new Date(Date.now() - 420000); // 7 min ghosted
  await db.checkConfirmationTimeouts(sid);
  const q2 = await getQ(sid);
  assert(!!q2.find(e => e.player_name === 'C'), 'C still in queue (no auto-removal)');
});

// === PURE FIFO PROMOTION ===
await test('FIFO: confirmed player does NOT skip ahead', async () => {
  const sid = await setup(6);
  await db.checkConfirmationTimeouts(sid);
  await db.confirmPresence(sid, 'phone_E'); // E confirms at pos 5
  // C at pos 3 hasn't confirmed
  await db.recordResult(sid, 'king-wins');
  const q = await getQ(sid);
  console.log(' ', names(q));
  assert(q[1].player_name === 'C', 'C becomes challenger (FIFO), not confirmed E');
});

await test('FIFO: ghosted player still promoted in order', async () => {
  const sid = await setup(6);
  await db.checkConfirmationTimeouts(sid);
  const q = await getQ(sid);
  const pos3 = q.find(e => e.player_name === 'C');
  pos3.status = 'ghosted';
  pos3.ghosted_at = new Date();
  pos3.confirmation_sent_at = new Date(Date.now() - 200000);
  await db.confirmPresence(sid, 'phone_D'); // D confirmed at pos 4
  
  await db.recordResult(sid, 'king-wins');
  const q2 = await getQ(sid);
  console.log(' ', names(q2));
  assert(q2[1].player_name === 'C', 'C promoted (FIFO) even though ghosted — bartender decides');
});

await test('FIFO: bartender swipes ghosted, next gets promoted', async () => {
  const sid = await setup(6);
  await db.checkConfirmationTimeouts(sid);
  const q = await getQ(sid);
  const pos3 = q.find(e => e.player_name === 'C');
  pos3.status = 'ghosted';
  pos3.ghosted_at = new Date();
  
  // Bartender swipes C
  await db.removePlayer(sid, pos3.id);
  // King wins
  await db.recordResult(sid, 'king-wins');
  const q2 = await getQ(sid);
  console.log(' ', names(q2));
  assert(q2[1].player_name === 'D', 'D promoted after C swiped');
});

// === EDGE CASES ===
await test('Rapid 5 games', async () => {
  const sid = await setup(10);
  for (let i = 0; i < 5; i++) await db.recordResult(sid, 'king-wins');
  const q = await getQ(sid);
  console.log(' ', names(q));
  assert(q[0].player_name === 'A' && q[0].win_streak === 5, 'A king, 5 streak');
  assert(q.length === 5, '5 remain');
  q.forEach((e, i) => assert(e.position === i+1, `Sequential pos ${i+1}`));
});

await test('Alternating wins', async () => {
  const sid = await setup(8);
  await db.recordResult(sid, 'king-wins');
  await db.recordResult(sid, 'challenger-wins');
  await db.recordResult(sid, 'king-wins');
  const q = await getQ(sid);
  console.log(' ', names(q));
  assert(q[0].player_name === 'C', 'C is king');
  assert(q[0].win_streak === 2, 'C streak 2');
});

await test('Undo king-wins', async () => {
  const sid = await setup(5);
  await db.recordResult(sid, 'king-wins');
  await db.undoLastRemoval(sid);
  const q = await getQ(sid);
  console.log(' ', names(q));
  assert(q.length === 5, 'All 5 back');
  assert(q[0].player_name === 'A', 'A king');
  assert(q[1].player_name === 'B', 'B challenger');
});

await test('Undo challenger-wins', async () => {
  const sid = await setup(4);
  await db.recordResult(sid, 'challenger-wins');
  await db.undoLastRemoval(sid);
  const q = await getQ(sid);
  assert(q[0].player_name === 'A', 'A restored king');
  assert(q[1].player_name === 'B', 'B restored challenger');
});

await test('All leave except king', async () => {
  const sid = await setup(4);
  await db.leaveQueue(sid, 'phone_B');
  await db.leaveQueue(sid, 'phone_C');
  await db.leaveQueue(sid, 'phone_D');
  const q = await getQ(sid);
  assert(q.length === 1 && q[0].position === 1, 'Only king');
});

await test('Everyone leaves', async () => {
  const sid = await setup(3);
  await db.leaveQueue(sid, 'phone_A');
  await db.leaveQueue(sid, 'phone_B');
  await db.leaveQueue(sid, 'phone_C');
  const q = await getQ(sid);
  assert(q.length === 0, 'Empty');
});

await test('Both king and challenger leave', async () => {
  const sid = await setup(5);
  await db.leaveQueue(sid, 'phone_A');
  await db.leaveQueue(sid, 'phone_B');
  const q = await getQ(sid);
  console.log(' ', names(q));
  assert(q[0].position === 1, 'New king at 1');
  assert(q[1].position === 2, 'New challenger at 2');
});

await test('Duplicate join blocked', async () => {
  const sid = await db.createSession('table1', '0000');
  await db.addToQueue(sid, 'A', null, 'phone_A');
  await db.addToQueue(sid, 'A', null, 'phone_A');
  const q = await getQ(sid);
  assert(q.length === 1, 'Only 1 entry');
});

await test('Confirmation state cleared on promotion to pos 1-2', async () => {
  const sid = await setup(4);
  await db.checkConfirmationTimeouts(sid);
  await db.confirmPresence(sid, 'phone_C'); // C confirmed at pos 3
  // King wins, B out, C promoted to challenger
  await db.recordResult(sid, 'king-wins');
  await db.checkConfirmationTimeouts(sid);
  const q = await getQ(sid);
  const c = q.find(e => e.player_name === 'C');
  console.log('  C at pos', c.position, 'status:', c.status, 'asked:', !!c.confirmation_sent_at);
  assert(c.position === 2, 'C at pos 2');
  assert(!c.confirmation_sent_at, 'Confirmation cleared at pos 2');
  assert(c.status === 'waiting', 'Status reset to waiting');
});

// === SUMMARY ===
console.log('\n========================================');
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
if (failures.length) { console.log('\nFAILURES:'); failures.forEach(f => console.log(f)); }
console.log('========================================');
}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });
