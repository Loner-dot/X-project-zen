const express = require('express');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    delay, 
    makeCacheableSignalKeyStore 
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

    // Render fix: Always use /tmp for session storage
    const authPath = path.join('/tmp', 'session', `${phone}_${Date.now()}`);
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(authPath);

        const sock = makeWASocket({
            version: [2, 3000, 1017531287], // Hardcoded to avoid extra network/CPU calls
            printQRInTerminal: false,
            logger: pino({ level: "fatal" }), // SILENCE logs to save CPU cycles
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
            },
            browser: ["Chrome (Linux)", "", ""] 
        });

        if (!sock.authState.creds.registered) {
            // CRITICAL: Give Render 10s to "warm up" before requesting the code
            await delay(10000); 
            
            try {
                const code = await sock.requestPairingCode(phone);
                if (!res.headersSent) return res.json({ code: code });
            } catch (err) {
                if (!res.headersSent) return res.json({ error: "CPU Timeout. Try again." });
            }
        }

        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', async (s) => {
            if (s.connection === 'open') {
                await delay(3000);
                const creds = fs.readFileSync(path.join(authPath, 'creds.json'));
                const sessionID = "X-PROJECT~" + Buffer.from(creds).toString('base64');
                
                // Send the ID to the user's WhatsApp
                await sock.sendMessage(sock.user.id, { text: sessionID });
                
                // Cleanup to keep Render instance from crashing
                await sock.logout();
                fs.removeSync(authPath);
            }
        });

    } catch (e) {
        if (!res.headersSent) res.json({ error: "Server Overloaded" });
    }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, '0.0.0.0');
