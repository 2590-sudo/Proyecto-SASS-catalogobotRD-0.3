const express = require('express');
const { default: makeWASocket, DisconnectReason, makeInMemoryStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const mongoose = require('mongoose');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { useMongoDBAuthState } = require('./mongoAuth');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// Variables de Entorno (En Render las configuras en el panel)
const MONGO_URI = process.env.MONGO_URI || "URL_DE_MONGO_AQUI";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "TU_API_KEY_DE_GEMINI";

// Inicializar Gemini
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Estado en memoria de Baileys para poder leer contactos y saber quién es familia/amigo
const store = makeInMemoryStore({ logger: pino().child({ level: 'silent', stream: 'store' }) });

const activeSessions = {};
const clientConfigs = {}; // Aquí guardaremos menús y configuraciones. (En el futuro esto irá a Mongo)

// Función para conectar a MongoDB
async function connectDB() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log("Conectado a MongoDB");
    } catch (e) {
        console.error("Error conectando a MongoDB:", e);
    }
}

// Función principal del bot por cliente
async function startClientSession(clientId, phoneNumber, res) {
    const { state, saveCreds, removeCreds } = await useMongoDBAuthState(clientId);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '20.0.04']
    });

    store.bind(sock.ev);
    activeSessions[clientId] = sock;

    sock.ev.on('creds.update', saveCreds);

    // Generar código de 8 dígitos (Pairing Code)
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

    // Gestionar Desconexiones
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log(`Reconectando a ${clientId}...`);
                setTimeout(() => startClientSession(clientId), 5000);
            } else {
                console.log(`Cliente ${clientId} cerró sesión desde su WhatsApp.`);
                await removeCreds();
                delete activeSessions[clientId];
            }
        } else if (connection === 'open') {
            console.log(`[!] ${clientId} está online y operando.`);
        }
    });

    // MOTOR DE RESPUESTA: FILTRO ANTI-CONTACTOS + IA HÍBRIDA
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe || msg.key.remoteJid.includes('@g.us')) return; // No responder en grupos ni a sí mismo

        const sender = msg.key.remoteJid;
        const textoCliente = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim().toLowerCase();

        if (!textoCliente) return;

        // FILTRO A: ¿Es un contacto guardado por el dueño?
        // store.contacts contiene la agenda del teléfono que Baileys descarga al conectar
        const contactoInfo = store.contacts[sender];
        if (contactoInfo && (contactoInfo.name || contactoInfo.notify)) {
            // Es un amigo, familiar o proveedor guardado. El bot lo ignora.
            console.log(`Ignorando a ${contactoInfo.name || sender} (Está en contactos)`);
            return;
        }

        // --- INICIO DEL ENRUTADOR INTELIGENTE (CLIENTE NUEVO O NO GUARDADO) ---
        console.log(`[${clientId}] Cliente dice: ${textoCliente}`);

        // Leer la config de este negocio (Simulado. En produccion vendría de Mongo)
        const tipoNegocio = clientConfigs[clientId]?.tipo || "colmado";
        const nombreLocal = clientConfigs[clientId]?.nombre || "Nuestro Local";

        // Reglas Fijas (Baratas y Rápidas en milisegundos)
        const saludos = ['hola', 'buenas', 'saludos', 'buenos dias', 'buenas tardes'];
        if (saludos.some(s => textoCliente.includes(s))) {
            return sock.sendMessage(sender, { text: `¡Hola! Gracias por comunicarte con *${nombreLocal}*. ¿En qué podemos servirte hoy? Escribe *menu* para ver lo que tenemos.` });
        }

        if (textoCliente.includes('menu') || textoCliente.includes('catalogo')) {
            // Generar un menú dinámico de ejemplo
            let menuTxt = `📋 *MENÚ DE ${nombreLocal.toUpperCase()}*\n\n`;
            if (tipoNegocio === "colmado") {
                menuTxt += "🍗 1. Pica Pollo ($250)\n🥛 2. Leche Rica ($80)\n🍺 3. Cerveza Presidente ($150)\n\n_Dime qué deseas pedir o si tienes alguna duda._";
            } else if (tipoNegocio === "salon") {
                menuTxt += "✂️ 1. Corte de Pelo ($500)\n💅 2. Uñas Acrílicas ($1200)\n💇‍♀️ 3. Lavado y Secado ($400)\n\n_¿A qué hora quieres tu cita?_";
            }
            return sock.sendMessage(sender, { text: menuTxt });
        }

        // Si no es un saludo ni pide menú, asume que es una duda compleja o un pedido específico. Llama a Gemini.
        try {
            const prompt = `Eres un asistente de WhatsApp amable que trabaja en un negocio tipo: ${tipoNegocio}. El local se llama: ${nombreLocal}. Un cliente potencial dice: "${textoCliente}". Responde en un solo párrafo corto, amable y persuasivo, propio de la República Dominicana. No ofrezcas cosas que no sabrías si tienen, pídele que confirme su orden.`;
            
            const result = await model.generateContent(prompt);
            const respuestaIA = result.response.text().trim();
            
            await sock.sendMessage(sender, { text: respuestaIA });
        } catch (error) {
            console.error(`Error en Gemini para ${clientId}:`, error);
        }
    });
}

// APIs del Panel Administrativo
app.post('/api/connect', async (req, res) => {
    const { clientId, phoneNumber, tipoNegocio, nombreLocal } = req.body;
    if (!clientId || !phoneNumber) return res.status(400).json({ error: 'Faltan datos' });
    
    // Guardar config (En produccion se guarda en DB)
    clientConfigs[clientId] = { tipo: tipoNegocio || "colmado", nombre: nombreLocal || "Mi Negocio" };
    
    if (activeSessions[clientId] && activeSessions[clientId].authState.creds.me?.id) {
        return res.status(400).json({ error: 'El cliente ya está conectado' });
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
    
    // Borrar de Mongo
    const { useMongoDBAuthState } = require('./mongoAuth');
    const authState = await useMongoDBAuthState(clientId);
    await authState.removeCreds();
    
    res.json({ success: true });
});

// Reactivar sesiones de Mongo al reiniciar el servidor
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
