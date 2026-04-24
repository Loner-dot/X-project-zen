const express = require('express');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    delay, 
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    PHONENUMBER_MCC
} = require("@whiskeysockets/baileys");
const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.get('/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.json({ error: "Provide a valid number." });
    phone = phone.replace(/\D/g, '');

    const authPath = path.join(__dirname, 'session', phone);
    if (fs.existsSync(authPath)) fs.removeSync(authPath);

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        printQRInTerminal: false,
        logger: pino({ level: "fatal" }),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
        },
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    if (!sock.authState.creds.registered) {
        try {
            await delay(5000); // Wait for socket stabilization
            const code = await sock.requestPairingCode(phone);
            if (!res.headersSent) res.json({ code: code });
        } catch (err) {
            console.error("Pairing Error:", err);
            if (!res.headersSent) res.json({ error: "Request Failed. Check number." });
        }
    }

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
        const { connection } = update;
        if (connection === 'open') {
            await delay(5000);
            
            // Generate Session ID from creds.json
            const creds = fs.readFileSync(path.join(authPath, 'creds.json'));
            const sessionID = "X-PROJECT~" + Buffer.from(creds).toString('base64');

            // Send to your WhatsApp
            await sock.sendMessage(sock.user.id, { 
                text: `*『 𝗫-𝗣𝗥𝗢𝗝𝗘𝗖𝗧 | 𝗭𝗘𝗡 』*\n\n*Status:* Secure Connection\n*Device:* Chrome (Linux)\n\n*Session ID:* \n\`\`\`${sessionID}\`\`\`\n\n_Keep this secret._` 
            });

            await delay(2000);
            await sock.logout();
            fs.removeSync(authPath);
        }
    });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`𝗫-𝗣𝗥𝗢𝗝𝗘𝗖𝗧 | 𝗭𝗘𝗡 active on port ${PORT}`);
});
