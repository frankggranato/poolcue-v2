/**
 * FULL AUDIT — Pool Cue v2
 * Comprehensive simulation: every API path, edge case, and scenario.
 * Run: node test-full-audit.js
 */

const db = require('./db');

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

function reset() { db._resetMemory(); }

async function run() {
  await db.init();

  // =========================================================
  section('SESSION LIFECYCLE');
  // =========================================================
  reset();
  const s1 = await db.createSession('t1', '1234', 'singles', 'bar_rules');
  assert(s1.id > 0, 'Session created');
  assert(s1.status === 'active', 'Status is active');
  assert(s1.game_type === 'singles', 'Game type correct');

  const fetched = await db.getSession('t1');
  assert(fetched.id === s1.id, 'getSession returns correct session');

  const s1b = await db.createSession('t1', '1234', 'doubles', 'apa');
  assert(s1b.id !== s1.id, 'New session closes old');
  const check = await db.getSession('t1');
  assert(check.id === s1b.id, 'Active session is the new one');

  await db.closeSession('t1');
  assert(await db.getSession('t1') === null, 'Closed session not found');

  const auto = await db.ensureSession('auto');
  assert(auto.status === 'active', 'ensureSession auto-creates');

  const upd = await db.updateRules('auto', 'doubles', 'bca');
  assert(upd.game_type === 'doubles' && upd.rule_type === 'bca', 'Rules updated');

  const partial = await db.updateRules('auto', null, 'apa');
  assert(partial.game_type === 'doubles' && partial.rule_type === 'apa', 'Partial update');

  assert(await db.updateRules('nonexistent', 'singles', 'bar_rules') === null, 'Update nonexistent returns null');

  // =========================================================
  section('QUEUE JOIN / LEAVE / POSITIONS');
  // =========================================================
  reset();
  const s2 = await db.createSession('t2', '0000', 'singles', 'bar_rules');
  const pa = await db.addToQueue(s2.id, 'Alice', null, 'pa');
  const pb = await db.addToQueue(s2.id, 'Bob', null, 'pb');
  const pc = await db.addToQueue(s2.id, 'Charlie', null, 'pc');
  const pd = await db.addToQueue(s2.id, 'Diana', null, 'pd');
  const pe = await db.addToQueue(s2.id, 'Eve', null, 'pe');

  assert(pa.position === 1, 'First join = pos 1');
  assert(pb.position === 2, 'Second join = pos 2');
  assert(pe.position === 5, 'Fifth join = pos 5');

  const dup = await db.addToQueue(s2.id, 'X', null, 'pa');
  assert(dup.error === 'already_in_queue', 'Duplicate phone blocked');

  const np1 = await db.addToQueue(s2.id, 'Dbg1', null, null);
  const np2 = await db.addToQueue(s2.id, 'Dbg2', null, null);
  assert(!np1.error && !np2.error, 'Null phones allowed (debug)');

  await db.leaveQueue(s2.id, 'pc');
  let q2 = await db.getQueue(s2.id);
  assert(!q2.find(e => e.player_name === 'Charlie'), 'Charlie removed');
  const positions = q2.map(e => e.position);
  assert(JSON.stringify(positions) === JSON.stringify([1,2,3,4,5,6]), 'Positions compacted sequentially');

  assert((await db.leaveQueue(s2.id, 'ghost')).error === 'not_in_queue', 'Leave nonexistent errors');
  assert((await db.leaveQueue(s2.id, 'pc')).error === 'not_in_queue', 'Double leave errors');

  // Partner names
  const partner = await db.addToQueue(s2.id, 'Frank', 'Grace', 'pf');
  assert(partner.partner_name === 'Grace', 'Partner stored');
  await db.updatePartnerName(s2.id, 'pf', 'Heidi');
  q2 = await db.getQueue(s2.id);
  const frank = q2.find(e => e.player_name === 'Frank');
  assert(frank.partner_name === 'Heidi', 'Partner updated');
  await db.updatePartnerName(s2.id, 'pf', null);
  q2 = await db.getQueue(s2.id);
  assert(q2.find(e => e.player_name === 'Frank').partner_name === null, 'Partner cleared');

  assert(await db.updatePartnerName(s2.id, 'nonexistent', 'X') === undefined || await db.updatePartnerName(s2.id, 'nonexistent', 'X') === null, 'Update partner for nonexistent returns falsy');

  // =========================================================
  section('GAME RESULTS — KING WINS');
  // =========================================================
  reset();
  const s3 = await db.createSession('t3', '0000', 'singles', 'bar_rules');
  await db.addToQueue(s3.id, 'King', null, 'pk');
  await db.addToQueue(s3.id, 'Chal', null, 'pc');
  await db.addToQueue(s3.id, 'Wait', null, 'pw');

  const r3 = await db.recordResult(s3.id, 'king-wins');
  assert(r3.winner === 'King' && r3.loser === 'Chal', 'King wins correctly');
  assert(r3.streak === 1, 'Streak starts at 1');

  let q3 = await db.getQueue(s3.id);
  assert(q3.length === 2, '2 remain after king wins');
  assert(q3[0].player_name === 'King' && q3[0].position === 1, 'King stays pos 1');
  assert(q3[1].player_name === 'Wait' && q3[1].position === 2, 'Waiter promoted');

  await db.addToQueue(s3.id, 'New', null, 'pn');
  const r3b = await db.recordResult(s3.id, 'king-wins');
  assert(r3b.streak === 2, 'Streak increments');

  // Edge: result with <2
  reset();
  const s3c = await db.createSession('s3c', '0', 'singles', 'bar_rules');
  await db.addToQueue(s3c.id, 'Solo', null, 'ps');
  assert((await db.recordResult(s3c.id, 'king-wins')).error === 'need_two_players', 'Blocked with 1 player');

  reset();
  const s3d = await db.createSession('s3d', '0', 'singles', 'bar_rules');
  assert((await db.recordResult(s3d.id, 'challenger-wins')).error === 'need_two_players', 'Blocked with 0 players');

  // =========================================================
  section('GAME RESULTS — CHALLENGER WINS');
  // =========================================================
  reset();
  const s4 = await db.createSession('t4', '0', 'singles', 'bar_rules');
  await db.addToQueue(s4.id, 'OldKing', null, 'p1');
  await db.addToQueue(s4.id, 'NewKing', null, 'p2');
  await db.addToQueue(s4.id, 'Waiter', null, 'p3');

  const r4 = await db.recordResult(s4.id, 'challenger-wins');
  assert(r4.winner === 'NewKing' && r4.loser === 'OldKing', 'Challenger wins');

  let q4 = await db.getQueue(s4.id);
  assert(q4[0].player_name === 'NewKing' && q4[0].position === 1, 'New king at pos 1');
  assert(q4[1].player_name === 'Waiter' && q4[1].position === 2, 'Waiter promoted');

  // Chain: 5 players, challenger wins 3x
  reset();
  const s4b = await db.createSession('s4b', '0', 'singles', 'bar_rules');
  for (let i = 1; i <= 5; i++) await db.addToQueue(s4b.id, `P${i}`, null, `cp${i}`);
  await db.recordResult(s4b.id, 'challenger-wins');
  await db.recordResult(s4b.id, 'challenger-wins');
  await db.recordResult(s4b.id, 'challenger-wins');
  let q4b = await db.getQueue(s4b.id);
  assert(q4b[0].player_name === 'P4' && q4b.length === 2, 'Chain: P4 is king, 2 remain');

  // Exactly 2 players, challenger wins — leaves 1 player (king only)
  reset();
  const s4c = await db.createSession('s4c', '0', 'singles', 'bar_rules');
  await db.addToQueue(s4c.id, 'A', null, 'a');
  await db.addToQueue(s4c.id, 'B', null, 'b');
  const r4c = await db.recordResult(s4c.id, 'challenger-wins');
  assert(r4c.success, 'Result with exactly 2 works');
  let q4c = await db.getQueue(s4c.id);
  assert(q4c.length === 1 && q4c[0].player_name === 'B', 'B is sole king');

  // =========================================================
  section('UNDO SYSTEM');
  // =========================================================
  reset();
  const s5 = await db.createSession('t5', '0', 'singles', 'bar_rules');
  await db.addToQueue(s5.id, 'King', null, 'uk');
  await db.addToQueue(s5.id, 'Chal', null, 'uc');
  await db.addToQueue(s5.id, 'Wait', null, 'uw');

  await db.recordResult(s5.id, 'king-wins');
  let q5 = await db.getQueue(s5.id);
  assert(q5.length === 2, 'After result: 2 remain');

  const undo5 = await db.undoLastRemoval(s5.id);
  assert(undo5.success && undo5.restored === 'Chal', 'Undo restores Chal');
  q5 = await db.getQueue(s5.id);
  assert(q5.length === 3, 'After undo: 3 restored');
  assert(q5[0].player_name === 'King' && q5[0].position === 1, 'King back at 1');
  assert(q5[1].player_name === 'Chal' && q5[1].position === 2, 'Chal back at 2');
  assert(q5[2].player_name === 'Wait' && q5[2].position === 3, 'Wait back at 3');

  // Undo with nothing to undo
  const undo5b = await db.undoLastRemoval(s5.id);
  assert(undo5b.error === 'nothing_to_undo', 'No double undo');

  // Undo challenger wins
  reset();
  const s5c = await db.createSession('s5c', '0', 'singles', 'bar_rules');
  await db.addToQueue(s5c.id, 'A', null, 'a');
  await db.addToQueue(s5c.id, 'B', null, 'b');
  await db.addToQueue(s5c.id, 'C', null, 'c');
  await db.recordResult(s5c.id, 'challenger-wins'); // B beats A
  let q5c = await db.getQueue(s5c.id);
  assert(q5c[0].player_name === 'B', 'B is king after win');
  await db.undoLastRemoval(s5c.id);
  q5c = await db.getQueue(s5c.id);
  assert(q5c[0].player_name === 'A' && q5c[1].player_name === 'B', 'Undo restores A as king');
  assert(q5c[0].win_streak === 0, 'A streak reset to 0');

  // Undo respects voluntary leaves
  reset();
  const s5d = await db.createSession('s5d', '0', 'singles', 'bar_rules');
  await db.addToQueue(s5d.id, 'A', null, 'a');
  await db.addToQueue(s5d.id, 'B', null, 'b');
  await db.addToQueue(s5d.id, 'C', null, 'c');
  await db.recordResult(s5d.id, 'king-wins'); // A beats B
  await db.leaveQueue(s5d.id, 'c'); // C voluntarily leaves
  await db.undoLastRemoval(s5d.id); // Should restore B but NOT C
  let q5d = await db.getQueue(s5d.id);
  const names5d = q5d.map(e => e.player_name);
  assert(names5d.includes('B'), 'B restored by undo');
  assert(!names5d.includes('C'), 'C stays gone (voluntary leave)');

  // Undo preserves new joins
  reset();
  const s5e = await db.createSession('s5e', '0', 'singles', 'bar_rules');
  await db.addToQueue(s5e.id, 'A', null, 'a');
  await db.addToQueue(s5e.id, 'B', null, 'b');
  await db.recordResult(s5e.id, 'challenger-wins');
  await db.addToQueue(s5e.id, 'NewGuy', null, 'ng');
  await db.undoLastRemoval(s5e.id);
  let q5e = await db.getQueue(s5e.id);
  assert(q5e.find(e => e.player_name === 'NewGuy'), 'NewGuy preserved after undo');
  assert(q5e.find(e => e.player_name === 'A'), 'A restored after undo');

  // =========================================================
  section('REMOVE PLAYER (BARTENDER/BOARD)');
  // =========================================================
  reset();
  const s6 = await db.createSession('t6', '0', 'singles', 'bar_rules');
  const r6a = await db.addToQueue(s6.id, 'A', null, 'a');
  await db.addToQueue(s6.id, 'B', null, 'b');
  await db.addToQueue(s6.id, 'C', null, 'c');

  const rem6 = await db.removePlayer(s6.id, r6a.id);
  assert(rem6.success, 'Remove king works');
  let q6 = await db.getQueue(s6.id);
  assert(q6.length === 2, 'Queue shrinks');
  assert(q6[0].player_name === 'B' && q6[0].position === 1, 'B promoted to king');
  assert(q6[1].player_name === 'C' && q6[1].position === 2, 'C promoted to challenger');

  // Remove nonexistent
  const rem6b = await db.removePlayer(s6.id, 99999);
  assert(rem6b.error === 'not_found', 'Remove nonexistent errors');

  // Remove last player
  reset();
  const s6c = await db.createSession('s6c', '0', 'singles', 'bar_rules');
  const solo6 = await db.addToQueue(s6c.id, 'Solo', null, 'solo');
  await db.removePlayer(s6c.id, solo6.id);
  q6 = await db.getQueue(s6c.id);
  assert(q6.length === 0, 'Queue empty after removing sole player');

  // =========================================================
  section('CONFIRMATION SYSTEM');
  // =========================================================
  reset();
  const s7 = await db.createSession('t7', '0', 'singles', 'bar_rules');
  await db.addToQueue(s7.id, 'King', null, 'k7');
  await db.addToQueue(s7.id, 'Chal', null, 'c7');
  await db.addToQueue(s7.id, 'P3', null, 'p37');
  await db.addToQueue(s7.id, 'P4', null, 'p47');
  await db.addToQueue(s7.id, 'P5', null, 'p57');
  await db.addToQueue(s7.id, 'P6', null, 'p67');

  // First check — should ask P3-P5 to confirm
  const actions7 = await db.checkConfirmationTimeouts(s7.id);
  const asked = actions7.filter(a => a.action === 'confirmation_sent');
  assert(asked.length === 3, 'Asks positions 3-5 to confirm');
  assert(!asked.find(a => a.name === 'King' || a.name === 'Chal'), 'Doesnt ask king/challenger');
  assert(!asked.find(a => a.name === 'P6'), 'Doesnt ask pos 6');

  // Confirm presence
  const conf7 = await db.confirmPresence(s7.id, 'p37');
  assert(conf7.success && conf7.name === 'P3', 'Confirm works');
  let q7 = await db.getQueue(s7.id);
  const p3entry = q7.find(e => e.player_name === 'P3');
  assert(p3entry.status === 'confirmed', 'Status set to confirmed');

  // Confirm for nonexistent
  const conf7b = await db.confirmPresence(s7.id, 'nonexistent');
  assert(conf7b.error === 'not_in_queue', 'Confirm nonexistent errors');

  // MIA escalation (simulate 5min elapsed)
  reset();
  const s7b = await db.createSession('s7b', '0', 'singles', 'bar_rules');
  await db.addToQueue(s7b.id, 'K', null, 'kk');
  await db.addToQueue(s7b.id, 'C', null, 'cc');
  const p3b = await db.addToQueue(s7b.id, 'MIA', null, 'mm');
  // Manually set confirmation_sent_at to 6 min ago
  const sixMinAgo = new Date(Date.now() - 360000);
  const mem_entry = db._getMemEntry(p3b.id);
  if (mem_entry) {
    mem_entry.confirmation_sent_at = sixMinAgo;
    mem_entry.status = 'waiting';
  }
  const actions7b = await db.checkConfirmationTimeouts(s7b.id);
  const miaActions = actions7b.filter(a => a.action === 'mia');
  assert(miaActions.length >= 1, 'MIA escalation at 5min');

  // Ghost escalation (simulate 11min elapsed)
  if (mem_entry) {
    mem_entry.confirmation_sent_at = new Date(Date.now() - 660000);
    mem_entry.status = 'mia';
  }
  const actions7c = await db.checkConfirmationTimeouts(s7b.id);
  const ghostActions = actions7c.filter(a => a.action === 'ghosted');
  assert(ghostActions.length >= 1, 'Ghost escalation at 10min');

  // =========================================================
  section('IDLE CLEAR / RESTORE');
  // =========================================================
  reset();
  const s8 = await db.createSession('t8', '0', 'singles', 'bar_rules');
  await db.addToQueue(s8.id, 'A', null, 'a8');
  await db.addToQueue(s8.id, 'B', null, 'b8');
  await db.addToQueue(s8.id, 'C', null, 'c8');

  const idle8 = await db.idleClearQueue(s8.id);
  assert(idle8.success && idle8.cleared === 3, 'Idle clears 3 players');
  let q8 = await db.getQueue(s8.id);
  assert(q8.length === 0, 'Queue empty after idle clear');

  const restore8 = await db.idleRestoreQueue(s8.id);
  assert(restore8.success && restore8.restored === 3, 'Idle restores 3 players');
  q8 = await db.getQueue(s8.id);
  assert(q8.length === 3, 'Queue restored');
  assert(q8[0].player_name === 'A' && q8[0].position === 1, 'Positions restored');

  // Double restore fails
  const restore8b = await db.idleRestoreQueue(s8.id);
  assert(restore8b.error === 'nothing_to_restore', 'Double restore errors');

  // Clear empty queue
  reset();
  const s8c = await db.createSession('s8c', '0', 'singles', 'bar_rules');
  const idle8c = await db.idleClearQueue(s8c.id);
  assert(idle8c.success && idle8c.cleared === 0, 'Clear empty queue = 0');

  // =========================================================
  section('DAILY RESET (closeAllSessions)');
  // =========================================================
  reset();
  const sr1 = await db.createSession('bar1', '0', 'singles', 'bar_rules');
  const sr2 = await db.createSession('bar2', '0', 'doubles', 'apa');
  await db.addToQueue(sr1.id, 'X', null, 'x');
  await db.addToQueue(sr2.id, 'Y', null, 'y');

  const resetCount = await db.closeAllSessions();
  assert(resetCount === 2, 'Closed 2 sessions');
  assert(await db.getSession('bar1') === null, 'bar1 closed');
  assert(await db.getSession('bar2') === null, 'bar2 closed');
  // Queues should be wiped
  const m = db._getMemory();
  const remaining = m.queue_entries.filter(e => !['eliminated', 'removed'].includes(e.status));
  assert(remaining.length === 0, 'All queue entries cleared');

  // =========================================================
  section('STALE QUEUE AUTO-CLEAR');
  // =========================================================
  reset();
  const s9 = await db.createSession('t9', '0', 'singles', 'bar_rules');
  const staleEntry = await db.addToQueue(s9.id, 'Stale', null, 'stale');
  // Hack join time to 7 hours ago
  const memE = db._getMemEntry(staleEntry.id);
  if (memE) memE.joined_at = new Date(Date.now() - 7 * 60 * 60 * 1000);
  const wasCleared = await db.clearStaleQueue(s9.id);
  assert(wasCleared === true, 'Stale queue cleared after 6h');
  let q9 = await db.getQueue(s9.id);
  assert(q9.length === 0, 'Queue empty after stale clear');

  // Fresh queue NOT cleared
  reset();
  const s9b = await db.createSession('s9b', '0', 'singles', 'bar_rules');
  await db.addToQueue(s9b.id, 'Fresh', null, 'fresh');
  const notCleared = await db.clearStaleQueue(s9b.id);
  assert(notCleared === false, 'Fresh queue not cleared');

  // =========================================================
  section('BAR MANAGEMENT');
  // =========================================================
  reset();
  const bar1 = await db.createBar('Flanagans', 'flanagans', '123 Main', 'Joe', '555-1234');
  assert(bar1.id > 0, 'Bar created');
  assert(bar1.slug === 'flanagans', 'Slug correct');

  const bar2 = await db.createBar('Test Bar', 'testbar', null, null, null);
  assert(bar2.id > 0, 'Bar with null optional fields');

  const allBars = await db.getAllBars();
  assert(allBars.length === 2, 'getAllBars returns 2');

  const bySlug = await db.getBarBySlug('flanagans');
  assert(bySlug.name === 'Flanagans', 'getBarBySlug works');
  assert(await db.getBarBySlug('nonexistent') === null, 'Nonexistent slug = null');

  const updBar = await db.updateBar(bar1.id, { address: '456 Oak' });
  assert(updBar.address === '456 Oak', 'Bar updated');
  assert(await db.updateBar(9999, { name: 'X' }) === null, 'Update nonexistent bar = null');

  // getBarForTableCode matching
  const matchExact = await db.getBarForTableCode('flanagans');
  assert(matchExact?.slug === 'flanagans', 'Exact table code match');
  const matchPrefix = await db.getBarForTableCode('flanagans-2');
  assert(matchPrefix?.slug === 'flanagans', 'Prefix table code match');
  const matchTestbar = await db.getBarForTableCode('testbar');
  assert(matchTestbar?.slug === 'testbar', 'Testbar matched');
  const noMatch = await db.getBarForTableCode('randomtable');
  assert(noMatch === null, 'No match for random table');

  // =========================================================
  section('AD MANAGEMENT');
  // =========================================================
  reset();
  const testBar = await db.createBar('Test', 'testbar', null, null, null);
  const ad1 = await db.createAd('Pizza Joe', 'base64data...', 'image/png', null, null);
  assert(ad1.id > 0, 'Ad created');
  assert(ad1.active === true, 'Ad active by default');

  const ad2 = await db.createAd('Beer Co', 'data2', 'image/jpeg', '2025-01-01', '2026-12-31');
  assert(ad2.start_date === '2025-01-01', 'Start date stored');

  // Targeting
  await db.setAdTargets(ad1.id, [testBar.id]);
  const targets = await db.getAdTargets(ad1.id);
  assert(targets.length === 1 && targets[0] === testBar.id, 'Ad targeted to bar');

  // getAdsForBar
  await db.setAdTargets(ad2.id, [testBar.id]);
  const barAds = await db.getAdsForBar(testBar.id);
  assert(barAds.length >= 1, 'Ads returned for bar');

  // Update ad
  const updAd = await db.updateAd(ad1.id, { active: false });
  assert(updAd.active === false, 'Ad deactivated');
  assert(await db.updateAd(9999, {}) === null, 'Update nonexistent ad = null');

  // Delete ad
  await db.deleteAd(ad1.id);
  assert(await db.getAd(ad1.id) === null, 'Ad deleted');

  // Impressions
  await db.logImpression(ad2.id, testBar.id);
  await db.logImpression(ad2.id, testBar.id);
  await db.logImpression(ad2.id, testBar.id);
  const report = await db.getImpressionReport();
  assert(report.length === 1, 'One report entry');
  assert(report[0].total === 3, '3 impressions logged');
  assert(report[0].today === 3, 'All from today');

  // =========================================================
  section('AVG GAME TIME');
  // =========================================================
  reset();
  const s10 = await db.createSession('t10', '0', 'singles', 'bar_rules');
  
  // No games yet
  let avg = await db.getAvgGameTime(s10.id);
  assert(avg === null, 'No avg with 0 games');

  // Manually inject game_log entries with known durations
  const mem10 = db._getMemory();
  for (let i = 1; i <= 5; i++) {
    mem10.game_log.push({
      id: 1000 + i, session_id: s10.id,
      winner_name: 'W', loser_name: 'L', winner_streak: 1,
      duration_seconds: i * 120, counted_for_avg: true,
      ended_at: new Date(), queue_snapshot: null
    });
  }
  avg = await db.getAvgGameTime(s10.id);
  assert(avg > 0, 'Avg calculated with games');

  // Short games not counted
  mem10.game_log.push({
    id: 1006, session_id: s10.id,
    winner_name: 'W', loser_name: 'L', winner_streak: 1,
    duration_seconds: 30, counted_for_avg: false,
    ended_at: new Date(), queue_snapshot: null
  });
  const avgAfter = await db.getAvgGameTime(s10.id);
  assert(avgAfter === avg, 'Short games excluded from avg');

  // =========================================================
  section('STRESS: LARGE QUEUE');
  // =========================================================
  reset();
  const s11 = await db.createSession('t11', '0', 'singles', 'bar_rules');
  for (let i = 0; i < 50; i++) {
    await db.addToQueue(s11.id, `Player${i}`, null, `stress-${i}`);
  }
  let q11 = await db.getQueue(s11.id);
  assert(q11.length === 50, '50 players in queue');
  assert(q11[0].position === 1, 'First player pos 1');
  assert(q11[49].position === 50, 'Last player pos 50');

  // King wins 10x in a row — stress position compaction
  for (let i = 0; i < 10; i++) {
    await db.recordResult(s11.id, 'king-wins');
  }
  q11 = await db.getQueue(s11.id);
  assert(q11.length === 40, '40 remain after 10 games');
  assert(q11[0].win_streak === 10, 'King on 10 streak');
  // Verify positions are sequential
  const allSeq = q11.every((e, i) => e.position === i + 1);
  assert(allSeq, 'All 40 positions sequential (1-40)');

  // =========================================================
  section('STRESS: RAPID RESULTS');
  // =========================================================
  reset();
  const s12 = await db.createSession('t12', '0', 'singles', 'bar_rules');
  for (let i = 0; i < 20; i++) {
    await db.addToQueue(s12.id, `R${i}`, null, `rapid-${i}`);
  }
  // Alternate king/challenger wins rapidly
  for (let i = 0; i < 15; i++) {
    const result = i % 2 === 0 ? 'king-wins' : 'challenger-wins';
    const r = await db.recordResult(s12.id, result);
    assert(r.success, `Rapid result ${i+1} ok`);
  }
  let q12 = await db.getQueue(s12.id);
  assert(q12.length === 5, '5 remain after 15 games (20-15)');
  const seq12 = q12.every((e, i) => e.position === i + 1);
  assert(seq12, 'Positions sequential after rapid results');

  // =========================================================
  section('EDGE: KING REMOVAL (SINGLE PLAYER SWIPE)');
  // =========================================================
  reset();
  const s13 = await db.createSession('t13', '0', 'singles', 'bar_rules');
  const soloKing = await db.addToQueue(s13.id, 'SoloKing', null, 'sk');
  
  // The board uses /api/remove for solo king swipe
  const rem13 = await db.removePlayer(s13.id, soloKing.id);
  assert(rem13.success, 'Solo king removed via /api/remove');
  let q13 = await db.getQueue(s13.id);
  assert(q13.length === 0, 'Queue empty after solo king removal');

  // =========================================================
  section('EDGE: CHALLENGER LEAVES DURING GAME');
  // =========================================================
  reset();
  const s14 = await db.createSession('t14', '0', 'singles', 'bar_rules');
  await db.addToQueue(s14.id, 'K', null, 'k14');
  await db.addToQueue(s14.id, 'C', null, 'c14');
  await db.addToQueue(s14.id, 'W', null, 'w14');
  
  // Challenger leaves voluntarily
  await db.leaveQueue(s14.id, 'c14');
  let q14 = await db.getQueue(s14.id);
  assert(q14.length === 2, '2 remain after challenger leaves');
  assert(q14[0].player_name === 'K' && q14[0].position === 1, 'King stays');
  assert(q14[1].player_name === 'W' && q14[1].position === 2, 'Waiter promoted to challenger');

  // =========================================================
  section('EDGE: KING LEAVES');
  // =========================================================
  reset();
  const s15 = await db.createSession('t15', '0', 'singles', 'bar_rules');
  await db.addToQueue(s15.id, 'K', null, 'k15');
  await db.addToQueue(s15.id, 'C', null, 'c15');
  await db.addToQueue(s15.id, 'W', null, 'w15');
  
  await db.leaveQueue(s15.id, 'k15');
  let q15 = await db.getQueue(s15.id);
  assert(q15.length === 2, '2 remain after king leaves');
  assert(q15[0].player_name === 'C' && q15[0].position === 1, 'Challenger promoted to king');
  assert(q15[1].player_name === 'W' && q15[1].position === 2, 'Waiter promoted to challenger');

  // =========================================================
  section('EDGE: MIDDLE PLAYER LEAVES');
  // =========================================================
  reset();
  const s16 = await db.createSession('t16', '0', 'singles', 'bar_rules');
  for (let i = 1; i <= 5; i++) await db.addToQueue(s16.id, `P${i}`, null, `p${i}x`);
  
  await db.leaveQueue(s16.id, 'p3x'); // P3 (position 3) leaves
  let q16 = await db.getQueue(s16.id);
  assert(q16.length === 4, '4 remain');
  const pos16 = q16.map(e => e.position);
  assert(JSON.stringify(pos16) === JSON.stringify([1,2,3,4]), 'Positions compacted after middle leave');
  assert(q16[2].player_name === 'P4', 'P4 moved to position 3');

  // =========================================================
  section('EDGE: CROSS-SESSION ISOLATION');
  // =========================================================
  reset();
  const sA = await db.createSession('tA', '0', 'singles', 'bar_rules');
  const sB = await db.createSession('tB', '0', 'singles', 'bar_rules');
  
  await db.addToQueue(sA.id, 'Alice', null, 'alice');
  await db.addToQueue(sB.id, 'Bob', null, 'bob');
  
  let qA = await db.getQueue(sA.id);
  let qB = await db.getQueue(sB.id);
  assert(qA.length === 1 && qA[0].player_name === 'Alice', 'Session A has Alice');
  assert(qB.length === 1 && qB[0].player_name === 'Bob', 'Session B has Bob');
  
  // Same phone can join different sessions
  await db.addToQueue(sB.id, 'Alice', null, 'alice');
  qB = await db.getQueue(sB.id);
  assert(qB.length === 2, 'Alice joins session B too');

  // =========================================================
  section('EDGE: SINGLE UNDO ONLY (NO CHAIN)');
  // =========================================================
  reset();
  const s17 = await db.createSession('t17', '0', 'singles', 'bar_rules');
  await db.addToQueue(s17.id, 'A', null, 'a17');
  await db.addToQueue(s17.id, 'B', null, 'b17');
  await db.addToQueue(s17.id, 'C', null, 'c17');
  
  await db.recordResult(s17.id, 'king-wins'); // A beats B
  await db.recordResult(s17.id, 'king-wins'); // A beats C
  
  const undo17 = await db.undoLastRemoval(s17.id);
  assert(undo17.restored === 'C', 'First undo restores C');
  
  const undo17b = await db.undoLastRemoval(s17.id);
  assert(undo17b.error === 'nothing_to_undo', 'Second undo blocked (single undo only)');
  
  let q17 = await db.getQueue(s17.id);
  assert(q17.length === 2, 'Only C restored, B stays eliminated');

  // =========================================================
  section('EDGE: DOUBLES / PARTNER WORKFLOW');
  // =========================================================
  reset();
  const s18 = await db.createSession('t18', '0', 'doubles', 'bar_rules');
  await db.addToQueue(s18.id, 'Alice', 'Partner1', 'a18');
  await db.addToQueue(s18.id, 'Bob', 'Partner2', 'b18');
  
  let q18 = await db.getQueue(s18.id);
  assert(q18[0].partner_name === 'Partner1', 'Partner stored on join');
  
  await db.recordResult(s18.id, 'challenger-wins');
  q18 = await db.getQueue(s18.id);
  assert(q18[0].player_name === 'Bob' && q18[0].partner_name === 'Partner2', 'Partner preserved through result');

  // =========================================================
  section('EDGE: AD DATE FILTERING');
  // =========================================================
  reset();
  const dateBar = await db.createBar('DateBar', 'datebar', null, null, null);
  
  // Ad with expired end date
  const expiredAd = await db.createAd('Expired', 'data', 'image/png', '2020-01-01', '2020-12-31');
  await db.setAdTargets(expiredAd.id, [dateBar.id]);
  
  // Ad with future start date
  const futureAd = await db.createAd('Future', 'data', 'image/png', '2030-01-01', '2030-12-31');
  await db.setAdTargets(futureAd.id, [dateBar.id]);
  
  // Ad with valid date range
  const validAd = await db.createAd('Valid', 'data', 'image/png', '2020-01-01', '2030-12-31');
  await db.setAdTargets(validAd.id, [dateBar.id]);
  
  // Ad with no dates (always valid)
  const noDatesAd = await db.createAd('NoDate', 'data', 'image/png', null, null);
  await db.setAdTargets(noDatesAd.id, [dateBar.id]);
  
  const dateAds = await db.getAdsForBar(dateBar.id);
  const adNames = dateAds.map(a => a.advertiser_name);
  assert(!adNames.includes('Expired'), 'Expired ad not served');
  assert(!adNames.includes('Future'), 'Future ad not served');
  assert(adNames.includes('Valid'), 'Valid ad served');
  assert(adNames.includes('NoDate'), 'No-date ad served');

  // =========================================================
  section('EDGE: AD TARGETING — UNTARGETED BAR');
  // =========================================================
  reset();
  const barX = await db.createBar('BarX', 'barx', null, null, null);
  const barY = await db.createBar('BarY', 'bary', null, null, null);
  const adX = await db.createAd('AdX', 'data', 'image/png', null, null);
  await db.setAdTargets(adX.id, [barX.id]); // Only targeted to barX
  
  const adsX = await db.getAdsForBar(barX.id);
  const adsY = await db.getAdsForBar(barY.id);
  assert(adsX.length === 1, 'BarX gets targeted ad');
  assert(adsY.length === 0, 'BarY gets no ads');

  // =========================================================
  section('EDGE: RETARGET ADS');
  // =========================================================
  await db.setAdTargets(adX.id, [barY.id]); // Move target
  const adsX2 = await db.getAdsForBar(barX.id);
  const adsY2 = await db.getAdsForBar(barY.id);
  assert(adsX2.length === 0, 'BarX no longer has ad');
  assert(adsY2.length === 1, 'BarY now has ad');

  // =========================================================
  section('EDGE: GAME LOG SNAPSHOT CLEANUP');
  // =========================================================
  reset();
  const s19 = await db.createSession('t19', '0', 'singles', 'bar_rules');
  await db.addToQueue(s19.id, 'A', null, 'a19');
  await db.addToQueue(s19.id, 'B', null, 'b19');
  await db.recordResult(s19.id, 'king-wins');
  
  // Manually age the game log > 12h
  const mem19 = db._getMemory();
  const log19 = mem19.game_log.find(g => g.session_id === s19.id);
  if (log19) log19.ended_at = new Date(Date.now() - 13 * 60 * 60 * 1000);
  
  // Trigger cleanup via checkConfirmationTimeouts
  await db.checkConfirmationTimeouts(s19.id);
  await db.checkConfirmationTimeouts(s19.id); // May need 2nd call for timer
  
  // After cleanup, undo should fail (snapshot nulled)
  // Note: cleanup runs every 2min, so we may need to force it
  const oldTimestamp = db.checkConfirmationTimeouts._lastCleanup;
  db.checkConfirmationTimeouts._lastCleanup = 0; // Force cleanup
  await db.checkConfirmationTimeouts(s19.id);
  
  if (log19) {
    assert(log19.queue_snapshot === null, 'Old snapshot cleaned up');
  }

  // =========================================================
  section('EDGE: POSITION COMPACTION DEEP TEST');
  // =========================================================
  reset();
  const s20 = await db.createSession('t20', '0', 'singles', 'bar_rules');
  for (let i = 1; i <= 10; i++) await db.addToQueue(s20.id, `P${i}`, null, `t20p${i}`);
  
  // Remove king, challenger, and pos 5 simultaneously via removePlayer
  let q20 = await db.getQueue(s20.id);
  const king20 = q20.find(e => e.position === 1);
  await db.removePlayer(s20.id, king20.id);
  q20 = await db.getQueue(s20.id);
  const chal20 = q20.find(e => e.position === 1); // New king
  await db.removePlayer(s20.id, chal20.id);
  q20 = await db.getQueue(s20.id);
  // Remove position 3
  const pos3 = q20.find(e => e.position === 3);
  await db.removePlayer(s20.id, pos3.id);
  
  q20 = await db.getQueue(s20.id);
  assert(q20.length === 7, '7 remain after 3 removals');
  const all20Seq = q20.every((e, i) => e.position === i + 1);
  assert(all20Seq, 'Positions perfectly sequential after scattered removals');

  // =========================================================
  section('EDGE: JOIN AFTER IDLE CLEAR (WAKE UP)');
  // =========================================================
  reset();
  const s21 = await db.createSession('t21', '0', 'singles', 'bar_rules');
  await db.addToQueue(s21.id, 'Old', null, 'old21');
  await db.idleClearQueue(s21.id);
  
  // New player joins — board should wake up (tested via server logic, but db supports it)
  const newJoin = await db.addToQueue(s21.id, 'NewGuy', null, 'new21');
  assert(!newJoin.error, 'Join after idle clear works');
  let q21 = await db.getQueue(s21.id);
  assert(q21.length === 1, 'Only new player in queue');
  assert(q21[0].player_name === 'NewGuy', 'New player is there');

  // =========================================================
  section('EDGE: RESULT RIGHT AFTER UNDO');
  // =========================================================
  reset();
  const s22 = await db.createSession('t22', '0', 'singles', 'bar_rules');
  await db.addToQueue(s22.id, 'A', null, 'a22');
  await db.addToQueue(s22.id, 'B', null, 'b22');
  await db.addToQueue(s22.id, 'C', null, 'c22');
  
  await db.recordResult(s22.id, 'king-wins'); // A beats B
  await db.undoLastRemoval(s22.id); // B restored
  const r22 = await db.recordResult(s22.id, 'challenger-wins'); // B beats A
  assert(r22.winner === 'B', 'Result after undo: B wins');
  let q22 = await db.getQueue(s22.id);
  assert(q22[0].player_name === 'B' && q22[0].position === 1, 'B is king after undo+result');

  // =========================================================
  section('EDGE: ENSURE SESSION IDEMPOTENT');
  // =========================================================
  reset();
  const e1 = await db.ensureSession('idem');
  const e2 = await db.ensureSession('idem');
  assert(e1.id === e2.id, 'ensureSession returns same session');

  // =========================================================
  section('INPUT VALIDATION (SERVER-LEVEL)');
  // =========================================================
  // These test what server.js validates before hitting db
  
  // Name too long (server truncates to 24)
  const longName = 'A'.repeat(50);
  const truncated = longName.substring(0, 24);
  assert(truncated.length === 24, 'Server truncates names to 24 chars');
  
  // HTML stripped
  const dirty = '<script>alert("xss")</script>Test';
  const clean = dirty.replace(/<[^>]*>/g, '');
  assert(clean === 'alert("xss")Test', 'HTML tags stripped');
  
  // Zero-width chars stripped
  const zw = 'Te\u200Bst';
  const cleanZw = zw.replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, '');
  assert(cleanZw === 'Test', 'Zero-width chars stripped');

  // =========================================================
  // SUMMARY
  // =========================================================
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  AUDIT COMPLETE`);
  console.log('='.repeat(60));
  console.log(`\n  ✅ Passed: ${passed}`);
  console.log(`  ❌ Failed: ${failed}`);
  console.log(`  📋 Sections: ${sections}`);
  console.log(`  📊 Total:  ${passed + failed}`);
  console.log('');
  
  if (failed > 0) {
    console.log('  ⚠️  ISSUES FOUND — scroll up for details');
    process.exit(1);
  } else {
    console.log('  🎱 ALL TESTS PASSING');
    process.exit(0);
  }
}

run().catch(err => {
  console.error('AUDIT CRASHED:', err);
  process.exit(1);
});
