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

// Variables de Entorno
const MONGO_URI = process.env.MONGO_URI || "URL_DE_MONGO_AQUI";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "TU_API_KEY_DE_GEMINI";

// Inicializar Gemini
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const activeSessions = {};
const clientConfigs = {}; // Configuración de clientes (En el futuro a MongoDB)

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
        if (res) res.json({ success: true, message: 'Ya estaba conectado en la base de datos' });
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log(`Reconectando a ${clientId}...`);
                setTimeout(() => startClientSession(clientId), 5000);
            } else {
                console.log(`Cliente ${clientId} cerro sesion.`);
                await removeCreds();
                delete activeSessions[clientId];
            }
        } else if (connection === 'open') {
            console.log(`[!] ${clientId} esta online.`);
        }
    });

    // MOTOR DE RESPUESTA: OPCION B (ACTIVACION POR PALABRAS CLAVE)
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe || msg.key.remoteJid.includes('@g.us')) return;

        const sender = msg.key.remoteJid;
        const textoCliente = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim().toLowerCase();

        if (!textoCliente) return;

        // FILTRO B: Palabras clave de negocio
        const triggerWords = [
            'hola', 'buenas', 'saludo', 'menu', 'menú', 'catalogo', 'catálogo', 
            'pedido', 'orden', 'delivery', 'precio', 'cuanto', 'cuánto', 
            'a como', 'tiene', 'venden', 'comprar', 'info', 'direccion', 'ubicacion'
        ];

        const isBusinessQuery = triggerWords.some(kw => textoCliente.includes(kw));

        if (!isBusinessQuery) {
            // Es un mensaje personal, el bot lo ignora silenciosamente.
            console.log(`[${clientId}] Ignorando mensaje personal: "${textoCliente}"`);
            return;
        }

        console.log(`[${clientId}] Cliente de negocio dice: ${textoCliente}`);

        const tipoNegocio = clientConfigs[clientId]?.tipo || "colmado";
        const nombreLocal = clientConfigs[clientId]?.nombre || "Nuestro Local";

        // Reglas Fijas para Saludos
        const saludos = ['hola', 'buenas', 'saludos', 'buenos dias', 'buenas tardes', 'buenas noches'];
        // Si SOLO es un saludo (o contiene un saludo pero no pide menu explicitamente)
        if (saludos.some(s => textoCliente === s || textoCliente.startsWith(s)) && !textoCliente.includes('menu') && !textoCliente.includes('catalogo')) {
            return sock.sendMessage(sender, { text: `¡Hola! Gracias por comunicarte con *${nombreLocal}*. ¿En qué podemos servirte hoy? Escribe *menu* para ver nuestras opciones.` });
        }

        // Reglas Fijas para Menu
        if (textoCliente.includes('menu') || textoCliente.includes('catalogo')) {
            let menuTxt = `📋 *MENU DE ${nombreLocal.toUpperCase()}*\n\n`;
            if (tipoNegocio === "colmado") {
                menuTxt += "🍗 1. Pica Pollo ($250)\n🥛 2. Leche Rica ($80)\n🍺 3. Cerveza Presidente ($150)\n\n_Dime qué deseas pedir o si tienes alguna duda._";
            } else if (tipoNegocio === "salon") {
                menuTxt += "✂️ 1. Corte de Pelo ($500)\n💅 2. Uñas Acrilicas ($1200)\n💇‍♀️ 3. Lavado y Secado ($400)\n\n_¿A qué hora quieres tu cita?_";
            } else {
                menuTxt += "📦 1. Producto A ($100)\n📦 2. Producto B ($200)\n\n_Dime qué deseas pedir._";
            }
            return sock.sendMessage(sender, { text: menuTxt });
        }

        // Si es una duda compleja o pedido especifico -> Gemini AI
        try {
            const prompt = `Eres un asistente de WhatsApp muy amable que trabaja en un negocio de tipo: ${tipoNegocio}. El local se llama: ${nombreLocal}. Un cliente dice: "${textoCliente}". Responde en un solo parrafo corto, amable y persuasivo, con estilo de Republica Dominicana. No ofrezcas productos si no sabes si hay, solo asiste con amabilidad o pide que especifique la orden.`;
            
            const result = await model.generateContent(prompt);
            const respuestaIA = result.response.text().trim();
            
            await sock.sendMessage(sender, { text: respuestaIA });
        } catch (error) {
            console.error(`Error en Gemini para ${clientId}:`, error);
        }
    });
}

app.post('/api/connect', async (req, res) => {
    const { clientId, phoneNumber, tipoNegocio, nombreLocal } = req.body;
    if (!clientId || !phoneNumber) return res.status(400).json({ error: 'Faltan datos' });
    
    clientConfigs[clientId] = { tipo: tipoNegocio || "colmado", nombre: nombreLocal || "Mi Negocio" };
    
    if (activeSessions[clientId] && activeSessions[clientId].authState.creds.me?.id) {
        return res.status(400).json({ error: 'El cliente ya esta conectado' });
    }
    startClientSession(clientId, phoneNumber, res);
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

async function reactivarSesiones() {
    try {
        const Auth = mongoose.models.Auth || mongoose.model('Auth');
        const sesiones = await Auth.distinct('clientId');
        console.log(`[Boot] Reactivando ${sesiones.length} bots desde MongoDB...`);
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
