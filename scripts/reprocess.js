import { db, reprocessFailedMessages, getQueueStats } from '../src/db.js';

// 1. Remove mock test items
const deleted = db.prepare(`
  DELETE FROM message_queue
  WHERE sender_id IN ('follower_future', 'failing_user_999', 'follower_mature')
`).run();

console.log(`Deleted ${deleted.changes} test queue messages.`);

// 2. Reprocess any remaining failed messages
const reprocessed = reprocessFailedMessages();
console.log(`Reprocessed ${reprocessed} failed messages back to pending.`);

// 3. Print current queue stats and rows
console.log('Current Queue Stats:', getQueueStats());
console.table(db.prepare("SELECT id, sender_id, reply_text, status, datetime(send_at/1000, 'unixepoch') as send_time, error_message FROM message_queue").all());

db.close();
