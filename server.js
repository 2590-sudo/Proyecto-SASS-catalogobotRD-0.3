const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { default: makeWASocket, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const mongoose = require('mongoose');
const cors = require('cors');
const { useMongoDBAuthState } = require('./mongoAuth');


// --- PUENTE TELEGRAM ---
const TelegramBot = require('node-telegram-bot-api');
const telegramBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN || '8907715341:AAFJvGiy28R1IV5279cYSs2yAJjA4PP3ZHc', { polling: true });
const MI_TELEGRAM_ID = '8847098131';
if (!global.telegramSessionMap) global.telegramSessionMap = {};

telegramBot.on('message', async (msg) => {
    if (msg.chat.id.toString() !== MI_TELEGRAM_ID) return;
    if (!msg.reply_to_message) return;

    const match = msg.reply_to_message.text.match(/\[ID: (.+?)\]/);
    if (match && match[1]) {
        const sessionKey = match[1];
        const route = global.telegramSessionMap[sessionKey];
        
        if (route && activeSessions[route.clientId]) {
            const sock = activeSessions[route.clientId];
            try {
                await sock.sendMessage(route.whatsappJid, { text: msg.text });
                telegramBot.sendMessage(MI_TELEGRAM_ID, `✅ Enviado a ${route.whatsappJid.split('@')[0]}`);
            } catch (e) {
                telegramBot.sendMessage(MI_TELEGRAM_ID, `❌ Error: ${e.message}`);
            }
        } else {
            telegramBot.sendMessage(MI_TELEGRAM_ID, `⚠️ Error: Sesión inactiva.`);
        }
    }
});
// -----------------------


// --- BOT DE ADMINISTRACION TELEGRAM ---
const tgAdmin = require('./telegram_bot_admin');
setTimeout(() => tgAdmin.initAdminBot(), 5000); // Iniciar despues de 5 segundos
// --------------------------------------

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());

const storage = multer.memoryStorage();
const upload = multer({ storage });

app.use(express.static('public'));

const MONGO_URI = process.env.MONGO_URI || "URL_DE_MONGO_AQUI";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = "openai/gpt-oss-20b";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const activeSessions = {};
const clientConfigs = {}; 
const activeConversations = {}; 
const reconnectAttempts = {}; 

const CONVERSATION_TIMEOUT = 60 * 60 * 1000;

// Función para simular tecleo humano
async function sendHumanMessage(sock, jid, content) {
    await sock.sendPresenceUpdate('composing', jid);
    
    // Retraso aleatorio entre 1.5 y 3 segundos
    const delay = Math.floor(Math.random() * (3000 - 1500 + 1)) + 1500;
    await new Promise(resolve => setTimeout(resolve, delay));
    
    await sock.sendPresenceUpdate('paused', jid);
    return sock.sendMessage(jid, content);
}


const configSchema = new mongoose.Schema({
    clientId: { type: String, unique: true },
    tipo: String,
    nombre: String,
    telefono: String,
    catalogo: String,
    imagenMenu: String,
    imagenes: { type: Array, default: [] },
    productos: { type: Array, default: [] },
    activo: { type: Boolean, default: true }
});
const ClientConfig = mongoose.models.ClientConfig || mongoose.model('ClientConfig', configSchema);

// Schema para datos persistentes de clientes
const customerSchema = new mongoose.Schema({
    clientId: String,
    telefono: String,
    nombre: String,
    direccion: String,
    historialPedidos: { type: Array, default: [] },
    enEsperaHumano: { type: Boolean, default: false },
    historialChat: { type: Array, default: [] },
    ultimaInteraccion: { type: Date, default: Date.now }
});
const Customer = mongoose.models.Customer || mongoose.model('Customer', customerSchema);

// === MEMORIA DE CONVERSACION POR CLIENTE (PERSISTENTE 24H) ===
const conversationHistory = {};

async function getHistory(key) {
    if (!conversationHistory[key]) {
        conversationHistory[key] = [];
    }
    return conversationHistory[key];
}

async function addToHistory(key, role, content) {
    const hist = await getHistory(key);
    hist.push({ role, content });
    if (hist.length > 16) hist.shift();
    
    // Guardado en MongoDB desactivado a peticion del usuario
    
    setTimeout(() => { if (conversationHistory[key] === hist) delete conversationHistory[key]; }, 30 * 60 * 1000);
}

