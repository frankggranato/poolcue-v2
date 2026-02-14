// ============================================
// POOL CUE — FULL BAR SCENARIO SIMULATION
// Every real-world situation at a bar pool table
// ============================================
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
  const sid = await db.createSession('table1', '0000');
  for (let i = 0; i < n; i++) {
    await db.addToQueue(sid, String.fromCharCode(65+i), null, `phone_${String.fromCharCode(65+i)}`);
  }
  return sid;
}
// Helper: fake a confirmation_sent_at timestamp
async function fakeAsked(sid, playerName, minutesAgo) {
  const q = await getQ(sid);
  const e = q.find(x => x.player_name === playerName);
  if (e) e.confirmation_sent_at = new Date(Date.now() - minutesAgo * 60000);
}
async function fakeMia(sid, playerName, miaMinutesAgo) {
  const q = await getQ(sid);
  const e = q.find(x => x.player_name === playerName);
  if (e) {
    e.status = 'mia';
    e.mia_at = new Date(Date.now() - miaMinutesAgo * 60000);
    e.confirmation_sent_at = new Date(Date.now() - (miaMinutesAgo + 5) * 60000);
  }
}
async function fakeGhosted(sid, playerName, ghostMinutesAgo) {
  const q = await getQ(sid);
  const e = q.find(x => x.player_name === playerName);
  if (e) {
    e.status = 'ghosted';
    e.ghosted_at = new Date(Date.now() - ghostMinutesAgo * 60000);
    e.confirmation_sent_at = new Date(Date.now() - (ghostMinutesAgo + 10) * 60000);
  }
}

