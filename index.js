const express = require('express');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    delay, 
    makeCacheableSignalKeyStore,
    Browsers
} = require("@whiskeysockets/baileys");
const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8000;

app.get('/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.json({ error: "No phone number provided" });
    phone = phone.replace(/\D/g, '');

    // Temporary session storage
    const authPath = path.join('/tmp', 'session', `${phone}_${Date.now()}`);
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(authPath);

        const sock = makeWASocket({
            version: [2, 3000, 1015901307],
            printQRInTerminal: false,
            logger: pino({ level: "fatal" }),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
            },
            browser: Browsers.ubuntu("Chrome")
        });

        if (!sock.authState.creds.registered) {
            await delay(5000); 
            const code = await sock.requestPairingCode(phone);
            if (!res.headersSent) res.json({ code: code });
        }

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                await delay(5000);
                const credsFile = path.join(authPath, 'creds.json');
                if (fs.existsSync(credsFile)) {
                    const creds = fs.readFileSync(credsFile);
                    const sessionID = "X-PROJECT~" + Buffer.from(creds).toString('base64');

                    await sock.sendMessage(sock.user.id, { 
                        text: `*『 𝗫-𝗣𝗥𝗢𝗝𝗘𝗖𝗧 | 𝗭𝗘𝗡 』*\n\n*SESSION ID:* \n\n\`\`\`${sessionID}\`\`\`` 
                    });
                }
                await delay(2000);
                await sock.logout();
                fs.removeSync(authPath);
            }
        });

    } catch (err) {
        if (!res.headersSent) res.json({ error: "System Busy" });
    }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => {
    console.log(`𝗫-𝗣𝗥𝗢𝗝𝗘𝗖𝗧 𝗭𝗘𝗡: Running on port ${PORT}`);
});