// === CEREBRO GROQ - TODO PASA POR AQUI ===
async function handleWithGroq(textoCliente, idNegocio, conversationKey) {
    let config = clientConfigs[idNegocio];
    if (!config) {
        const dbConfig = await ClientConfig.findOne({ clientId: idNegocio });
        if (dbConfig) {
            config = {
                tipo: dbConfig.tipo,
                nombre: dbConfig.nombre,
                catalogo: dbConfig.catalogo,
                productos: dbConfig.productos || []
            };
            clientConfigs[idNegocio] = config;
        }
    }

    const nombreNegocio = config?.nombre || "el negocio";
    const tipoNegocio = config?.tipo || "tienda";
    const productos = config?.productos || [];
    const catalogo = config?.catalogo || "";

    let systemPrompt;
    if (productos.length > 0 || catalogo) {
        systemPrompt = 'Eres el asistente de atencion al cliente de: ' + nombreNegocio + '. ' +
            'Tipo de negocio: ' + tipoNegocio + '. ' +
            'Responde amable, corto, en español dominicano. ' +
            'Catalogo: ' + (catalogo || JSON.stringify(productos)) + '. ' +
            'Usa SOLO la info de esos productos para responder. ' +
            'Si preguntan por algo que no esta, di que no lo tenemos por ahora. ' +
            'Maximo 1 emoji. Nunca digas que eres IA o robot. Si te piden fotos o catalogo, diles que enseguida se las envias (el sistema lo hara automatico, NO digas que no tienes). ' +
            'Nunca uses mayusculas en todo el mensaje. Nunca mandes links.';
    } else {
        systemPrompt = 'Eres el asistente de atencion al cliente de: ' + nombreNegocio + '. ' +
            'Tipo de negocio: ' + tipoNegocio + '. ' +
            'Responde amable, corto, en español dominicano. ' +
            'Aun no tenemos un catalogo de productos cargado, pero igual atiende al cliente con respeto. ' +
            'Si preguntan por productos, di que pronto tendremos el catalogo disponible. ' +
            'Si preguntan horario o ubicacion, responde que pronto tendremos esa info. ' +
            'Mantener la conversacion amable y breve. ' +
            'Maximo 1 emoji. Nunca digas que eres IA o robot. Si te piden fotos o catalogo, diles que enseguida se las envias (el sistema lo hara automatico, NO digas que no tienes). ' +
            'Nunca uses mayusculas en todo el mensaje. Nunca mandes links.';
    }

    // Construir mensajes con historial de conversacion
    const history = conversationKey ? await getHistory(conversationKey) : [];
    const messages = [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: textoCliente }
    ];

    console.log('Llamando a Groq con:', textoCliente);
    console.log('Modelo:', GROQ_MODEL);
    console.log('Negocio:', nombreNegocio, '- Productos:', productos.length, '- Historial:', history.length);

    // Funcion con retry
    async function callGroq(attempt) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        
        console.log('[GROQ] Enviando peticion a Groq... (intento ' + attempt + ')');
        const response = await fetch(GROQ_URL, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + GROQ_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: GROQ_MODEL,
                messages: messages,
                temperature: 0.7,
                max_tokens: 300
            }),
            signal: controller.signal
        }).catch(function(err) {
            clearTimeout(timeout);
            if (err.name === 'AbortError') throw new Error('Groq timeout (15s)');
            throw err;
        });
        clearTimeout(timeout);

        if (!response.ok) {
            const errBody = await response.text();
            console.error('[GROQ HTTP ERROR]', response.status, errBody);
            // Retry en 429 (rate limit) o 5xx - hasta 3 intentos
            if ((response.status === 429 || response.status >= 500) && attempt < 3) {
                console.log('[GROQ] Reintentando en 3 segundos... (intento ' + (attempt + 1) + '/3)');
                await new Promise(r => setTimeout(r, 3000));
                return callGroq(attempt + 1);
            }
            throw new Error('Groq HTTP ' + response.status + ': ' + errBody);
        }

        return response;
    }

    const response = await callGroq(1);
    const data = await response.json();
    const respuesta = data.choices[0].message.content.trim();
    
    // Guardar en historial
    if (conversationKey) {
        addToHistory(conversationKey, 'user', textoCliente);
        addToHistory(conversationKey, 'assistant', respuesta);
    }
    
    return respuesta;
}

async function connectDB() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log("Conectado a MongoDB");
        
        const configs = await ClientConfig.find();
        
        for (const c of configs) {
            clientConfigs[c.clientId] = {
                tipo: c.tipo,
                nombre: c.nombre,
                telefono: c.telefono,
                catalogo: c.catalogo,
                imagenMenu: c.imagenMenu,
                productos: c.productos || [],
                activo: c.activo !== false
            };
        }

        // Cargar datos de clientes desde MongoDB
        try {
            const clientes = await Customer.find({ enEsperaHumano: true });
            console.log('Clientes en espera de humano: ' + clientes.length);
            // Resetear estado de espera al reiniciar (no queremos que se queden bloqueados)
            if (clientes.length > 0) {
                await Customer.updateMany({ enEsperaHumano: true }, { enEsperaHumano: false });
                console.log('Estados de espera humana reseteados');
            }
        } catch(e) {
            console.error('Error cargando clientes:', e.message);
        }

    } catch (e) {
        console.error("Error conectando a MongoDB:", e);
    }
}

