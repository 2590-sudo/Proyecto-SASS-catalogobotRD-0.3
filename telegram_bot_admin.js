const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');

const configSchema = new mongoose.Schema({
    welcomeText: { type: String, default: '¡Bienvenido/a {name} al grupo!' },
    welcomePhotoUrl: { type: String, default: '' },
    deleteLinks: { type: Boolean, default: true },
    autoApprove: { type: Boolean, default: false }
});

const TGConfig = mongoose.models.TGConfig || mongoose.model('TGConfig', configSchema);

let bot;
let activeConfig = {
    welcomeText: '¡Bienvenido/a {name} al grupo!',
    welcomePhotoUrl: '',
    deleteLinks: true,
    autoApprove: false
};

async function initAdminBot() {
    const token = process.env.TELEGRAM_BOT_TOKEN_2 || process.env.TELEGRAM_ADMIN_TOKEN;
    if (!token) {
        console.log('[TG ADMIN] No se encontro TELEGRAM_BOT_TOKEN_2 en las variables de entorno.');
        return;
    }
    
    bot = new TelegramBot(token, { polling: true });
    console.log('[TG ADMIN] Bot de administracion iniciado.');
    
    try {
        let conf = await TGConfig.findOne({});
        if (conf) activeConfig = conf;
        else {
            conf = new TGConfig(activeConfig);
            await conf.save();
        }
    } catch(e) { console.error('Error cargando config TG:', e.message); }

    // Eliminar enlaces
    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        if (activeConfig.deleteLinks && msg.text) {
            const regexLink = /(http:\/\/|https:\/\/|t\.me|www\.)/i;
            if (regexLink.test(msg.text)) {
                try {
                    const member = await bot.getChatMember(chatId, msg.from.id);
                    if (member.status !== 'administrator' && member.status !== 'creator') {
                        bot.deleteMessage(chatId, msg.message_id).catch(()=>{});
                        bot.sendMessage(chatId, `⚠️ @${msg.from.username || msg.from.first_name}, los enlaces no están permitidos.`).then(m => {
                            setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(()=>{}), 5000);
                        });
                    }
                } catch(e) {}
            }
        }
    });

    // Dar Bienvenida
    bot.on('new_chat_members', async (msg) => {
        const chatId = msg.chat.id;
        const newMembers = msg.new_chat_members;
        
        for (const member of newMembers) {
            // Ignorar si es el propio bot
            if (member.id === bot.botInfo?.id) continue;
            
            const text = activeConfig.welcomeText.replace('{name}', member.first_name);
            try {
                if (activeConfig.welcomePhotoUrl && activeConfig.welcomePhotoUrl.startsWith('http')) {
                    await bot.sendPhoto(chatId, activeConfig.welcomePhotoUrl, { caption: text });
                } else {
                    await bot.sendMessage(chatId, text);
                }
            } catch(e) { console.error('Error enviando bienvenida:', e.message); }
        }
    });

    // Auto Aprobar solicitudes de union
    bot.on('chat_join_request', async (request) => {
        if (activeConfig.autoApprove) {
            try {
                await bot.approveChatJoinRequest(request.chat.id, request.from.id);
                console.log(`[TG ADMIN] Solicitud aprobada para ${request.from.first_name}`);
            } catch (e) {
                console.error('[TG ADMIN] Error aprobando solicitud:', e.message);
            }
        }
    });
}

module.exports = { 
    initAdminBot, 
    TGConfig, 
    getActiveConfig: () => activeConfig, 
    updateActiveConfig: (c) => activeConfig = c 
};
