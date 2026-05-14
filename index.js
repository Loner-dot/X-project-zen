import express from 'express';
import {
  default as makeWASocket,
  useMultiFileAuthState,
  delay,
  makeCacheableSignalKeyStore,
  Browsers,
  DisconnectReason
} from "@whiskeysockets/baileys";
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve frontend
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ─────────────────────────────────────────────
// Helper: Poll until WebSocket is fully open
// ─────────────────────────────────────────────
const waitForWebSocket = async (sock, timeout = 60000) => {
  const checkInterval = 100;
  let waited = 0;
  while (waited < timeout) {
    if (sock.ws?.socket?.readyState === 1) return true;
    await new Promise(r => setTimeout(r, checkInterval));
    waited += checkInterval;
  }
  return false;
};

// ─────────────────────────────────────────────
// Helper: Safe cleanup
// ─────────────────────────────────────────────
const safeCleanup = (authPath, delayMs = 60000) => {
  setTimeout(() => {
    try {
      fs.rmSync(authPath, { recursive: true, force: true });
      console.log('🧹 Session folder cleaned up:', authPath);
    } catch (err) {
      console.error('Cleanup error:', err.message);
    }
  }, delayMs);
};

// ─────────────────────────────────────────────
// /pair endpoint
// ─────────────────────────────────────────────
app.get('/pair', async (req, res) => {
  let phone = req.query.phone;
  if (!phone) return res.json({ error: 'No phone number provided' });

  phone = phone.replace(/\D/g, '');
  if (phone.length < 7 || phone.length > 15) {
    return res.json({ error: 'Invalid phone number format' });
  }

  const authPath = path.join(__dirname, 'sessions', `${phone}_${Date.now()}`);
  fs.mkdirSync(authPath, { recursive: true });
  console.log('📂 Auth path:', authPath);

  let responded = false;
  const safeJson = (data) => {
    if (!responded && !res.headersSent) {
      responded = true;
      res.json(data);
    }
  };

  // ⏱️ 5 MINUTE overall timeout (generous)
  const timeout = setTimeout(() => {
    safeJson({ error: 'Request timed out. Please try again.' });
    safeCleanup(authPath);
  }, 300000);

  const connectSocket = async () => {
    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    const logger = pino({ level: 'silent' });

    const sock = makeWASocket({
      printQRInTerminal: false,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      browser: Browsers.ubuntu('Chrome'),
      connectTimeoutMs: 60000,
    });

    if (!sock.authState.creds.registered) {

      const wsReady = await waitForWebSocket(sock, 60000);
      if (!wsReady) {
        clearTimeout(timeout);
        safeJson({ error: 'WebSocket failed to open. Please try again.' });
        safeCleanup(authPath);
        return;
      }

      // ⏱️ Wait 3 seconds after WebSocket opens
      await delay(3000);

      try {
        const code = await sock.requestPairingCode(phone);
        safeJson({ code: code?.match(/.{1,4}/g)?.join('-') || code });
      } catch (err) {
        clearTimeout(timeout);
        safeJson({ error: 'Failed to generate pairing code: ' + err.message });
        safeCleanup(authPath);
        return;
      }
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;

        if (statusCode !== DisconnectReason.loggedOut) {
          console.log(`🔄 Connection closed (${statusCode}) — reconnecting...`);
          await connectSocket();
        } else {
          clearTimeout(timeout);
          safeCleanup(authPath);
        }
        return;
      }

      if (connection === 'open') {
        clearTimeout(timeout);
        console.log('✅ WhatsApp connected!');

        // ⏱️ WAIT 4 MINUTES - BULLETPROOF 😂
        console.log('⏳ Waiting 4 minutes for WhatsApp to fully sync...');
        console.log('💤 Grab a coffee, this will take a while...');
        await delay(240000); // 4 MINUTES

        try {
          const credsFile = path.join(authPath, 'creds.json');
          if (!fs.existsSync(credsFile)) {
            safeJson({ error: 'Session file not found after pairing.' });
            safeCleanup(authPath);
            return;
          }

          const creds = fs.readFileSync(credsFile);
          const sessionID = 'ZEN-AI~' + Buffer.from(creds).toString('base64');

          const rawJid = sock.user.id;
          const cleanJid = rawJid.split(':')[0] + '@s.whatsapp.net';
          console.log('📤 Sending session to:', cleanJid);

          await sock.sendMessage(cleanJid, {
            text: `🔮 *ZEN AI CONNECTED!*\n\n✅ Your WhatsApp is now linked\n\n*SESSION ID:*\n\`\`\`${sessionID}\`\`\`\n\n📁 Save this in your .env file:\nSESSION_ID=${sessionID}\n\n_Powered by ZEN AI_ ✨`
          });

          console.log('✅ Session ID sent successfully');

          // ⏱️ WAIT 30 SECONDS - Message delivery
          console.log('⏳ Waiting 30s for message delivery...');
          await delay(30000);

        } catch (err) {
          console.error('❌ Error sending session:', err.message);
        } finally {
          // ⏱️ WAIT 2 MINUTES before cleanup
          console.log('⏳ Waiting 2 minutes before cleanup...');
          safeCleanup(authPath, 120000);
        }
      }
    });
  };

  try {
    await connectSocket();
  } catch (err) {
    clearTimeout(timeout);
    console.error('❌ Pair error:', err.message);
    safeJson({ error: 'System Busy' });
    safeCleanup(authPath);
  }
});

app.listen(PORT, () => {
  console.log('╔═══════════════════════════════════╗');
  console.log('║   🔮 ZEN AI DASHBOARD ONLINE 🔮  ║');
  console.log('╠═══════════════════════════════════╣');
  console.log(`║   Port: ${PORT}                      ║');
  console.log('║   Mode: BULLETPROOF 4 MIN     ║');
  console.log('╚═══════════════════════════════════╝');
});
