import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

console.log('==============================================');
console.log('   RUNNING AUTOMATED VERIFICATION SUITE       ');
console.log('==============================================\n');

async function runTests() {
  // Test 1: Database Initialization & Tables
  console.log('[Test 1] Testing Database & WAL mode initialization...');
  const { db, getConversationHistory, saveConversationHistory, enqueueReply, getMaturePendingMessages, updateMessageStatus, getQueueStats } = await import('../src/db.js');

  const journalMode = db.pragma('journal_mode', { simple: true });
  console.log(`  -> SQLite journal_mode: ${journalMode}`);
  assert.strictEqual(journalMode.toLowerCase(), 'wal', 'journal_mode must be WAL');

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  console.log(`  -> Created tables: ${tables.join(', ')}`);
  assert.ok(tables.includes('conversations'), 'conversations table must exist');
  assert.ok(tables.includes('message_queue'), 'message_queue table must exist');
  console.log('  [PASS] Test 1: Database schema & WAL mode verified.\n');

  // Test 2: Conversation History & 6-Turn Max Trimming
  console.log('[Test 2] Testing Conversation History and 6-turn maximum trimming...');
  const testSenderId = 'test_follower_123';

  // Save 8 turns to verify it trims to exactly 6
  const sampleTurns = [
    { role: 'user', text: 'turn 1' },
    { role: 'model', text: 'turn 2' },
    { role: 'user', text: 'turn 3' },
    { role: 'model', text: 'turn 4' },
    { role: 'user', text: 'turn 5' },
    { role: 'model', text: 'turn 6' },
    { role: 'user', text: 'turn 7' },
    { role: 'model', text: 'turn 8' }
  ];
  saveConversationHistory(testSenderId, sampleTurns);

  const retrieved = getConversationHistory(testSenderId);
  console.log(`  -> Stored 8 turns, retrieved: ${retrieved.length} turns`);
  assert.strictEqual(retrieved.length, 6, 'Should keep strictly the last 6 turns');
  assert.strictEqual(retrieved[0].text, 'turn 3', 'First turn in trimmed history should be turn 3');
  assert.strictEqual(retrieved[5].text, 'turn 8', 'Last turn in trimmed history should be turn 8');
  console.log('  [PASS] Test 2: 6-turn sliding window verified.\n');

  // Test 3: Queue Management (Enqueue, Fetch Mature, Status Transitions)
  console.log('[Test 3] Testing Message Queue functions and status transitions...');
  const matureItem = enqueueReply('follower_mature', 'Mature reply test', Date.now() - 1000);
  assert.ok(matureItem.id > 0, 'Enqueue should return valid ID');

  const futureItem = enqueueReply('follower_future', 'Future reply test', Date.now() + 60000);

  const matureList = getMaturePendingMessages();
  const found = matureList.find(m => m.id === matureItem.id);
  assert.ok(found, 'Mature message should be fetched');
  const foundFuture = matureList.find(m => m.id === futureItem.id);
  assert.strictEqual(foundFuture, undefined, 'Future message should NOT be fetched');

  updateMessageStatus(matureItem.id, 'processing');
  const stats1 = getQueueStats();
  assert.ok(stats1.processing >= 1, 'Processing count should be >= 1');

  updateMessageStatus(matureItem.id, 'completed');
  const stats2 = getQueueStats();
  assert.ok(stats2.completed >= 1, 'Completed count should be >= 1');

  updateMessageStatus(futureItem.id, 'failed', 'Simulated failure reason');
  const stats3 = getQueueStats();
  assert.ok(stats3.failed >= 1, 'Failed count should be >= 1');

  console.log('  -> Queue stats:', stats3);
  console.log('  [PASS] Test 3: Queue operations and state machine verified.\n');

  // Test 4: Webhook Handshake (GET /webhook) & POST /webhook
  console.log('[Test 4] Testing Webhook Handshake (GET /webhook)...');
  const { startServer, stopServer } = await import('../src/server.js');
  const testPort = 3999;
  startServer(testPort);

  try {
    // 4.1 Valid verification handshake
    const challengeStr = 'test_challenge_code_98765';
    const verifyToken = process.env.VERIFY_TOKEN || 'mehak_secret_verify_token';
    const validUrl = `http://127.0.0.1:${testPort}/webhook?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=${challengeStr}`;

    const resValid = await fetch(validUrl);
    const textValid = await resValid.text();
    console.log(`  -> GET valid handshake status: ${resValid.status}, response: "${textValid}"`);
    assert.strictEqual(resValid.status, 200);
    assert.strictEqual(textValid, challengeStr);

    // 4.2 Invalid verification handshake
    const invalidUrl = `http://127.0.0.1:${testPort}/webhook?hub.mode=subscribe&hub.verify_token=wrong_token&hub.challenge=${challengeStr}`;
    const resInvalid = await fetch(invalidUrl);
    console.log(`  -> GET invalid handshake status: ${resInvalid.status}`);
    assert.strictEqual(resInvalid.status, 403);
    console.log('  [PASS] Test 4: Webhook handshake endpoint verified.\n');

    // Test 5: Incoming Webhook Receiver (POST /webhook)
    console.log('[Test 5] Testing Incoming Webhook (POST /webhook)...');
    const postUrl = `http://127.0.0.1:${testPort}/webhook`;

    // 5.1 Test Fast 200 OK
    const startTime = Date.now();
    const mockPayload = {
      object: 'instagram',
      entry: [
        {
          id: 'instagram_page_id',
          time: Date.now(),
          messaging: [
            {
              sender: { id: 'test_ig_user_456' },
              recipient: { id: 'instagram_page_id' },
              timestamp: Date.now(),
              message: {
                mid: 'mid.1234567890',
                text: 'Hey Mehak! Love your aesthetic ✨'
              }
            }
          ]
        }
      ]
    };

    const postRes = await fetch(postUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mockPayload)
    });
    const postBody = await postRes.text();
    const responseDuration = Date.now() - startTime;

    console.log(`  -> POST status: ${postRes.status}, response: "${postBody}", duration: ${responseDuration}ms`);
    assert.strictEqual(postRes.status, 200);
    assert.strictEqual(postBody, 'EVENT_RECEIVED');
    assert.ok(responseDuration < 200, 'POST response must be immediate (< 200ms)');

    // 5.2 Test Echo rejection
    const echoPayload = {
      object: 'instagram',
      entry: [
        {
          messaging: [
            {
              sender: { id: 'mehak_page' },
              message: {
                is_echo: true,
                text: 'Bot echoed message'
              }
            }
          ]
        }
      ]
    };
    const echoRes = await fetch(postUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(echoPayload)
    });
    assert.strictEqual(echoRes.status, 200);
    console.log('  [PASS] Test 5: Webhook receiver speed and echo filtering verified.\n');

    // Test 6: Health Endpoint (GET /health)
    console.log('[Test 6] Testing Health Endpoint (GET /health)...');
    const healthRes = await fetch(`http://127.0.0.1:${testPort}/health`);
    const healthJson = await healthRes.json();
    console.log('  -> Health JSON:', healthJson);
    assert.strictEqual(healthRes.status, 200);
    assert.strictEqual(healthJson.status, 'ok');
    assert.ok(healthJson.queue);
    console.log('  [PASS] Test 6: Healthcheck endpoint verified.\n');

  } finally {
    stopServer();
  }

  // Test 7: Worker Tick Functionality
  console.log('[Test 7] Testing Queue Worker dispatch error handling...');
  const { processQueue } = await import('../src/queueWorker.js');
  const errorTestItem = enqueueReply('failing_user_999', 'Failing test message', Date.now() - 500);
  await processQueue();
  const queueAfterTick = getMaturePendingMessages();
  const stillPending = queueAfterTick.find(m => m.id === errorTestItem.id);
  assert.strictEqual(stillPending, undefined, 'Message should have been processed and no longer pending');
  console.log('  [PASS] Test 7: Worker error handling & status transition verified.\n');

  console.log('==============================================');
  console.log('   ALL VERIFICATION TESTS PASSED SUCCESSFULLY! ');
  console.log('==============================================\n');

  // Close database and server cleanly
  db.close();
  setTimeout(() => {
    process.exit(0);
  }, 100);
}

runTests().catch((err) => {
  console.error('\n[FATAL] Test failed:', err);
  process.exit(1);
});
