import express from 'express';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enqueueReply, getQueueStats } from './db.js';
import { generateMehakReply } from './ai.js';
import { startQueueWorker } from './queueWorker.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// Minimum 15 seconds, maximum 15 minutes
const MIN_DELAY_MS = 15 * 1000;
const MAX_DELAY_MS = 15 * 60 * 1000;

/**
 * Validate core environment variables required for cloud execution.
 */
export function validateEnvironment() {
  const missing = [];
  if (!process.env.VERIFY_TOKEN) missing.push('VERIFY_TOKEN');
  if (!process.env.PAGE_ACCESS_TOKEN) missing.push('PAGE_ACCESS_TOKEN');
  if (!process.env.GEMINI_API_KEY) missing.push('GEMINI_API_KEY');

  if (missing.length > 0) {
    console.warn(`[Env Warning] Missing recommended environment variable(s): ${missing.join(', ')}. Ensure these are configured in your Railway variables.`);
  } else {
    console.log('[Env Check] All core environment variables (VERIFY_TOKEN, PAGE_ACCESS_TOKEN, GEMINI_API_KEY) are configured.');
  }
}

/**
 * Generate a random humanized delay between 15s and 15m.
 * @returns {number} Delay in milliseconds
 */
export function getRandomDelayMs() {
  return Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS;
}

// Parse incoming JSON requests
app.use(express.json());

// Gracefully handle malformed JSON bodies
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.warn('[Server] Received malformed JSON request body.');
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }
  next(err);
});

/**
 * Root Status Endpoint
 */
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'online',
    app: 'Mehak Instagram DM Automation',
    webhook: '/webhook',
    health: '/health'
  });
});

/**
 * Endpoint 1: GET /webhook
 * Meta Webhook Verification Handshake
 * Handles Meta Graph API webhook subscription verification.
 * Meta sends GET with hub.mode, hub.challenge, and hub.verify_token query parameters.
 */
app.get('/webhook', (req, res) => {
  // Query parameters may come in standard hub.* format, nested hub.* format, or flat format
  const mode = req.query['hub.mode'] || (req.query.hub && req.query.hub.mode) || req.query.mode;
  const token = req.query['hub.verify_token'] || (req.query.hub && req.query.hub.verify_token) || req.query.verify_token || req.query.token;
  const challenge = req.query['hub.challenge'] || (req.query.hub && req.query.hub.challenge) || req.query.challenge;

  // Sanitize expected and received tokens (remove quotes, trim whitespace)
  const expectedToken = (process.env.VERIFY_TOKEN || VERIFY_TOKEN || '').trim().replace(/^["']|["']$/g, '');
  const receivedToken = (typeof token === 'string' ? token.trim() : String(token || '')).replace(/^["']|["']$/g, '');

  console.log(`[Webhook] Verification attempt: mode="${mode}", token="${token ? '***' : 'EMPTY'}"`);

  if (!expectedToken) {
    console.error('[Webhook] Verification failed: process.env.VERIFY_TOKEN is not set in environment.');
    return res.status(500).send('Server configuration error: VERIFY_TOKEN is missing');
  }

  // Check if mode is 'subscribe' and token matches
  if (mode === 'subscribe' && receivedToken === expectedToken) {
    console.log('[Webhook] Verification handshake successful. Responding with challenge.');
    return res.status(200).set('Content-Type', 'text/plain').send(String(challenge));
  }

  console.warn(`[Webhook] Verification handshake failed. Mode was "${mode}", token matched: ${receivedToken === expectedToken}`);
  return res.status(403).send('Verification token mismatch or invalid mode');
});

/**
 * Background processor for incoming Meta webhook events.
 * Intentionally unawaited by the HTTP route handler to prevent Meta webhook timeout.
 * @param {object} payload
 */
export async function processIncomingWebhook(payload) {
  try {
    if (!payload || !Array.isArray(payload.entry)) {
      console.warn('[Webhook Background] Missing or invalid entry array in payload.');
      return;
    }

    for (const entry of payload.entry) {
      const entryId = entry.id;
      const messageItems = [];

      // 1. Extract from standard entry.messaging array
      if (Array.isArray(entry.messaging)) {
        for (const item of entry.messaging) {
          messageItems.push(item);
        }
      }

      // 2. Extract from entry.changes array (Meta Instagram Graph API webhooks format)
      if (Array.isArray(entry.changes)) {
        for (const change of entry.changes) {
          const val = change.value;
          if (!val) continue;

          if (val.message) {
            messageItems.push({
              sender: val.sender || val.from || { id: val.sender_id || val.from_id },
              recipient: val.recipient || { id: val.recipient_id || entryId },
              message: val.message
            });
          } else if (val.text) {
            messageItems.push({
              sender: val.sender || val.from || { id: val.sender_id || val.from_id },
              recipient: val.recipient || { id: val.recipient_id || entryId },
              message: {
                text: val.text,
                is_echo: Boolean(val.is_echo)
              }
            });
          }
        }
      }

      for (const item of messageItems) {
        // Critical Echo & Text Check:
        // Discard if item.message is missing, has is_echo === true, or lacks text
        if (!item || !item.message) continue;
        if (item.message.is_echo === true) {
          console.log('[Webhook Background] Echo message detected. Discarding to prevent bot reply loops.');
          continue;
        }
        if (!item.message.text || typeof item.message.text !== 'string' || item.message.text.trim() === '') {
          console.log('[Webhook Background] Non-text message or empty string received. Discarding.');
          continue;
        }

        const senderId = item.sender?.id || item.sender_id;
        const recipientId = item.recipient?.id || item.recipient_id;
        const text = item.message.text.trim();

        if (!senderId) {
          console.warn('[Webhook Background] Message missing sender ID. Discarding.');
          continue;
        }

        // Log incoming message to console
        console.log(`[Webhook Background] Incoming message received: "${text}" from sender: ${senderId} (Entry ID: ${entryId}, Recipient ID: ${recipientId})`);

        // Generate AI reply using Gemini queue / persona
        const replyText = await generateMehakReply(senderId, text);
        console.log(`[Webhook Background] Generated Mehak reply for ${senderId}: "${replyText}"`);

        // Immediate dispatch (no message delay logic applied)
        const sendAt = Date.now();

        // Save to SQLite message_queue
        const enqueued = enqueueReply(senderId, replyText, sendAt);
        console.log(`[Webhook Background] Enqueued message #${enqueued.id} for ${senderId} for immediate dispatch.`);
      }
    }
  } catch (error) {
    console.error('[Webhook Background] Error processing incoming webhook:', error.message || error);
  }
}

/**
 * Endpoint 2: POST /webhook
 * Incoming Message Receiver
 */
app.post('/webhook', (req, res) => {
  // Step A: IMMEDIATELY return 200 OK. Meta enforces a strict timeout (<5s).
  res.status(200).send('EVENT_RECEIVED');

  // Step B: Asynchronous unawaited background processing
  processIncomingWebhook(req.body).catch((err) => {
    console.error('[Webhook POST] Uncaught error in processIncomingWebhook:', err);
  });
});

/**
 * Health & Operational Monitoring Endpoint
 */
app.get('/health', (req, res) => {
  const stats = getQueueStats();
  res.status(200).json({
    status: 'ok',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    queue: stats
  });
});

let serverInstance = null;
let workerTaskInstance = null;

/**
 * Start the Express HTTP server and the background queue worker.
 * Binds to 0.0.0.0 for cloud container compatibility (e.g. Railway).
 * @param {number|string} [port=process.env.PORT || 3000]
 */
export function startServer(port = (process.env.PORT || 3000)) {
  const listenPort = Number(port) || 3000;

  // Validate critical cloud environment variables on startup
  validateEnvironment();

  serverInstance = app.listen(listenPort, '0.0.0.0', () => {
    console.log(`[Server] Mehak Instagram DM Automation server running on port ${listenPort}`);
    console.log(`[Server] Webhook URL: http://0.0.0.0:${listenPort}/webhook`);
    console.log(`[Server] Healthcheck: http://0.0.0.0:${listenPort}/health`);
  });

  // Start background queue worker
  workerTaskInstance = startQueueWorker();

  return { server: serverInstance, workerTask: workerTaskInstance };
}

/**
 * Stop HTTP server and background worker.
 */
export function stopServer() {
  if (workerTaskInstance) {
    workerTaskInstance.stop();
    workerTaskInstance = null;
  }
  if (serverInstance) {
    serverInstance.close();
    serverInstance = null;
  }
}

// Handle graceful shutdown
function gracefulShutdown(signal) {
  console.log(`[Server] Received ${signal}. Shutting down gracefully...`);
  stopServer();
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Auto-start server when executed directly as script
const currentFile = fileURLToPath(import.meta.url);
const executedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (executedFile && (currentFile === executedFile || executedFile.endsWith('server.js'))) {
  startServer(process.env.PORT || 3000);
}

export { app };
