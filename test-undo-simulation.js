// POOL CUE — UNDO SYSTEM STRESS TEST
// Simulates full bar usage: add names, play games, undo, check everything
delete process.env.DATABASE_URL;
const db = require('./db');

let testNum = 0, passed = 0, failed = 0;
const failures = [];

function assert(cond, msg) {
  if (!cond) { failures.push(`  ❌ T${testNum}: ${msg}`); failed++; }
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
  const s = await db.createSession('table1', '0000');
  for (let i = 0; i < n; i++) {
    const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i];
    await db.addToQueue(s.id, L, null, `phone_${L}`);
  }
  return s.id;
}

async function run() {
await db.init();
console.log('\n🔧 UNDO SYSTEM STRESS TEST\n==========================================\n');

// === SECTION 1: Basic Swipe + Undo ===
console.log('📋 SECTION 1: Basic Swipe + Undo\n');

await test('King-wins then undo: challenger returns to pos 2', async () => {
  const sid = await setup(6);
  await db.recordResult(sid, 'king-wins');
  let q = await getQ(sid);
  assert(q[0].player_name === 'A', 'A still king');
  assert(q[1].player_name === 'C', 'C new challenger');
  assert(q.length === 5, 'B eliminated');

  await db.undoLastRemoval(sid);
  q = await getQ(sid);
  assert(q.length === 6, '6 players back');
  assert(q[0].player_name === 'A', 'A king');
  assert(q[1].player_name === 'B', 'B challenger back');
  assert(q[2].player_name === 'C', 'C back to pos 3');
  q.forEach((e, i) => assert(e.position === i+1, `Pos ${i+1} sequential`));
  console.log(`  T${testNum} ✓ King-wins undo: ${names(q)}`);
});

await test('Challenger-wins then undo: king returns', async () => {
  const sid = await setup(6);
  await db.recordResult(sid, 'challenger-wins');
  let q = await getQ(sid);
  assert(q[0].player_name === 'B', 'B king');
  assert(q[0].win_streak === 1, 'B streak 1');

  await db.undoLastRemoval(sid);
  q = await getQ(sid);
  assert(q[0].player_name === 'A', 'A king again');
  assert(q[0].win_streak === 0, 'A streak 0');
  assert(q[1].player_name === 'B', 'B challenger');
  q.forEach((e, i) => assert(e.position === i+1, `Pos ${i+1} sequential`));
  console.log(`  T${testNum} ✓ Challenger-wins undo: ${names(q)}`);
});

await test('Undo always has challenger when 2+ players', async () => {
  const sid = await setup(5);
  for (let i = 0; i < 3; i++) await db.recordResult(sid, 'king-wins');
  let q = await getQ(sid);
  assert(q.length === 2, '3 eliminated');

  for (let i = 0; i < 3; i++) {
    await db.undoLastRemoval(sid);
    q = await getQ(sid);
    const ch = q.find(e => e.position === 2);
    assert(ch !== undefined, `Undo ${i+1}: pos 2 exists`);
    assert(ch.player_name !== undefined, `Undo ${i+1}: challenger has name`);
    q.forEach((e, j) => assert(e.position === j+1, `Undo ${i+1}: sequential`));
  }
  assert((await getQ(sid)).length === 5, 'All 5 restored');
  console.log(`  T${testNum} ✓ Challenger always present after undo`);
});

// === SECTION 2: Confirmation Tags + Undo ===
console.log('\n📋 SECTION 2: Confirmation Tags + Undo\n');

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
  console.log(`  T${testNum} ✓ Waiting tags preserved: ${names(q)}`);
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
  console.log(`  T${testNum} ✓ Confirmed status preserved`);
});

