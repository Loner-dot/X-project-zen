const express = require('express');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    delay, 
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    DisconnectReason
} = require("@whiskeysockets/baileys");
const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.get('/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.json({ error: "No phone number" });
    phone = phone.replace(/\D/g, '');

    const authPath = path.join(__dirname, 'session', phone);
    if (fs.existsSync(authPath)) fs.removeSync(authPath);

    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    const sock = makeWASocket({
        // Forced stable version for better handshake
        version: [2, 3000, 1015901307],
        printQRInTerminal: false,
        logger: pino({ level: "fatal" }),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
        },
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        // 🛠️ CRITICAL SPEED FIXES
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        emitOwnEvents: true,
        fireInitQueries: true,
        generateHighQualityLinkPreview: false,
        syncFullHistory: false, // Prevents loading too much data/ram
        markOnlineOnConnect: true
    });

    if (!sock.authState.creds.registered) {
        try {
            await delay(3500); 
            const code = await sock.requestPairingCode(phone);
            if (!res.headersSent) res.json({ code: code });
        } catch (err) {
            console.error("Pair Error:", err);
            if (!res.headersSent) res.json({ error: "Try again in 10 seconds." });
        }
    }

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'open') {
            console.log("✅ Linked successfully");
            await delay(5000);
            const creds = fs.readFileSync(path.join(authPath, 'creds.json'));
            const sessionID = "X-PROJECT~" + Buffer.from(creds).toString('base64');

            await sock.sendMessage(sock.user.id, { 
                text: `*『 𝗫-𝗣𝗥𝗢𝗝𝗘𝗖𝗧 | 𝗭𝗘𝗡 』*\n\n*ID:* \`\`\`${sessionID}\`\`\`` 
            });

            await delay(3000);
            await sock.logout();
            fs.removeSync(authPath);
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log("Connection closed, reason:", reason);
            // If it closed with a 401, the pairing failed.
        }
    });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`𝗫-𝗣𝗥𝗢𝗝𝗘𝗖𝗧 Active`);
});