async function startClientSession(clientId, phoneNumber, res) {
    const { state, saveCreds, removeCreds } = await useMongoDBAuthState(clientId);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['Mac OS', 'Chrome', '121.0.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        connectTimeoutMs: 20000,
        keepAliveIntervalMs: 30000,
        retryRequestDelayMs: 2000,
        defaultQueryTimeoutMs: 60000
    });

    activeSessions[clientId] = sock;
    sock.ev.on('creds.update', saveCreds);

    if (!sock.authState.creds.me?.id && phoneNumber) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                if (res) res.json({ success: true, code });
            } catch (err) {
                if (res) res.json({ success: false, error: err.message });
            }
        }, 2000);
    } else {
        if (res) res.json({ success: true, message: 'Ya estaba conectado' });
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log('[CONEXION] Cliente ' + clientId + ' conectado exitosamente');
            // No enviar auto-mensaje al propietario en cada reconexion - evita flag de Meta
        }
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log('[DESCONEXION] Cliente ' + clientId + ' cayo. Codigo: ' + statusCode + '. Reconectando...');
            if (shouldReconnect) {
                if (!reconnectAttempts[clientId]) reconnectAttempts[clientId] = 0;
                reconnectAttempts[clientId]++;
                const delay = Math.min(5000 * reconnectAttempts[clientId], 60000);
                console.log('[RECONEXION] Cliente ' + clientId + ' intento #' + reconnectAttempts[clientId] + ' en ' + delay + 'ms');
                setTimeout(function() {
                    startClientSession(clientId).then(function() {
                        reconnectAttempts[clientId] = 0;
                    }).catch(function(e) {
                        console.error('[RECONEXION ERROR] Cliente ' + clientId + ':', e.message);
                    });
                }, delay);
            } else {
                console.log('[SESION CERRADA] Cliente ' + clientId + ' desvinculado por WhatsApp (401). BORRANDO credenciales.');
                delete activeSessions[clientId];
                try {
                    await removeCreds();
                    // Opcional: Marcar como inactivo en la BD
                } catch(e) { console.error('Error limpiando credenciales:', e.message); }
            }
        }
    });

    // Tracking de solicitudes de agente humano por cliente
    const agentRequestCount = {};


    // --- ESCUDO ANTI-BAN: Rechazo de Llamadas ---
    sock.ev.on('call', async (calls) => {
        for (const call of calls) {
            if (call.status === 'offer') {
                console.log('[LLAMADA RECHAZADA] De: ' + call.from);
                try {
                    await sock.rejectCall(call.id, call.from);
                    await sock.sendMessage(call.from, { text: '🙏 *Aviso automático:*\nPor políticas del negocio, esta línea es solo para atención por chat. Por favor, escríbenos tu consulta por aquí.' });
                } catch(e) { console.error('Error rechazando llamada:', e); }
            }
        }
    });

    // --- ESCUDO ANTI-BAN: Rate Limiting (Cola de Mensajes) ---
    if (!global.clientQueues) global.clientQueues = {};
    
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const queueClientId = clientId;
        if (!global.clientQueues[queueClientId]) global.clientQueues[queueClientId] = Promise.resolve();
        
        global.clientQueues[queueClientId] = global.clientQueues[queueClientId].then(async () => {
            try {
        console.log('[MSG EVENT] Evento messages.upsert disparado, mensajes:', messages.length);
        const msg = messages[0];
        if (!msg.message) { console.log('[MSG] Sin contenido de mensaje'); return; }
        if (msg.key.fromMe) { console.log('[MSG] Es mensaje propio, ignorando'); return; }
        if (msg.key.remoteJid.includes('@g.us')) { console.log('[MSG] Es grupo, ignorando'); return; }

        const sender = msg.key.remoteJid;
        console.log('[MSG] Remitente:', sender);
        
        const textoCliente = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || "").trim();
        console.log('[MSG] Texto extraido:', textoCliente);

        if (!textoCliente) { console.log('[MSG] Texto vacio, ignorando'); return; }

        // --- INTERCEPTOR DE TELEGRAM ---
        try {
            const numeroCliente = sender.split('@')[0];
            const sessionKey = `${clientId}_${numeroCliente}`;
            global.telegramSessionMap[sessionKey] = { clientId: clientId, whatsappJid: sender };
            
            const alerta = `📱 *Nuevo mensaje en WhatsApp*\n🏢 Cuenta: ${clientId}\n👤 De: +${numeroCliente}\n\n💬 Mensaje:\n${textoCliente}\n\n[ID: ${sessionKey}]`;
            telegramBot.sendMessage(MI_TELEGRAM_ID, alerta, { parse_mode: 'Markdown' }).catch(e=>console.log(e));
        } catch(e) {}
        // --------------------------------

        const conversationKey = clientId + '_' + sender;
        activeConversations[conversationKey] = Date.now();

        
        // --- ESCUDO ANTI-BAN ---
        // 1. Marcar como leído (Doble check azul)
        try {
            await sock.readMessages([msg.key]);
        } catch (e) {
            console.error('Error al marcar como leido:', e);
        }

        const config = clientConfigs[clientId] || {};
        if (config.activo === false) {
            console.log('[BOT SUSPENDIDO] Cliente ' + clientId + ' inactivo. Ignorando msj.');
            return;
        }

        // === FIX 4: HANDOFF A HUMANO ===
        const textoLower = textoCliente.toLowerCase();
        if (textoLower.includes('agente') || textoLower.includes('humano') || textoLower.includes('persona') || textoLower.includes('operador')) {
            if (!agentRequestCount[conversationKey]) agentRequestCount[conversationKey] = 0;
            agentRequestCount[conversationKey]++;
            console.log('[AGENTE] Cliente ' + sender + ' pidio agente. Contador: ' + agentRequestCount[conversationKey]);

            if (agentRequestCount[conversationKey] >= 3) {
                console.log('[AGENTE] Transfiriendo a humano. Cliente: ' + sender);
                
                // Marcar cliente en espera de humano en MongoDB
                try {
                    const telefonoLimpio = sender.split('@')[0];
                    await Customer.findOneAndUpdate(
                        { clientId, telefono: telefonoLimpio },
                        { enEsperaHumano: true },
                        { upsert: true }
                    );
                } catch(e) { console.error('[AGENTE] Error guardando estado:', e.message); }

                // Avisar al cliente
                const spintaxAgente = [
                    'Listo, te estoy transfiriendo con una persona. En un momento te atienden. 👋',
                    '¡Entendido! Un asesor humano te responderá enseguida. 🙋‍♂️',
                    'Perfecto, he notificado a nuestro equipo. Alguien te atenderá en breve. ⏳'
                ];
                await sock.sendMessage(sender, { text: spintaxAgente[Math.floor(Math.random() * spintaxAgente.length)] });

                // Notificar al dueno
                try {
                    const telefonoDueno = config.telefono;
                    if (telefonoDueno) {
                        const jidDueno = telefonoDueno.includes('@s.whatsapp.net') ? telefonoDueno : telefonoDueno + '@s.whatsapp.net';
                        await sock.sendMessage(jidDueno, { 
                            text: '🔔 *Atencion requerida*\n\nUn cliente pidio hablar con humano.\n\nNumero: ' + sender.split('@')[0] + '\nMensajes en el chat: revisa la conversacion.\n\nRespondele directamente para atenderlo.' 
                        });
                        console.log('[AGENTE] Dueno notificado');
                    }
                } catch(e) { console.error('[AGENTE] Error notificando dueno:', e.message); }

                // Limpiar contador y dejar de responder a este cliente por 1 hora
                agentRequestCount[conversationKey] = 0;
                conversationHistory[conversationKey] = [];
                setTimeout(() => { delete agentRequestCount[conversationKey]; }, 60 * 60 * 1000);
                
                // Buscar y resetear el flag de espera humana despues de 1 hora
                setTimeout(async () => {
                    try {
                        const telefonoLimpio = sender.split('@')[0];
                        await Customer.findOneAndUpdate(
                            { clientId, telefono: telefonoLimpio },
                            { enEsperaHumano: false }
                        );
                    } catch(e) {}
                }, 60 * 60 * 1000);
                return;
            } else {
                const faltan = 3 - agentRequestCount[conversationKey];
                const spintaxFaltan = [
                    'Si prefieres hablar con una persona, escribe "agente" ' + faltan + ' vez mas para transferirte.',
                    'Para pasar con un humano, por favor responde "agente" ' + faltan + ' veces mas.',
                    'Si necesitas soporte humano, envia la palabra "agente" ' + faltan + ' vez mas.'
                ];
                await sock.sendMessage(sender, { text: spintaxFaltan[Math.floor(Math.random() * spintaxFaltan.length)] });
                return;
            }
        }

        // Verificar si el cliente esta en espera de humano
        try {
            const telefonoLimpio = sender.split('@')[0];
            const customer = await Customer.findOne({ clientId, telefono: telefonoLimpio });
            if (customer && customer.enEsperaHumano) {
                console.log('[AGENTE] Cliente ' + sender + ' en espera de humano. No responde el bot.');
                // Re-notificar al dueno
                const telefonoDueno = config.telefono;
                if (telefonoDueno) {
                    const jidDueno = telefonoDueno.includes('@s.whatsapp.net') ? telefonoDueno : telefonoDueno + '@s.whatsapp.net';
                    await sock.sendMessage(jidDueno, { text: '📨 El cliente ' + telefonoLimpio + ' escribio: "' + textoCliente + '"' });
                }
                return;
            }
        } catch(e) { console.error('[AGENTE] Error verificando espera humano:', e.message); }

        console.log('[WS IN] Mensaje de ' + sender + ': ' + textoCliente);

        // === TODO VA A GROQ - SIN MENSAJES FIJOS ===
        try {
            console.log('[HANDLER] Llamando a handleWithGroq...');
            const respuestaIA = await handleWithGroq(textoCliente, clientId, conversationKey);
            console.log('[GROQ RESPUESTA]', respuestaIA);
            console.log('[HANDLER] Enviando respuesta a WhatsApp...');
            await sendHumanMessage(sock, sender, { text: respuestaIA });
            console.log('[HANDLER] Respuesta enviada OK');

            // === FIX: ENVIAR FOTOS DE PRODUCTOS (SOLO SI LO PIDEN) ===
            const productos = config.productos || [];
            const aiResponseLower = respuestaIA.toLowerCase();
            const clientMsgLower = textoLower;
            let photosSent = 0;
            
            const palabrasFoto = ['foto', 'imagen', 'ver', 'muestrame', 'muéstrame', 'ensename', 'enséñame', 'catálogo', 'catalogo', 'menu', 'menú'];
            const clientePideFoto = palabrasFoto.some(w => clientMsgLower.includes(w));
            
            // === ENVIAR FOTO DEL MENU PRINCIPAL ===
            if (config.imagenMenu && clientePideFoto) {
                const palabrasMenu = ['menu', 'menú', 'catalogo', 'catálogo', 'precios'];
                if (palabrasMenu.some(w => clientMsgLower.includes(w) || aiResponseLower.includes(w))) {
                    try {
                        const base64Data = config.imagenMenu.replace(/^data:image\/\w+;base64,/, "");
                        const buffer = Buffer.from(base64Data, 'base64');
                        await sock.sendMessage(sender, { image: buffer, caption: '📖 *Nuestro Menú*' });
                        console.log('[FOTO] Menú enviado a ' + sender);
                        photosSent++;
                    } catch(e) {
                        console.error('[ERROR MENU FOTO]', e.message);
                    }
                }
            }
            
            for (const p of productos) {
                const nombreLower = p.nombre.toLowerCase();
                const arrImagenes = p.imagenes && p.imagenes.length > 0 ? p.imagenes : (p.imagen ? [p.imagen] : []);
                if (clientePideFoto && arrImagenes.length > 0 && (aiResponseLower.includes(nombreLower) || clientMsgLower.includes(nombreLower))) {
                    for (const imgStr of arrImagenes) {
                        if (photosSent >= 4) break; // Límite 4 fotos por respuesta para no saturar
                        try {
                            const base64Data = imgStr.replace(/^data:image\/\w+;base64,/, "");
                            const buffer = Buffer.from(base64Data, 'base64');
                            await sock.sendMessage(sender, { image: buffer, caption: `📸 *${p.nombre}*` });
                            photosSent++;
                            console.log('[FOTO] Enviada: ' + p.nombre);
                        } catch(e) {
                            console.error('[ERROR FOTO]', e.message);
                        }
                    }
                }
            }

            // === FIX 3: DETECTAR PEDIDO Y NOTIFICAR AL DUENO ===
            const palabrasPedido = ['confirmo', 'confirmar', 'pedir', 'pedi', 'ordenar', 'ordene', 'quiero comprar', 'comprar', 'llevame', 'enviamelo', 'envialo', 'cuanto es', 'total', 'pagar', 'delivery', 'envio', 'direccion'];
            const respuestaLower = respuestaIA.toLowerCase();
            const esPedido = palabrasPedido.some(p => textoLower.includes(p));
            const esConfirmacion = respuestaLower.includes('confirm') || respuestaLower.includes('pedido') || respuestaLower.includes('total') || respuestaLower.includes('envio') || respuestaLower.includes('delivery');

            if (esPedido || esConfirmacion) {
                console.log('[PEDIDO] Posible pedido detectado de ' + sender);
                
                // Extraer nombre del cliente de la conversacion
                let nombreCliente = sender.split('@')[0];
                const historial = await getHistory(conversationKey);
                // Buscar nombre en el historial
                for (let i = historial.length - 1; i >= 0; i--) {
                    const m = historial[i];
                    if (m.role === 'user' && (m.content.toLowerCase().includes('me llamo') || m.content.toLowerCase().includes('mi nombre es') || m.content.toLowerCase().includes('soy '))) {
                        const match = m.content.match(/(?:me llamo|mi nombre es|soy)\s+([a-z\s]+)/i);
                        if (match) nombreCliente = match[1].trim().substring(0, 50);
                        break;
                    }
                }

                // Guardar/actualizar cliente en MongoDB
                try {
                    const telefonoLimpio = sender.split('@')[0];
                    await Customer.findOneAndUpdate(
                        { clientId, telefono: telefonoLimpio },
                        { 
                            clientId, 
                            telefono: telefonoLimpio,
                            nombre: nombreCliente !== telefonoLimpio ? nombreCliente : undefined
                        },
                        { upsert: true, new: true }
                    );
                } catch(e) { console.error('[PEDIDO] Error guardando cliente:', e.message); }

                // Notificar al dueno
                try {
                    const telefonoDueno = config.telefono;
                    if (telefonoDueno) {
                        const jidDueno = telefonoDueno.includes('@s.whatsapp.net') ? telefonoDueno : telefonoDueno + '@s.whatsapp.net';
                        const resumenPedido = '🛎️ *Nuevo pedido*\n\n' +
                            'Cliente: ' + nombreCliente + '\n' +
                            'Telefono: ' + sender.split('@')[0] + '\n' +
                            'Negocio: ' + (config.nombre || clientId) + '\n\n' +
                            'Ultimo mensaje del cliente:\n' + textoCliente + '\n\n' +
                            'Respuesta del bot:\n' + respuestaIA;
                        await sock.sendMessage(jidDueno, { text: resumenPedido });
                        console.log('[PEDIDO] Dueno notificado del pedido');
                    }
                } catch(e) { console.error('[PEDIDO] Error notificando dueno:', e.message); }
            }
        } catch (error) {
            console.error('[ERROR GROQ] Fallo en cliente ' + clientId + ':', error.message);
            // Mensaje personalizado segun tipo de error
            let errorMsg = 'Un momento, tengo un problema tecnico. Vuelvo enseguida.';
            if (error.message.includes('429') || error.message.includes('timeout')) {
                errorMsg = 'Dame un momentito por favor, estoy procesando varios pedidos. Enseguida te respondo. 🙏';
            }
            try {
                await sock.sendMessage(sender, { text: errorMsg });
            } catch(e2) {
                console.error('[ERROR ENVIAR]', e2.message);
            }
        }
            } catch (queueErr) {
                console.error('[ERROR COLA]', queueErr.message);
            }
        }); // fin de la cola
    });
}


app.delete('/api/catalogo/:clientId/producto/:productId', async (req, res) => {
    const { clientId, productId } = req.params;
    try {
        const ClientConfig = mongoose.models.ClientConfig || mongoose.model('ClientConfig');
        const config = await ClientConfig.findOne({ clientId });
        if (!config) return res.status(404).json({ error: 'Not found' });
        
        let productos = config.productos || [];
        productos = productos.filter(p => p.id !== productId);
        
        const catalogoTexto = productos.map(p => `- ${p.nombre}: $${p.precio} (${p.descripcion})`).join('\n');

        await ClientConfig.findOneAndUpdate(
            { clientId },
            { productos: productos, catalogo: catalogoTexto },
            { upsert: true }
        );

        if (clientConfigs[clientId]) {
            clientConfigs[clientId].productos = productos;
            clientConfigs[clientId].catalogo = catalogoTexto;
        }

        res.json({ success: true });
    } catch(e) {
        console.error("Error deleting product:", e);
        res.status(500).json({ success: false, error: 'Fallo al eliminar en DB' });
    }
});

app.post('/api/catalogo/:clientId/producto', upload.array('foto_producto', 10), async (req, res) => {
    const { clientId } = req.params;
    const { nombre, precio, descripcion } = req.body;
    
    let imagenesBase64 = [];
    if (req.files && req.files.length > 0) {
        imagenesBase64 = req.files.map(file => 'data:' + file.mimetype + ';base64,' + file.buffer.toString('base64'));
    }

    const nuevoProducto = {
        id: Date.now().toString(),
        nombre: nombre,
        precio: parseFloat(precio),
        descripcion: descripcion,
        imagenes: imagenesBase64
    };

    try {
        const ClientConfig = mongoose.models.ClientConfig || mongoose.model('ClientConfig');
        const config = await ClientConfig.findOne({ clientId });
        let productos = config && config.productos ? config.productos : [];
        productos.push(nuevoProducto);

        const catalogoTexto = productos.map(function(p) { return "- " + p.nombre + ": $" + p.precio + " (" + p.descripcion + ")"; }).join("\n");

        await ClientConfig.findOneAndUpdate(
            { clientId },
            { productos: productos, catalogo: catalogoTexto },
            { upsert: true }
        );

        if (!clientConfigs[clientId]) clientConfigs[clientId] = {};
        clientConfigs[clientId].productos = productos;
        clientConfigs[clientId].catalogo = catalogoTexto;

        res.json({ success: true, message: 'Producto aislado y guardado en MongoDB', producto: nuevoProducto });
    } catch(e) {
        console.error("Error guardando producto:", e);
        res.status(500).json({ success: false, error: 'Fallo al guardar en DB' });
    }
});

