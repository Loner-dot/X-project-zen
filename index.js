import express from 'express';
import {
  default as makeWASocket,
  useMultiFileAuthState,
  delay,
  makeCacheableSignalKeyStore,
  Browsers,
  DisconnectReason
} from "@nexustechpro/baileys";
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
// WhatsApp requires readyState === 1 before
// a pairing code can be requested. A flat
// delay() is unreliable — we poll instead.
// ─────────────────────────────────────────────
const waitForWebSocket = async (sock, timeout = 20000) => {
  const checkInterval = 100;
  let waited = 0;
  while (waited < timeout) {
    if (sock.ws?.socket?._readyState === 1) return true;
    await new Promise(r => setTimeout(r, checkInterval));
    waited += checkInterval;
  }
  return false;
};

// ─────────────────────────────────────────────
// Helper: Safe cleanup — waits before deleting
// so Baileys can finish writing its session files
// before we remove the directory
// ─────────────────────────────────────────────
const safeCleanup = (authPath, delayMs = 10000) => {
  setTimeout(() => {
    try {
      fs.rmSync(authPath, { recursive: true, force: true });
      console.log('Session folder cleaned up:', authPath);
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

  // Strip non-numeric characters
  phone = phone.replace(/\D/g, '');
  if (phone.length < 7 || phone.length > 15) {
    return res.json({ error: 'Invalid phone number format' });
  }

  // Use local sessions folder — works on Windows and Linux/Render
  // os.tmpdir() resolves to AppData on Windows which causes path issues
  const authPath = path.join(__dirname, 'sessions', `${phone}_${Date.now()}`);
  fs.mkdirSync(authPath, { recursive: true });
  console.log('Auth path:', authPath);

  // Guard against sending response twice
  let responded = false;
  const safeJson = (data) => {
    if (!responded && !res.headersSent) {
      responded = true;
      res.json(data);
    }
  };

  // 60s overall timeout — enough time for 515 reconnect cycle
  const timeout = setTimeout(() => {
    safeJson({ error: 'Request timed out. Please try again.' });
    safeCleanup(authPath);
  }, 60000);

  // ─────────────────────────────────────────
  // connectSocket is a named function so it
  // can call itself on reconnect (e.g. 515)
  // exactly how Baileys recommends it
  // ─────────────────────────────────────────
  const connectSocket = async () => {
    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    // pino must always be passed to makeCacheableSignalKeyStore
    // even if we don't want socket-level logs — never skip this
    const logger = pino({ level: 'silent' });

    const sock = makeWASocket({
      printQRInTerminal: false,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      browser: Browsers.ubuntu('Chrome'),
      connectTimeoutMs: 20000,
    });

    // Only request pairing code on fresh (unregistered) sessions
    if (!sock.authState.creds.registered) {

      // Wait for WS handshake to complete before requesting code
      // A flat delay() is not reliable — WS must be readyState 1
      const wsReady = await waitForWebSocket(sock, 20000);
      if (!wsReady) {
        clearTimeout(timeout);
        safeJson({ error: 'WebSocket failed to open. Please try again.' });
        safeCleanup(authPath);
        return;
      }

      // Small buffer after WS open for stability
      await delay(500);

      try {
        const code = await sock.requestPairingCode(phone);
        // Format as XXXX-XXXX for readability
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

        // WhatsApp sends 515 after pairing to force a restart
        // We must reconnect — NOT close — this is expected Baileys behaviour
        if (statusCode !== DisconnectReason.loggedOut) {
          console.log(`Connection closed (${statusCode}) — reconnecting...`);
          await connectSocket();
        } else {
          // Intentional logout — clean up after Baileys finishes writing
          clearTimeout(timeout);
          safeCleanup(authPath);
        }
        return;
      }

      if (connection === 'open') {
        clearTimeout(timeout);

        // Wait for app state sync to fully complete
        // Logs show sync takes a few seconds after 'open' fires
        await delay(8000);

        try {
          const credsFile = path.join(authPath, 'creds.json');
          if (!fs.existsSync(credsFile)) {
            safeJson({ error: 'Session file not found after pairing.' });
            safeCleanup(authPath);
            return;
          }

          const creds = fs.readFileSync(credsFile);
          const sessionID = 'X-PROJECT~' + Buffer.from(creds).toString('base64');

          // Baileys v7 appends device ID to user JID e.g. 234...:24@s.whatsapp.net
          // Strip the device suffix before sending so the message goes to self-chat
          const rawJid = sock.user.id;
          const cleanJid = rawJid.split(':')[0] + '@s.whatsapp.net';
          console.log('Sending session to:', cleanJid);

          await sock.sendMessage(cleanJid, {
            text: `*『 𝗫-𝗣𝗥𝗢𝗝𝗘𝗖𝗧 | 𝗭𝗘𝗡 』*\n\n*SESSION ID:* \n\n\`\`\`${sessionID}\`\`\``
          });

          console.log('Session ID sent successfully');

          // Wait for message delivery before cleanup
          // Do NOT call sock.logout() here — it triggers connection close
          // which causes connectSocket() to recurse unnecessarily
          // Just wait, then clean up the temp session folder
          await delay(5000);

        } catch (err) {
          console.error('Error sending session message:', err.message);
        } finally {
          // Delay cleanup so Baileys can finish any pending file writes
          // Calling rmSync immediately causes ENOENT errors in Baileys internals
          safeCleanup(authPath, 15000);
        }
      }
    });
  };

  try {
    await connectSocket();
  } catch (err) {
    clearTimeout(timeout);
    console.error('Pair error:', err.message);
    safeJson({ error: 'System Busy' });
    safeCleanup(authPath);
  }
});

app.listen(PORT, () => {
  console.log(`𝗫-𝗣𝗥𝗢𝗝𝗘𝗖𝗧 𝗭𝗘𝗡: Running on port ${PORT}`);
});
