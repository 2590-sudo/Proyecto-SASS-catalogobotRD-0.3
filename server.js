const express = require('express');
const { default: makeWASocket, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const mongoose = require('mongoose');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { useMongoDBAuthState } = require('./mongoAuth');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

const MONGO_URI = process.env.MONGO_URI || "URL_DE_MONGO_AQUI";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "TU_API_KEY_DE_GEMINI";

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const activeSessions = {};
const clientConfigs = {}; // Configuración de clientes (En el futuro a MongoDB)
const activeConversations = {}; // Memoria temporal: { "clientId_sender": timestamp }
const CONVERSATION_TIMEOUT = 30 * 60 * 1000; // 30 minutos

async function connectDB() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log("Conectado a MongoDB");
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
        browser: ['Ubuntu', 'Chrome', '20.0.04']
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
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                setTimeout(() => startClientSession(clientId), 5000);
            } else {
                await removeCreds();
                delete activeSessions[clientId];
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe || msg.key.remoteJid.includes('@g.us')) return;

        const sender = msg.key.remoteJid;
        const textoCliente = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim().toLowerCase();

        if (!textoCliente) return;

        const conversationKey = `${clientId}_${sender}`;
        const now = Date.now();
        let isBusinessQuery = false;

        // FILTRO MEJORADO: Ver si ya está en una conversación activa (últimos 30 min)
        if (activeConversations[conversationKey] && (now - activeConversations[conversationKey] < CONVERSATION_TIMEOUT)) {
            isBusinessQuery = true;
        } else {
            // Si no está en conversación, verificar si usó una palabra clave
            const triggerWords = [
                'hola', 'buenas', 'saludo', 'menu', 'menú', 'catalogo', 'catálogo', 
                'pedido', 'orden', 'delivery', 'precio', 'cuanto', 'cuánto', 
                'a como', 'tiene', 'venden', 'comprar', 'info', 'direccion', 'ubicacion'
            ];
            isBusinessQuery = triggerWords.some(kw => textoCliente.includes(kw));
        }

        if (!isBusinessQuery) return; // Ignora mensajes personales

        // Actualizar el temporizador de la conversación
        activeConversations[conversationKey] = now;

        const tipoNegocio = clientConfigs[clientId]?.tipo || "Negocio";
        const nombreLocal = clientConfigs[clientId]?.nombre || "Nuestro Local";
        const catalogoLocal = clientConfigs[clientId]?.catalogo || "Catálogo en actualización.";

        // Reglas Fijas: Saludos (Solo si no pide menú explícitamente)
        const saludos = ['hola', 'buenas', 'saludos', 'buenos dias', 'buenas tardes', 'buenas noches'];
        if (saludos.some(s => textoCliente === s || textoCliente.startsWith(s + ' ')) && !textoCliente.includes('menu') && !textoCliente.includes('catalogo')) {
            return sock.sendMessage(sender, { text: `¡Hola! Gracias por comunicarte con *${nombreLocal}*. ¿En qué podemos servirte hoy? Escribe *menú* para ver nuestras opciones.` });
        }

        // Reglas Fijas: Menú dinámico
        if (textoCliente.includes('menu') || textoCliente.includes('menú') || textoCliente.includes('catalogo') || textoCliente.includes('catálogo')) {
            let menuTxt = `📋 *CATÁLOGO DE ${nombreLocal.toUpperCase()}*\n\n${catalogoLocal}\n\n_Dime qué deseas pedir o si tienes alguna duda._`;
            return sock.sendMessage(sender, { text: menuTxt });
        }

        // Gemini AI para continuar la conversación con contexto del catálogo
        try {
            const prompt = `Eres un asistente de WhatsApp de la República Dominicana, amable y persuasivo.
            Trabajas en: ${nombreLocal} (Tipo: ${tipoNegocio})
            
            Este es tu CATÁLOGO DE PRODUCTOS ACTUAL:
            ${catalogoLocal}

            El cliente dice: "${textoCliente}". 
            
            REGLAS ESTRICTAS:
            1. Responde en un solo párrafo corto y amigable.
            2. BASA TUS RESPUESTAS EN EL CATÁLOGO. Si el cliente pide un producto o precio, búscalo en el catálogo y dáselo.
            3. Si pide algo que no está en el catálogo, dile amablemente que por ahora no tienen eso disponible y ofrécele algo similar.
            4. Si el cliente está pidiendo, confirma su orden y pregúntale su dirección de envío (si aplica).`;
            
            const result = await model.generateContent(prompt);
            const respuestaIA = result.response.text().trim();
            
            await sock.sendMessage(sender, { text: respuestaIA });
        } catch (error) {
            console.error(`Error en Gemini para ${clientId}:`, error);
        }
    });
}

// ENDPOINTS API
app.post('/api/connect', async (req, res) => {
    const { clientId, phoneNumber, tipoNegocio, nombreLocal, catalogo } = req.body;
    if (!clientId || !phoneNumber) return res.status(400).json({ error: 'Faltan datos' });
    
    clientConfigs[clientId] = { 
        tipo: tipoNegocio || "Negocio", 
        nombre: nombreLocal || "Mi Negocio",
        catalogo: catalogo || "Catálogo en actualización."
    };
    
    if (activeSessions[clientId] && activeSessions[clientId].authState.creds.me?.id) {
        return res.status(400).json({ error: 'El cliente ya está conectado' });
    }
    startClientSession(clientId, phoneNumber, res);
});

app.post('/api/update_catalog', (req, res) => {
    const { clientId, catalogo } = req.body;
    if (clientConfigs[clientId]) {
        clientConfigs[clientId].catalogo = catalogo;
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Cliente no encontrado en memoria' });
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
    
    res.json({ success: true });
});

app.get('/api/status', (req, res) => {
    const status = {};
    for (const [id, sock] of Object.entries(activeSessions)) {
        status[id] = {
            state: sock.authState.creds.me?.id ? 'Conectado (Activo)' : 'Esperando Código...',
            nombre: clientConfigs[id]?.nombre || 'Sin nombre',
            catalogo: clientConfigs[id]?.catalogo || ''
        };
    }
    res.json(status);
});

async function reactivarSesiones() {
    try {
        const Auth = mongoose.models.Auth || mongoose.model('Auth');
        const sesiones = await Auth.distinct('clientId');
        for (const clientId of sesiones) {
            // Valores por defecto al reiniciar (en un SaaS real, leeríamos clientConfigs de MongoDB)
            clientConfigs[clientId] = { tipo: "Negocio Reactivado", nombre: clientId, catalogo: "Contacte al admin para actualizar catálogo." };
            startClientSession(clientId, null, null);
        }
    } catch(e) {}
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`🚀 Motor SaaS escuchando en el puerto ${PORT}`);
    if (MONGO_URI !== "URL_DE_MONGO_AQUI") {
        await connectDB();
        reactivarSesiones();
    }
});
