// POOL CUE — UNDO STRESS TEST
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
  return q.map(e => {
    let s = `${e.position}:${e.player_name}`;
    if (e.status !== 'waiting') s += `(${e.status})`;
    if (e.win_streak > 0) s += `[${e.win_streak}W]`;
    if (e.confirmation_sent_at) s += '{conf}';
    return s;
  }).join(' | ');
}
async function test(name, fn) {
  testNum++;
  db._resetMemory();
  try { await fn(); }
  catch(e) { failures.push(`  💥 T${testNum} CRASH: ${name}: ${e.message}`); failed++; }
}
async function setup(n) {
  const session = await db.createSession('table1', '0000');
  const sid = session.id;
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  for (let i = 0; i < n; i++) {
    await db.addToQueue(sid, letters[i], null, `phone_${letters[i]}`);
  }
  return sid;
}

async function run() {
await db.init();
console.log('\n🔧 UNDO STRESS TEST');
console.log('==========================================\n');
// === BASIC SWIPE + UNDO ===
console.log('📋 SECTION 1: Basic Swipe + Undo\n');

await test('King-wins then undo: B returns to pos 2', async () => {
  const sid = await setup(6);
  await db.recordResult(sid, 'king-wins');
  let q = await getQ(sid);
  assert(q.length === 5, '5 left after B eliminated');
  assert(q[0].player_name === 'A', 'A king');
  assert(q[0].position === 1, 'A at pos 1');
  assert(q[1].player_name === 'C', 'C challenger');
  assert(q[1].position === 2, 'C at pos 2');

  await db.undoLastRemoval(sid);
  q = await getQ(sid);
  assert(q.length === 6, '6 back');
  assert(q[0].player_name === 'A' && q[0].position === 1, 'A pos 1');
  assert(q[1].player_name === 'B' && q[1].position === 2, 'B pos 2 (challenger restored)');
  assert(q[2].player_name === 'C' && q[2].position === 3, 'C pos 3');
  q.forEach((e,i) => assert(e.position === i+1, `pos ${i+1} sequential`));
  console.log(`  T${testNum} ✓ ${names(q)}`);
});

await test('Challenger-wins then undo: A returns as king', async () => {
  const sid = await setup(6);
  await db.recordResult(sid, 'challenger-wins');
  let q = await getQ(sid);
  assert(q[0].player_name === 'B', 'B king');
  assert(q[0].win_streak === 1, 'B streak 1');

  await db.undoLastRemoval(sid);
  q = await getQ(sid);
  assert(q[0].player_name === 'A' && q[0].win_streak === 0, 'A king streak 0');
  assert(q[1].player_name === 'B' && q[1].position === 2, 'B challenger');
  q.forEach((e,i) => assert(e.position === i+1, `pos ${i+1} sequential`));
  console.log(`  T${testNum} ✓ ${names(q)}`);
});

await test('Undo with only 2 players (king-wins)', async () => {
  const sid = await setup(2);
  await db.recordResult(sid, 'king-wins');
  let q = await getQ(sid);
  assert(q.length === 1, '1 left');

  await db.undoLastRemoval(sid);
  q = await getQ(sid);
  assert(q.length === 2, '2 back');
  assert(q[0].player_name === 'A', 'A king');
  assert(q[1].player_name === 'B', 'B challenger');
  console.log(`  T${testNum} ✓ ${names(q)}`);
});

await test('Undo with only 2 players (challenger-wins)', async () => {
  const sid = await setup(2);
  await db.recordResult(sid, 'challenger-wins');
  let q = await getQ(sid);
  assert(q.length === 1, '1 left');
  assert(q[0].player_name === 'B', 'B king');

  await db.undoLastRemoval(sid);
  q = await getQ(sid);
  assert(q.length === 2, '2 back');
  assert(q[0].player_name === 'A', 'A king');
  assert(q[1].player_name === 'B', 'B challenger');
  console.log(`  T${testNum} ✓ ${names(q)}`);
});
// === MULTIPLE UNDOS ===
console.log('\n📋 SECTION 2: Multiple Undos\n');

await test('5 king-wins then 5 undos', async () => {
  const sid = await setup(10);
  for (let i = 0; i < 5; i++) await db.recordResult(sid, 'king-wins');
  let q = await getQ(sid);
  assert(q.length === 5, '5 eliminated');
  assert(q[0].win_streak === 5, 'A streak 5');

  const expected = ['F','E','D','C','B'];
  for (let i = 0; i < 5; i++) {
    await db.undoLastRemoval(sid);
    q = await getQ(sid);
    const chal = q.find(e => e.position === 2);
    assert(chal !== undefined, `Undo ${i+1}: pos 2 exists`);
    assert(chal.player_name === expected[i], `Undo ${i+1}: ${expected[i]} at pos 2 (got ${chal?.player_name})`);
    assert(q[0].win_streak === 5-i-1, `Undo ${i+1}: streak ${5-i-1}`);
    q.forEach((e,j) => assert(e.position === j+1, `Undo ${i+1}: pos sequential`));
  }
  q = await getQ(sid);
  assert(q.length === 10, 'All 10 back');
  console.log(`  T${testNum} ✓ ${names(q).substring(0,80)}...`);
});

await test('Alternating wins then undo all', async () => {
  const sid = await setup(8);
  await db.recordResult(sid, 'king-wins');      // B out
  await db.recordResult(sid, 'challenger-wins'); // A out, C king
  await db.recordResult(sid, 'king-wins');      // D out
  await db.recordResult(sid, 'challenger-wins'); // C out, E king
  let q = await getQ(sid);
  assert(q[0].player_name === 'E', 'E king');
  assert(q.length === 4, '4 eliminated');

  await db.undoLastRemoval(sid);
  q = await getQ(sid);
  assert(q[0].player_name === 'C', 'Undo 1: C king');
  assert(q.find(e => e.position === 2) !== undefined, 'Undo 1: challenger exists');

  await db.undoLastRemoval(sid);
  q = await getQ(sid);
  assert(q.find(e => e.position === 2).player_name === 'D', 'Undo 2: D challenger');

  await db.undoLastRemoval(sid);
  q = await getQ(sid);
  assert(q[0].player_name === 'A', 'Undo 3: A king');

  await db.undoLastRemoval(sid);
  q = await getQ(sid);
  assert(q[1].player_name === 'B', 'Undo 4: B challenger');
  assert(q.length === 8, 'All 8 back');
  console.log(`  T${testNum} ✓ ${names(q).substring(0,80)}...`);
});

await test('Rapid game+undo x10 cycles', async () => {
  const sid = await setup(6);
  for (let i = 0; i < 10; i++) {
    const res = i % 2 === 0 ? 'king-wins' : 'challenger-wins';
    await db.recordResult(sid, res);
    await db.undoLastRemoval(sid);
    const q = await getQ(sid);
    assert(q.length === 6, `Cycle ${i+1}: 6 players`);
    assert(q.find(e => e.position === 2) !== undefined, `Cycle ${i+1}: challenger exists`);
  }
  const q = await getQ(sid);
  assert(q[0].player_name === 'A', 'A king');
  assert(q[1].player_name === 'B', 'B challenger');
  console.log(`  T${testNum} ✓ ${names(q)}`);
});
// === CONFIRMATION TAGS + UNDO ===
console.log('\n📋 SECTION 3: Waiting Tags & Confirmations\n');

await test('Waiting tags preserved through undo', async () => {
  const sid = await setup(8);
  await db.checkConfirmationTimeouts(sid);
  let q = await getQ(sid);
  assert(!!q.find(e => e.player_name === 'C').confirmation_sent_at, 'C asked (pos 3)');
  assert(!!q.find(e => e.player_name === 'D').confirmation_sent_at, 'D asked (pos 4)');
  assert(!!q.find(e => e.player_name === 'E').confirmation_sent_at, 'E asked (pos 5)');

  await db.recordResult(sid, 'king-wins'); // B out
  await db.undoLastRemoval(sid);
  q = await getQ(sid);
  assert(!!q.find(e => e.player_name === 'C').confirmation_sent_at, 'C conf restored');
  assert(!!q.find(e => e.player_name === 'D').confirmation_sent_at, 'D conf restored');
  assert(!!q.find(e => e.player_name === 'E').confirmation_sent_at, 'E conf restored');
  console.log(`  T${testNum} ✓ ${names(q).substring(0,80)}...`);
});

await test('Confirmed status preserved through undo', async () => {
  const sid = await setup(6);
  await db.checkConfirmationTimeouts(sid);
  await db.confirmPresence(sid, 'phone_C');
  let q = await getQ(sid);
  assert(q.find(e => e.player_name === 'C').status === 'confirmed', 'C confirmed');

  await db.recordResult(sid, 'king-wins');
  await db.undoLastRemoval(sid);
  q = await getQ(sid);
  assert(q.find(e => e.player_name === 'C').status === 'confirmed', 'C still confirmed');
  console.log(`  T${testNum} ✓`);
});

await test('Challenger gets waiting tag from pos 3, keeps it at pos 2 after game', async () => {
  const sid = await setup(6);
  await db.checkConfirmationTimeouts(sid);
  let q = await getQ(sid);
  const cConf = q.find(e => e.player_name === 'C').confirmation_sent_at;
  assert(!!cConf, 'C has conf at pos 3');

  // B eliminated — C becomes challenger at pos 2
  await db.recordResult(sid, 'king-wins');
  q = await getQ(sid);
  const cNow = q.find(e => e.player_name === 'C');
  assert(cNow.position === 2, 'C at pos 2');
  // C's conf tag should persist — it was in the snapshot and recordResult
  // doesn't clear it. Only checkConfirmationTimeouts clears pos 1-2.
  assert(!!cNow.confirmation_sent_at, 'C still has conf at pos 2 (before next timeout check)');
  console.log(`  T${testNum} ✓ C keeps waiting tag at pos 2: ${names(q).substring(0,80)}`);
});

await test('Undo after game preserves challenger waiting tag', async () => {
  const sid = await setup(6);
  await db.checkConfirmationTimeouts(sid);

  await db.recordResult(sid, 'king-wins'); // B out, C→2
  // Now undo
  await db.undoLastRemoval(sid);
  let q = await getQ(sid);
  const c = q.find(e => e.player_name === 'C');
  assert(c.position === 3, 'C back to pos 3');
  assert(!!c.confirmation_sent_at, 'C conf restored at pos 3');
  console.log(`  T${testNum} ✓`);
});
// === EDGE CASES ===
console.log('\n📋 SECTION 4: Edge Cases\n');

await test('New player joins after game, then undo', async () => {
  const sid = await setup(4);
  await db.recordResult(sid, 'king-wins'); // B out
  await db.addToQueue(sid, 'Z', null, 'phone_Z');
  let q = await getQ(sid);
  assert(q.find(e => e.player_name === 'Z') !== undefined, 'Z joined');

  await db.undoLastRemoval(sid);
  q = await getQ(sid);
  assert(q[0].player_name === 'A', 'A king');
  assert(q[1].player_name === 'B', 'B challenger');
  assert(q.find(e => e.player_name === 'Z') !== undefined, 'Z still in');
  const z = q.find(e => e.player_name === 'Z');
  assert(z.position === 5, `Z at end pos 5 (got ${z.position})`);
  q.forEach((e,i) => assert(e.position === i+1, `pos ${i+1}`));
  console.log(`  T${testNum} ✓ ${names(q)}`);
});

await test('Player leaves after game, then undo (they stay gone)', async () => {
  const sid = await setup(6);
  await db.recordResult(sid, 'king-wins'); // B out
  await db.leaveQueue(sid, 'phone_D');
  await db.undoLastRemoval(sid);
  let q = await getQ(sid);
  assert(q.find(e => e.player_name === 'B') !== undefined, 'B restored');
  assert(q.find(e => e.player_name === 'D') === undefined, 'D gone (left voluntarily)');
  q.forEach((e,i) => assert(e.position === i+1, `pos ${i+1}`));
  console.log(`  T${testNum} ✓ ${names(q)}`);
});

await test('Nothing to undo', async () => {
  const sid = await setup(4);
  const result = await db.undoLastRemoval(sid);
  assert(result.error === 'nothing_to_undo', 'nothing_to_undo');
  console.log(`  T${testNum} ✓`);
});

await test('Win streaks accurate through undo cycles', async () => {
  const sid = await setup(6);
  await db.recordResult(sid, 'king-wins'); // A streak 1
  await db.recordResult(sid, 'king-wins'); // A streak 2
  await db.recordResult(sid, 'king-wins'); // A streak 3
  let q = await getQ(sid);
  assert(q[0].win_streak === 3, 'streak 3');

  await db.undoLastRemoval(sid);
  q = await getQ(sid);
  assert(q[0].win_streak === 2, 'streak 2');
  await db.undoLastRemoval(sid);
  q = await getQ(sid);
  assert(q[0].win_streak === 1, 'streak 1');
  await db.undoLastRemoval(sid);
  q = await getQ(sid);
  assert(q[0].win_streak === 0, 'streak 0');
  console.log(`  T${testNum} ✓`);
});

await test('Challenger-wins streak through undo', async () => {
  const sid = await setup(5);
  await db.recordResult(sid, 'challenger-wins'); // B king streak 1
  await db.recordResult(sid, 'king-wins');        // B streak 2
  let q = await getQ(sid);
  assert(q[0].win_streak === 2, 'B streak 2');

  await db.undoLastRemoval(sid);
  q = await getQ(sid);
  assert(q[0].win_streak === 1, 'B streak 1');
  await db.undoLastRemoval(sid);
  q = await getQ(sid);
  assert(q[0].player_name === 'A', 'A king');
  assert(q[0].win_streak === 0, 'A streak 0');
  console.log(`  T${testNum} ✓`);
});
// === FULL SIMULATION ===
console.log('\n📋 SECTION 5: Full Bar Simulation\n');

await test('15 players, 20 games, random undos', async () => {
  const sid = await setup(15);
  let undos = 0, games = 0;
  for (let r = 0; r < 20; r++) {
    let q = await getQ(sid);
    if (q.length < 2) break;
    await db.recordResult(sid, Math.random()<0.5 ? 'king-wins' : 'challenger-wins');
    games++;
    q = await getQ(sid);
    if (q.length >= 2) {
      assert(q.find(e => e.position === 2) !== undefined, `G${r+1}: challenger exists`);
    }
    if (Math.random() < 0.3) {
      await db.undoLastRemoval(sid);
      undos++;
      q = await getQ(sid);
      if (q.length >= 2) assert(q.find(e=>e.position===2) !== undefined, `G${r+1} undo: challenger`);
      q.forEach((e,i) => assert(e.position === i+1, `G${r+1} undo: sequential`));
    }
  }
  console.log(`  T${testNum} ✓ ${games} games, ${undos} undos, all valid`);
});

await test('Games + confirmations + undos interleaved', async () => {
  const sid = await setup(12);
  await db.checkConfirmationTimeouts(sid);
  await db.recordResult(sid, 'king-wins');
  await db.checkConfirmationTimeouts(sid);
  await db.recordResult(sid, 'challenger-wins');
  await db.recordResult(sid, 'king-wins');

  // Undo all 3
  for (let i = 0; i < 3; i++) {
    await db.undoLastRemoval(sid);
    let q = await getQ(sid);
    if (q.length >= 2) assert(q.find(e=>e.position===2) !== undefined, `Undo ${i+1}: challenger`);
    q.forEach((e,j) => assert(e.position === j+1, `Undo ${i+1}: sequential`));
  }
  let q = await getQ(sid);
  assert(q[0].player_name === 'A', 'A king');
  assert(q[1].player_name === 'B', 'B challenger');
  assert(q.length === 12, 'All 12 back');
  console.log(`  T${testNum} ✓ ${names(q).substring(0,80)}...`);
});

await test('20 players, 10 games, undo all, 10 more, undo all', async () => {
  const sid = await setup(20);
  for (let i = 0; i < 10; i++) {
    await db.recordResult(sid, i%3===0 ? 'challenger-wins' : 'king-wins');
  }
  for (let i = 0; i < 10; i++) {
    await db.undoLastRemoval(sid);
    let q = await getQ(sid);
    assert(q.find(e=>e.position===2) !== undefined, `Batch1 undo ${i+1}: challenger`);
    q.forEach((e,j) => assert(e.position === j+1, `Batch1 undo ${i+1}: seq`));
  }
  let q = await getQ(sid);
  assert(q.length === 20, 'All 20 back');

  for (let i = 0; i < 10; i++) await db.recordResult(sid, 'king-wins');
  for (let i = 0; i < 10; i++) {
    await db.undoLastRemoval(sid);
    q = await getQ(sid);
    assert(q.find(e=>e.position===2) !== undefined, `Batch2 undo ${i+1}: challenger`);
  }
  q = await getQ(sid);
  assert(q.length === 20, 'All 20 back again');
  console.log(`  T${testNum} ✓`);
});

// === RESULTS ===
console.log('\n==========================================');
console.log(`🎱 UNDO TEST RESULTS: ${passed} passed, ${failed} failed`);
if (failures.length) { console.log('\n🚨 FAILURES:'); failures.forEach(f => console.log(f)); }
if (failed === 0) console.log('✅ ALL UNDO TESTS PASSED');
console.log('==========================================\n');

}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });
