const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');

const altamiraSchema = new mongoose.Schema({
    managedGroupId: { type: String, default: '' }
});
const AltamiraConfig = mongoose.models.AltamiraConfig || mongoose.model('AltamiraConfig', altamiraSchema);

let bot;
let groupId = '';

async function initAltamiraBot() {
    const token = process.env.TELEGRAM_BOT_TOKEN_3;
    if (!token) {
        console.log('[ALTAMIRA] No se encontro TELEGRAM_BOT_TOKEN_3 en las variables de entorno.');
        return;
    }
    
    bot = new TelegramBot(token, { polling: true });
    console.log('[ALTAMIRA] Bot motivador/pagos iniciado.');
    
    try {
        let conf = await AltamiraConfig.findOne({});
        if (conf && conf.managedGroupId) {
            groupId = conf.managedGroupId;
        } else {
            conf = new AltamiraConfig();
            await conf.save();
        }
    } catch(e) { console.error('Error cargando config Altamira:', e.message); }

    // Escuchar mensajes para capturar el ID del grupo
    bot.on('message', async (msg) => {
        if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
            const chatId = msg.chat.id.toString();
            if (groupId !== chatId) {
                groupId = chatId;
                try {
                    await AltamiraConfig.updateOne({}, { managedGroupId: groupId });
                    console.log(`[ALTAMIRA] Enganchado al grupo: ${groupId}`);
                } catch(e) {}
            }
        }
    });
}

async function sendProofMessage(text, photoUrl) {
    if (!bot) throw new Error("El bot Altamira no está encendido (revisa el Token).");
    if (!groupId) throw new Error("El bot no sabe a qué grupo enviar. Escribe cualquier cosa en el grupo para que Altamira lo detecte primero.");
    
    if (photoUrl && photoUrl.trim() !== '') {
        await bot.sendPhoto(groupId, photoUrl, { caption: text, parse_mode: 'HTML' });
    } else {
        await bot.sendMessage(groupId, text, { parse_mode: 'HTML' });
    }
}

module.exports = { 
    initAltamiraBot,
    sendProofMessage
};
