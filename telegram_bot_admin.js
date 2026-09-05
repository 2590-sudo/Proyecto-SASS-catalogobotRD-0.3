const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');

const configSchema = new mongoose.Schema({
    welcomeText: { type: String, default: '¡Bienvenido/a {name} al grupo!' },
    welcomePhotoUrl: { type: String, default: '' },
    deleteLinks: { type: Boolean, default: true },
    autoApprove: { type: Boolean, default: false },
    recurringMessage: { type: String, default: '' },
    recurringInterval: { type: Number, default: 0 },
    managedGroupId: { type: String, default: '' }
});

const TGConfig = mongoose.models.TGConfig || mongoose.model('TGConfig', configSchema);

let bot;
let activeConfig = {
    welcomeText: '¡Bienvenido/a {name} al grupo!',
    welcomePhotoUrl: '',
    deleteLinks: true,
    autoApprove: false,
    recurringMessage: '',
    recurringInterval: 0,
    managedGroupId: ''
};

let broadcastTimer = null;

function restartBroadcast() {
    if (broadcastTimer) clearInterval(broadcastTimer);
    if (activeConfig.recurringInterval > 0 && activeConfig.recurringMessage && activeConfig.managedGroupId) {
        console.log(`[TG ADMIN] Iniciando mensaje recurrente cada ${activeConfig.recurringInterval} min`);
        broadcastTimer = setInterval(() => {
            if (bot) {
                bot.sendMessage(activeConfig.managedGroupId, activeConfig.recurringMessage, { parse_mode: 'HTML' }).catch(console.error);
            }
        }, activeConfig.recurringInterval * 60 * 1000);
    }
}

async function initAdminBot() {
    const token = process.env.TELEGRAM_BOT_TOKEN_2 || process.env.TELEGRAM_ADMIN_TOKEN;
    if (!token) return;
    
    bot = new TelegramBot(token, { polling: true });
    
    try {
        let conf = await TGConfig.findOne({});
        if (conf) activeConfig = conf;
        else {
            conf = new TGConfig(activeConfig);
            await conf.save();
        }
        restartBroadcast();
    } catch(e) {}

    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        
        // Auto-capturar el ID del grupo
        if ((msg.chat.type === 'group' || msg.chat.type === 'supergroup') && activeConfig.managedGroupId !== chatId.toString()) {
            activeConfig.managedGroupId = chatId.toString();
            try {
                await TGConfig.updateOne({}, { managedGroupId: activeConfig.managedGroupId });
                restartBroadcast();
            } catch(e) {}
        }

        // Anti-links
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

    bot.on('new_chat_members', async (msg) => {
        const chatId = msg.chat.id;
        const newMembers = msg.new_chat_members;
        for (const member of newMembers) {
            if (member.id === bot.botInfo?.id) continue;
            const text = activeConfig.welcomeText.replace('{name}', member.first_name);
            try {
                if (activeConfig.welcomePhotoUrl && activeConfig.welcomePhotoUrl.startsWith('http')) {
                    await bot.sendPhoto(chatId, activeConfig.welcomePhotoUrl, { caption: text });
                } else {
                    await bot.sendMessage(chatId, text);
                }
            } catch(e) {}
        }
    });

    bot.on('chat_join_request', async (request) => {
        if (activeConfig.autoApprove) {
            try { await bot.approveChatJoinRequest(request.chat.id, request.from.id); } catch (e) {}
        }
    });
}

module.exports = { 
    initAdminBot, 
    TGConfig, 
    getActiveConfig: () => activeConfig, 
    updateActiveConfig: (c) => { activeConfig = c; restartBroadcast(); } 
};
