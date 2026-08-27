const express = require('express');
const { default: makeWASocket, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const mongoose = require('mongoose');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { useMongoDBAuthState } = require('./mongoAuth');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());
app.use(express.static('public'));

const MONGO_URI = process.env.MONGO_URI || "URL_DE_MONGO_AQUI";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "TU_API_KEY_DE_GEMINI";

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const activeSessions = {};
const clientConfigs = {}; 
const activeConversations = {}; 
const CONVERSATION_TIMEOUT = 60 * 60 * 1000;

const configSchema = new mongoose.Schema({
    clientId: { type: String, unique: true },
    tipo: String,
    nombre: String,
    telefono: String, // Añadido para mostrar el numero en la lista
    catalogo: String,
    imagenMenu: String
});
const ClientConfig = mongoose.models.ClientConfig || mongoose.model('ClientConfig', configSchema);

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
                imagenMenu: c.imagenMenu
            };
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

        if (activeConversations[conversationKey] && (now - activeConversations[conversationKey] < CONVERSATION_TIMEOUT)) {
            isBusinessQuery = true;
        } else {
            const triggerWords = [
                'hola', 'buenas', 'saludo', 'menu', 'menú', 'catalogo', 'catálogo', 
                'pedido', 'orden', 'delivery', 'precio', 'cuanto', 'cuánto', 
                'a como', 'tiene', 'venden', 'comprar', 'info', 'direccion', 'ubicacion',
                'quiero', 'dame', 'necesito', 'busco', 'tienen', 'hay', 'deseo', 'mandame'
            ];
            isBusinessQuery = triggerWords.some(kw => textoCliente.includes(kw));
        }

        if (!isBusinessQuery) return; 

        activeConversations[conversationKey] = now;

        const config = clientConfigs[clientId] || {};
        const tipoNegocio = config.tipo || "Negocio";
        const nombreLocal = config.nombre || "Nuestro Local";
        const catalogoLocal = config.catalogo || "Catálogo no disponible.";
        const imagenMenu = config.imagenMenu || null;

        const saludos = ['hola', 'buenas', 'saludos', 'buenos dias', 'buenas tardes', 'buenas noches'];
        if (saludos.some(s => textoCliente === s || textoCliente.startsWith(s + ' ')) && !textoCliente.includes('menu') && !textoCliente.includes('catalogo')) {
            return sock.sendMessage(sender, { text: `¡Hola! Gracias por comunicarte con *${nombreLocal}*. ¿En qué podemos servirte hoy? Escribe *menú* para ver nuestras opciones.` });
        }

        if (textoCliente.includes('menu') || textoCliente.includes('menú') || textoCliente.includes('catalogo') || textoCliente.includes('catálogo')) {
            let menuTxt = `📋 *CATÁLOGO DE ${nombreLocal.toUpperCase()}*\n\n${catalogoLocal}\n\n_Dime qué deseas pedir o si tienes alguna duda._`;
            
            if (imagenMenu) {
                try {
                    const base64Data = imagenMenu.replace(/^data:image\/\w+;base64,/, "");
                    const buffer = Buffer.from(base64Data, 'base64');
                    return sock.sendMessage(sender, { image: buffer, caption: menuTxt });
                } catch(e) {
                    return sock.sendMessage(sender, { text: menuTxt });
                }
            } else {
                return sock.sendMessage(sender, { text: menuTxt });
            }
        }

        try {
            const prompt = `Eres un asistente de WhatsApp de la República Dominicana, súper amable, servicial y persuasivo.
            Trabajas en: ${nombreLocal} (Tipo: ${tipoNegocio})
            
            ESTE ES TU CATÁLOGO ESTRICTO DE PRODUCTOS Y PRECIOS:
            ${catalogoLocal}

            El cliente dice: "${textoCliente}". 
            
            REGLAS VITALES:
            1. Responde SIEMPRE en UN SOLO PÁRRAFO corto, natural y amigable.
            2. BASA TUS RESPUESTAS SOLO EN EL CATÁLOGO. No inventes precios ni productos.
            3. Si el cliente pide algo que NO está en el catálogo, dile amablemente que por ahora no tienen ese producto y ofrécele la mejor alternativa que SÍ esté en el catálogo.
            4. Si el cliente está pidiendo o confirmando un pedido, hazle un resumen rápido de su orden y pregúntale su dirección para el envío.`;
            
            const result = await model.generateContent(prompt);
            const respuestaIA = result.response.text().trim();
            
            await sock.sendMessage(sender, { text: respuestaIA });
        } catch (error) {
            console.error(`[ERROR GEMINI] Fallo en cliente ${clientId}:`, error);
            await sock.sendMessage(sender, { text: "⏳ _Estoy revisando el inventario, dame un momentito por favor..._" });
        }
    });
}

app.post('/api/connect', async (req, res) => {
    const { clientId, phoneNumber, tipoNegocio, nombreLocal, catalogo } = req.body;
    if (!clientId || !phoneNumber) return res.status(400).json({ error: 'Faltan datos' });
    
    await ClientConfig.findOneAndUpdate(
        { clientId },
        { tipo: tipoNegocio, nombre: nombreLocal, telefono: phoneNumber, catalogo: catalogo },
        { upsert: true, new: true }
    );
    
    clientConfigs[clientId] = { tipo: tipoNegocio, nombre: nombreLocal, telefono: phoneNumber, catalogo, imagenMenu: null };
    
    if (activeSessions[clientId] && activeSessions[clientId].authState.creds.me?.id) {
        return res.status(400).json({ error: 'El cliente ya está conectado' });
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

app.get('/api/status', (req, res) => {
    const status = {};
    for (const [id, config] of Object.entries(clientConfigs)) {
        status[id] = {
            state: activeSessions[id]?.authState?.creds?.me?.id ? 'Conectado (Activo)' : 'Desconectado',
            nombre: config.nombre || 'Sin nombre',
            telefono: config.telefono || 'Desconocido',
            catalogo: config.catalogo || '',
            tieneImagen: !!config.imagenMenu
        };
    }
    res.json(status);
});

async function reactivarSesiones() {
    try {
        const Auth = mongoose.models.Auth || mongoose.model('Auth');
        const sesiones = await Auth.distinct('clientId');
        for (const clientId of sesiones) {
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
