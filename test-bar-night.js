/**
 * CREATIVE AUDIT — "Thursday Night at the Bar"
 * 
 * Simulates a real 4-hour bar session with realistic player behavior,
 * drunk chaos, edge cases, and adversarial scenarios.
 * 
 * Run: node test-bar-night.js
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

  // =============================================
  section('SCENARIO: First Customer of the Night');
  // =============================================
  // Bar opens at 4pm. Board is showing welcome screen (no active session).
  // First person walks up, scans QR code, joins.
  // Board should auto-create session and show them as king.
  reset();

  // No session exists yet — ensureSession auto-creates
  const sess = await db.ensureSession('testbar');
  assert(sess.status === 'active', 'Auto-created session on first scan');
  
  const first = await db.addToQueue(sess.id, 'Early Eddie', null, 'phone-eddie');
  assert(first.position === 1, 'First customer is king');
  
  let q = await db.getQueue(sess.id);
  assert(q.length === 1, 'Only 1 person — board shows king, no challenger');
  
  // Eddie is alone. He practices. Nobody to play. Board should eventually idle.
  // But if someone joins within 10 min, idle won't trigger.
  const second = await db.addToQueue(sess.id, 'Late Larry', null, 'phone-larry');
  assert(second.position === 2, 'Larry becomes challenger');
  assert(q.length === 1, 'Queue snapshot before Larry was 1 (king only)');
  
  // First game: Larry beats Eddie
  const game1 = await db.recordResult(sess.id, 'challenger-wins');
  assert(game1.winner === 'Late Larry', 'Larry wins first game');
  assert(game1.streak === 1, 'Larry starts streak');
  
  q = await db.getQueue(sess.id);
  assert(q.length === 1, 'Eddie eliminated, Larry alone as king');

  // =============================================
  section('SCENARIO: Rush Hour — 8 People Join Fast');
  // =============================================
  // 6pm crowd arrives. 8 people join in quick succession.
  const rushNames = ['Ace', 'Bones', 'Cue Ball', 'Danger Dave', 'Eight Ball', 'Flipside', 'Ghost', 'Hustler'];
  for (let i = 0; i < rushNames.length; i++) {
    await db.addToQueue(sess.id, rushNames[i], null, `rush-${i}`);
  }
  q = await db.getQueue(sess.id);
  assert(q.length === 9, '9 total (Larry + 8 new)');
  assert(q[0].player_name === 'Late Larry' && q[0].position === 1, 'Larry still king');
  assert(q[1].player_name === 'Ace' && q[1].position === 2, 'Ace is challenger');
  assert(q[8].player_name === 'Hustler' && q[8].position === 9, 'Hustler is last');

  // Verify positions are perfectly sequential
  const positions = q.map(e => e.position);
  const expected = Array.from({length: 9}, (_, i) => i + 1);
  assert(JSON.stringify(positions) === JSON.stringify(expected), 'All 9 positions sequential (1-9)');

  // =============================================
  section('SCENARIO: The Hot Streak — King Wins 5 in a Row');
  // =============================================
  for (let i = 0; i < 5; i++) {
    await db.recordResult(sess.id, 'king-wins');
  }
  q = await db.getQueue(sess.id);
  const king = q.find(e => e.position === 1);
  assert(king.player_name === 'Late Larry', 'Larry still king after 5 wins');
  assert(king.win_streak === 6, 'Larry on 6-game streak (1 initial + 5)');
  assert(q.length === 4, '4 remain (9 - 5 eliminated)');
  assert(q[1].player_name === 'Flipside', 'Flipside promoted to challenger');

  // =============================================
  section('SCENARIO: The Upset — Streak Broken');
  // =============================================
  const upset = await db.recordResult(sess.id, 'challenger-wins');
  assert(upset.winner === 'Flipside', 'Flipside dethrones Larry');
  assert(upset.streak === 1, 'Flipside starts fresh streak');
  q = await db.getQueue(sess.id);
  assert(q[0].player_name === 'Flipside', 'Flipside is new king');
  assert(q[0].win_streak === 1, 'Fresh streak');
  // Larry is gone — eliminated
  assert(!q.find(e => e.player_name === 'Late Larry'), 'Larry eliminated');

  // =============================================
  section('SCENARIO: Oops Wrong Swipe — Undo');
  // =============================================
  // Bartender accidentally swipes wrong person
  const beforeUndo = await db.getQueue(sess.id);
  const beforeLen = beforeUndo.length;
  await db.recordResult(sess.id, 'king-wins'); // Flipside "beats" Ghost
  q = await db.getQueue(sess.id);
  assert(q.length === beforeLen - 1, 'One eliminated by mistake');
  
  const undo = await db.undoLastRemoval(sess.id);
  assert(undo.success, 'Undo succeeds');
  q = await db.getQueue(sess.id);
  assert(q.length === beforeLen, 'Queue restored to pre-mistake state');
  
  // Can't double undo
  const undo2 = await db.undoLastRemoval(sess.id);
  assert(undo2.error === 'nothing_to_undo', 'No double undo');

  // =============================================
  section('SCENARIO: Drunk Dude Joins Twice From Different Browser');
  // =============================================
  // Same person, two phones (or incognito tab). Different phone IDs.
  reset();
  const s = await db.ensureSession('testbar');
  await db.addToQueue(s.id, 'Sober Steve', null, 'phone-steve');
  await db.addToQueue(s.id, 'Drunk Dave', null, 'phone-dave1');
  const dave2 = await db.addToQueue(s.id, 'Drunk Dave', null, 'phone-dave2');
  // Same NAME is allowed (different phones) — can't enforce real identity
  assert(!dave2.error, 'Same name, different phone = allowed');
  q = await db.getQueue(s.id);
  assert(q.filter(e => e.player_name === 'Drunk Dave').length === 2, 'Two Drunk Daves in queue');
  
  // But same phone blocked
  const dave3 = await db.addToQueue(s.id, 'Dave Again', null, 'phone-dave1');
  assert(dave3.error === 'already_in_queue', 'Same phone blocked even with different name');

  // =============================================
  section('SCENARIO: Wild Names — Emoji, Unicode, Edge Cases');
  // =============================================
  reset();
  const sn = await db.ensureSession('testbar');

  // Emoji names
  const emoji = await db.addToQueue(sn.id, '🎱🔥💀', null, 'p-emoji');
  assert(!emoji.error, 'Emoji name accepted');
  assert(emoji.player_name === '🎱🔥💀', 'Emoji name preserved');

  // Max length (24 chars)
  const long = await db.addToQueue(sn.id, 'ABCDEFGHIJKLMNOPQRSTUVWX', null, 'p-long');
  assert(long.player_name.length === 24, '24-char name accepted');

  // Single character
  const single = await db.addToQueue(sn.id, 'X', null, 'p-single');
  assert(single.player_name === 'X', 'Single char name ok');

  // Spaces (server trims — but db layer accepts whatever server sends)
  const spaced = await db.addToQueue(sn.id, '  Bob  ', null, 'p-spaced');
  assert(!spaced.error, 'Spaced name accepted at db level');

  // Name with apostrophe (O'Brien)
  const irish = await db.addToQueue(sn.id, "O'Brien", null, 'p-irish');
  assert(irish.player_name === "O'Brien", 'Apostrophe in name preserved');

  // Name with numbers
  const num = await db.addToQueue(sn.id, 'Player123', null, 'p-num');
  assert(num.player_name === 'Player123', 'Alphanumeric name ok');

  // Accented characters
  const accent = await db.addToQueue(sn.id, 'José García', null, 'p-accent');
  assert(accent.player_name === 'José García', 'Accented chars preserved');

  // CJK characters
  const cjk = await db.addToQueue(sn.id, '田中太郎', null, 'p-cjk');
  assert(cjk.player_name === '田中太郎', 'CJK characters preserved');

  // =============================================
  section('SCENARIO: Phone Dies Mid-Queue (Orphaned Entry)');
  // =============================================
  // Player joins, phone dies. Entry stays in queue with no WS connection.
  // They can't confirm, can't leave. What happens?
  reset();
  const sp = await db.ensureSession('testbar');
  await db.addToQueue(sp.id, 'King', null, 'pk');
  await db.addToQueue(sp.id, 'Challenger', null, 'pc');
  const orphan = await db.addToQueue(sp.id, 'PhoneDied', null, 'p-dead');
  await db.addToQueue(sp.id, 'Player4', null, 'p4');
  await db.addToQueue(sp.id, 'Player5', null, 'p5');

  // PhoneDied is at position 3 — gets asked to confirm
  let actions = await db.checkConfirmationTimeouts(sp.id);
  const asked = actions.filter(a => a.action === 'confirmation_sent');
  assert(asked.some(a => a.name === 'PhoneDied'), 'PhoneDied asked to confirm');

  // Simulate 5 minutes passing — no response (phone is dead)
  const deadEntry = db._getMemEntry(orphan.id);
  deadEntry.confirmation_sent_at = new Date(Date.now() - 301000); // 5min 1sec ago
  
  actions = await db.checkConfirmationTimeouts(sp.id);
  assert(actions.some(a => a.action === 'mia' && a.name === 'PhoneDied'), 'PhoneDied goes MIA (orange)');

  // 10 minutes total — still no response
  deadEntry.confirmation_sent_at = new Date(Date.now() - 601000); // 10min 1sec ago
  deadEntry.mia_at = new Date(Date.now() - 301000);
  deadEntry.status = 'mia';
  
  actions = await db.checkConfirmationTimeouts(sp.id);
  assert(actions.some(a => a.action === 'ghosted' && a.name === 'PhoneDied'), 'PhoneDied goes ghosted (red)');

  // Player is red on board. Bartender or king can see it.
  // They stay in queue until manually swiped — no auto-removal. This is correct.
  q = await db.getQueue(sp.id);
  const ghost = q.find(e => e.player_name === 'PhoneDied');
  assert(ghost && ghost.status === 'ghosted', 'PhoneDied still in queue as ghosted');
  assert(ghost.position === 3, 'PhoneDied still at pos 3 (no auto-bump)');

  // When they eventually get to challenger, their status shows red
  // King sees the red tag and knows to skip/remove them
  
  // If PhoneDied's phone comes back and they tap confirm...
  const revive = await db.confirmPresence(sp.id, 'p-dead');
  assert(revive.success, 'PhoneDied can still confirm after ghosting');
  const revived = db._getMemEntry(orphan.id);
  assert(revived.status === 'confirmed', 'Status flips to confirmed (green)');

  // =============================================
  section('SCENARIO: The Closing Time Stampede');
  // =============================================
  // 1:30 AM — bar is closing. 12 people still in queue.
  // Bartender needs to close everything. Daily reset hasn't hit yet.
  reset();
  const sClose = await db.ensureSession('testbar');
  for (let i = 0; i < 12; i++) {
    await db.addToQueue(sClose.id, `Closer${i}`, null, `close-${i}`);
  }
  q = await db.getQueue(sClose.id);
  assert(q.length === 12, '12 players at closing time');

  // Bartender closes session via setup page
  await db.closeSession('testbar');
  const gone = await db.getSession('testbar');
  assert(gone === null, 'Session closed');
  
  // All queue data wiped
  q = await db.getQueue(sClose.id);
  assert(q.length === 0, 'Queue wiped on close');

  // Board receives session_closed → shows welcome
  // Phone status pages receive session_closed → redirect to join

  // Next morning: someone scans QR. Auto-creates fresh session.
  const fresh = await db.ensureSession('testbar');
  assert(fresh.id !== sClose.id, 'Brand new session');
  assert(fresh.status === 'active', 'Fresh active session');

  // =============================================
  section('SCENARIO: Doubles Night — Partners');
  // =============================================
  reset();
  const sd = await db.createSession('testbar', '0000', 'doubles', 'apa');
  
  const team1 = await db.addToQueue(sd.id, 'Mike', 'Sarah', 'phone-mike');
  assert(team1.partner_name === 'Sarah', 'Partner stored on join');
  
  const team2 = await db.addToQueue(sd.id, 'Jake', 'Emma', 'phone-jake');
  const team3 = await db.addToQueue(sd.id, 'Tom', null, 'phone-tom');
  assert(team3.partner_name === null, 'Tom joins without partner (lazy)');
  
  // Tom realizes he needs a partner, updates
  await db.updatePartnerName(sd.id, 'phone-tom', 'Lisa');
  q = await db.getQueue(sd.id);
  const tom = q.find(e => e.player_name === 'Tom');
  assert(tom.partner_name === 'Lisa', 'Partner added after join');

  // Game result — teams play
  const dResult = await db.recordResult(sd.id, 'challenger-wins');
  assert(dResult.winner === 'Jake', 'Jake & Emma win');
  assert(dResult.loser === 'Mike', 'Mike & Sarah lose');

  // Switch back to singles mid-session
  await db.updateRules('testbar', 'singles', null);
  const updated = await db.getSession('testbar');
  assert(updated.game_type === 'singles', 'Switched to singles');
  
  // Partners still stored — they just don't display in singles mode
  q = await db.getQueue(sd.id);
  const jake = q.find(e => e.player_name === 'Jake');
  assert(jake.partner_name === 'Emma', 'Partner data preserved even in singles');

  // =============================================
  section('SCENARIO: Undo After Someone New Joined');
  // =============================================
  // Critical edge case: Game happens, new person joins, THEN undo.
  // The new person should keep their spot.
  reset();
  const su = await db.ensureSession('testbar');
  await db.addToQueue(su.id, 'A', null, 'pa');
  await db.addToQueue(su.id, 'B', null, 'pb');
  await db.addToQueue(su.id, 'C', null, 'pc');

  // A beats B
  await db.recordResult(su.id, 'king-wins');
  q = await db.getQueue(su.id);
  assert(q.length === 2, 'A and C remain');

  // New person joins AFTER the result
  await db.addToQueue(su.id, 'NewGuy', null, 'pnew');
  q = await db.getQueue(su.id);
  assert(q.length === 3, '3 total: A, C, NewGuy');

  // Now undo — B should come back, NewGuy should stay
  await db.undoLastRemoval(su.id);
  q = await db.getQueue(su.id);
  assert(q.length === 4, 'All 4 present after undo');
  assert(q.find(e => e.player_name === 'B'), 'B restored by undo');
  assert(q.find(e => e.player_name === 'NewGuy'), 'NewGuy kept after undo');
  
  // Position order: A(1), B(2), C(3), NewGuy(4) — snapshot first, then new joins
  assert(q[0].player_name === 'A' && q[0].position === 1, 'A still king');
  assert(q[1].player_name === 'B' && q[1].position === 2, 'B restored to challenger');
  assert(q[3].player_name === 'NewGuy' && q[3].position === 4, 'NewGuy at end');

  // =============================================
  section('SCENARIO: The Ragequitter — Leaves Mid-Game');
  // =============================================
  reset();
  const sr = await db.ensureSession('testbar');
  await db.addToQueue(sr.id, 'Chill', null, 'p-chill');
  await db.addToQueue(sr.id, 'Ragequit', null, 'p-rage');
  await db.addToQueue(sr.id, 'Patient', null, 'p-patient');

  // Ragequit is challenger but rages and leaves queue from phone
  await db.leaveQueue(sr.id, 'p-rage');
  q = await db.getQueue(sr.id);
  assert(q.length === 2, 'Ragequitter gone');
  assert(q[0].player_name === 'Chill' && q[0].position === 1, 'Chill still king');
  assert(q[1].player_name === 'Patient' && q[1].position === 2, 'Patient auto-promoted to challenger');

  // Ragequit tries to rejoin (new device — different phone_id means new entry)
  const rejoin = await db.addToQueue(sr.id, 'Ragequit', null, 'p-rage');
  // p-rage was marked removed, so cookie check should pass since status is 'removed'
  assert(!rejoin.error, 'Ragequitter can rejoin after leaving');
  q = await db.getQueue(sr.id);
  assert(q.length === 3, 'Ragequitter back in queue');
  assert(q[2].player_name === 'Ragequit' && q[2].position === 3, 'Back of the line');

  // =============================================
  section('SCENARIO: Rapid Fire — 20 Games in a Row');
  // =============================================
  reset();
  const srf = await db.ensureSession('testbar');
  for (let i = 1; i <= 25; i++) {
    await db.addToQueue(srf.id, `RapidP${i}`, null, `rapid-${i}`);
  }

  // Play 20 games — alternating king/challenger wins
  for (let i = 0; i < 20; i++) {
    const result = i % 3 === 0 ? 'challenger-wins' : 'king-wins';
    const r = await db.recordResult(srf.id, result);
    assert(r.success || r.winner, `Rapid game ${i + 1} completed`);
  }

  q = await db.getQueue(srf.id);
  assert(q.length > 0, 'Players still remain');
  // Verify positions still sequential
  for (let i = 0; i < q.length; i++) {
    assert(q[i].position === i + 1, `Position ${i + 1} correct after rapid fire`);
  }

  // =============================================
  section('SCENARIO: Idle Board Recovery');
  // =============================================
  // Board goes idle with 3 players. Gets cleared. Someone scans QR and joins.
  // Board should wake up showing only the new person (old data gone).
  reset();
  const si = await db.ensureSession('testbar');
  await db.addToQueue(si.id, 'OldKing', null, 'p-old1');
  await db.addToQueue(si.id, 'OldChal', null, 'p-old2');
  await db.addToQueue(si.id, 'OldWait', null, 'p-old3');

  // Board idle-clears
  const cleared = await db.idleClearQueue(si.id);
  assert(cleared.cleared === 3, '3 players idle-cleared');
  q = await db.getQueue(si.id);
  assert(q.length === 0, 'Queue empty after idle');

  // New person scans QR and joins
  const newP = await db.addToQueue(si.id, 'FreshFace', null, 'p-fresh');
  assert(newP.position === 1, 'New joiner is king on empty board');
  q = await db.getQueue(si.id);
  assert(q.length === 1, 'Only fresh player');

  // Old players try to restore (they see "Restore Board" button within 30 min)
  const restore = await db.idleRestoreQueue(si.id);
  assert(restore.success, 'Restore works');
  q = await db.getQueue(si.id);
  // Now we have old players + new player
  assert(q.length === 4, 'Old 3 restored + FreshFace = 4');
  assert(q.find(e => e.player_name === 'FreshFace'), 'FreshFace still in queue');

  // =============================================
  section('SCENARIO: Morning After — Daily Reset');
  // =============================================
  // 2am — stragglers left in queue. 8am rolls around.
  reset();
  const bar1 = await db.ensureSession('testbar');
  const bar2 = await db.ensureSession('flanagans');
  await db.addToQueue(bar1.id, 'Straggler1', null, 'strag-1');
  await db.addToQueue(bar1.id, 'Straggler2', null, 'strag-2');
  await db.addToQueue(bar2.id, 'Straggler3', null, 'strag-3');

  // 8am daily reset fires
  const closedCount = await db.closeAllSessions();
  assert(closedCount === 2, 'Both bar sessions closed');

  assert(await db.getSession('testbar') === null, 'testbar session gone');
  assert(await db.getSession('flanagans') === null, 'flanagans session gone');
  
  // Queue data wiped
  q = await db.getQueue(bar1.id);
  assert(q.length === 0, 'testbar queue wiped');
  q = await db.getQueue(bar2.id);
  assert(q.length === 0, 'flanagans queue wiped');

  // Thursday afternoon: first scan auto-creates
  const thursday = await db.ensureSession('testbar');
  assert(thursday.status === 'active', 'Fresh session ready for Thursday');

  // =============================================
  section('SCENARIO: Ad System — Full Night Cycle');
  // =============================================
  reset();
  const bar = await db.createBar('Test Bar', 'testbar', '123 Main St', 'Frank', '555-0000');
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  // Create ads with various date ranges
  const adActive = await db.createAd('Bud Light', 'base64data1', 'image/png', yesterday, nextWeek);
  const adExpired = await db.createAd('Old Promo', 'base64data2', 'image/png', yesterday, yesterday);
  const adFuture = await db.createAd('Next Week', 'base64data3', 'image/png', tomorrow, nextWeek);
  const adNoDate = await db.createAd('Evergreen', 'base64data4', 'image/png', null, null);
  const adPaused = await db.createAd('Paused Ad', 'base64data5', 'image/png', yesterday, nextWeek);

  // Target all to bar
  await db.setAdTargets(adActive.id, [bar.id]);
  await db.setAdTargets(adExpired.id, [bar.id]);
  await db.setAdTargets(adFuture.id, [bar.id]);
  await db.setAdTargets(adNoDate.id, [bar.id]);
  await db.setAdTargets(adPaused.id, [bar.id]);

  // Pause one
  await db.updateAd(adPaused.id, { active: false });

  // Check what actually gets served
  const served = await db.getAdsForBar(bar.id);
  const servedNames = served.map(a => a.advertiser_name);
  assert(servedNames.includes('Bud Light'), 'Active ad served');
  assert(servedNames.includes('Evergreen'), 'No-date ad served');
  assert(!servedNames.includes('Old Promo'), 'Expired ad filtered');
  assert(!servedNames.includes('Next Week'), 'Future ad filtered');
  assert(!servedNames.includes('Paused Ad'), 'Paused ad filtered');
  assert(served.length === 2, 'Exactly 2 ads served');

  // Bar-table matching
  const matched = await db.getBarForTableCode('testbar');
  assert(matched && matched.slug === 'testbar', 'testbar matches bar');
  const matched2 = await db.getBarForTableCode('testbar-2');
  assert(matched2 && matched2.slug === 'testbar', 'testbar-2 matches bar (prefix)');
  const noMatch = await db.getBarForTableCode('randomtable');
  assert(noMatch === null, 'randomtable has no bar');

  // Impression logging
  await db.logImpression(adActive.id, bar.id);
  await db.logImpression(adActive.id, bar.id);
  await db.logImpression(adNoDate.id, bar.id);
  const report = await db.getImpressionReport();
  const budReport = report.find(r => r.advertiser_name === 'Bud Light');
  assert(budReport && budReport.total === 2, 'Bud Light: 2 impressions');
  assert(budReport.today === 2, 'Both from today');

  // =============================================
  section('CHAOS MONKEY — Random Operations Stress Test');
  // =============================================
  // Simulate 200 random operations on the same table.
  // After each operation, verify positions are always sequential.
  reset();
  const sc = await db.ensureSession('testbar');
  let phoneCounter = 0;
  let queuePhones = []; // track who's in queue
  let errors = 0;

  for (let i = 0; i < 200; i++) {
    const op = Math.random();
    try {
      if (op < 0.35) {
        // JOIN — new player
        const phone = `chaos-${phoneCounter++}`;
        const r = await db.addToQueue(sc.id, `P${phoneCounter}`, null, phone);
        if (!r.error) queuePhones.push(phone);
      } else if (op < 0.55) {
        // KING WINS
        await db.recordResult(sc.id, 'king-wins');
      } else if (op < 0.75) {
        // CHALLENGER WINS
        await db.recordResult(sc.id, 'challenger-wins');
      } else if (op < 0.85) {
        // LEAVE — random person leaves
        if (queuePhones.length > 0) {
          const idx = Math.floor(Math.random() * queuePhones.length);
          const phone = queuePhones[idx];
          const r = await db.leaveQueue(sc.id, phone);
          if (r.success) queuePhones.splice(idx, 1);
        }
      } else if (op < 0.92) {
        // UNDO
        await db.undoLastRemoval(sc.id);
      } else if (op < 0.96) {
        // CONFIRM random person
        if (queuePhones.length > 0) {
          const phone = queuePhones[Math.floor(Math.random() * queuePhones.length)];
          await db.confirmPresence(sc.id, phone);
        }
      } else {
        // CHECK CONFIRMATIONS
        await db.checkConfirmationTimeouts(sc.id);
      }
    } catch (e) {
      errors++;
      console.log(`    ⚠️ Chaos op ${i}: ${e.message}`);
    }

    // INVARIANT CHECK after every operation
    q = await db.getQueue(sc.id);
    if (q.length > 0) {
      const positions = q.map(e => e.position);
      const sorted = [...positions].sort((a, b) => a - b);
      const expectedSeq = Array.from({length: q.length}, (_, i) => i + 1);
      if (JSON.stringify(sorted) !== JSON.stringify(expectedSeq)) {
        errors++;
        console.log(`    ❌ INVARIANT BROKEN at op ${i}: positions = ${positions}`);
      }
    }
  }

  assert(errors === 0, `200 chaos operations — 0 invariant violations`);
  q = await db.getQueue(sc.id);
  console.log(`    📊 Final state: ${q.length} players, ${phoneCounter} total joins`);

  // =============================================
  section('SCENARIO: Confirm Overlay Left Open (No Auto-Dismiss)');
  // =============================================
  // This is a FRONTEND issue: if someone swipes and the confirm
  // dialog appears but nobody taps Confirm or Cancel, it stays
  // forever. Meanwhile another game result comes in via WS —
  // the queue changes underneath the pending action.
  //
  // Testing: can we record a result while one is "pending"?
  // At the DB level, there's no lock — two results in sequence work fine.
  reset();
  const so = await db.ensureSession('testbar');
  await db.addToQueue(so.id, 'A', null, 'oa');
  await db.addToQueue(so.id, 'B', null, 'ob');
  await db.addToQueue(so.id, 'C', null, 'oc');
  await db.addToQueue(so.id, 'D', null, 'od');

  // Two rapid results — like if someone swipes on board AND phone submits
  const r1 = await db.recordResult(so.id, 'king-wins');
  assert(r1.success || r1.winner, 'First rapid result ok');
  const r2 = await db.recordResult(so.id, 'king-wins');
  assert(r2.success || r2.winner, 'Second rapid result ok (A beats C)');
  q = await db.getQueue(so.id);
  assert(q.length === 2, '2 remain after 2 rapid results');
  assert(q[0].player_name === 'A', 'A still king after both');

  // =============================================
  section('SCENARIO: Table Code Weirdness');
  // =============================================
  // What happens with unusual table codes?
  reset();
  
  const weird1 = await db.ensureSession('UPPERCASE');
  assert(weird1.status === 'active', 'Uppercase table code works');
  
  const weird2 = await db.ensureSession('with-dashes');
  assert(weird2.status === 'active', 'Dashed table code works');

  const weird3 = await db.ensureSession('table123');
  assert(weird3.status === 'active', 'Alphanumeric table code works');

  // Bar matching with dashes: flanagans-2 should match bar slug "flanagans"
  await db.createBar('Flanagans', 'flanagans', null, null, null);
  const dashMatch = await db.getBarForTableCode('flanagans-2');
  assert(dashMatch && dashMatch.slug === 'flanagans', 'flanagans-2 matches flanagans bar');
  const dashMatch2 = await db.getBarForTableCode('flanagans-table-vip');
  assert(dashMatch2 && dashMatch2.slug === 'flanagans', 'flanagans-table-vip matches');
  const noMatch2 = await db.getBarForTableCode('flanagan'); // missing the 's'
  assert(noMatch2 === null, 'flanagan (no s) does NOT match flanagans');

  // =============================================
  section('SCENARIO: Avg Game Time Accuracy');
  // =============================================
  reset();
  const sa = await db.ensureSession('testbar');
  // Need to create game log entries with known durations
  // The system uses time between game log entries, so we fake it:
  for (let i = 0; i < 8; i++) {
    await db.addToQueue(sa.id, `T${i}`, null, `tavg-${i}`);
  }

  // Play 6 games. First game has no prior, so duration=0.
  // Games 2-6 will have durations based on time between calls.
  // Since we're running instantly, durations will be ~0 (filtered by >=90s rule).
  for (let i = 0; i < 6; i++) {
    await db.recordResult(sa.id, 'king-wins');
  }

  const avg = await db.getAvgGameTime(sa.id);
  // All games were <90s apart (instant in test), so all filtered
  assert(avg === null || avg === 0, 'Instant games filtered from avg (< 90s)');

  // =============================================
  // SUMMARY
  // =============================================
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  🍺 BAR NIGHT SIMULATION COMPLETE`);
  console.log('='.repeat(60));
  console.log(`\n  ✅ Passed: ${passed}`);
  console.log(`  ❌ Failed: ${failed}`);
  console.log(`  📋 Scenarios: ${sections}`);
  console.log(`  📊 Total assertions: ${passed + failed}`);
  console.log('');
  
  if (failed > 0) {
    console.log('  ⚠️  ISSUES FOUND');
    process.exit(1);
  } else {
    console.log('  🎱 ALL SCENARIOS PASS — READY FOR THURSDAY');
    process.exit(0);
  }
}

run().catch(err => {
  console.error('SIMULATION CRASHED:', err);
  process.exit(1);
});