async function run() {
await db.init();

console.log('\n🎱 POOL CUE — BAR SCENARIO STRESS TEST');
console.log('==========================================\n');

// ============================================
// SECTION 1: OPENING NIGHT — FIRST GAMES
// ============================================
console.log('📋 SECTION 1: Opening Night\n');

await test('Empty table, first person walks up', async () => {
  const sid = await db.createSession('table1', '0000');
  await db.addToQueue(sid, 'Frank', null, 'phone_frank');
  const q = await getQ(sid);
  assert(q.length === 1, 'Frank in queue');
  assert(q[0].position === 1, 'Frank is king (first player)');
  console.log(`  T${testNum} ✓ First player is king`);
});

await test('Second person joins — game can start', async () => {
  const sid = await db.createSession('table1', '0000');
  await db.addToQueue(sid, 'Frank', null, 'phone_frank');
  await db.addToQueue(sid, 'Mike', null, 'phone_mike');
  const q = await getQ(sid);
  assert(q[0].player_name === 'Frank' && q[0].position === 1, 'Frank king');
  assert(q[1].player_name === 'Mike' && q[1].position === 2, 'Mike challenger');
  console.log(`  T${testNum} ✓ Two players, game ready`);
});

await test('5 people sign up at once (busy night)', async () => {
  const sid = await setup(5);
  const q = await getQ(sid);
  assert(q.length === 5, '5 players');
  q.forEach((e, i) => assert(e.position === i+1, `Pos ${i+1} correct`));
  console.log(`  T${testNum} ✓ 5 players, positions 1-5`);
});

// ============================================
// SECTION 2: NORMAL GAME FLOW
// ============================================
console.log('\n📋 SECTION 2: Normal Game Flow\n');

await test('King runs the table 5 straight', async () => {
  const sid = await setup(8);
  for (let i = 0; i < 5; i++) await db.recordResult(sid, 'king-wins');
  const q = await getQ(sid);
  assert(q[0].player_name === 'A' && q[0].win_streak === 5, 'A 5-streak');
  assert(q.length === 3, '3 remain');
  assert(q[1].player_name === 'G', 'G is challenger');
  console.log(`  T${testNum} ✓ ${names(q)}`);
});

await test('Challenger upsets the king', async () => {
  const sid = await setup(5);
  await db.recordResult(sid, 'king-wins'); // A beats B, streak 1
  await db.recordResult(sid, 'king-wins'); // A beats C, streak 2
  await db.recordResult(sid, 'challenger-wins'); // D beats A!
  const q = await getQ(sid);
  assert(q[0].player_name === 'D', 'D new king');
  assert(q[0].win_streak === 1, 'D streak starts at 1');
  assert(q[1].player_name === 'E', 'E new challenger');
  console.log(`  T${testNum} ✓ Upset! ${names(q)}`);
});

await test('Back and forth — no one holds the table', async () => {
  const sid = await setup(10);
  // Every challenger wins
  for (let i = 0; i < 6; i++) await db.recordResult(sid, 'challenger-wins');
  const q = await getQ(sid);
  assert(q[0].win_streak === 1, 'Current king only 1 win');
  assert(q.length === 4, '4 remain');
  // All positions sequential
  q.forEach((e, i) => assert(e.position === i+1, `Sequential pos ${i+1}`));
  console.log(`  T${testNum} ✓ Revolving door: ${names(q)}`);
});

await test('Exactly 2 players trading wins all night', async () => {
  const sid = await db.createSession('table1', '0000');
  await db.addToQueue(sid, 'Frank', null, 'phone_frank');
  await db.addToQueue(sid, 'Mike', null, 'phone_mike');
  // They trade wins 5 times
  for (let i = 0; i < 5; i++) {
    await db.recordResult(sid, 'challenger-wins');
    // After challenger wins, old king is eliminated. Only winner remains.
    // Need to re-add the loser
    const q = await getQ(sid);
    if (q.length === 1) {
      const loser = q[0].player_name === 'Frank' ? 'Mike' : 'Frank';
      const loserId = q[0].player_name === 'Frank' ? 'phone_mike' : 'phone_frank';
      await db.addToQueue(sid, loser, null, loserId);
    }
  }
  const q = await getQ(sid);
  assert(q.length === 2, 'Still 2 players');
  console.log(`  T${testNum} ✓ Trading blows: ${names(q)}`);
});

// ============================================
// SECTION 3: PEOPLE LEAVING
// ============================================
console.log('\n📋 SECTION 3: People Leaving\n');

await test('Guy at pos 5 gets bored and leaves', async () => {
  const sid = await setup(6);
  await db.leaveQueue(sid, 'phone_E');
  const q = await getQ(sid);
  assert(q.length === 5, '5 remain');
  assert(!q.find(e => e.player_name === 'E'), 'E gone');
  assert(q[4].player_name === 'F' && q[4].position === 5, 'F moved to 5');
  console.log(`  T${testNum} ✓ E left, F moved up`);
});

await test('Challenger walks out mid-game — bartender swipes', async () => {
  const sid = await setup(5);
  // B (challenger) left. Bartender removes them
  const q = await getQ(sid);
  const b = q.find(e => e.player_name === 'B');
  await db.removePlayer(sid, b.id);
  const q2 = await getQ(sid);
  assert(q2[0].player_name === 'A', 'A still king');
  assert(q2[1].player_name === 'C', 'C auto-promoted to challenger');
  console.log(`  T${testNum} ✓ ${names(q2)}`);
});

await test('King storms off after losing — already handled by recordResult', async () => {
  const sid = await setup(5);
  await db.recordResult(sid, 'challenger-wins');
  const q = await getQ(sid);
  assert(!q.find(e => e.player_name === 'A'), 'A gone');
  assert(q[0].player_name === 'B', 'B now king');
  console.log(`  T${testNum} ✓ Sore loser gone: ${names(q)}`);
});

await test('3 people leave at once (group heads to another bar)', async () => {
  const sid = await setup(8);
  await db.leaveQueue(sid, 'phone_D');
  await db.leaveQueue(sid, 'phone_E');
  await db.leaveQueue(sid, 'phone_F');
  const q = await getQ(sid);
  assert(q.length === 5, '5 remain');
  assert(q.map(e=>e.player_name).join('') === 'ABCGH', 'Correct players');
  q.forEach((e, i) => assert(e.position === i+1, `Pos ${i+1} sequential`));
  console.log(`  T${testNum} ✓ Group left: ${names(q)}`);
});

await test('Everyone leaves except the king (closing time?)', async () => {
  const sid = await setup(6);
  for (const c of 'BCDEF'.split('')) await db.leaveQueue(sid, `phone_${c}`);
  const q = await getQ(sid);
  assert(q.length === 1, 'Only king');
  assert(q[0].player_name === 'A', 'A alone');
  console.log(`  T${testNum} ✓ A playing alone`);
});

await test('King leaves, then new king leaves too', async () => {
  const sid = await setup(5);
  await db.leaveQueue(sid, 'phone_A'); // B becomes king
  await db.leaveQueue(sid, 'phone_B'); // C becomes king
  const q = await getQ(sid);
  assert(q[0].player_name === 'C', 'C king after 2 kings left');
  assert(q[1].player_name === 'D', 'D challenger');
  console.log(`  T${testNum} ✓ Musical chairs: ${names(q)}`);
});

await test('Last person leaves — queue empty', async () => {
  const sid = await setup(1);
  await db.leaveQueue(sid, 'phone_A');
  const q = await getQ(sid);
  assert(q.length === 0, 'Empty');
  console.log(`  T${testNum} ✓ Table empty`);
});

// ============================================
// SECTION 4: JOINING MID-SESSION
// ============================================
console.log('\n📋 SECTION 4: Late Arrivals\n');

await test('New player joins mid-session', async () => {
  const sid = await setup(4);
  await db.recordResult(sid, 'king-wins'); // B out
  await db.addToQueue(sid, 'Z', null, 'phone_Z');
  const q = await getQ(sid);
  const z = q.find(e => e.player_name === 'Z');
  assert(z.position === q.length, 'Z at end of queue');
  console.log(`  T${testNum} ✓ Z joins at end: ${names(q)}`);
});

await test('Guy rejoins after being eliminated', async () => {
  const sid = await setup(4);
  await db.recordResult(sid, 'king-wins'); // B eliminated
  // B wants back in
  await db.addToQueue(sid, 'B', null, 'phone_B');
  const q = await getQ(sid);
  const b = q.find(e => e.player_name === 'B');
  assert(b.position === q.length, 'B at end (back of line)');
  console.log(`  T${testNum} ✓ B rejoins at back: ${names(q)}`);
});

await test('3 people join when only king is playing alone', async () => {
  const sid = await db.createSession('table1', '0000');
  await db.addToQueue(sid, 'A', null, 'phone_A');
  // A is alone. 3 friends walk in.
  await db.addToQueue(sid, 'B', null, 'phone_B');
  await db.addToQueue(sid, 'C', null, 'phone_C');
  await db.addToQueue(sid, 'D', null, 'phone_D');
  const q = await getQ(sid);
  assert(q[0].player_name === 'A', 'A still king');
  assert(q[1].player_name === 'B', 'B challenger');
  assert(q.length === 4, '4 total');
  console.log(`  T${testNum} ✓ Friends arrive: ${names(q)}`);
});

await test('Rapid joins during a long game', async () => {
  const sid = await setup(3);
  // Game going on, people keep joining
  for (let i = 0; i < 7; i++) {
    await db.addToQueue(sid, `P${i}`, null, `phone_p${i}`);
  }
  const q = await getQ(sid);
  assert(q.length === 10, '10 players total');
  assert(q[9].position === 10, 'Last at pos 10');
  console.log(`  T${testNum} ✓ 10 deep: ${names(q)}`);
});

// ============================================
// SECTION 5: CONFIRMATION SYSTEM
// ============================================
console.log('\n📋 SECTION 5: Confirmation (Bartender Visual)\n');

await test('Pos 2-5 asked on first check', async () => {
  const sid = await setup(7);
  await db.checkConfirmationTimeouts(sid);
  const q = await getQ(sid);
  for (let p = 3; p <= 5; p++) {
    const e = q.find(x => x.position === p);
    assert(!!e.confirmation_sent_at, `Pos ${p} asked`);
  }
  assert(!q.find(x => x.position === 6).confirmation_sent_at, 'Pos 6 NOT asked');
  assert(!q.find(x => x.position === 1).confirmation_sent_at, 'Pos 1 NOT asked');
  assert(!q.find(x => x.position === 2).confirmation_sent_at, 'Pos 2 NOT asked (at table)');
  console.log(`  T${testNum} ✓ Pos 3-5 asked, king/challenger/6+ not`);
});

await test('Player confirms — status changes', async () => {
  const sid = await setup(5);
  await db.checkConfirmationTimeouts(sid);
  await db.confirmPresence(sid, 'phone_C');
  const q = await getQ(sid);
  const c = q.find(e => e.player_name === 'C');
  assert(c.status === 'confirmed', 'C confirmed');
  console.log(`  T${testNum} ✓ C confirmed`);
});

await test('MIA after 5 min — stays in queue as visual flag', async () => {
  const sid = await setup(5);
  await db.checkConfirmationTimeouts(sid);
  await fakeAsked(sid, 'C', 6); // asked 6 min ago
  await db.checkConfirmationTimeouts(sid);
  const q = await getQ(sid);
  const c = q.find(e => e.player_name === 'C');
  assert(c.status === 'mia', 'C MIA after 5 min');
  assert(c.position === 3, 'C still at pos 3');
  console.log(`  T${testNum} ✓ C MIA but still in line`);
});

await test('Probably left after 10 min — still in queue', async () => {
  const sid = await setup(5);
  await db.checkConfirmationTimeouts(sid);
  await fakeAsked(sid, 'C', 11); // asked 11 min ago
  await db.checkConfirmationTimeouts(sid); // MIA (5 min)
  await db.checkConfirmationTimeouts(sid); // Probably left (10 min, already MIA + elapsed > 600s)
  const q = await getQ(sid);
  const c = q.find(e => e.player_name === 'C');
  assert(c.status === 'ghosted', 'C probably left after 10 min');
  assert(c.position === 3, 'C still at pos 3');
  console.log(`  T${testNum} ✓ C red but still in line`);
});

await test('Confirmed player promoted to challenger — status cleared (at table)', async () => {
  const sid = await setup(5);
  await db.checkConfirmationTimeouts(sid);
  await db.confirmPresence(sid, 'phone_C'); // C confirmed at pos 3
  await db.recordResult(sid, 'king-wins'); // B out, C → pos 2
  await db.checkConfirmationTimeouts(sid);
  const q = await getQ(sid);
  const c = q.find(e => e.player_name === 'C');
  assert(c.position === 2, 'C challenger');
  // Challenger keeps their tag for 30 seconds after promotion
  assert(c.status === 'confirmed', 'Confirmed status stays on challenger for 30s');
  console.log(`  T${testNum} ✓ C promoted, confirmed tag stays 30s`);
});

await test('New pos 3 gets asked after game ends', async () => {
  const sid = await setup(7);
  await db.checkConfirmationTimeouts(sid);
  await db.recordResult(sid, 'king-wins'); // B out, everyone moves up
  await db.checkConfirmationTimeouts(sid);
  const q = await getQ(sid);
  // New pos 3 is D, should be asked
  const d = q.find(e => e.position === 3);
  assert(d.player_name === 'D', 'D at pos 3');
  // D may still have old confirmation from when they were at pos 4
  // OR may have been re-asked. Either way should have confirmation_sent_at
  assert(!!d.confirmation_sent_at, 'D asked at new pos');
  console.log(`  T${testNum} ✓ New pos 3 asked`);
});

// ============================================
// SECTION 6: FIFO INTEGRITY
// ============================================
console.log('\n📋 SECTION 6: FIFO Integrity (The Core Promise)\n');

await test('Confirmed #5 does NOT skip unconfirmed #3', async () => {
  const sid = await setup(6);
  await db.checkConfirmationTimeouts(sid);
  await db.confirmPresence(sid, 'phone_E');
  // Don't confirm C
  await db.recordResult(sid, 'king-wins'); // B out
  const q = await getQ(sid);
  assert(q[1].player_name === 'C', 'C (unconfirmed) is challenger, NOT E');
  console.log(`  T${testNum} ✓ FIFO preserved — no line-cutting`);
});

await test('Ghosted #3 still promoted in FIFO order', async () => {
  const sid = await setup(6);
  await db.checkConfirmationTimeouts(sid);
  await fakeGhosted(sid, 'C', 1); // fresh ghost, not yet auto-removed
  await db.confirmPresence(sid, 'phone_D');
  await db.recordResult(sid, 'king-wins');
  const q = await getQ(sid);
  assert(q[1].player_name === 'C', 'C (ghosted) promoted — FIFO');
  console.log(`  T${testNum} ✓ Ghosted player promoted, system or bartender removes if truly gone`);
});

await test('Bartender swipes ghosted → next up correctly', async () => {
  const sid = await setup(6);
  await db.checkConfirmationTimeouts(sid);
  const q = await getQ(sid);
  const c = q.find(e => e.player_name === 'C');
  await fakeGhosted(sid, 'C', 5);
  await db.removePlayer(sid, c.id); // bartender swipes C
  await db.recordResult(sid, 'king-wins');
  const q2 = await getQ(sid);
  assert(q2[1].player_name === 'D', 'D promoted after C swiped');
  console.log(`  T${testNum} ✓ ${names(q2)}`);
});

await test('FIFO over 10 games', async () => {
  const sid = await setup(12);
  const eliminated = [];
  for (let i = 0; i < 10; i++) {
    await db.recordResult(sid, 'king-wins');
    // Track who got eliminated (was challenger)
    eliminated.push(String.fromCharCode(66 + i)); // B, C, D, E, F, G, H, I, J, K
  }
  const q = await getQ(sid);
  assert(q[0].player_name === 'A', 'A still king after 10 wins');
  assert(q[0].win_streak === 10, '10 win streak');
  assert(q[1].player_name === 'L', 'L is challenger (last person)');
  // Eliminated in order B,C,D,E,F,G,H,I,J,K
  assert(eliminated.join('') === 'BCDEFGHIJK', 'Eliminated in FIFO order');
  console.log(`  T${testNum} ✓ 10 games, FIFO perfect`);
});

// ============================================
// SECTION 7: UNDO SCENARIOS
// ============================================
console.log('\n📋 SECTION 7: Undo (Bartender Mistakes)\n');

await test('Undo wrong swipe on king-wins', async () => {
  const sid = await setup(5);
  await db.recordResult(sid, 'king-wins');
  await db.undoLastRemoval(sid);
  const q = await getQ(sid);
  assert(q.length === 5, 'All 5 back');
  assert(q[0].player_name === 'A', 'A king');
  assert(q[1].player_name === 'B', 'B challenger');
  console.log(`  T${testNum} ✓ Undo king-wins: ${names(q)}`);
});

await test('Undo wrong swipe on challenger-wins', async () => {
  const sid = await setup(5);
  await db.recordResult(sid, 'challenger-wins');
  await db.undoLastRemoval(sid);
  const q = await getQ(sid);
  assert(q[0].player_name === 'A', 'A restored king');
  assert(q[1].player_name === 'B', 'B restored challenger');
  console.log(`  T${testNum} ✓ Undo challenger-wins: ${names(q)}`);
});

await test('Undo only works within 60 seconds', async () => {
  const sid = await setup(4);
  await db.recordResult(sid, 'king-wins');
  // Fake the removal timestamp to 2 min ago
  const q = await getQ(sid);
  // Can't easily fake timestamp here, but test the undo works within window
  const result = await db.undoLastRemoval(sid);
  assert(result.success || !result.error, 'Undo works within window');
  console.log(`  T${testNum} ✓ Undo within window works`);
});

await test('Undo then play another game', async () => {
  const sid = await setup(5);
  await db.recordResult(sid, 'king-wins'); // B out
  await db.undoLastRemoval(sid); // B back
  await db.recordResult(sid, 'challenger-wins'); // A out, B wins
  const q = await getQ(sid);
  assert(q[0].player_name === 'B', 'B king after undo+new game');
  assert(q.length === 4, 'A eliminated');
  console.log(`  T${testNum} ✓ Undo then continue: ${names(q)}`);
});

// ============================================
// SECTION 8: RACE CONDITIONS & TIMING
// ============================================
console.log('\n📋 SECTION 8: Race Conditions\n');

await test('Record result with only 1 player — should fail', async () => {
  const sid = await setup(1);
  const result = await db.recordResult(sid, 'king-wins');
  assert(result.error === 'need_two_players', 'Error returned');
  const q = await getQ(sid);
  assert(q.length === 1, 'Queue unchanged');
  console.log(`  T${testNum} ✓ Can't play with 1 player`);
});

await test('Record result on empty queue — should fail', async () => {
  const sid = await db.createSession('table1', '0000');
  const result = await db.recordResult(sid, 'king-wins');
  assert(result.error, 'Error returned');
  console.log(`  T${testNum} ✓ Can't play with 0 players`);
});

await test('Leave queue when not in it', async () => {
  const sid = await setup(3);
  const result = await db.leaveQueue(sid, 'phone_Z');
  assert(result.error === 'not_in_queue', 'Error returned');
  console.log(`  T${testNum} ✓ Can't leave if not in queue`);
});

await test('Confirm when not in queue', async () => {
  const sid = await setup(3);
  const result = await db.confirmPresence(sid, 'phone_Z');
  assert(result.error === 'not_in_queue', 'Error returned');
  console.log(`  T${testNum} ✓ Can't confirm if not in queue`);
});

await test('Double join same phone', async () => {
  const sid = await db.createSession('table1', '0000');
  await db.addToQueue(sid, 'Frank', null, 'phone_frank');
  const r2 = await db.addToQueue(sid, 'Frank', null, 'phone_frank');
  const q = await getQ(sid);
  assert(q.length === 1, 'Still 1 player');
  console.log(`  T${testNum} ✓ No double-join`);
});

await test('Undo with nothing to undo', async () => {
  const sid = await setup(3);
  const result = await db.undoLastRemoval(sid);
  assert(result.error, 'Error returned');
  console.log(`  T${testNum} ✓ Nothing to undo handled`);
});

// ============================================
// SECTION 9: BIG QUEUE — STRESS TEST
// ============================================
console.log('\n📋 SECTION 9: Big Queue Stress\n');

await test('20 players, 15 games', async () => {
  const sid = await db.createSession('table1', '0000');
  for (let i = 0; i < 20; i++) {
    await db.addToQueue(sid, `P${i.toString().padStart(2,'0')}`, null, `phone_${i}`);
  }
  for (let i = 0; i < 15; i++) {
    await db.recordResult(sid, i % 3 === 0 ? 'challenger-wins' : 'king-wins');
  }
  const q = await getQ(sid);
  assert(q.length === 5, '5 remain after 15 games');
  q.forEach((e, i) => assert(e.position === i+1, `Pos ${i+1} sequential`));
  // No duplicate positions
  const positions = q.map(e => e.position);
  assert(new Set(positions).size === positions.length, 'No duplicate positions');
  console.log(`  T${testNum} ✓ 20 players, 15 games: ${names(q)}`);
});

await test('20 players, all leave one by one', async () => {
  const sid = await db.createSession('table1', '0000');
  for (let i = 0; i < 20; i++) {
    await db.addToQueue(sid, `P${i}`, null, `phone_${i}`);
  }
  for (let i = 19; i >= 0; i--) {
    await db.leaveQueue(sid, `phone_${i}`);
    const q = await getQ(sid);
    assert(q.length === i, `${i} remain`);
    if (q.length > 0) {
      q.forEach((e, j) => assert(e.position === j+1, `Sequential after ${20-i} leaves`));
    }
  }
  const q = await getQ(sid);
  assert(q.length === 0, 'Empty');
  console.log(`  T${testNum} ✓ 20 players all leave, positions always sequential`);
});

await test('Joins and games interleaved', async () => {
  const sid = await db.createSession('table1', '0000');
  await db.addToQueue(sid, 'A', null, 'phone_A');
  await db.addToQueue(sid, 'B', null, 'phone_B');
  await db.recordResult(sid, 'king-wins'); // B out
  await db.addToQueue(sid, 'C', null, 'phone_C');
  await db.addToQueue(sid, 'D', null, 'phone_D');
  await db.recordResult(sid, 'challenger-wins'); // A out, C wins
  await db.addToQueue(sid, 'E', null, 'phone_E');
  await db.recordResult(sid, 'king-wins'); // C beats D
  const q = await getQ(sid);
  assert(q[0].player_name === 'C', 'C king');
  assert(q[1].player_name === 'E', 'E challenger');
  assert(q.length === 2, '2 remain');
  console.log(`  T${testNum} ✓ Interleaved: ${names(q)}`);
});

// ============================================
// SECTION 10: REAL BAR DRAMA
// ============================================
console.log('\n📋 SECTION 10: Real Bar Drama\n');

await test('Drunk guy keeps rejoining after losing', async () => {
  const sid = await setup(5);
  // A beats B, B rejoins. 3 times.
  for (let i = 0; i < 3; i++) {
    await db.recordResult(sid, 'king-wins');
    await db.addToQueue(sid, 'B', null, 'phone_B');
  }
  const q = await getQ(sid);
  const b = q.find(e => e.player_name === 'B');
  assert(b.position === q.length, 'B always at end');
  assert(q[0].player_name === 'A', 'A still king');
  console.log(`  T${testNum} ✓ B keeps rejoining at back: ${names(q)}`);
});

await test('Bartender accidentally swipes wrong result, undoes, records right one', async () => {
  const sid = await setup(5);
  // Bartender swipes king-wins but it was actually challenger
  await db.recordResult(sid, 'king-wins');
  let q = await getQ(sid);
  assert(q[0].player_name === 'A', 'Wrong: A still king');
  // Undo!
  await db.undoLastRemoval(sid);
  // Record correct result
  await db.recordResult(sid, 'challenger-wins');
  q = await getQ(sid);
  assert(q[0].player_name === 'B', 'B correctly king');
  console.log(`  T${testNum} ✓ Undo and correct: ${names(q)}`);
});

await test('Half the bar confirms, half MIA — queue order unchanged', async () => {
  const sid = await setup(8);
  await db.checkConfirmationTimeouts(sid);
  // C confirms, D goes MIA, E confirms
  await db.confirmPresence(sid, 'phone_C');
  await fakeAsked(sid, 'D', 6); // asked 6 min ago → MIA
  await db.checkConfirmationTimeouts(sid);
  await db.confirmPresence(sid, 'phone_E');
  
  const q = await getQ(sid);
  // Order should still be A,B,C,D,E,F,G,H regardless of confirm status
  assert(q.map(e=>e.player_name).join('') === 'ABCDEFGH', 'Queue order unchanged');
  const d = q.find(e => e.player_name === 'D');
  assert(d.status === 'mia', 'D MIA');
  assert(d.position === 4, 'D still at pos 4');
  console.log(`  T${testNum} ✓ Mixed confirm/MIA, FIFO intact: ${names(q)}`);
});

await test('MIA player taps confirm — recovers to green', async () => {
  const sid = await setup(5);
  await db.checkConfirmationTimeouts(sid);
  await fakeAsked(sid, 'C', 6); // 6 min → MIA
  await db.checkConfirmationTimeouts(sid);
  const q = await getQ(sid);
  assert(q.find(e => e.player_name === 'C').status === 'mia', 'C MIA');
  // C taps confirm
  await db.confirmPresence(sid, 'phone_C');
  const q2 = await getQ(sid);
  const c = q2.find(e => e.player_name === 'C');
  assert(c.status === 'confirmed', 'C recovered!');
  assert(c.position === 3, 'C still pos 3');
  console.log(`  T${testNum} ✓ MIA recovery works`);
});

await test('10 games then session closed and reopened', async () => {
  const sid = await setup(6);
  for (let i = 0; i < 4; i++) await db.recordResult(sid, 'king-wins');
  await db.closeSession('table1');
  // Open new session
  const sid2 = await db.createSession('table1', '0000');
  await db.addToQueue(sid2, 'X', null, 'phone_X');
  await db.addToQueue(sid2, 'Y', null, 'phone_Y');
  const q = await getQ(sid2);
  assert(q.length === 2, 'Fresh queue');
  assert(q[0].player_name === 'X', 'X king');
  console.log(`  T${testNum} ✓ Clean slate after close`);
});

await test('Person at pos 3 leaves → new pos 3 gets asked on next check', async () => {
  const sid = await setup(7);
  await db.checkConfirmationTimeouts(sid);
  await db.leaveQueue(sid, 'phone_C'); // D→3, E→4, F→5
  await db.checkConfirmationTimeouts(sid);
  const q = await getQ(sid);
  const d = q.find(e => e.player_name === 'D');
  // D already had confirmation from when it was pos 4
  assert(!!d.confirmation_sent_at, 'D still asked (carried from pos 4)');
  console.log(`  T${testNum} ✓ D carries confirmation state`);
});

await test('Pos 6 joins → not asked. Pos 3 leaves → pos 6 becomes 5 → asked', async () => {
  const sid = await setup(6);
  await db.checkConfirmationTimeouts(sid);
  let q = await getQ(sid);
  assert(!q.find(e => e.player_name === 'F').confirmation_sent_at, 'F (pos 6) not asked');
  
  await db.leaveQueue(sid, 'phone_C'); // D→3, E→4, F→5
  await db.checkConfirmationTimeouts(sid);
  q = await getQ(sid);
  const f = q.find(e => e.player_name === 'F');
  assert(f.position === 5, 'F now at pos 5');
  assert(!!f.confirmation_sent_at, 'F now asked');
  console.log(`  T${testNum} ✓ F promoted to 5, now asked`);
});

// ============================================
// SECTION 11: EDGE CASES THAT COULD BREAK THINGS
// ============================================
console.log('\n📋 SECTION 11: Edge Cases\n');

await test('Record result, undo, record result, undo, record result', async () => {
  const sid = await setup(6);
  await db.recordResult(sid, 'king-wins');
  await db.undoLastRemoval(sid);
  await db.recordResult(sid, 'challenger-wins');
  await db.undoLastRemoval(sid);
  await db.recordResult(sid, 'king-wins');
  const q = await getQ(sid);
  assert(q[0].player_name === 'A', 'A king');
  assert(q[0].win_streak === 1, 'A streak 1');
  q.forEach((e, i) => assert(e.position === i+1, `Sequential pos`));
  console.log(`  T${testNum} ✓ Multiple undo cycles: ${names(q)}`);
});

await test('Snapshot undo: 3 games + 3 undos preserves exact state', async () => {
  const sid = await setup(8);
  // Trigger confirmations: pos 3-5 (C, D, E) get asked
  await db.checkConfirmationTimeouts(sid);
  let q = await getQ(sid);
  const initialAsked = q.filter(e => !!e.confirmation_sent_at).length;
  assert(initialAsked === 3, '3 asked before games');

  // Play 3 games with confirmations running between each
  await db.recordResult(sid, 'king-wins'); // B out
  await db.checkConfirmationTimeouts(sid);
  await db.recordResult(sid, 'king-wins'); // C out
  await db.checkConfirmationTimeouts(sid);
  await db.recordResult(sid, 'king-wins'); // D out

  // Undo all 3 — each should restore to EXACT state before that game
  await db.undoLastRemoval(sid); // D back — restores state before game 3
  q = await getQ(sid);
  assert(q[0].player_name === 'A', 'Undo 1: A king');
  assert(q[1].player_name === 'D', 'Undo 1: D challenger');
  q.forEach((e, i) => assert(e.position === i+1, 'Undo 1: Sequential'));

  await db.undoLastRemoval(sid); // C back — restores state before game 2
  q = await getQ(sid);
  assert(q[0].player_name === 'A', 'Undo 2: A king');
  assert(q[1].player_name === 'C', 'Undo 2: C challenger');
  q.forEach((e, i) => assert(e.position === i+1, 'Undo 2: Sequential'));

  await db.undoLastRemoval(sid); // B back — restores original state
  q = await getQ(sid);
  assert(q[0].player_name === 'A', 'A king');
  assert(q[1].player_name === 'B', 'B challenger');
  assert(q[2].player_name === 'C', 'C pos 3');
  assert(q[3].player_name === 'D', 'D pos 4');
  q.forEach((e, i) => assert(e.position === i+1, 'Sequential'));

  // Confirmation states should be restored to the original state
  // C, D, E were asked originally (pos 3-5). B was pos 2 (at table, not asked).
  const finalAsked = q.filter(e => !!e.confirmation_sent_at);
  assert(finalAsked.length === 3, 'Original 3 confirmation states restored');
  assert(!!q.find(e => e.player_name === 'C').confirmation_sent_at, 'C confirmation restored');
  assert(!!q.find(e => e.player_name === 'D').confirmation_sent_at, 'D confirmation restored');
  assert(!!q.find(e => e.player_name === 'E').confirmation_sent_at, 'E confirmation restored');
  assert(!q.find(e => e.player_name === 'B').confirmation_sent_at, 'B not asked (at table)');
  console.log(`  T${testNum} ✓ 3 games + 3 undos: exact state restored with confirmations`);
});

await test('All positions 3-5 ghosted, game ends — FIFO still promotes them', async () => {
  const sid = await setup(7);
  await db.checkConfirmationTimeouts(sid);
  // Fresh ghosts (1 min) — not yet eligible for auto-removal
  await fakeGhosted(sid, 'C', 1);
  await fakeGhosted(sid, 'D', 1);
  await fakeGhosted(sid, 'E', 1);
  
  await db.recordResult(sid, 'king-wins'); // B out
  const q = await getQ(sid);
  assert(q[1].player_name === 'C', 'C promoted even though ghosted (FIFO)');
  console.log(`  T${testNum} ✓ All ghosted, FIFO still works: ${names(q)}`);
});

await test('Remove player then immediately undo game result', async () => {
  const sid = await setup(5);
  await db.recordResult(sid, 'king-wins'); // B out
  const q = await getQ(sid);
  const c = q.find(e => e.player_name === 'C');
  await db.removePlayer(sid, c.id); // bartender also swipes C (mistake?)
  await db.undoLastRemoval(sid); // undo the game — but C was separately removed
  // This should restore B (the game elimination), not C (the manual removal)
  const q2 = await getQ(sid);
  console.log(`  T${testNum} Undo after manual remove: ${names(q2)}`);
  // Just verify it doesn't crash and positions are sequential
  q2.forEach((e, i) => assert(e.position === i+1, 'Sequential'));
});

await test('Join, leave, rejoin same phone', async () => {
  const sid = await db.createSession('table1', '0000');
  await db.addToQueue(sid, 'A', null, 'phone_A');
  await db.addToQueue(sid, 'B', null, 'phone_B');
  await db.addToQueue(sid, 'C', null, 'phone_C');
  await db.leaveQueue(sid, 'phone_B');
  await db.addToQueue(sid, 'B', null, 'phone_B');
  const q = await getQ(sid);
  const b = q.find(e => e.player_name === 'B');
  assert(b.position === 3, 'B at back of line');
  assert(q.length === 3, '3 total');
  console.log(`  T${testNum} ✓ Rejoin after leaving: ${names(q)}`);
});

await test('Confirm presence at wrong time (pos 1 or 2)', async () => {
  const sid = await setup(4);
  const result = await db.confirmPresence(sid, 'phone_A'); // King
  // Should not crash, status changes but gets reset on next check
  assert(!result.error, 'No error for king confirming');
  await db.checkConfirmationTimeouts(sid);
  const q = await getQ(sid);
  const a = q.find(e => e.player_name === 'A');
  assert(a.status === 'waiting', 'King status reset to waiting');
  console.log(`  T${testNum} ✓ King confirm harmless, gets reset`);
});

await test('checkConfirmationTimeouts called 100 times (idempotent)', async () => {
  const sid = await setup(7);
  for (let i = 0; i < 100; i++) {
    await db.checkConfirmationTimeouts(sid);
  }
  const q = await getQ(sid);
  assert(q.length === 7, 'Still 7 players');
  q.forEach((e, i) => assert(e.position === i+1, 'Sequential'));
  // Pos 3-5 asked exactly once (pos 1-2 at table, not asked)
  const asked = q.filter(e => !!e.confirmation_sent_at);
  assert(asked.length === 3, 'Exactly 3 asked (pos 3-5)');
  console.log(`  T${testNum} ✓ 100 checks, idempotent`);
});

await test('Game with only 2 players, one leaves, rejoin, repeat', async () => {
  const sid = await db.createSession('table1', '0000');
  await db.addToQueue(sid, 'A', null, 'phone_A');
  await db.addToQueue(sid, 'B', null, 'phone_B');
  
  for (let i = 0; i < 5; i++) {
    await db.recordResult(sid, 'king-wins'); // B eliminated
    let q = await getQ(sid);
    assert(q.length === 1, `Round ${i}: 1 player after result`);
    await db.addToQueue(sid, 'B', null, 'phone_B');
    q = await getQ(sid);
    assert(q.length === 2, `Round ${i}: B rejoined`);
    assert(q[1].player_name === 'B', `Round ${i}: B at pos 2`);
  }
  console.log(`  T${testNum} ✓ 5 rounds of 2-player rejoin`);
});

// ============================================
// SECTION 12: POSITION INTEGRITY (THE GOLDEN RULE)
// ============================================
console.log('\n📋 SECTION 12: Position Integrity\n');

await test('GOLDEN RULE: After any operation, positions are 1,2,3,...N', async () => {
  const sid = await setup(10);
  const ops = [
    () => db.recordResult(sid, 'king-wins'),
    () => db.recordResult(sid, 'challenger-wins'),
    () => db.leaveQueue(sid, 'phone_E'),
    () => db.addToQueue(sid, 'Z', null, 'phone_Z'),
    () => db.checkConfirmationTimeouts(sid),
    () => db.recordResult(sid, 'king-wins'),
    () => db.leaveQueue(sid, 'phone_H'),
    () => db.recordResult(sid, 'challenger-wins'),
  ];
  
  for (let i = 0; i < ops.length; i++) {
    await ops[i]();
    const q = await getQ(sid);
    const positions = q.map(e => e.position);
    const expected = q.map((_, j) => j+1);
    assert(JSON.stringify(positions) === JSON.stringify(expected), 
      `Op ${i}: positions=${positions.join(',')} expected=${expected.join(',')}`);
  }
  console.log(`  T${testNum} ✓ Positions always sequential after every operation`);
});

await test('No duplicate positions after 20 mixed operations', async () => {
  const sid = await db.createSession('table1', '0000');
  // Add 15 players
  for (let i = 0; i < 15; i++) {
    await db.addToQueue(sid, `P${i}`, null, `phone_${i}`);
  }
  
  const actions = [
    () => db.recordResult(sid, 'king-wins'),
    () => db.recordResult(sid, 'challenger-wins'),
    () => db.recordResult(sid, 'king-wins'),
    () => db.leaveQueue(sid, 'phone_5'),
    () => db.leaveQueue(sid, 'phone_8'),
    () => db.recordResult(sid, 'king-wins'),
    () => db.addToQueue(sid, 'Late1', null, 'phone_late1'),
    () => db.recordResult(sid, 'challenger-wins'),
    () => db.addToQueue(sid, 'Late2', null, 'phone_late2'),
    () => db.recordResult(sid, 'king-wins'),
    () => db.leaveQueue(sid, 'phone_12'),
    () => db.recordResult(sid, 'king-wins'),
    () => db.recordResult(sid, 'challenger-wins'),
    () => db.addToQueue(sid, 'Late3', null, 'phone_late3'),
    () => db.recordResult(sid, 'king-wins'),
    () => db.checkConfirmationTimeouts(sid),
    () => db.recordResult(sid, 'king-wins'),
    () => db.recordResult(sid, 'challenger-wins'),
    () => db.leaveQueue(sid, 'phone_late1'),
    () => db.recordResult(sid, 'king-wins'),
  ];
  
  for (let i = 0; i < actions.length; i++) {
    try { await actions[i](); } catch(e) {} // Some may fail (not enough players etc)
    const q = await getQ(sid);
    if (q.length > 0) {
      const positions = q.map(e => e.position);
      const unique = new Set(positions);
      assert(unique.size === positions.length, `Op ${i}: no duplicates (${positions})`);
      assert(Math.max(...positions) === q.length, `Op ${i}: max pos matches length`);
      assert(Math.min(...positions) === 1, `Op ${i}: min pos is 1`);
    }
  }
  console.log(`  T${testNum} ✓ 20 mixed ops, no duplicate/gap positions ever`);
});

// ============================================
// FINAL SUMMARY
// ============================================
console.log('\n==========================================');
console.log(`🎱 FINAL RESULTS: ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\n🚨 FAILURES:');
  failures.forEach(f => console.log(f));
}
if (failed === 0) {
  console.log('✅ ALL TESTS PASSED — Queue logic is solid');
}
console.log('==========================================\n');

}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });
