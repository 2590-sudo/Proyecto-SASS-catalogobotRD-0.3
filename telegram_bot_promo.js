const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');

const promoSchema = new mongoose.Schema({
    managedGroupId: { type: String, default: '' }
});
const PromoConfig = mongoose.models.PromoConfig || mongoose.model('PromoConfig', promoSchema);

let bot;
let groupId = '';

async function initPromoBot() {
    const token = process.env.TELEGRAM_BOT_TOKEN_4;
    if (!token) {
        console.log('[PROMO] No se encontro TELEGRAM_BOT_TOKEN_4 en las variables de entorno.');
        return;
    }
    
    bot = new TelegramBot(token, { polling: true });
    console.log('[PROMO] Bot dinamizador/comunidad iniciado.');
    
    try {
        let conf = await PromoConfig.findOne({});
        if (conf && conf.managedGroupId) {
            groupId = conf.managedGroupId;
        } else {
            conf = new PromoConfig();
            await conf.save();
        }
    } catch(e) { console.error('Error cargando config Promo:', e.message); }

    bot.on('message', async (msg) => {
        if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
            const chatId = msg.chat.id.toString();
            if (groupId !== chatId) {
                groupId = chatId;
                try {
                    await PromoConfig.updateOne({}, { managedGroupId: groupId });
                    console.log(`[PROMO] Enganchado al grupo: ${groupId}`);
                } catch(e) {}
            }
        }
    });
}

async function sendPromoMessage(text, photoData, isBuffer = false) {
    if (!bot) throw new Error("El bot Dinamizador no está encendido (revisa el Token).");
    if (!groupId) throw new Error("El bot no sabe a qué grupo enviar. Escribe cualquier cosa en el grupo para que lo detecte primero.");
    
    if (photoData) {
        if (isBuffer) {
            await bot.sendPhoto(groupId, photoData, { caption: text, parse_mode: 'HTML' }, { filename: 'imagen.jpg', contentType: 'image/jpeg' });
        } else if (typeof photoData === 'string' && photoData.trim() !== '') {
            await bot.sendPhoto(groupId, photoData, { caption: text, parse_mode: 'HTML' });
        } else {
            await bot.sendMessage(groupId, text, { parse_mode: 'HTML' });
        }
    } else {
        await bot.sendMessage(groupId, text, { parse_mode: 'HTML' });
    }
}

module.exports = { initPromoBot, sendPromoMessage };