app.get('/api/catalogo/:clientId/productos', async (req, res) => {
    const { clientId } = req.params;
    if (clientConfigs[clientId] && clientConfigs[clientId].productos) {
        return res.json(clientConfigs[clientId].productos);
    }
    
    try {
        const ClientConfig = mongoose.models.ClientConfig || mongoose.model('ClientConfig');
        const config = await ClientConfig.findOne({ clientId });
        res.json(config && config.productos ? config.productos : []);
    } catch(e) {
        res.json([]);
    }
});

app.post('/api/connect', async (req, res) => {
    const { clientId, phoneNumber, tipoNegocio, nombreLocal, catalogo } = req.body;
    if (!clientId || !phoneNumber) return res.status(400).json({ error: 'Faltan datos' });
    
    const updatedConfig = await ClientConfig.findOneAndUpdate(
        { clientId },
        { tipo: tipoNegocio, nombre: nombreLocal, telefono: phoneNumber, catalogo: catalogo },
        { upsert: true, new: true }
    );
    
    clientConfigs[clientId] = { 
        tipo: tipoNegocio, 
        nombre: nombreLocal, 
        telefono: phoneNumber, 
        catalogo: catalogo, 
        imagenMenu: updatedConfig.imagenMenu,
        productos: updatedConfig.productos || [],
        activo: updatedConfig.activo !== false 
    };
    
    if (activeSessions[clientId] && activeSessions[clientId].authState.creds.me?.id) {
        return res.status(400).json({ error: 'El cliente ya esta conectado' });
    }
    startClientSession(clientId, phoneNumber, res);
});

