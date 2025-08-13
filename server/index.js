import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';
import { z } from 'zod';

const app = express();
app.use(cors());
app.use(express.static('public'));
app.get('/health', (_, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ---- Gemini setup
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY, // server-side only
});

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-preview-native-audio-dialog';
// Dev fallbacks you can toggle temporarily if you hit free-tier limits:
const DEV_FALLBACKS = ['gemini-live-2.5-flash-preview', 'gemini-2.0-flash-live-001']; // optional

// Revolt-only system instruction (short, firm scope)
const SYSTEM_INSTRUCTION = `
You are "Rev", a voice assistant for Revolt Motors.
Answer only questions about Revolt Motors—its bikes, policies, service, stores, financing, test rides, charging, and ownership.
If asked anything outside Revolt Motors, politely say you can only discuss Revolt Motors topics.
Keep responses concise, friendly, and in the user's language when obvious.
`;

wss.on('connection', async (clientWs) => {
  // open a Live API session for this browser connection
  let session;
  let closed = false;

  function sendToClient(obj) {
    if (!closed && clientWs.readyState === 1) clientWs.send(JSON.stringify(obj));
  }

  try {
    // queue to buffer messages from Gemini until client is ready
    const responseQueue = [];

    session = await ai.live.connect({
      model: MODEL,
      config: {
        // audio out
        responseModalities: [Modality.AUDIO],
        // (Native audio yields 24kHz PCM; half-cascade uses TTS; both are fine per docs)
        systemInstruction: SYSTEM_INSTRUCTION.trim(),
      },
      callbacks: {
        onopen() {
          sendToClient({ type: 'session_open' });
        },
        onmessage(message) {
          // Stream back model audio chunks + server events
          if (message?.data) {
            // data is base64-encoded 16-bit PCM @ 24kHz per docs
            sendToClient({ type: 'audio', data: message.data });
          }
          if (message?.serverContent) {
            const { turnComplete, interrupted, inputTranscription, outputTranscription } = message.serverContent;
            if (interrupted) sendToClient({ type: 'interrupted' });
            if (inputTranscription?.transcript) {
              sendToClient({ type: 'input_stt', text: inputTranscription.transcript });
            }
            if (outputTranscription?.transcript) {
              sendToClient({ type: 'output_stt', text: outputTranscription.transcript });
            }
            if (turnComplete) sendToClient({ type: 'turn_complete' });
          }
          // (You can forward usage metadata here too if you want)
          responseQueue.push(message);
        },
        onerror(e) {
          sendToClient({ type: 'error', message: e?.message || 'Gemini error' });
        },
        onclose() {
          sendToClient({ type: 'session_closed' });
        },
      },
    });

    // Any message from the browser → forward to Gemini
    clientWs.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        // Validate message
        const schema = z.discriminatedUnion('type', [
          z.object({
            type: z.literal('audio'),
            // base64 of 16-bit PCM mono @ 16kHz
            data: z.string().min(8),
          }),
          z.object({ type: z.literal('audio_end') }),
          z.object({
            type: z.literal('text'),
            text: z.string().min(1),
          }),
          z.object({ type: z.literal('cancel') }),
        ]);
        const m = schema.parse(msg);

        if (m.type === 'audio') {
          session.sendRealtimeInput({
            audio: {
              data: m.data,
              mimeType: 'audio/pcm;rate=16000',
            },
          });
        } else if (m.type === 'audio_end') {
          // signal end-of-stream for VAD/turn completion if you're stopping mic
          session.sendRealtimeInput({ audioStreamEnd: true });
        } else if (m.type === 'text') {
          // (Optional) text turns: this also supports barge-in
          session.sendRealtimeInput({ text: m.text });
        } else if (m.type === 'cancel') {
          // Sending new activity automatically interrupts; explicit cancel not required,
          // but you can close/reopen session if you need a hard reset.
        }
      } catch (e) {
        sendToClient({ type: 'error', message: 'Bad client message' });
      }
    });

    clientWs.on('close', () => {
      closed = true;
      try { session?.close(); } catch {}
    });
  } catch (err) {
    sendToClient({ type: 'error', message: err?.message || 'Failed to open session' });
    clientWs.close();
  }
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log(`http://localhost:${port}`);
});
