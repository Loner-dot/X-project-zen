const express = require('express');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    delay, 
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
    if (!phone) return res.json({ error: "No phone number provided" });
    
    phone = phone.replace(/\D/g, '');

    // 1. Ensure the session directory exists and is fresh
    const authPath = path.join('/tmp', 'session', `${phone}_${Date.now()}`);
    fs.ensureDirSync(authPath);
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(authPath);

        const sock = makeWASocket({
            // Forced standard version for pairing
            version: [2, 3000, 1017531287], 
            printQRInTerminal: false,
            logger: pino({ level: "fatal" }),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
            },
            // This specific browser string is crucial for pairing code generation
            browser: ["Chrome (Linux)", "", ""] 
        });

        if (!sock.authState.creds.registered) {
            // 2. Longer delay for Render (Free tier can be slow)
            await delay(8000); 
            
            try {
                const code = await sock.requestPairingCode(phone);
                if (!res.headersSent) {
                    return res.json({ code: code });
                }
            } catch (pairingErr) {
                console.log("CRITICAL PAIRING ERROR:", pairingErr);
                // If the fork doesn't support pairing codes, this will trigger
                if (!res.headersSent) {
                    return res.json({ error: "WhatsApp rejected the connection. Try a different number." });
                }
            }
        }

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'open') {
                console.log(`✅ Success`);
                await delay(5000);
                const credsFile = path.join(authPath, 'creds.json');
                if (fs.existsSync(credsFile)) {
                    const creds = fs.readFileSync(credsFile);
                    const sessionID = "X-PROJECT~" + Buffer.from(creds).toString('base64');
                    await sock.sendMessage(sock.user.id, { text: sessionID });
                }
                await sock.logout();
                fs.removeSync(authPath);
            }
        });

    } catch (err) {
        console.error("Internal Error:", err);
        if (!res.headersSent) res.json({ error: "Server busy. Try again." });
    }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`ZEN X-PROJECT LIVE ON ${PORT}`);
});