await test('Challenger waiting tag after promotion to pos 2', async () => {
  const sid = await setup(6);
  await db.checkConfirmationTimeouts(sid);
  let q = await getQ(sid);
  const cConfBefore = !!q.find(e => e.player_name === 'C').confirmation_sent_at;
  assert(cConfBefore, 'C was asked at pos 3');

  await db.recordResult(sid, 'king-wins'); // B out, C promoted to challenger
  q = await getQ(sid);
  const c = q.find(e => e.player_name === 'C');
  assert(c.position === 2, 'C is now challenger');
  // C should still have confirmation_sent_at from when they were asked at pos 3
  console.log(`  T${testNum} Info: C at pos 2 - conf_sent=${!!c.confirmation_sent_at}, status=${c.status}`);
  
  // Now undo - C should go back to pos 3 with original conf status
  await db.undoLastRemoval(sid);
  q = await getQ(sid);
  const cAfter = q.find(e => e.player_name === 'C');
  assert(cAfter.position === 3, 'C back to pos 3');
  assert(!!cAfter.confirmation_sent_at, 'C conf restored after undo');
  console.log(`  T${testNum} ✓ Challenger tag + undo: ${names(q)}`);
});

// === SECTION 3: Rapid Multiple Undos ===
console.log('\n📋 SECTION 3: Rapid Multiple Undos\n');

await test('5 king-wins then 5 undos: perfect revert', async () => {
  const sid = await setup(10);
  for (let i = 0; i < 5; i++) await db.recordResult(sid, 'king-wins');
  let q = await getQ(sid);
  assert(q.length === 5, '5 eliminated');
  assert(q[0].win_streak === 5, 'A 5-win streak');

  const expected = ['F', 'E', 'D', 'C', 'B'];
  for (let i = 0; i < 5; i++) {
    await db.undoLastRemoval(sid);
    q = await getQ(sid);
    const ch = q.find(e => e.position === 2);
    assert(ch !== undefined, `Undo ${i+1}: pos 2 exists`);
    assert(ch.player_name === expected[i], `Undo ${i+1}: ${expected[i]} challenger (got ${ch?.player_name})`);
    assert(q[0].win_streak === 5 - i - 1, `Undo ${i+1}: streak=${5-i-1}`);
    q.forEach((e, j) => assert(e.position === j+1, `Undo ${i+1}: sequential`));
  }
  q = await getQ(sid);
  assert(q.length === 10, 'All 10 back');
  console.log(`  T${testNum} ✓ 5 games + 5 undos: ${names(q).substring(0,80)}...`);
});

await test('Alternating king/challenger wins then undo all', async () => {
  const sid = await setup(8);
  await db.recordResult(sid, 'king-wins');       // B out
  await db.recordResult(sid, 'challenger-wins');  // A out, C king
  await db.recordResult(sid, 'king-wins');       // D out
  await db.recordResult(sid, 'challenger-wins');  // C out, E king
  let q = await getQ(sid);
  assert(q[0].player_name === 'E', 'E king');
  assert(q.length === 4, '4 left');

  await db.undoLastRemoval(sid);
  q = await getQ(sid);
  assert(q[0].player_name === 'C', 'Undo1: C king');
  assert(q.find(e => e.position === 2) !== undefined, 'Undo1: challenger exists');

  await db.undoLastRemoval(sid);
  q = await getQ(sid);
  assert(q.find(e => e.position === 2).player_name === 'D', 'Undo2: D challenger');

  await db.undoLastRemoval(sid);
  q = await getQ(sid);
  assert(q[0].player_name === 'A', 'Undo3: A king');

  await db.undoLastRemoval(sid);
  q = await getQ(sid);
  assert(q[0].player_name === 'A' && q[1].player_name === 'B', 'Undo4: A+B');
  assert(q.length === 8, 'All 8 back');
  q.forEach((e, i) => assert(e.position === i+1, 'Final sequential'));
  console.log(`  T${testNum} ✓ Alternating wins + undo all`);
});

await test('Rapid game+undo x10', async () => {
  const sid = await setup(6);
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 'king-wins' : 'challenger-wins';
    await db.recordResult(sid, r);
    await db.undoLastRemoval(sid);
    const q = await getQ(sid);
    assert(q.length === 6, `Round ${i+1}: 6 players`);
    assert(q.find(e => e.position === 2) !== undefined, `Round ${i+1}: challenger`);
    q.forEach((e, j) => assert(e.position === j+1, `Round ${i+1}: sequential`));
  }
  const q = await getQ(sid);
  assert(q[0].player_name === 'A' && q[1].player_name === 'B', 'A+B after all');
  console.log(`  T${testNum} ✓ 10 rapid game+undo cycles`);
});

// === SECTION 4: Edge Cases ===
console.log('\n📋 SECTION 4: Edge Cases\n');