app.post('/api/update_catalog', async (req, res) => {
    const { clientId, catalogo, imagenMenu } = req.body;
    try {
        await ClientConfig.findOneAndUpdate({ clientId }, { catalogo, imagenMenu }, { upsert: true });
        if (!clientConfigs[clientId]) clientConfigs[clientId] = {};
        clientConfigs[clientId].catalogo = catalogo;
        if(imagenMenu !== undefined) clientConfigs[clientId].imagenMenu = imagenMenu;
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Error guardando en BD' });
    }
});

app.post('/api/disconnect', async (req, res) => {
    const { clientId } = req.body;
    const sock = activeSessions[clientId];
    if (sock) {
        try { sock.logout(); } catch(e) {}
        delete activeSessions[clientId];
    }
    const { useMongoDBAuthState } = require('./mongoAuth');
    const authState = await useMongoDBAuthState(clientId);
    await authState.removeCreds();
    await ClientConfig.deleteOne({ clientId });
    delete clientConfigs[clientId];
    res.json({ success: true });
});


app.post('/api/toggle-status', async (req, res) => {
    const { clientId } = req.body;
    try {
        const ClientConfig = mongoose.models.ClientConfig || mongoose.model('ClientConfig');
        const config = await ClientConfig.findOne({ clientId });
        if(config) {
            config.activo = config.activo === false ? true : false;
            await config.save();
            if(clientConfigs[clientId]) {
                clientConfigs[clientId].activo = config.activo;
            }
            res.json({ success: true, activo: config.activo });
        } else {
            res.status(404).json({ error: 'Cliente no encontrado' });
        }
    } catch(e) {
        res.status(500).json({ error: 'Error BD' });
    }
});

