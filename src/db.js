import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure data directory exists (supports custom DATABASE_PATH for Railway Persistent Volumes)
const defaultDataDir = path.resolve(__dirname, '../data');
const dbPath = process.env.DATABASE_PATH || path.join(defaultDataDir, 'chat_queue.db');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db = new Database(dbPath);

// Enable Write-Ahead Logging for high-concurrency read/write operations
db.pragma('journal_mode = WAL');

// Initialize database schema
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    sender_id TEXT PRIMARY KEY,
    history TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS message_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id TEXT NOT NULL,
    reply_text TEXT NOT NULL,
    send_at INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    error_message TEXT DEFAULT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_message_queue_pending 
  ON message_queue(status, send_at);
`);

// Prepared statements for high performance
const getConversationStmt = db.prepare('SELECT history FROM conversations WHERE sender_id = ?');

const upsertConversationStmt = db.prepare(`
  INSERT INTO conversations (sender_id, history, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(sender_id) DO UPDATE SET
    history = excluded.history,
    updated_at = excluded.updated_at
`);

const enqueueReplyStmt = db.prepare(`
  INSERT INTO message_queue (sender_id, reply_text, send_at, status, error_message, created_at)
  VALUES (?, ?, ?, 'pending', NULL, ?)
`);

const getMaturePendingStmt = db.prepare(`
  SELECT id, sender_id, reply_text, send_at, status, error_message, created_at
  FROM message_queue
  WHERE status = 'pending' AND send_at <= ?
  ORDER BY send_at ASC
`);

const updateMessageStatusStmt = db.prepare(`
  UPDATE message_queue
  SET status = ?, error_message = ?
  WHERE id = ?
`);

const getQueueStatsStmt = db.prepare(`
  SELECT 
    COUNT(*) as total,
    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
    SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
  FROM message_queue
`);

/**
 * Retrieve user conversation history.
 * @param {string} senderId
 * @returns {Array<{ role: 'user' | 'model', text: string }>}
 */
export function getConversationHistory(senderId) {
  const row = getConversationStmt.get(senderId);
  if (!row || !row.history) {
    return [];
  }
  try {
    const parsed = JSON.parse(row.history);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error(`[DB] Failed to parse history for sender_id ${senderId}:`, err.message);
    return [];
  }
}

/**
 * Save/update user conversation history, auto-trimming to the last 6 entries.
 * @param {string} senderId
 * @param {Array<{ role: 'user' | 'model', text: string }>} history
 */
export function saveConversationHistory(senderId, history) {
  if (!Array.isArray(history)) {
    throw new TypeError('History must be an array of conversation turns');
  }
  // Keep strictly the last 6 turns maximum
  const trimmed = history.slice(-6);
  const jsonHistory = JSON.stringify(trimmed);
  const now = Date.now();
  upsertConversationStmt.run(senderId, jsonHistory, now);
  return trimmed;
}

/**
 * Enqueue a generated reply with its scheduled timestamp.
 * @param {string} senderId - Recipient Instagram sender ID
 * @param {string} replyText - Generated text reply
 * @param {number} sendAt - UNIX epoch timestamp in milliseconds
 * @returns {{ id: number, senderId: string, replyText: string, sendAt: number }}
 */
export function enqueueReply(senderId, replyText, sendAt) {
  const now = Date.now();
  const info = enqueueReplyStmt.run(senderId, replyText, sendAt, now);
  return {
    id: Number(info.lastInsertRowid),
    senderId,
    replyText,
    sendAt
  };
}

/**
 * Fetch mature pending messages (send_at <= Date.now() AND status = 'pending').
 * @returns {Array<{ id: number, sender_id: string, reply_text: string, send_at: number, status: string, error_message: string|null, created_at: number }>}
 */
export function getMaturePendingMessages() {
  const now = Date.now();
  return getMaturePendingStmt.all(now);
}

/**
 * Update message status to 'processing', 'completed', or 'failed'.
 * @param {number} id - Queue record id
 * @param {'pending' | 'processing' | 'completed' | 'failed'} status
 * @param {string|null} [errorMessage=null]
 */
export function updateMessageStatus(id, status, errorMessage = null) {
  const validStatuses = ['pending', 'processing', 'completed', 'failed'];
  if (!validStatuses.includes(status)) {
    throw new Error(`Invalid status: ${status}. Must be one of ${validStatuses.join(', ')}`);
  }
  updateMessageStatusStmt.run(status, errorMessage, id);
}

/**
 * Get message queue statistics for monitoring and healthchecks.
 * @returns {{ total: number, pending: number, processing: number, completed: number, failed: number }}
 */
export function getQueueStats() {
  const row = getQueueStatsStmt.get();
  return {
    total: row.total || 0,
    pending: row.pending || 0,
    processing: row.processing || 0,
    completed: row.completed || 0,
    failed: row.failed || 0
  };
}

/**
 * Reprocess failed messages by resetting their status to 'pending'
 * and scheduling send_at to immediately (Date.now()).
 * @param {number|null} [id=null]
 * @returns {number} Number of messages reset to pending
 */
export function reprocessFailedMessages(id = null) {
  const now = Date.now();
  if (id !== null) {
    const info = db.prepare(`
      UPDATE message_queue
      SET status = 'pending', error_message = NULL, send_at = ?
      WHERE id = ? AND status = 'failed'
    `).run(now, id);
    return info.changes;
  }
  const info = db.prepare(`
    UPDATE message_queue
    SET status = 'pending', error_message = NULL, send_at = ?
    WHERE status = 'failed'
  `).run(now);
  return info.changes;
}

/**
 * Clear failed messages from the queue table.
 * @param {number|null} [id=null]
 * @returns {number} Number of deleted messages
 */
export function clearFailedMessages(id = null) {
  if (id !== null) {
    const info = db.prepare('DELETE FROM message_queue WHERE id = ? AND status = "failed"').run(id);
    return info.changes;
  }
  const info = db.prepare('DELETE FROM message_queue WHERE status = "failed"').run();
  return info.changes;
}