await test('Undo with only 2 players (king-wins)', async () => {
  const sid = await setup(2);
  await db.recordResult(sid, 'king-wins');
  assert((await getQ(sid)).length === 1, 'Only A left');
  await db.undoLastRemoval(sid);
  const q = await getQ(sid);
  assert(q.length === 2 && q[0].player_name === 'A' && q[1].player_name === 'B', '2 back');
  console.log(`  T${testNum} ✓ 2-player king-wins undo: ${names(q)}`);
});

await test('Undo with only 2 players (challenger-wins)', async () => {
  const sid = await setup(2);
  await db.recordResult(sid, 'challenger-wins');
  let q = await getQ(sid);
  assert(q.length === 1 && q[0].player_name === 'B', 'Only B');
  await db.undoLastRemoval(sid);
  q = await getQ(sid);
  assert(q.length === 2 && q[0].player_name === 'A' && q[1].player_name === 'B', '2 back');
  console.log(`  T${testNum} ✓ 2-player challenger-wins undo: ${names(q)}`);
});

await test('New player joins after game then undo', async () => {
  const sid = await setup(4);
  await db.recordResult(sid, 'king-wins');
  await db.addToQueue(sid, 'Z', null, 'phone_Z');
  await db.undoLastRemoval(sid);
  const q = await getQ(sid);
  assert(q[0].player_name === 'A', 'A king');
  assert(q[1].player_name === 'B', 'B challenger');
  assert(q.find(e => e.player_name === 'Z') !== undefined, 'Z still there');
  assert(q.find(e => e.player_name === 'Z').position === 5, 'Z at end');
  q.forEach((e, i) => assert(e.position === i+1, 'Sequential'));
  console.log(`  T${testNum} ✓ New join + undo: ${names(q)}`);
});

await test('Someone leaves after game then undo', async () => {
  const sid = await setup(6);
  await db.recordResult(sid, 'king-wins');
  await db.leaveQueue(sid, 'phone_D');
  await db.undoLastRemoval(sid);
  const q = await getQ(sid);
  assert(q.find(e => e.player_name === 'B') !== undefined, 'B restored');
  assert(q.find(e => e.player_name === 'D') === undefined, 'D still gone');
  q.forEach((e, i) => assert(e.position === i+1, 'Sequential'));
  console.log(`  T${testNum} ✓ Leave + undo: ${names(q)}`);
});

await test('Nothing to undo', async () => {
  const sid = await setup(4);
  const r = await db.undoLastRemoval(sid);
  assert(r.error === 'nothing_to_undo', 'Error returned');
  console.log(`  T${testNum} ✓ Nothing to undo handled`);
});

// === SECTION 5: Full Bar Simulation ===
console.log('\n📋 SECTION 5: Full Bar Simulation\n');

await test('15 players, 20 games, random undos', async () => {
  const sid = await setup(15);
  let undos = 0, games = 0;
  for (let r = 0; r < 20; r++) {
    let q = await getQ(sid);
    if (q.length < 2) break;
    await db.recordResult(sid, Math.random() < 0.5 ? 'king-wins' : 'challenger-wins');
    games++;
    q = await getQ(sid);
    if (q.length >= 2) assert(q.find(e => e.position === 2) !== undefined, `Game ${r+1}: challenger`);
    if (Math.random() < 0.3) {
      await db.undoLastRemoval(sid);
      undos++;
      q = await getQ(sid);
      if (q.length >= 2) assert(q.find(e => e.position === 2) !== undefined, `Undo ${r+1}: challenger`);
      q.forEach((e, i) => assert(e.position === i+1, `Undo ${r+1}: sequential`));
    }
  }
  const q = await getQ(sid);
  q.forEach((e, i) => assert(e.position === i+1, 'Final sequential'));
  console.log(`  T${testNum} ✓ ${games} games, ${undos} undos, all valid`);
});

