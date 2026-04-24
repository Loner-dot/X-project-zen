const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, delay, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/pair', async (req, res) => {
    const phone = req.query.phone;
    if (!phone) return res.json({ error: "Provide a valid number." });

    const authPath = path.join(__dirname, 'auth', phone);
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        auth: state,
        // 🛠️ SETTING BROWSER TO CHROME FOR NOTIFICATIONS
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    if (!sock.authState.creds.registered) {
        try {
            await delay(3000);
            const code = await sock.requestPairingCode(phone);
            if (!res.headersSent) res.json({ code });
        } catch (err) {
            if (!res.headersSent) res.json({ error: "Pairing failed." });
        }
    }

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
        const { connection } = update;
        if (connection === 'open') {
            await delay(5000);
            
            const creds = fs.readFileSync(path.join(authPath, 'creds.json'));
            const sessionID = "X-PROJECT~" + Buffer.from(creds).toString('base64');

            // THE WHATSAPP NOTIFICATION
            await sock.sendMessage(sock.user.id, { 
                text: `*『 𝗫-𝗣𝗥𝗢𝗝𝗘𝗖𝗧 | 𝗭𝗘𝗡 』*\n\n*Status:* Secure Connection Established\n*Browser:* Chrome (Linux)\n\n*Session ID:* \`\`\`${sessionID}\`\`\`\n\n_Use this ID to power your X-PROJECT bot._` 
            });

            await delay(2000);
            await sock.logout();
            fs.removeSync(authPath);
        }
    });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, () => console.log(`𝗫-𝗣𝗥𝗢𝗝𝗘𝗖𝗧 online on ${PORT}`));