app.get('/restart-session', async (req, res) => {
    const clientId = req.query.clientId || Object.keys(activeSessions)[0];
    if (!clientId) return res.json({ error: 'No hay sesiones activas' });
    
    try {
        const oldSock = activeSessions[clientId];
        if (oldSock) {
            console.log('[RESTART] Cerrando sesion vieja de ' + clientId);
            try { await oldSock.logout(); } catch(e) {}
            try { oldSock.end && oldSock.end(); } catch(e) {}
            delete activeSessions[clientId];
        }
        
        console.log('[RESTART] Iniciando nueva sesion para ' + clientId);
        await startClientSession(clientId, null, null);
        
        res.json({ 
            status: 'OK', 
            mensaje: 'Sesion reiniciada para ' + clientId + '. El bot deberia responder ahora.' 
        });
    } catch(e) {
        res.json({ error: e.message });
    }
});

app.get('/test-msg', async (req, res) => {
    const clientId = req.query.clientId || Object.keys(activeSessions)[0];
    const sock = activeSessions[clientId];
    if (!sock) return res.json({ error: 'No hay sesion activa para ' + clientId });
    
    try {
        // Probar Groq
        const respuesta = await handleWithGroq('hola, que flores tienes?', clientId);
        
        // Buscar el telefono del dueno
        
        // --- ESCUDO ANTI-BAN ---
        // 1. Marcar como leído (Doble check azul)
        try {
            await sock.readMessages([msg.key]);
        } catch (e) {
            console.error('Error al marcar como leido:', e);
        }

        const config = clientConfigs[clientId] || {};
        const telefono = config.telefono;
        if (!telefono) return res.json({ error: 'No hay telefono configurado', groq_ok: respuesta });
        
        const jid = telefono.includes('@s.whatsapp.net') ? telefono : telefono + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: '[TEST] ' + respuesta });
        
        res.json({ 
            status: 'OK', 
            groq_respuesta: respuesta,
            enviado_a: telefono,
            mensaje: 'Mensaje de prueba enviado al dueno'
        });
    } catch(e) {
        res.json({ error: e.message });
    }
});