await test('Games + confirmations + undos interleaved', async () => {
  const sid = await setup(12);
  await db.checkConfirmationTimeouts(sid);
  await db.recordResult(sid, 'king-wins');
  await db.checkConfirmationTimeouts(sid);
  let q = await getQ(sid);
  const p3 = q.find(e => e.position === 3);
  if (p3) await db.confirmPresence(sid, p3.phone_id);
  await db.recordResult(sid, 'challenger-wins');
  await db.recordResult(sid, 'king-wins');

  for (let i = 0; i < 3; i++) {
    await db.undoLastRemoval(sid);
    q = await getQ(sid);
    assert(q.find(e => e.position === 2) !== undefined, `Undo ${i+1}: challenger`);
    q.forEach((e, j) => assert(e.position === j+1, `Undo ${i+1}: sequential`));
  }
  q = await getQ(sid);
  assert(q[0].player_name === 'A' && q[1].player_name === 'B', 'A+B restored');
  assert(q.length === 12, 'All 12 back');
  console.log(`  T${testNum} ✓ Interleaved games/confirms/undos`);
});

await test('20 players, 10 games, undo all, 10 more, undo all', async () => {
  const sid = await setup(20);
  for (let i = 0; i < 10; i++) await db.recordResult(sid, i%3===0 ? 'challenger-wins' : 'king-wins');
  assert((await getQ(sid)).length === 10, '10 eliminated');
  for (let i = 0; i < 10; i++) {
    await db.undoLastRemoval(sid);
    const q = await getQ(sid);
    assert(q.find(e => e.position === 2) !== undefined, `Batch1 undo ${i+1}: challenger`);
    q.forEach((e, j) => assert(e.position === j+1, `Batch1 undo ${i+1}: sequential`));
  }
  assert((await getQ(sid)).length === 20, 'All 20 back');
  for (let i = 0; i < 10; i++) await db.recordResult(sid, 'king-wins');
  for (let i = 0; i < 10; i++) {
    await db.undoLastRemoval(sid);
    const q = await getQ(sid);
    assert(q.find(e => e.position === 2) !== undefined, `Batch2 undo ${i+1}: challenger`);
  }
  const q = await getQ(sid);
  assert(q.length === 20, 'All 20 back again');
  q.forEach((e, i) => assert(e.position === i+1, 'Final sequential'));
  console.log(`  T${testNum} ✓ 2 batches of 10 + undo all`);
});

// === SECTION 6: Win Streak Accuracy ===
console.log('\n📋 SECTION 6: Win Streaks\n');

await test('Win streaks correct through undo cycles', async () => {
  const sid = await setup(6);
  await db.recordResult(sid, 'king-wins'); // A streak 1
  await db.recordResult(sid, 'king-wins'); // A streak 2
  await db.recordResult(sid, 'king-wins'); // A streak 3
  assert((await getQ(sid))[0].win_streak === 3, 'A streak 3');
  await db.undoLastRemoval(sid);
  assert((await getQ(sid))[0].win_streak === 2, 'Undo: streak 2');
  await db.undoLastRemoval(sid);
  assert((await getQ(sid))[0].win_streak === 1, 'Undo: streak 1');
  await db.undoLastRemoval(sid);
  assert((await getQ(sid))[0].win_streak === 0, 'Undo: streak 0');
  console.log(`  T${testNum} ✓ Streaks track through undos`);
});

await test('Challenger-wins streak + undo', async () => {
  const sid = await setup(5);
  await db.recordResult(sid, 'challenger-wins'); // B king, streak 1
  await db.recordResult(sid, 'king-wins');       // B streak 2
  assert((await getQ(sid))[0].win_streak === 2, 'B streak 2');
  await db.undoLastRemoval(sid);
  assert((await getQ(sid))[0].win_streak === 1, 'B streak 1');
  await db.undoLastRemoval(sid);
  let q = await getQ(sid);
  assert(q[0].player_name === 'A' && q[0].win_streak === 0, 'A king streak 0');
  console.log(`  T${testNum} ✓ Challenger-wins streaks + undo`);
});

// === Results ===
console.log('\n==========================================');
if (failures.length > 0) {
  console.log(`🎱 RESULTS: ${passed} passed, ${failed} failed\n`);
  console.log('🚨 FAILURES:');
  failures.forEach(f => console.log(f));
} else {
  console.log(`🎱 RESULTS: ${passed} passed, ${failed} failed`);
  console.log('✅ ALL UNDO TESTS PASSED');
}
console.log('==========================================\n');
}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });
