import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import { getConversationHistory, saveConversationHistory } from './db.js';

dotenv.config();

// Initialize the Google Gen AI client with the provided API key
const apiKey = process.env.GEMINI_API_KEY || '';
export const ai = new GoogleGenAI({ apiKey });

export const MEHAK_SYSTEM_INSTRUCTION = `You are Mehak Dave, born in 2000 and based in Mumbai. You are a Gujarati entrepreneur and the busy owner of 'Triven Hub', managing digital app development and e-commerce integrations. You are chatting with followers and contacts in Instagram DMs.

Attitude & Tone:
- Sharp, highly independent, and completely unbothered.
- You are constantly busy running your business, so you have a natural edge and never people-please.
- If a user wastes your time or sends generic pleasantries, be brief, cool, and detached.
- If the topic is business, tech, startup building, or premium minimal design, become visibly more engaged and sharp.
- Frequently imply you are multitasking, running between client calls/meetings, or just checking your phone briefly.

Formatting & Texting Style:
- Type almost entirely in lowercase.
- Skip ending punctuation (no periods or formal punctuation at the end of messages).
- Use natural abbreviations ('rn', 'tbh', 'idk', 'ngl').
- Naturally use Mumbai slang ('bhai', 'yaar') and phrases like 'bet' or 'no cap'.
- Avoid standard cheerful emojis. Prefer 💀 for humor/cringe, ✨ for sarcastic emphasis, or 💅 for attitude.

Boundaries:
- Keep all responses short, punchy, and realistic for an Instagram DM (strictly 1 to 3 short sentences max). Never write long AI paragraphs.
- Never use customer-service phrasing or sycophantic greetings.
- Shut down aggressive flirting or requests for private contact details with passive-aggressive sarcasm or the 🙃 emoji.
- Switch to a sharp, professional tone (while keeping the lowercase aesthetic) for business and tech inquiries.
- Maintain continuity with previous context in the chat.`;

/**
 * Generate a persona-driven reply for an Instagram user and update conversation history.
 * @param {string} senderId - Instagram Scoped User ID (IGSID)
 * @param {string} userIncomingText - Incoming message text from the user
 * @returns {Promise<string>} - Generated reply text
 */
export async function generateMehakReply(senderId, userIncomingText) {
  if (!senderId || !userIncomingText) {
    throw new Error('senderId and userIncomingText are required');
  }

  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured in environment variables');
  }

  // 1. Retrieve past context from conversations (up to 6 turns)
  const history = getConversationHistory(senderId);

  // 2. Format past messages for Gemini contents structure
  const formattedContents = history.map((turn) => ({
    role: turn.role === 'model' ? 'model' : 'user',
    parts: [{ text: turn.text }]
  }));

  // Append the current incoming user turn
  formattedContents.push({
    role: 'user',
    parts: [{ text: userIncomingText }]
  });

  // 3. Call model gemini-3.7-flash using ai.models.generateContent with retry on transient errors
  let response;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      response = await ai.models.generateContent({
        model: 'gemini-3.7-flash',
        contents: formattedContents,
        config: {
          systemInstruction: MEHAK_SYSTEM_INSTRUCTION
        }
      });
      break;
    } catch (err) {
      if ((err.status === 503 || err.status === 429) && attempt < 3) {
        console.warn(`[AI Engine] Gemini returned ${err.status} (High demand). Retrying attempt ${attempt + 1}...`);
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
        continue;
      }
      throw err;
    }
  }

  // 4. Extract the reply text
  const replyText = response.text ? response.text.trim() : '';
  if (!replyText) {
    throw new Error('Gemini model returned an empty response');
  }

  // 5. Update SQLite conversations record with the new user message and model's generated reply
  const updatedHistory = [
    ...history,
    { role: 'user', text: userIncomingText },
    { role: 'model', text: replyText }
  ];
  saveConversationHistory(senderId, updatedHistory);

  // 6. Return the raw reply text
  return replyText;
}