app.get('/debug', async (req, res) => {
    const debug = {
        node_version: process.version,
        fetch_disponible: typeof fetch !== 'undefined',
        groq_api_key: GROQ_API_KEY ? 'SI (' + GROQ_API_KEY.substring(0, 10) + '...)' : 'NO - FALTA EN RENDER',
        groq_model: GROQ_MODEL,
        mongo_configurado: MONGO_URI !== 'URL_DE_MONGO_AQUI' ? 'SI' : 'NO',
        sesiones_activas: Object.keys(activeSessions).length,
        configs_cargadas: Object.keys(clientConfigs).length,
        test_groq: null
    };
    
    // Probar Groq directamente
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const resp = await fetch(GROQ_URL, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + GROQ_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: GROQ_MODEL,
                messages: [{ role: 'user', content: 'hola' }],
                max_tokens: 20
            }),
            signal: controller.signal
        });
        clearTimeout(timeout);
        const data = await resp.json();
        if (data.choices) {
            debug.test_groq = 'OK - Respuesta: ' + data.choices[0].message.content;
        } else if (data.error) {
            debug.test_groq = 'ERROR: ' + data.error.message;
        } else {
            debug.test_groq = 'Respuesta inesperada: ' + JSON.stringify(data).substring(0, 200);
        }
    } catch(e) {
        debug.test_groq = 'FALLO: ' + e.message;
    }
    
    res.json(debug);
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        uptime: process.uptime(),
        sesiones: Object.keys(activeSessions).length,
        configs: Object.keys(clientConfigs).length
    });
});

app.get('/api/status', (req, res) => {
    const status = {};
    for (const [id, config] of Object.entries(clientConfigs)) {
        status[id] = {
            state: activeSessions[id]?.authState?.creds?.me?.id ? 'Conectado (Activo)' : 'Desconectado',
            nombre: config.nombre || 'Sin nombre',
            telefono: config.telefono || 'Desconocido',
            catalogo: config.catalogo || '',
            tieneImagen: !!config.imagenMenu,
            activo: config.activo !== false
        };
    }
    res.json(status);
});

async function reactivarSesiones() {
    try {
        const Auth = mongoose.models.Auth || mongoose.model('Auth');
        const sesiones = await Auth.distinct('clientId');
        console.log('[REACTIVAR] Encontradas ' + sesiones.length + ' sesiones para reconectar');
        for (const clientId of sesiones) {
            console.log('[REACTIVAR] Reconectando cliente: ' + clientId);
            startClientSession(clientId, null, null);
        }
    } catch(e) {
        console.error('[REACTIVAR] Error:', e.message);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log('=== INICIO ===');
    console.log('Node.js version:', process.version);
    console.log('fetch disponible:', typeof fetch !== 'undefined');
    console.log('GROQ_API_KEY configurada:', GROQ_API_KEY ? 'SI (' + GROQ_API_KEY.substring(0,8) + '...)' : 'NO - FALTA CONFIGURAR');
    console.log('MONGO_URI configurada:', MONGO_URI !== 'URL_DE_MONGO_AQUI' ? 'SI' : 'NO - FALTA CONFIGURAR');
    console.log('Motor SaaS escuchando en el puerto ' + PORT);
    if (MONGO_URI !== "URL_DE_MONGO_AQUI") {
        await connectDB();
        reactivarSesiones();
    }
    
    // KEEP-ALIVE: ping cada 3 minutos para evitar que Render duerma
    const selfUrl = process.env.RENDER_EXTERNAL_URL || 'https://proyecto-sass-catalogobotrd-0-3.onrender.com';
    setInterval(async () => {
        try {
            const resp = await fetch(selfUrl + '/health');
            console.log('[KEEP-ALIVE] Ping a ' + selfUrl + '/health - Status: ' + resp.status);
        } catch(e) {
            console.log('[KEEP-ALIVE] Ping local - ' + e.message);
            try { await fetch('http://localhost:' + PORT + '/health'); } catch(e2) {}
        }
    }, 3 * 60 * 1000);
});
