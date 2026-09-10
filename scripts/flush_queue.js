import { db, getQueueStats } from '../src/db.js';

const now = Date.now();
// Make all pending or failed messages mature immediately
const info = db.prepare(`
  UPDATE message_queue
  SET send_at = ?, status = 'pending', error_message = NULL
  WHERE status IN ('pending', 'failed', 'processing')
`).run(now - 1000);

console.log(`Flushed ${info.changes} messages to mature pending status.`);
console.log('Queue Stats:', getQueueStats());
console.table(db.prepare("SELECT id, sender_id, reply_text, status, datetime(send_at/1000, 'unixepoch') as send_time FROM message_queue").all());

db.close();
