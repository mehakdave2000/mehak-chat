import cron from 'node-cron';
import axios from 'axios';
import dotenv from 'dotenv';
import { getMaturePendingMessages, updateMessageStatus } from './db.js';

dotenv.config();

let isProcessing = false;

/**
 * Process all mature pending messages from the queue.
 * Fetches messages whose send_at <= Date.now(), marks them as processing,
 * and sends them to Meta Graph API v21.0.
 */
export async function processQueue() {
  if (isProcessing) {
    return;
  }
  isProcessing = true;

  try {
    const matureItems = getMaturePendingMessages();
    if (matureItems.length === 0) {
      return;
    }

    console.log(`[QueueWorker] Found ${matureItems.length} mature pending message(s) to process.`);

    for (const item of matureItems) {
      // 1. Immediately mark as processing to prevent duplicate sends across ticks
      updateMessageStatus(item.id, 'processing');

      try {
        const token = process.env.PAGE_ACCESS_TOKEN;
        if (!token) {
          throw new Error('PAGE_ACCESS_TOKEN is not configured');
        }

        const url = 'https://graph.facebook.com/v21.0/me/messages';
        const payload = {
          recipient: { id: item.sender_id },
          message: { text: item.reply_text }
        };

        const response = await axios.post(url, payload, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        });

        console.log(`[QueueWorker] Successfully dispatched message id=${item.id} to recipient=${item.sender_id}. Meta response:`, response.data);
        updateMessageStatus(item.id, 'completed');
      } catch (err) {
        const metaError = err.response?.data?.error
          ? JSON.stringify(err.response.data.error)
          : (err.response?.data ? JSON.stringify(err.response.data) : err.message);

        console.error(`[QueueWorker] Failed to dispatch message id=${item.id} to ${item.sender_id}:`, metaError);
        updateMessageStatus(item.id, 'failed', metaError);
      }
    }
  } catch (error) {
    console.error('[QueueWorker] Unexpected error in queue processing tick:', error.message);
  } finally {
    isProcessing = false;
  }
}

/**
 * Start the cron schedule to run every 10 seconds.
 * @returns {import('node-cron').ScheduledTask}
 */
export function startQueueWorker() {
  console.log('[QueueWorker] Initializing cron worker with schedule "*/10 * * * * *" (every 10 seconds)...');
  const task = cron.schedule('*/10 * * * * *', async () => {
    await processQueue();
  });
  return task;
}
