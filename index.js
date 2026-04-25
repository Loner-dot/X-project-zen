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
// Railway automatically provides a PORT environment variable
const PORT = process.env.PORT || 8080; 

// Serve static files if you have a separate CSS/JS folder
app.use(express.static(path.join(__dirname, 'public')));

app.get('/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.json({ error: "No phone number" });
    phone = phone.replace(/\D/g, '');

    // Railway has a persistent /tmp directory for sessions
    const authPath = path.join('/tmp', 'session', `${phone}_${Date.now()}`);
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(authPath);

        const sock = makeWASocket({
            version: [2, 3000, 1017531287],
            printQRInTerminal: false,
            logger: pino({ level: "fatal" }),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
            },
            browser: ["Chrome (Linux)", "", ""] 
        });

        if (!sock.authState.creds.registered) {
            // Reduced delay for Railway since CPU is faster than Render
            await delay(5000); 
            
            try {
                const code = await sock.requestPairingCode(phone);
                if (!res.headersSent) return res.json({ code: code });
            } catch (err) {
                if (!res.headersSent) return res.json({ error: "WA Request Failed" });
            }
        }

        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', async (s) => {
            if (s.connection === 'open') {
                const creds = fs.readFileSync(path.join(authPath, 'creds.json'));
                const sessionID = "X-PROJECT~" + Buffer.from(creds).toString('base64');
                await sock.sendMessage(sock.user.id, { text: sessionID });
                await sock.logout();
                fs.removeSync(authPath);
            }
        });

    } catch (e) {
        if (!res.headersSent) res.json({ error: "Internal Error" });
    }
});

// Serve the index.html from your root directory
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`ZEN X-PROJECT: Online on Port ${PORT}`);
});
