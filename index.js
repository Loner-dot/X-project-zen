const express = require('express');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    delay, 
    makeCacheableSignalKeyStore,
    DisconnectReason // Added to handle closure reasons
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

    // Render's /tmp is the only safe place for session storage
    const authPath = path.join('/tmp', 'session', `${phone}_${Date.now()}`);
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(authPath);

        const sock = makeWASocket({
            // Using a high version number to trick the server if the fork is old
            version: [2, 3000, 1017531287], 
            printQRInTerminal: false,
            logger: pino({ level: "silent" }), // 'silent' reduces Render log clutter
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
            },
            browser: ["Ubuntu", "Chrome", "20.0.04"]
        });

        // Generate Pairing Code
        if (!sock.authState.creds.registered) {
            await delay(5000); 
            try {
                const code = await sock.requestPairingCode(phone);
                if (!res.headersSent) res.json({ code: code });
            } catch (pErr) {
                console.error("Pairing Error:", pErr);
                if (!res.headersSent) res.json({ error: "WhatsApp Blocked Request. Use a different number or wait." });
                return; // Stop execution if pairing fails
            }
        }

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                console.log(`✅ Success: ${phone}`);
                await delay(5000);

                const credsFile = path.join(authPath, 'creds.json');
                if (fs.existsSync(credsFile)) {
                    const creds = fs.readFileSync(credsFile);
                    const sessionID = "X-PROJECT~" + Buffer.from(creds).toString('base64');

                    await sock.sendMessage(sock.user.id, { 
                        text: `*『 𝗫-𝗣𝗥𝗢𝗝𝗘𝗖𝗧 | 𝗭𝗘𝗡 』*\n\n*SESSION ID:* \n\n\`\`\`${sessionID}\`\`\`` 
                    });
                }

                await delay(3000);
                await sock.logout();
                fs.removeSync(authPath);
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                console.log(`Connection closed: ${reason}`);
                
                // If it's a "Forbidden" (403) or "Logged Out" (401), clean up
                if (reason === DisconnectReason.loggedOut) {
                    fs.removeSync(authPath);
                }
            }
        });

    } catch (err) {
        console.error("Critical Error:", err);
        if (!res.headersSent) res.json({ error: "Server error. Check terminal." });
    }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`𝗫-𝗣𝗥𝗢𝗝𝗘𝗖𝗧 | 𝗭𝗘𝗡: Running on port ${PORT}`);
});
